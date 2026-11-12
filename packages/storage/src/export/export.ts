/**
 * `exportGroup` and `exportMember` — `02` §3.15's JSONL container.
 *
 * The output is a directory of one-JSON-object-per-line files plus a `manifest.json`, written to
 * `<dataDir>/exports/` with `0600` permissions and then packed as `tar.gz`. Every record carries
 * `$type` and `$v`, because `02` §3.15 designs the format for a re-import that is explicitly out of
 * scope before 1.0 — and a format without a version is a format that cannot be read later.
 *
 * ## The filter is one predicate, and that is the whole safety argument
 *
 * `01` §9 and `02` §3.15: a **group** export runs with audience `{kind:'group'}`, so it contains
 * only data every current member may read. An admin running it therefore cannot obtain another
 * member's private notes — not because the export politely omits them, but because the eligible set
 * computed for the group audience does not contain their labels. A **member** export runs with
 * `{kind:'members', memberIds:[m]}` and adds the `me/` section, which is filtered by person rather
 * than by label because those rows are *about* the requester.
 *
 * Both compute the set through `core`'s `computeEligible`, with the same `ReadEligibility` the
 * context builder uses. That is what makes `export.member-scope.property` a statement about the
 * product rather than about this file: if the two ever disagreed, one of them would be wrong, and
 * `labels.eligibility-equivalence.property` would catch it.
 *
 * ## Serialisation
 *
 * The records are domain objects, so instants are `Temporal.Instant` and labels are `label_id`
 * integers. `serialiseRecord` turns the first into ISO-8601 strings and the second into `02`
 * §3.15's rendered shape, recursively, in one place — because a per-source serialiser would be
 * eighteen chances for one field to go out as epoch milliseconds.
 */
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import {
  type Audience,
  computeEligible,
  type EligibleLabelSet,
  type GroupSnapshot,
  type Label,
  type ReadEligibility,
} from '@comvivo/core';
import { BRAND, type GroupId, type LabelId, type MemberId } from '@comvivo/shared';
import { sha256 } from '@comvivo/shared/crypto';
import { pack as tarPack } from 'tar-stream';
import { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import {
  AUDIT_SOURCE,
  EXPORT_CHUNK_ROWS,
  type ExportSource,
  GROUP_PROFILE_FILE,
  GROUP_SOURCES,
  ME_PERSON_FILE,
  ME_POLICY_FILE,
  ME_SOURCES,
  readChunk,
  readGroupProfile,
  readPerson,
  readPrivatePolicy,
} from './sources.js';

/** `02` §3.15's `exportFormatVersion`. */
export const EXPORT_FORMAT_VERSION = 1;

/** Every record's `$v`. One number for the whole format, which is what `$v` is for. */
export const EXPORT_RECORD_VERSION = 1;

export interface ExportManifestFile {
  readonly name: string;
  readonly records: number;
  readonly sha256: string;
}

export interface ExportManifest {
  readonly exportFormatVersion: number;
  readonly scope: 'group' | 'member';
  readonly groupId: GroupId;
  readonly memberId?: MemberId | undefined;
  /** The audience the eligible set was computed for — the export's own safety statement. */
  readonly audience: Audience;
  readonly generatedAt: string;
  readonly appVersion: string;
  readonly files: readonly ExportManifestFile[];
  readonly filters: {
    /**
     * Whether attachment bodies are in the archive.
     *
     * Always `false` before `M6`: nothing reads `message_attachments` yet, so no export can carry
     * `files/`. The field is in the manifest anyway because the manifest is the published contract
     * (`02` §3.15) and "this archive has no file bodies" is exactly what a consumer needs to know.
     */
    readonly includeFiles: boolean;
    /** Whether `audit_events.jsonl` is in the archive (`02` §3.15: capability-gated). */
    readonly includeAudit: boolean;
    readonly eligibleLabels: number;
  };
}

/**
 * `03`'s hook (`02` §3.15).
 *
 * `redact` is not `exclude`: a redacted record keeps its id and its shape and loses its content, so
 * an export stays a complete account of *what exists* even where `03` decides the requester may not
 * read it. A policy that could only exclude would make "this conversation has a gap" and "this
 * conversation is complete" indistinguishable.
 */
export type ExportPolicy = (record: {
  readonly type: string;
  readonly value: Record<string, unknown>;
}) => 'include' | 'exclude' | 'redact';

export interface ExportOptions {
  readonly db: Db;
  readonly dataDir: string;
  readonly groupId: GroupId;
  /** Every label of the group, which is `computeEligible`'s candidate set. */
  readonly labels: ReadonlyMap<LabelId, Label>;
  readonly snapshot: GroupSnapshot;
  readonly flow: ReadEligibility;
  readonly appVersion: string;
  readonly generatedAt: Temporal.Instant;
  /**
   * Include `audit_events.jsonl` (`02` §3.15: "group scope + capability only").
   *
   * The caller decides, because the capability system is `M5` and the requester is only known at
   * `M9`'s CLI and dashboard. Defaulting to `false` makes the safe answer the one you get by not
   * thinking about it — an audit log is the record of what admins did, and `01` §9's rule that a
   * group export holds only what every member may read does not cover it.
   */
  readonly includeAudit?: boolean | undefined;
  readonly policy?: ExportPolicy | undefined;
}

export interface ExportResult {
  readonly dir: string;
  readonly archive: string;
  readonly manifest: ExportManifest;
  readonly eligible: EligibleLabelSet;
}

/** `02` §3.15's directory name. */
export function exportDirName(subject: string, generatedAt: Temporal.Instant): string {
  const stamp = generatedAt.toString().replaceAll(/[-:]/g, '').replace(/\.\d+/, '');
  return `${BRAND.slug}-export-${subject}-${stamp}`;
}

/**
 * Turn a domain object into an export record.
 *
 * Three conversions, all recursive and all in one place:
 *
 *  - `Temporal.Instant` → ISO-8601, because `02` §3.15 says so and because epoch milliseconds in
 *    an exported file are a number nobody can read.
 *  - `labelId` → the rendered label, so a record says *who may read it* rather than carrying an
 *    integer that means nothing outside this database.
 *  - `undefined` → dropped, so an absent optional is absent rather than `null`. `JSON.stringify`
 *    does this for objects already; doing it explicitly keeps arrays consistent with them.
 */
export function serialiseRecord(
  type: string,
  value: unknown,
  labelOf: (id: LabelId) => Label | undefined,
): Record<string, unknown> {
  const body = convert(value, labelOf);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    // Unreachable for every source: each maps a row to an object. Thrown rather than coerced,
    // because a record that is not an object is a line a reader cannot parse as one. The shape is
    // named precisely because `typeof` calls both `null` and an array an object, and "produced a
    // object" would send whoever reads it looking in the wrong place.
    const shape = Array.isArray(body) ? 'an array' : body === null ? 'null' : `a ${typeof body}`;
    throw new TypeError(`export source ${type} produced ${shape} rather than an object`);
  }
  return { $type: type, $v: EXPORT_RECORD_VERSION, ...(body as Record<string, unknown>) };
}

