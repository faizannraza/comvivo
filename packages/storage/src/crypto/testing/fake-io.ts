/**
 * An in-memory filesystem for the keyring, with a fault injector.
 *
 * `M1-T5`'s acceptance criterion asks for `sec.keys.*` "incl. crash-resume via fault injection",
 * and that is not reachable through a real filesystem: the interesting failures happen *between*
 * two syscalls — after the temp file is fsynced but before the rename, or after the previous file
 * is moved aside but before the new one lands. A test that cannot stop the world at those points
 * cannot show that a crash there leaves a host with a working keyring.
 *
 * Deliberately a faithful fake rather than a mock. It tracks modes, it refuses to read a file that
 * is not there, and `rename` replaces the destination — so a test that passes against it is a test
 * about the write sequence rather than about which methods were called in which order. `08`
 * §3.7.4's guarantee is about what is on disk after a crash, and that is what this can express.
 */
import type { KeyringIo } from '../keyring-store.js';

/** A point in the write sequence a test can fail at. */
export type FaultPoint =
  | 'writeFile'
  | 'syncFile'
  | 'renameToPrevious'
  | 'renameTempIntoPlace'
  | 'syncDirectory';

export class InjectedFault extends Error {
  readonly point: FaultPoint;

  constructor(point: FaultPoint) {
    super(`injected fault at ${point}`);
    this.name = 'InjectedFault';
    this.point = point;
  }
}

export interface FakeKeyringIoOptions {
  /** Fail the first time this step runs. */
  readonly failAt?: FaultPoint;
}

/**
 * A fake `KeyringIo` over a `Map`.
 *
 * `renames` counts calls so the store's two renames can be told apart: the first moves the live
 * keyring to `.prev`, the second moves the temp file into place. A single `failAt: 'rename'` would
 * not be able to distinguish them, and they fail in very different ways — the first leaves the old
 * keyring intact, the second leaves it only as `.prev`.
 */
export class FakeKeyringIo implements KeyringIo {
  readonly files = new Map<string, { contents: string; mode: number }>();
  readonly directories = new Map<string, number>();
  readonly calls: string[] = [];

  #failAt: FaultPoint | undefined;
  #renameCount = 0;

  constructor(options: FakeKeyringIoOptions = {}) {
    this.#failAt = options.failAt;
  }

  /** Arm (or disarm) a fault for the next write. */
  armFault(point: FaultPoint | undefined): void {
    this.#failAt = point;
    this.#renameCount = 0;
  }

  #maybeFail(point: FaultPoint): void {
    if (this.#failAt === point) {
      // One-shot: a test that fails every attempt could not then show recovery.
      this.#failAt = undefined;
      throw new InjectedFault(point);
    }
  }

  readFile(path: string): Promise<string> {
    this.calls.push(`readFile ${path}`);
    const entry = this.files.get(path);
    if (entry === undefined) {
      const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file, open '${path}'`);
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve(entry.contents);
  }

  writeFile(path: string, contents: string, mode: number): Promise<void> {
    this.calls.push(`writeFile ${path}`);
    this.#maybeFail('writeFile');
    this.files.set(path, { contents, mode });
    return Promise.resolve();
  }

  syncFile(path: string): Promise<void> {
    this.calls.push(`syncFile ${path}`);
    this.#maybeFail('syncFile');
    if (!this.files.has(path)) {
      return Promise.reject(new Error(`ENOENT: cannot fsync a file that is not there: ${path}`));
    }
    return Promise.resolve();
  }

  syncDirectory(path: string): Promise<void> {
    this.calls.push(`syncDirectory ${path}`);
    this.#maybeFail('syncDirectory');
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename ${from} -> ${to}`);
    this.#renameCount += 1;
    this.#maybeFail(this.#renameCount === 1 ? 'renameToPrevious' : 'renameTempIntoPlace');
    const entry = this.files.get(from);
    if (entry === undefined) {
      return Promise.reject(new Error(`ENOENT: cannot rename a file that is not there: ${from}`));
    }
    this.files.delete(from);
    this.files.set(to, entry);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.calls.push(`remove ${path}`);
    this.files.delete(path);
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  modeOf(path: string): Promise<number | undefined> {
    return Promise.resolve(this.files.get(path)?.mode ?? this.directories.get(path));
  }

  chmod(path: string, mode: number): Promise<void> {
    this.calls.push(`chmod ${path} ${mode.toString(8)}`);
    const entry = this.files.get(path);
    if (entry !== undefined) this.files.set(path, { ...entry, mode });
    else if (this.directories.has(path)) this.directories.set(path, mode);
    return Promise.resolve();
  }

  mkdir(path: string, mode: number): Promise<void> {
    this.calls.push(`mkdir ${path}`);
    if (!this.directories.has(path)) this.directories.set(path, mode);
    return Promise.resolve();
  }

  /** How many renames this instance has seen, so a test can assert the sequence ran. */
  get renameCount(): number {
    return this.#renameCount;
  }

  /** Seed a file directly, for "what happens when one is already there" cases. */
  seed(path: string, contents: string, mode = 0o600): void {
    this.files.set(path, { contents, mode });
  }

  /** Seed a directory's mode, for the permission audit. */
  seedDirectory(path: string, mode: number): void {
    this.directories.set(path, mode);
  }
}
