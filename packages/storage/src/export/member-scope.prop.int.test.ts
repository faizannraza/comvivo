/**
 * `export.member-scope.property` (`M1-T28` AC; `02` §9.3, §3.15).
 *
 * `02` §9.3 states it in two halves, and both matter:
 *
 * > every exported record satisfies `canRead(label, {member})`, and every readable record is
 * > exported (**completeness**).
 *
 * The first half alone is satisfied by an export that emits nothing. The second alone is satisfied
 * by an export that emits everything. Together they pin the filter to exactly the eligible set,
 * and the property is checked over generated label shapes rather than over a fixture — because the
 * interesting cases are the ones nobody thinks to write: a label owned by one member and readable
 * by two, a members-set that happens to contain the whole group, a group-readable row in a DM.
 *
 * ## Why it runs against the stub flow, and why that is not a weakness
 *
 * `M1-T28`'s AC says "stub `canRead` until `M5-T2`, re-run there", and `14`'s `M5-T2` row says the
 * same properties run against the real lattice when it lands. The stub is containment — a datum is
 * eligible when its readers include everyone the requesting audience reaches — which is `I2` and is
 * the part that will not change. What `M5-T2` adds is `03`'s judgements *on top*, and a property
 * written against the stub is exactly the property that must still hold after them.
 *
 * The property is asserted against `canRead` itself rather than against a restatement of the rule,
 * so the test cannot drift from the function it is about.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Audience, expectWritten, type Label, StubInformationFlow } from '@comvivo/core';
import { BRAND } from '@comvivo/shared';
import { fcConfig } from '@comvivo/shared/testing';
import * as fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { afterEach, describe, expect, it } from 'vitest';
import {
  conversationId,
  fingerprintFor,
  groupLabel,
  memberId,
  memoryId,
  memoryItem,
  messageId,
  person,
  personId,
  T0,
  type World,
  withReposAsync,
} from '../repos/testing/harness.js';
import { exportGroup, exportMember } from './export.js';
import { AUDIT_SOURCE, GROUP_SOURCES, ME_SOURCES } from './sources.js';

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), `${BRAND.slug}-exp-`));
  temporaries.push(path);
  return path;
}

/** Three members, so a members-set label can be narrower than the group without being one person. */
const TAGS = ['exa', 'exb', 'exc'] as const;

interface Seeded {
  readonly members: readonly ReturnType<typeof memberId>[];
  readonly convId: ReturnType<typeof conversationId>;
}

function seedMembers(world: World): Seeded {
  const convId = conversationId('excv');
  const members = TAGS.map((tag) => memberId(tag));
  world.store.write((uow) => {
    for (const tag of TAGS) {
      expectWritten(world.repos.persons.create(uow, person(`${tag}p`)), 'the person');
      expectWritten(
        world.repos.members.add(uow, {
          id: memberId(tag),
          groupId: world.groupId,
          personId: personId(`${tag}p`),
          role: 'member',
          status: 'active',
          joinedAt: T0,
        }),
        'the member',
      );
    }
    expectWritten(
      world.repos.conversations.create(uow, {
        id: convId,
        groupId: world.groupId,
        channel: 'simulator',
        platformChatId: 'chat-export',
        kind: 'group',
        boundAt: T0,
      }),
      'the conversation',
    );
  });
  return { members, convId };
}

/** Seed one message and one memory under each generated label, and remember which label. */
function seedUnder(
  world: World,
  convId: ReturnType<typeof conversationId>,
  labels: readonly Label[],
): ReadonlyMap<string, Label> {
  const byId = new Map<string, Label>();
  world.store.write((uow) => {
    for (const [index, label] of labels.entries()) {
      const tag = `exm${index.toString(36)}f`;
      expectWritten(
        world.repos.messages.insert(
          uow,
          {
            id: messageId(tag),
            groupId: world.groupId,
            conversationId: convId,
            kind: 'member',
            text: `message ${String(index)}`,
            sentAt: T0,
            receivedAt: T0,
          },
          label,
        ),
        `message ${tag}`,
      );
      byId.set(messageId(tag), label);
      expectWritten(
        world.repos.memories.insert(
          uow,
          memoryItem(tag, world.groupId, { statement: `fact ${String(index)}` }),
          label,
          fingerprintFor(tag),
        ),
        `memory ${tag}`,
      );
      byId.set(memoryId(tag), label);
    }
  });
  return byId;
}