function convert(value: unknown, labelOf: (id: LabelId) => Label | undefined): unknown {
  if (value instanceof Temporal.Instant) return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64url');
  if (Array.isArray(value)) return value.map((item) => convert(item, labelOf));
  if (typeof value !== 'object' || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    if (key === 'labelId' && typeof raw === 'number') {
      const label = labelOf(raw as LabelId);
      // `label` rather than `labelId`: the integer is meaningless outside this database, and the
      // rendered shape is what `02` §3.15 publishes. A label the store cannot resolve is a bug
      // upstream — the row's own foreign key guarantees it exists — so the id is kept as a
      // diagnostic rather than silently dropped.
      if (label === undefined) out['labelId'] = raw;
      else out['label'] = renderLabel(label);
      continue;
    }
    out[key] = convert(raw, labelOf);
  }
  return out;
}

/** `02` §3.15's label rendering: who may read it, who owns it, and how it must be handled. */
export function renderLabel(label: Label): Record<string, unknown> {
  return {
    readers:
      label.readers.kind === 'group'
        ? { kind: 'group' }
        : { kind: 'members', memberIds: [...label.readers.memberIds] },
    owner: label.owner,
    sensitivity: label.sensitivity,
    influence: label.influence,
    untrusted: label.untrusted,
  };
}

