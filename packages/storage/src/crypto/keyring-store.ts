/**
 * Reading and writing `data/keys/keyring.json` safely (`08` §3.7.4, `12` §3.7).
 *
 * The write sequence is the whole point of this file: **write `.tmp` → fsync the file → rename over
 * the real one → fsync the directory**, keeping the previous contents as `keyring.json.prev`.
 *
 * Each step earns its place:
 *
 *  - Writing to a temporary name means a crash mid-write cannot leave a half-written keyring where
 *    the real one was. `rename` within a filesystem is atomic, so a reader sees the old file or the
 *    new one and never a mixture.
 *  - **fsync on the file** before the rename, or the rename can be durable while the bytes it
 *    points at are not — a power cut then leaves a correctly-named, empty or partial keyring.
 *  - **fsync on the directory** after the rename, or the rename itself may not survive a power
 *    cut, and the host comes back to the *old* keyring after a rotation they were told succeeded.
 *  - `.prev` is `08` §3.7.4's answer to "the new keyring is wrong": one copy back, kept until the
 *    next successful boot.
 *
 * File I/O is injected. `sec.keys.*` has to prove crash-resume, which means failing the write
 * *between* the fsync and the rename and then showing that the keyring on disk is still the old
 * one. There is no way to reach that state through the real filesystem on purpose.
 */
import { constants as fsConstants } from 'node:fs';
import {
  chmod as fsChmod,
  mkdir as fsMkdir,
  open as fsOpen,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import { type Keyring, KeyringError, parseKeyring, serialiseKeyring } from './keyring.js';

export const KEYRING_FILENAME = 'keyring.json';
export const KEYRING_PREVIOUS_FILENAME = 'keyring.json.prev';
export const KEYRING_TEMP_FILENAME = 'keyring.json.tmp';

/** `12` §3.7: `keys/` is 0700 and every file in it is 0600. */
export const KEY_DIR_MODE = 0o700;
export const KEY_FILE_MODE = 0o600;

/**
 * The filesystem operations this module needs.
 *
 * Narrow on purpose: a seam wide enough to mock the whole of `node:fs` would be a seam wide enough
 * to let a test pass against a fake that behaves nothing like a filesystem.
 */
export interface KeyringIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string, mode: number): Promise<void>;
  /** Flush a file's contents to the device. Called before the rename. */
  syncFile(path: string): Promise<void>;
  /** Flush a directory entry to the device. Called after the rename. */
  syncDirectory(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** The file's mode bits, or `undefined` if it is absent. */
  modeOf(path: string): Promise<number | undefined>;
  chmod(path: string, mode: number): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
}