interface ExportedRecord {
  readonly $type: string;
  readonly id?: string;
  readonly label?: { readonly readers: { readonly kind: string } };
}

/** Every record the export wrote, across the two labeled files this property is about. */
function recordsIn(dir: string, files: readonly string[]): readonly ExportedRecord[] {
  const out: ExportedRecord[] = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      out.push(JSON.parse(line) as ExportedRecord);
    }
  }
  return out;
}

const SNAPSHOT = (world: World, members: readonly ReturnType<typeof memberId>[]) => ({
  groupId: world.groupId,
  membershipEpoch: 1,
  memberIds: [...members].toSorted(),
});

function optionsFor(world: World, members: readonly ReturnType<typeof memberId>[]) {
  return {
    db: world.drizzle,
    dataDir: tempDir(),
    groupId: world.groupId,
    labels: world.repos.labels.groupLabels(world.groupId),
    snapshot: SNAPSHOT(world, members),
    flow: StubInformationFlow,
    appVersion: '0.1.0',
    generatedAt: T0,
  };
}

const LABELED_FILES = ['messages.jsonl', 'memories.jsonl'];

/**
 * Files a member's own export may legitimately carry in full.
 *
 * Every other source must be label-filtered or carry a `memberOnly` predicate — asserted
 * structurally below, because that is the gap this suite had: it checked two of fifteen files, and
 * `conversations.jsonl` was exporting every other member's DM row the whole time. A list of what
 * is deliberately group-wide, with the reason, is the only honest way to make "every other file is
 * filtered" an assertion instead of a hope.
 */
const GROUP_WIDE_FILES: Readonly<Record<string, string>> = {
  'members.jsonl': 'the membership list, which every member can see in any channel',
  'constitution_versions.jsonl': 'the constitution is the group’s shared agreement (`03` §3.2)',
  'audit_events.jsonl': 'host-only, and only with `--include-audit`',
  'me/identities.jsonl': 'scoped to the exporting person by `subjectScope`',
  'me/consent_events.jsonl': 'scoped to the exporting member by `subjectScope`',
};

describe('export.member-scope.property (02 §9.3)', () => {
  it('filters every file in a member export, or says why it does not', () => {
    // Structural, and exhaustive over the sources rather than over the data: a source added
    // without a label and without a `memberOnly` predicate fails here on the day it is added,
    // which is what would have caught the `conversations.jsonl` leak at `M1-T28` instead of at the
    // milestone gate.
    // Every source a member export writes: the group ones, their own `me/` ones, and the audit
    // file when the host asks for it.
    const inMemberExport = [...GROUP_SOURCES, ...ME_SOURCES, AUDIT_SOURCE];
    const unprotected = inMemberExport
      .filter(
        (source) =>
          !source.labeled && source.memberOnly === undefined && source.subjectScope === undefined,
      )
      .map((source) => source.file)
      .filter((file) => !(file in GROUP_WIDE_FILES));
    expect(
      unprotected,
      'each of these needs a label, a `memberOnly`, or an entry with a reason',
    ).toEqual([]);
    // And the allowlist does not name files that no longer exist, which is how such a list rots.
    const exported = new Set(inMemberExport.map((source) => source.file));
    expect(Object.keys(GROUP_WIDE_FILES).filter((file) => !exported.has(file))).toEqual([]);
  });

  it('exports exactly the records the member may read', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: 5 }), { minLength: 1, maxLength: 6 }),
        async (shape) => {
          await runCase(shape);
        },
      ),
      // Few runs, because each one builds a migrated database and writes an archive. The shapes
      // that matter are enumerated rather than hoped for: `runCase` always includes a
      // group-readable label and a single-member one, and the generator varies the rest.
      { ...fcConfig(), numRuns: 12 },
    );
  });
});