/** The whole of a group export (`01` §9: only what every current member may read). */
export async function exportGroup(options: ExportOptions): Promise<ExportResult> {
  const audience: Audience = { kind: 'group', groupId: options.groupId };
  return runExport(options, 'group', audience, undefined);
}

/** A member export: their eligible view, plus the `me/` section. */
export async function exportMember(
  options: ExportOptions & { readonly memberId: MemberId; readonly personId: string },
): Promise<ExportResult> {
  const audience: Audience = {
    kind: 'members',
    groupId: options.groupId,
    memberIds: [options.memberId],
  };
  return runExport(options, 'member', audience, {
    memberId: options.memberId,
    personId: options.personId,
  });
}

async function runExport(
  options: ExportOptions,
  scope: 'group' | 'member',
  audience: Audience,
  subject: { readonly memberId: MemberId; readonly personId: string } | undefined,
): Promise<ExportResult> {
  const eligible = computeEligible(options.labels, audience, options.snapshot, options.flow);
  const labelOf = (id: LabelId): Label | undefined => options.labels.get(id);

  const dir = join(
    options.dataDir,
    'exports',
    exportDirName(subject?.memberId ?? options.groupId, options.generatedAt),
  );
  // The subject is resolved **before** anything is written: a member export for a person this
  // instance does not have is a request that cannot be satisfied, and failing after `mkdir` would
  // leave a half-written directory for `export.cleanup` to find seven days later (`02` §3.15).
  const me = subject === undefined ? undefined : readPerson(options.db, subject.personId);
  if (subject !== undefined && me === undefined) {
    throw new Error(`export subject ${subject.personId} is not a person in this instance`);
  }

  mkdirSync(join(dir, 'me'), { recursive: true, mode: 0o700 });

  const files: ExportManifestFile[] = [];

  const profile = readGroupProfile(options.db, options.groupId);
  if (profile !== undefined) {
    files.push(
      writeFile(
        dir,
        GROUP_PROFILE_FILE,
        `${JSON.stringify(serialiseRecord('group', profile, labelOf), null, 2)}\n`,
        1,
      ),
    );
  }

  if (subject !== undefined) {
    files.push(
      writeFile(
        dir,
        ME_PERSON_FILE,
        `${JSON.stringify(serialiseRecord('person', me, labelOf), null, 2)}\n`,
        1,
      ),
    );

    const policy = readPrivatePolicy(options.db, subject.memberId);
    // Written only when it exists: `02` §3.15 lists one file per thing a member has, and a member
    // who has never set a private-constraint policy has none. An empty object here would be a
    // policy — `{}` means "nothing allowed" to `03` §3.5.3's reader — so writing one would be
    // inventing an answer the member never gave.
    if (policy !== undefined) {
      files.push(
        writeFile(
          dir,
          ME_POLICY_FILE,
          `${JSON.stringify(serialiseRecord('private_constraint_policy', policy, labelOf), null, 2)}\n`,
          1,
        ),
      );
    }
  }

  const sources = [
    ...GROUP_SOURCES,
    ...(options.includeAudit === true ? [AUDIT_SOURCE] : []),
    ...(scope === 'member' ? ME_SOURCES : []),
  ];
  for (const source of sources) {
    const written = writeSource(options, source, { eligible, labelOf, subject });
    // Every source writes its file, even an empty one. A missing file and an empty file say
    // different things — "this version does not export that" and "you have none" — and a reader
    // that had to tell them apart from an absence could not.
    files.push(writeFile(dir, source.file, written.text, written.records));
  }

  const manifest: ExportManifest = {
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    scope,
    groupId: options.groupId,
    ...(subject === undefined ? {} : { memberId: subject.memberId }),
    audience,
    generatedAt: options.generatedAt.toString(),
    appVersion: options.appVersion,
    files,
    filters: {
      includeFiles: false,
      includeAudit: options.includeAudit === true,
      // The count, not the ids: a label id is an internal integer, and the number is what a reader
      // needs to see that a member export is narrower than the group's.
      eligibleLabels: eligible.ids.length,
    },
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });

  const archive = `${dir}.tar.gz`;
  await packArchive(dir, [...files.map((file) => file.name), 'manifest.json'], archive);
  return { dir, archive, manifest, eligible };
}

