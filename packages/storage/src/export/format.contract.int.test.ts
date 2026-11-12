/**
 * The export format against its own published contract (`02` §3.15).
 *
 * One row in every table an export reads, then: every record parses against the schema `13`
 * publishes for its `$type`, every source actually produced it, and the archive on disk matches
 * the manifest that describes it.
 *
 * ## Why one row per source, rather than a focused fixture
 *
 * A source is a table, an ordering key and a mapper, and the mapper is reached through a cast —
 * `sources.ts`'s `mapper` takes `(row: never)` because drizzle's inferred row type is per-table.
 * So a source whose row and mapper disagree compiles, runs, and writes records whose every mapped
 * field is `undefined`. That is not hypothetical: it is what the first version of this library did
 * for **all sixteen** group sources, while a test asserting on ids passed, because ids are the one
 * field a raw row and a mapped row spell the same way.
 *
 * Nothing short of "every source, every record, every required field" catches that. Two of the
 * findings below were caught by exactly this test on its first run:
 *
 *  - `me/identities.jsonl` exported **nothing**, because the scope column was named but the value
 *    it should be compared against was inferred from that name, and `personId` fell through to the
 *    group id (`sources.ts`'s `subjectScope` is the fix);
 *  - `audit_events.jsonl` threw, because the table has no `rid` — the chain is ordered by `seq`.
 */

import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { StubInformationFlow } from '@comvivo/core';
import { BRAND } from '@comvivo/shared';
import { sha256 } from '@comvivo/shared/crypto';
import { extract as tarExtract } from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { T0, type World, withReposAsync } from '../repos/testing/harness.js';
import { type ExportResult, exportGroup, exportMember } from './export.js';
import { ExportManifestSchema, ExportRecordSchemas, type ExportRecordType } from './schemas.js';
import {
  AUDIT_SOURCE,
  GROUP_PROFILE_FILE,
  GROUP_SOURCES,
  ME_PERSON_FILE,
  ME_POLICY_FILE,
  ME_SOURCES,
} from './sources.js';
import { seedEverySource } from './testing/seed.js';

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), `${BRAND.slug}-fmt-`));
  temporaries.push(path);
  return path;
}

function optionsFor(world: World, subject: { readonly memberId: string }) {
  return {
    db: world.drizzle,
    dataDir: tempDir(),
    groupId: world.groupId,
    labels: world.repos.labels.groupLabels(world.groupId),
    snapshot: {
      groupId: world.groupId,
      membershipEpoch: 1,
      memberIds: [subject.memberId as never],
    },
    flow: StubInformationFlow,
    appVersion: '0.1.0',
    generatedAt: T0,
  };
}