async function runCase(shape: readonly number[]): Promise<void> {
  await withReposAsync(async (world) => {
    const { members, convId } = seedMembers(world);
    const [first, second] = members;
    if (first === undefined || second === undefined) {
      throw new Error('unreachable: three members are seeded');
    }

    // Three labels are always present, plus whatever the generator asked for. The third is the one
    // that makes the property mean anything, and the first version of this test left it out:
    //
    //  - **group-readable** — the member sees it;
    //  - **readable by the member alone** — the member sees it;
    //  - **readable by somebody *else* alone** — the member must **not** see it.
    //
    // Under containment a narrower audience is eligible for *more*, not less: a single member is
    // admitted by every label that includes them. So a generator producing only labels containing
    // the exporting member withholds nothing, every record is exported, and the soundness half of
    // the property is satisfied by an export that does no filtering at all. The non-vacuity
    // assertion below is what caught that.
    const labels: Label[] = [
      groupLabel(world.groupId),
      groupLabel(world.groupId, {
        owner: first,
        readers: { kind: 'members', groupId: world.groupId, memberIds: [first] },
        sensitivity: 'personal',
      }),
      groupLabel(world.groupId, {
        owner: second,
        readers: { kind: 'members', groupId: world.groupId, memberIds: [second] },
        sensitivity: 'personal',
      }),
      ...shape.map((n) => {
        // Rotated, so the generated labels sometimes exclude `first` and sometimes include them.
        const start = n % members.length;
        const chosen = [...members.slice(start), ...members.slice(0, start)].slice(
          0,
          (n % members.length) + 1,
        );
        return groupLabel(world.groupId, {
          readers: { kind: 'members', groupId: world.groupId, memberIds: [...chosen].toSorted() },
          ...(n % 2 === 0 ? { owner: first } : {}),
        });
      }),
    ];
    const byId = seedUnder(world, convId, labels);

    const audience: Audience = {
      kind: 'members',
      groupId: world.groupId,
      memberIds: [first],
    };
    const options = optionsFor(world, members);
    const result = await exportMember({ ...options, memberId: first, personId: personId('exap') });

    const exported = recordsIn(result.dir, LABELED_FILES);
    const snapshot = SNAPSHOT(world, members);

    // **Soundness.** Every record the export wrote is one `canRead` admits — asserted against the
    // function itself, so the test cannot drift from the rule it is about.
    for (const record of exported) {
      const label = byId.get(record.id ?? '');
      expect(label, `${record.$type} ${record.id ?? '?'} is a seeded record`).toBeDefined();
      if (label === undefined) continue;
      expect(
        StubInformationFlow.canRead(label, audience, snapshot),
        `${record.$type} ${record.id ?? '?'} was exported`,
      ).toBe(true);
    }

    // **Completeness.** Every record `canRead` admits was written. This is the half an export that
    // emitted nothing would pass, and the half that makes the first one mean something.
    const exportedIds = new Set(exported.map((record) => record.id));
    for (const [id, label] of byId) {
      if (!StubInformationFlow.canRead(label, audience, snapshot)) continue;
      expect(exportedIds.has(id), `${id} is readable and was exported`).toBe(true);
    }

    // Non-vacuity: the run saw both a record it exported and a record it withheld. Without this a
    // generator that produced only group-readable labels would make the property trivially true.
    const withheld = [...byId].filter(
      ([, label]) => !StubInformationFlow.canRead(label, audience, snapshot),
    );
    expect(exported.length).toBeGreaterThan(0);
    expect(withheld.length).toBeGreaterThan(0);

    // And the manifest states the audience it filtered for, which is the export's own account of
    // why it contains what it does.
    expect(result.manifest.audience).toEqual(audience);
    expect(result.manifest.scope).toBe('member');
  });
}