interface SourceScope {
  readonly eligible: EligibleLabelSet;
  readonly labelOf: (id: LabelId) => Label | undefined;
  readonly subject: { readonly memberId: MemberId; readonly personId: string } | undefined;
}

/** Read one source to exhaustion, in chunks, and return its JSONL. */
function writeSource(
  options: ExportOptions,
  source: ExportSource,
  scope: SourceScope,
): { readonly text: string; readonly records: number } {
  const lines: string[] = [];
  let after: string | number | undefined;
  for (;;) {
    const rows = readChunk(
      options.db,
      source,
      {
        groupId: options.groupId,
        eligible: scope.eligible,
        ...(scope.subject === undefined
          ? {}
          : { personId: scope.subject.personId, memberId: scope.subject.memberId }),
      },
      after,
      EXPORT_CHUNK_ROWS,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const record = serialiseRecord(source.type, source.map(row), scope.labelOf);
      const verdict = options.policy?.({ type: source.type, value: record }) ?? 'include';
      if (verdict === 'exclude') continue;
      lines.push(JSON.stringify(verdict === 'redact' ? redact(record) : record));
    }
    const last = rows.at(-1);
    after = last?.[source.orderBy] as string | number | undefined;
    if (after === undefined || rows.length < EXPORT_CHUNK_ROWS) break;
  }
  return { text: lines.length === 0 ? '' : `${lines.join('\n')}\n`, records: lines.length };
}

/**
 * Keep the record's identity and drop everything else.
 *
 * `$type`, `$v`, `id` and the label survive, so a reader can see that a record exists, what kind it
 * is, and who may read it — which is the difference between "there is something here you may not
 * see" and a silent gap. `03` decides when this applies.
 */
function redact(record: Record<string, unknown>): Record<string, unknown> {
  // Listed rather than conditionally spread: a key whose value is `undefined` is dropped by
  // `JSON.stringify`, which is the same rule `convert` applies to an absent optional — so an
  // unlabeled record (a membership, say) loses the key entirely rather than carrying a `null`.
  return {
    $type: record['$type'],
    $v: record['$v'],
    id: record['id'],
    label: record['label'],
    $redacted: true,
  };
}

function writeFile(dir: string, name: string, text: string, records: number): ExportManifestFile {
  writeFileSync(join(dir, name), text, { mode: 0o600 });
  // The digest is over the bytes as written, so a manifest entry is checkable without re-running
  // the export — which is what makes a transfer verifiable.
  return { name, records, sha256: sha256(Buffer.from(text, 'utf8')).toString('hex') };
}

/** `tar.gz`, as `02` §3.15 specifies: Node's `zlib` over `tar-stream`. */
async function packArchive(dir: string, names: readonly string[], archive: string): Promise<void> {
  const pack = tarPack();
  // Entries added before the pipeline rather than concurrently with it: an export's files are the
  // JSONL the run just wrote, all of them already in memory-sized chunks on disk, so there is no
  // 5 GB entry to stream and no reason for the ceremony `createBackup` needs.
  for (const name of names) {
    const body = readFileSync(join(dir, name));
    pack.entry({ name, size: body.length, mode: 0o600 }, body);
  }
  pack.finalize();
  await pipeline(pack, createGzip(), createWriteStream(archive, { mode: 0o600 }));
}