function recordsIn(dir: string, file: string): readonly Record<string, unknown>[] {
  const text = readFileSync(join(dir, file), 'utf8');
  if (file.endsWith('.json')) return [JSON.parse(text) as Record<string, unknown>];
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Parse one record against the schema its `$type` names. */
function parseRecord(record: Record<string, unknown>, where: string): void {
  const type = record['$type'];
  expect(typeof type, `${where} has a $type`).toBe('string');
  const schema = ExportRecordSchemas[type as ExportRecordType];
  expect(schema, `${where}: ${String(type)} has a published schema`).toBeDefined();
  const parsed = schema.safeParse(record);
  expect(
    parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    `${where} (${String(type)}) parses against its published schema`,
  ).toEqual([]);
}

describe('every export record against its published schema (02 §3.15)', () => {
  it('writes one parseable record per source, at member scope', async () => {
    await withReposAsync(async (world) => {
      const seeded = seedEverySource(world);
      const result = await exportMember({
        ...optionsFor(world, seeded),
        includeAudit: true,
        memberId: seeded.memberId,
        personId: seeded.personId,
      });

      const expected = [
        GROUP_PROFILE_FILE,
        ME_PERSON_FILE,
        ME_POLICY_FILE,
        ...GROUP_SOURCES.map((source) => source.file),
        AUDIT_SOURCE.file,
        ...ME_SOURCES.map((source) => source.file),
      ];
      // Every file the container promises, and nothing else. A source that stopped being written
      // would otherwise be invisible: its records would simply be absent from an archive that
      // still looked complete.
      expect(result.manifest.files.map((file) => file.name).toSorted()).toEqual(
        expected.toSorted(),
      );

      for (const file of result.manifest.files) {
        const records = recordsIn(result.dir, file.name);
        // One row per source was seeded, so a source that read **nothing** fails here. This is the
        // assertion that would have caught `me/identities.jsonl` exporting zero records.
        expect(records.length, `${file.name} has the seeded record`).toBe(1);
        expect(file.records, `${file.name}'s manifest count`).toBe(1);
        for (const record of records) {
          parseRecord(record, file.name);
          // No raw column names, anywhere. `02` §3.15: records are domain objects, and a
          // snake_case key means a row reached the file without its mapper — the failure this
          // whole fixture exists to catch.
          for (const key of Object.keys(record)) {
            expect(key.includes('_'), `${file.name} key ${key} is camelCase`).toBe(false);
          }
          // A rendered label, never the internal integer (`02` §3.15).
          expect(Object.keys(record)).not.toContain('labelId');
          // `null` is never written: an absent optional is an absent key (`serialiseRecord`).
          for (const [key, value] of Object.entries(record)) {
            expect(value, `${file.name}.${key} is not null`).not.toBeNull();
          }
        }
      }
    });
  });

  it('validates its own manifest, and the digests match the bytes on disk', async () => {
    await withReposAsync(async (world) => {
      const seeded = seedEverySource(world);
      const result = await exportMember({
        ...optionsFor(world, seeded),
        memberId: seeded.memberId,
        personId: seeded.personId,
      });

      const raw = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8')) as unknown;
      const parsed = ExportManifestSchema.safeParse(raw);
      expect(
        parsed.success
          ? []
          : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      ).toEqual([]);

      for (const file of result.manifest.files) {
        const bytes = readFileSync(join(result.dir, file.name));
        // The digest is the point of the manifest: a transfer is verifiable without re-running the
        // export. A digest over anything but the bytes as written would make it decorative.
        expect(sha256(bytes).toString('hex'), `${file.name} digest`).toBe(file.sha256);
      }
    });
  });

  it('packs exactly the files the manifest lists', async () => {
    await withReposAsync(async (world) => {
      const seeded = seedEverySource(world);
      const result = await exportMember({
        ...optionsFor(world, seeded),
        includeAudit: true,
        memberId: seeded.memberId,
        personId: seeded.personId,
      });

      const packed = await entriesOf(result);
      expect([...packed.keys()].toSorted()).toEqual(
        [...result.manifest.files.map((file) => file.name), 'manifest.json'].toSorted(),
      );
      // Byte-identical, because `tar.gz` is what the dashboard hands over (`09`) and the directory
      // is deleted after seven days (`02` §3.15). If they could differ, the manifest's digests
      // would describe a file nobody receives.
      for (const file of result.manifest.files) {
        expect(sha256(packed.get(file.name) ?? Buffer.alloc(0)).toString('hex')).toBe(file.sha256);
      }
    });
  });

  it('keeps the group scope out of me/ and out of the audit log', async () => {
    await withReposAsync(async (world) => {
      const seeded = seedEverySource(world);
      const result = await exportGroup(optionsFor(world, seeded));
      const names = result.manifest.files.map((file) => file.name);

      // `me/` is the member's own section, and the audit log is `02` §3.15's capability-gated file.
      // A group export that carried either would be an admin reading what `01` §9 says they cannot.
      expect(names.filter((name) => name.startsWith('me/'))).toEqual([]);
      expect(names).not.toContain(AUDIT_SOURCE.file);
      expect(result.manifest.filters.includeAudit).toBe(false);
      expect(result.manifest.memberId).toBeUndefined();
      // And it is still a complete group export: every group source, with its seeded record.
      expect(names.toSorted()).toEqual(
        [GROUP_PROFILE_FILE, ...GROUP_SOURCES.map((source) => source.file)].toSorted(),
      );
      for (const record of recordsIn(result.dir, 'members.jsonl')) parseRecord(record, 'members');
    });
  });
});

/** Every entry of the archive, by name. */
async function entriesOf(result: ExportResult): Promise<ReadonlyMap<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const extract = tarExtract();
  const reads: Promise<void>[] = [];
  extract.on('entry', (header, source, next) => {
    // `buffer(source)` rather than a `data` listener: the entry is a stream, and `next()` must not
    // be called before it is drained or `tar-stream` reads the following header into this entry.
    reads.push(
      buffer(source).then((bytes) => {
        out.set(header.name, Buffer.from(bytes));
        next();
      }),
    );
  });
  await pipeline(createReadStream(result.archive), createGunzip(), extract);
  await Promise.all(reads);
  return out;
}