describe('an empty eligible set (M1-T21’s recurring hole)', () => {
  it('exports nothing, and does so because of the filter', async () => {
    await withReposAsync(async (world) => {
      const { members, convId } = seedMembers(world);
      const [first, second, third] = members;
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error('unreachable: three members are seeded');
      }
      // Every label excludes the third member, and none is group-readable — so the eligible set
      // computed for them is **empty**.
      seedUnder(world, convId, [
        groupLabel(world.groupId, {
          owner: first,
          readers: { kind: 'members', groupId: world.groupId, memberIds: [first] },
        }),
        groupLabel(world.groupId, {
          owner: second,
          readers: { kind: 'members', groupId: world.groupId, memberIds: [first, second] },
        }),
      ]);

      const result = await exportMember({
        ...optionsFor(world, members),
        memberId: third,
        personId: personId('excp'),
      });

      // This is the case `M1-T21` found three labeled reads getting wrong, and a mutation found
      // this one getting wrong too: an empty set has to become a predicate that matches **nothing**
      // (`1 = 0`), because SQLite rejects `IN ()` and because the obvious alternatives — skip the
      // filter, or return early — both produce an export containing every row. Replacing the
      // predicate with `1 = 1` passed every other test in this file.
      expect(result.eligible.ids).toEqual([]);
      expect(recordsIn(result.dir, LABELED_FILES)).toEqual([]);
      // Non-vacuity: the rows exist and are readable by somebody, so "nothing exported" is the
      // filter's doing and not an empty database.
      const forFirst = await exportMember({
        ...optionsFor(world, members),
        memberId: first,
        personId: personId('exap'),
      });
      expect(recordsIn(forFirst.dir, LABELED_FILES).length).toBeGreaterThan(0);
    });
  });
});

describe('a group export cannot carry one member’s private data (01 §9)', () => {
  it('omits a members-set label from the group scope', async () => {
    await withReposAsync(async (world) => {
      const { members, convId } = seedMembers(world);
      const first = members[0];
      if (first === undefined) throw new Error('unreachable');
      const privateLabel = groupLabel(world.groupId, {
        owner: first,
        readers: { kind: 'members', groupId: world.groupId, memberIds: [first] },
        sensitivity: 'personal',
      });
      const byId = seedUnder(world, convId, [groupLabel(world.groupId), privateLabel]);

      const result = await exportGroup(optionsFor(world, members));
      const exported = recordsIn(result.dir, LABELED_FILES);
      const exportedIds = new Set(exported.map((record) => record.id));

      // This is `01` §9 as a test: an admin running a group export does not get it. Not because
      // the export politely omits it — because the eligible set computed for the group audience
      // does not contain the label.
      for (const [id, label] of byId) {
        const expected = label.readers.kind === 'group';
        expect(exportedIds.has(id), `${id} (${label.readers.kind})`).toBe(expected);
      }
      expect(exported.length).toBeGreaterThan(0);
      // And the group export has no `me/` section at all.
      expect(result.manifest.files.some((file) => file.name.startsWith('me/'))).toBe(false);
      expect(result.manifest.memberId).toBeUndefined();
    });
  });

  it('writes a label every record can be read by, rendered rather than numbered', async () => {
    await withReposAsync(async (world) => {
      const { members, convId } = seedMembers(world);
      seedUnder(world, convId, [groupLabel(world.groupId)]);
      const result = await exportGroup(optionsFor(world, members));
      const exported = recordsIn(result.dir, LABELED_FILES);
      expect(exported.length).toBeGreaterThan(0);
      for (const record of exported) {
        // `02` §3.15: labels are rendered. A `label_id` integer means nothing outside this
        // database, so a record carrying one would be unreadable by the format's own consumers.
        expect(record.label?.readers.kind).toBe('group');
        expect(JSON.stringify(record)).not.toContain('"labelId"');
        expect(record.$type).toBeTypeOf('string');
      }
      // And instants are ISO strings rather than epoch milliseconds.
      const line = JSON.parse(
        readFileSync(join(result.dir, 'messages.jsonl'), 'utf8').split('\n')[0] ?? '{}',
      ) as { sentAt?: string };
      expect(line.sentAt).toBe(T0.toString());
      expect(Temporal.Instant.from(line.sentAt ?? '')).toBeDefined();
    });
  });
});