/** The real filesystem. */
export const nodeKeyringIo: KeyringIo = {
  async readFile(path) {
    return fsReadFile(path, 'utf8');
  },
  async writeFile(path, contents, mode) {
    await fsWriteFile(path, contents, { encoding: 'utf8', mode });
    // `writeFile`'s `mode` applies only when it creates the file, so an existing file keeps
    // whatever mode it had. Setting it explicitly is what makes a pre-existing 0644 keyring become
    // 0600 rather than staying readable.
    await fsChmod(path, mode);
  },
  async syncFile(path) {
    const handle = await fsOpen(path, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async syncDirectory(path) {
    // A directory has to be opened read-only to be fsynced; `r+` fails with EISDIR on Linux.
    const handle = await fsOpen(path, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async rename(from, to) {
    await fsRename(from, to);
  },
  async remove(path) {
    await fsRm(path, { force: true });
  },
  async exists(path) {
    try {
      await fsStat(path);
      return true;
    } catch {
      return false;
    }
  },
  async modeOf(path) {
    try {
      return (await fsStat(path)).mode & 0o777;
    } catch {
      return undefined;
    }
  },
  async chmod(path, mode) {
    await fsChmod(path, mode);
  },
  async mkdir(path, mode) {
    await fsMkdir(path, { recursive: true, mode });
  },
};

/** What a permission audit concluded about one path (`08` §3.7.3, `12` §3.7). */
export interface PermissionFinding {
  readonly path: string;
  readonly mode: number;
  readonly kind: 'group_or_world_readable' | 'group_or_world_writable';
}

export class KeyPermissionError extends Error {
  readonly findings: readonly PermissionFinding[];
  readonly hint: string;

  constructor(findings: readonly PermissionFinding[]) {
    const described = findings
      .map((finding) => `${finding.path} is ${finding.mode.toString(8).padStart(4, '0')}`)
      .join(', ');
    super(`key material is readable by other users: ${described}`);
    this.name = 'KeyPermissionError';
    this.findings = findings;
    this.hint =
      'Run `chmod 600` on the key files and `chmod 700` on the keys directory, or start with ' +
      '`--insecure-permissions` if you have decided this host is safe (ssh-style).';
  }
}

/** `true` when any of the group or other bits allow reading. */
export function isGroupOrWorldReadable(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/** `true` when any of the group or other bits allow writing. */
export function isGroupOrWorldWritable(mode: number): boolean {
  return (mode & 0o022) !== 0;
}

/**
 * Audit the key directory and its files.
 *
 * `08` §3.7.3 and `12` §3.7 split the response in two, and the split is the interesting part:
 *
 *  - **key material** that is group- or world-readable → **refuse to start**, because another
 *    local user can already read the key, and starting anyway would be pretending otherwise;
 *  - **anything else** → tighten it silently and warn, because the host did not choose it and
 *    fixing it is unambiguous.
 *
 * Skipped on Windows, where these bits do not mean what they say (`08` §3.7.3).
 */
export async function auditKeyPermissions(
  keysDir: string,
  files: readonly string[],
  io: KeyringIo = nodeKeyringIo,
  options: { readonly platform?: string; readonly allowInsecure?: boolean } = {},
): Promise<{
  readonly refused: readonly PermissionFinding[];
  readonly tightened: readonly string[];
}> {
  if ((options.platform ?? process.platform) === 'win32') {
    return { refused: [], tightened: [] };
  }

  const refused: PermissionFinding[] = [];
  const tightened: string[] = [];

  const dirMode = await io.modeOf(keysDir);
  if (dirMode !== undefined && isGroupOrWorldReadable(dirMode)) {
    // A readable `keys/` directory leaks the *names* of the key files, and on many systems that is
    // enough to know which unlock modes are in use. `12` §3.7 refuses it.
    refused.push({ path: keysDir, mode: dirMode, kind: 'group_or_world_readable' });
  }

  for (const file of files) {
    const path = join(keysDir, file);
    const mode = await io.modeOf(path);
    if (mode === undefined) continue;
    if (isGroupOrWorldReadable(mode)) {
      refused.push({ path, mode, kind: 'group_or_world_readable' });
    } else if (mode !== KEY_FILE_MODE) {
      // Not readable by anyone else, but not exactly 0600 either — a stray execute bit, say. The
      // host did not choose it and there is one right answer, so fix it and say so.
      await io.chmod(path, KEY_FILE_MODE);
      tightened.push(path);
    }
  }

  if (refused.length > 0 && options.allowInsecure !== true) {
    throw new KeyPermissionError(refused);
  }
  return { refused, tightened };
}

/** Where a keyring lives, and how to touch it. */
export class KeyringStore {
  readonly #dir: string;
  readonly #io: KeyringIo;

  constructor(keysDir: string, io: KeyringIo = nodeKeyringIo) {
    this.#dir = keysDir;
    this.#io = io;
  }

  get path(): string {
    return join(this.#dir, KEYRING_FILENAME);
  }

  get previousPath(): string {
    return join(this.#dir, KEYRING_PREVIOUS_FILENAME);
  }

  get tempPath(): string {
    return join(this.#dir, KEYRING_TEMP_FILENAME);
  }

  async exists(): Promise<boolean> {
    return this.#io.exists(this.path);
  }

  /** Read and validate the keyring. */
  async read(): Promise<Keyring> {
    let text: string;
    try {
      text = await this.#io.readFile(this.path);
    } catch (cause) {
      throw new KeyringError(
        'KEYRING_MISSING',
        `there is no keyring at ${this.path}`,
        `If this is a new install, run \`${BRAND.cliName} init\`. If it is not, the key directory is ` +
          'missing or unreadable — check the path and the permissions before anything else.',
        { cause },
      );
    }
    return parseKeyring(text);
  }

  /** Read `keyring.json.prev`, for the recovery path. */
  async readPrevious(): Promise<Keyring> {
    let text: string;
    try {
      text = await this.#io.readFile(this.previousPath);
    } catch (cause) {
      throw new KeyringError(
        'KEYRING_MISSING',
        `there is no previous keyring at ${this.previousPath}`,
        'The previous keyring is kept only until the next successful boot, so there may ' +
          'legitimately be none. Recover with your recovery key instead.',
        { cause },
      );
    }
    return parseKeyring(text);
  }

  /**
   * Write the keyring atomically, keeping the old one as `.prev`.
   *
   * The order is: temp file → fsync → preserve the current file as `.prev` → rename temp over the
   * real path → fsync the directory. Validated before any of that, because writing a keyring the
   * reader will refuse is the one failure with no recovery: the old file is already gone.
   */
  async write(keyring: Keyring): Promise<void> {
    // Round-trip through the parser first. A keyring assembled in memory can violate the schema's
    // cross-field rules — a `current` pointing nowhere, a generation with no recovery slot — and
    // the only safe moment to find out is before the old file is replaced.
    const text = serialiseKeyring(keyring);
    parseKeyring(text);

    await this.#io.mkdir(this.#dir, KEY_DIR_MODE);
    await this.#io.writeFile(this.tempPath, text, KEY_FILE_MODE);
    await this.#io.syncFile(this.tempPath);

    if (await this.#io.exists(this.path)) {
      // Preserved before the rename, so there is never a moment with neither a keyring nor a
      // previous keyring on disk.
      await this.#io.rename(this.path, this.previousPath);
    }

    await this.#io.rename(this.tempPath, this.path);
    await this.#io.syncDirectory(this.#dir);
  }

  /**
   * Remove a leftover `.tmp` from an interrupted write.
   *
   * Called at boot. A stale temp file is harmless — the atomic rename means it was never the live
   * keyring — but leaving it would make the next write's `writeFile` overwrite a file whose
   * provenance nobody knows, and it would confuse a host reading the directory during an
   * emergency.
   */
  async clearTemp(): Promise<boolean> {
    if (!(await this.#io.exists(this.tempPath))) return false;
    await this.#io.remove(this.tempPath);
    return true;
  }

  /** Audit this directory's permissions (`08` §3.7.3). */
  async auditPermissions(
    files: readonly string[],
    options: { readonly platform?: string; readonly allowInsecure?: boolean } = {},
  ): Promise<{
    readonly refused: readonly PermissionFinding[];
    readonly tightened: readonly string[];
  }> {
    return auditKeyPermissions(this.#dir, files, this.#io, options);
  }

  /** The directory holding the keyring, for callers that need to place a sibling file. */
  get directory(): string {
    return this.#dir;
  }

  /** The parent of the key directory, for the data-dir audit in `M1-T7`. */
  get parentDirectory(): string {
    return dirname(this.#dir);
  }
}
