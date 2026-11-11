/**
 * The reader behind every export file (`02` §3.15).
 *
 * `member-scope.prop.int.test.ts` proves what the export *contains*. This file is about the three
 * ways the reader itself can be wrong, each of which was reached by a mutation or by a bug that
 * actually happened during `M1-T28`:
 *
 *  - **a source whose scope column does not exist**, which without the guard hands drizzle an
 *    `undefined` column and produces a query with no predicate at all — an export of every row in
 *    the database, for a format whose whole purpose is to contain only what one audience may read;
 *  - **a source marked `labeled` whose table has no `label_id`**, which is the mistake
 *    `plan_steps` was declared with for one run, and whose failure without the guard depends on
 *    the data: a silently empty file when the eligible set is empty, a syntax error from inside
 *    drizzle when it is not;
 *  - **a `me/` source read with no subject**, where "no person given" must mean *nothing* rather
 *    than *everyone*.
 *
 * Plus the two things the loop around the reader does, which no other test reaches:
 *
 *  - **the chunk boundary.** `writeSource` reads 1,000 rows at a time and resumes from the last
 *    row's key, and a one-off there either drops a record or writes it twice. Both are silent — the
 *    archive is well-formed either way — so the only way to see it is to export more rows than fit
 *    in one chunk and count.
 *  - **`03`'s `ExportPolicy` hook.** It has no caller before `03`, which is exactly why it is
 *    tested here: a hook nobody exercises is a hook that is wrong when its first caller arrives.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Audience,
  computeEligible,
  type EligibleLabelSet,
  expectWritten,
  type GroupSnapshot,
  StubInformationFlow,
} from '@comvivo/core';
import { BRAND } from '@comvivo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ABSENT_GROUP,
  consentEventId,
  conversationId,
  fingerprintFor,
  groupLabel,
  identityId,
  memberId,
  memoryItem,
  messageId,
  person,
  personId,
  planId,
  planStepId,
  T0,
  type World,
  withRepos,
  withReposAsync,
} from '../repos/testing/harness.js';
import {
  EXPORT_RECORD_VERSION,
  type ExportPolicy,
  exportGroup,
  exportMember,
  serialiseRecord,
} from './export.js';
import {
  EXPORT_CHUNK_ROWS,
  type ExportSource,
  GROUP_PROFILE_FILE,
  GROUP_SOURCES,
  ME_SOURCES,
  readChunk,
  readGroupProfile,
} from './sources.js';

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), `${BRAND.slug}-src-`));
  temporaries.push(path);
  return path;
}

/** The real source for `file`, by name — so a renamed file fails here rather than silently. */
function sourceFor(sources: readonly ExportSource[], file: string): ExportSource {
  const found = sources.find((source) => source.file === file);
  if (found === undefined) throw new Error(`no export source writes ${file}`);
  return found;
}

const MEMBER_TAG = 'srca';

function snapshotOf(world: World): GroupSnapshot {
  return { groupId: world.groupId, membershipEpoch: 1, memberIds: [memberId(MEMBER_TAG)] };
}

/** One member, one person, one consent event — the rows the `me/` section is made of. */
function seedSubject(world: World): void {
  world.store.write((uow) => {
    expectWritten(world.repos.persons.create(uow, person(MEMBER_TAG)), 'the person');
    expectWritten(
      world.repos.members.add(uow, {
        id: memberId(MEMBER_TAG),
        groupId: world.groupId,
        personId: personId(MEMBER_TAG),
        role: 'member',
        status: 'active',
        joinedAt: T0,
      }),
      'the member',
    );
    expectWritten(
      world.repos.identities.create(uow, {
        id: identityId(MEMBER_TAG),
        channel: 'simulator',
        platformUserId: `u-${MEMBER_TAG}`,
        personId: personId(MEMBER_TAG),
        displayNameSnapshot: 'Ana',
      }),
      'the channel identity',
    );
    expectWritten(
      world.repos.governance.recordConsent(uow, {
        id: consentEventId('srcc'),
        memberId: memberId(MEMBER_TAG),
        groupId: world.groupId,
        fromState: 'unknown',
        toState: 'informed',
        via: 'chat',
        at: T0,
      }),
      'the consent event',
    );
  });
}

/**
 * A plan with one step, under a group-readable label.
 *
 * Interning the label is half the point — it makes `eligibleFor` non-empty — and the step itself is
 * the other half: it is a row a mis-declared `plan_steps` source would read out unfiltered.
 */
function seedPlanStep(world: World): void {
  world.store.write((uow) => {
    const label = groupLabel(world.groupId);
    const plan = expectWritten(
      world.repos.plans.create(
        uow,
        { id: planId('srpf'), groupId: world.groupId, title: 'a plan' },
        label,
      ),
      'the plan',
    );
    expectWritten(
      world.repos.plans.addStep(
        uow,
        { id: planStepId('srsf'), planId: plan.id, groupId: world.groupId, title: 'a step' },
        label,
      ),
      'the step',
    );
  });
}

/**
 * `count` messages and one memory in one conversation, all under one group-readable label.
 *
 * Returns the message ids in insert order, which is `rid` order, which is the order an export
 * writes them in — so a caller can compare the file against the list.
 */
function seedMessages(world: World, count: number): readonly string[] {
  const convId = conversationId('srcv');
  const label = groupLabel(world.groupId);
  const ids: string[] = [];
  world.store.write((uow) => {
    expectWritten(
      world.repos.conversations.create(uow, {
        id: convId,
        groupId: world.groupId,
        channel: 'simulator',
        platformChatId: 'chat-chunk',
        kind: 'group',
        boundAt: T0,
      }),
      'the conversation',
    );
    for (let index = 0; index < count; index += 1) {
      const id = messageId(tagFor(index));
      ids.push(id);
      expectWritten(
        world.repos.messages.insert(
          uow,
          {
            id,
            groupId: world.groupId,
            conversationId: convId,
            kind: 'member',
            text: `message ${String(index)}`,
            sentAt: T0,
            receivedAt: T0,
          },
          label,
        ),
        `message ${String(index)}`,
      );
    }
    expectWritten(
      world.repos.memories.insert(
        uow,
        memoryItem('srmf', world.groupId, { statement: 'a remembered fact' }),
        label,
        fingerprintFor('srmf'),
      ),
      'the memory',
    );
  });
  return ids;
}

/** Every export option but the scope, for a group that exists. */
function optionsFor(world: World) {
  return {
    db: world.drizzle,
    dataDir: tempDir(),
    groupId: world.groupId,
    labels: world.repos.labels.groupLabels(world.groupId),
    snapshot: snapshotOf(world),
    flow: StubInformationFlow,
    appVersion: '0.1.0',
    generatedAt: T0,
  };
}

/** The lines of one JSONL file, parsed. */
function linesOf(dir: string, file: string): readonly Record<string, unknown>[] {
  return readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The group audience's eligible set, computed the way the export computes it. */
function eligibleFor(world: World): EligibleLabelSet {
  const audience: Audience = { kind: 'group', groupId: world.groupId };
  return computeEligible(
    world.repos.labels.groupLabels(world.groupId),
    audience,
    snapshotOf(world),
    StubInformationFlow,
  );
}

describe('a me/ source read with no subject (02 §3.15)', () => {
  it('matches nothing rather than everything', () => {
    withRepos((world) => {
      seedSubject(world);
      const eligible = eligibleFor(world);
      const scope = { groupId: world.groupId, eligible };
      const identitySource = sourceFor(ME_SOURCES, 'me/identities.jsonl');
      const consentSource = sourceFor(ME_SOURCES, 'me/consent_events.jsonl');

      // `me/` is filtered by person or member, and the fallback for "no subject" is an id no row
      // can carry. The alternative — leaving the value `undefined` — is the failure this is about:
      // drizzle would compare against `NULL`, which matches nothing *today*, but the predicate
      // would no longer be about the subject at all, and a group export of a `me/` source would
      // be one refactor away from emitting every person in the database.
      expect(readChunk(world.drizzle, identitySource, scope, undefined, 10)).toEqual([]);
      expect(readChunk(world.drizzle, consentSource, scope, undefined, 10)).toEqual([]);

      // Non-vacuity: the rows exist, and naming the subject finds exactly them.
      const mine = { ...scope, personId: personId(MEMBER_TAG), memberId: memberId(MEMBER_TAG) };
      expect(readChunk(world.drizzle, identitySource, mine, undefined, 10)).toHaveLength(1);
      expect(readChunk(world.drizzle, consentSource, mine, undefined, 10)).toHaveLength(1);
    });
  });
});

describe('a misconfigured source (02 §3.15)', () => {
  it('refuses a me/ source that forgot its scope column', () => {
    withRepos((world) => {
      seedSubject(world);
      // The real person source minus `scopeColumn`, which is the mistake the guard exists for:
      // `persons` has no `group_id`, so the fallback column resolves to `undefined`. Measured with
      // the guard replaced by `if (false)`: drizzle emits `WHERE = ?` and SQLite answers
      // `near "=": syntax error`, from inside the query builder, naming neither the source nor the
      // column it was looking for. This pins the message that names both.
      const { subjectScope: _dropped, ...unscoped } = sourceFor(ME_SOURCES, 'me/identities.jsonl');
      expect(() =>
        readChunk(
          world.drizzle,
          unscoped,
          { groupId: world.groupId, eligible: eligibleFor(world) },
          undefined,
          10,
        ),
      ).toThrow(/names a column its table does not have \(groupId, id\)/);
    });
  });

  it('refuses a source pointed at a column of another table', () => {
    withRepos((world) => {
      seedSubject(world);
      const source: ExportSource = {
        ...sourceFor(ME_SOURCES, 'me/identities.jsonl'),
        subjectScope: { column: 'memberId', subject: 'member' },
      };
      // Named in the message, because "a column its table does not have" is only actionable if it
      // says which column it looked for.
      expect(() =>
        readChunk(
          world.drizzle,
          source,
          { groupId: world.groupId, eligible: eligibleFor(world) },
          undefined,
          10,
        ),
      ).toThrow(/\(memberId, id\)/);
    });
  });

  it('refuses a labeled source whose table has no label, empty eligible set or not', () => {
    withRepos((world) => {
      const honest = sourceFor(GROUP_SOURCES, 'plan_steps.jsonl');
      const source: ExportSource = { ...honest, labeled: true };
      // Nothing is interned yet, so this set is empty — and the empty set is the shape that makes
      // the ordering of the guard matter.
      const empty = eligibleFor(world);
      expect(empty.ids).toEqual([]);
      seedPlanStep(world);
      const eligible = eligibleFor(world);
      expect(eligible.ids.length).toBeGreaterThan(0);

      // This is `plan_steps` as the first version of `sources.ts` declared it. The guard turns a
      // failure that depends on the data into one that depends only on the declaration — measured
      // with the guard deleted:
      //
      //  - **empty eligible set** — `0 rows`, no error: the `1 = 0` branch is taken and `inArray`
      //    is never reached, so the file is written empty and the export quietly omits the table.
      //  - **non-empty** — `near "in": syntax error`, from inside drizzle, naming neither the
      //    source nor the column.
      //
      // Both shapes are asserted because the first is what a suite with no interned labels sees: a
      // mis-declared source passes it and then fails on the first export that has a label.
      for (const set of [empty, eligible]) {
        expect(() =>
          readChunk(
            world.drizzle,
            source,
            { groupId: world.groupId, eligible: set },
            undefined,
            10,
          ),
        ).toThrow(/plan_step is marked labeled and has no labelId column/);
      }

      // Non-vacuity: the step exists, and the source as declared reads it.
      expect(
        readChunk(world.drizzle, honest, { groupId: world.groupId, eligible }, undefined, 10),
      ).toHaveLength(1);
    });
  });
});

describe('a group that does not exist', () => {
  it('has no profile, and exports an archive rather than failing', async () => {
    expect(withRepos((world) => readGroupProfile(world.drizzle, ABSENT_GROUP))).toBeUndefined();

    await withReposAsync(async (world) => {
      // `group.json` is the one file an export writes conditionally, so an absent group is the
      // case that proves the condition: the archive is still well-formed, and the manifest does
      // not promise a file that is not there.
      const result = await exportGroup({
        db: world.drizzle,
        dataDir: tempDir(),
        groupId: ABSENT_GROUP,
        labels: world.repos.labels.groupLabels(ABSENT_GROUP),
        snapshot: { groupId: ABSENT_GROUP, membershipEpoch: 1, memberIds: [] },
        flow: StubInformationFlow,
        appVersion: '0.1.0',
        generatedAt: T0,
      });
      expect(result.manifest.files.some((file) => file.name === GROUP_PROFILE_FILE)).toBe(false);
      expect(result.manifest.files.every((file) => file.records === 0)).toBe(true);
      expect(readFileSync(join(result.dir, 'manifest.json'), 'utf8')).toContain('"scope": "group"');
    });
  });
});

describe('a member export for someone this instance does not have', () => {
  it('is refused before anything is written', async () => {
    await withReposAsync(async (world) => {
      seedSubject(world);
      const absent = personId('srcx');
      // Refused rather than empty: the caller supplied the id, so "no such person" is a wrong
      // request and not a member with nothing. The archive that would otherwise be produced is an
      // export of nobody, with a `me/` section quietly missing its first file.
      await expect(
        exportMember({
          ...optionsFor(world),
          memberId: memberId(MEMBER_TAG),
          personId: absent,
        }),
      ).rejects.toThrow(/is not a person in this instance/);
      // And nothing was written: `02` §3.15's `export.cleanup` would otherwise find a half-built
      // directory a week later and have no way to tell it from a finished one.
      expect(readGroupProfile(world.drizzle, world.groupId)).toBeDefined();
      expect(existsSync(join(optionsFor(world).dataDir, 'exports'))).toBe(false);
    });
  });
});

/** Crockford base32, so 1,001 generated fixture tags are all ids the writes accept. */
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
function tagFor(index: number): string {
  let rest = index;
  let digits = '';
  do {
    digits = (CROCKFORD[rest % 32] ?? '0') + digits;
    rest = Math.trunc(rest / 32);
  } while (rest > 0);
  // Trailing 'f' because a tag may not end in '0' — `suffix` right-pads with zeros.
  return `srm${digits}f`;
}

describe('the chunk boundary (02 §3.15: "chunks of 1,000")', () => {
  it('writes every row once across more than one chunk', async () => {
    await withReposAsync(async (world) => {
      const rows = EXPORT_CHUNK_ROWS + 1;
      const ids = seedMessages(world, rows);
      const result = await exportGroup(optionsFor(world));
      const written = linesOf(result.dir, 'messages.jsonl').map((record) => record['id']);

      // Exactly once each, in `rid` order — which is insert order. A resume that re-read its own
      // last row would write 1,002 lines with one duplicate; a resume that skipped past it would
      // write 1,000 and lose the 1,001st. Both are caught by the same assertion, and both were
      // run as mutations against it.
      expect(written).toEqual(ids);
      expect(new Set(written).size).toBe(rows);
      const entry = result.manifest.files.find((file) => file.name === 'messages.jsonl');
      expect(entry?.records).toBe(rows);
    });
  });
});

describe("03's ExportPolicy hook (02 §3.15)", () => {
  it('excludes a source, redacts another, and counts what it wrote', async () => {
    await withReposAsync(async (world) => {
      seedSubject(world);
      seedMessages(world, 2);

      // Three verdicts in one export, because the three are not variations of each other:
      // `exclude` removes the record, `redact` keeps its identity and drops its content, and
      // `include` is what every other source gets.
      const policy: ExportPolicy = ({ type }) => {
        if (type === 'memory') return 'exclude';
        return type === 'message' || type === 'member' ? 'redact' : 'include';
      };
      const filtered = await exportGroup({ ...optionsFor(world), policy });
      const plain = await exportGroup(optionsFor(world));

      // **Excluded.** The file is still written, empty, and the manifest says so: `02` §3.15's
      // reader has to be able to tell "you have none" from "this version does not export that",
      // and an absent file cannot say either.
      expect(linesOf(filtered.dir, 'memories.jsonl')).toEqual([]);
      expect(filtered.manifest.files.find((file) => file.name === 'memories.jsonl')?.records).toBe(
        0,
      );
      // Non-vacuity: the memory is there, and an export without the hook writes it.
      expect(linesOf(plain.dir, 'memories.jsonl')).toHaveLength(1);

      // **Redacted, with a label.** A message keeps what a reader needs to know that something
      // exists and who may read it — and nothing else. Asserted as the exact key set, because
      // "does not contain the text" is also true of a record that kept the author and the time.
      const messages = linesOf(filtered.dir, 'messages.jsonl');
      expect(messages).toHaveLength(2);
      for (const record of messages) {
        expect(Object.keys(record).toSorted()).toEqual(['$redacted', '$type', '$v', 'id', 'label']);
        expect(record['$redacted']).toBe(true);
      }
      expect(JSON.stringify(linesOf(plain.dir, 'messages.jsonl'))).toContain('message 0');

      // **Redacted, without one.** A membership carries no label, and the redacted record carries
      // no `label` key rather than a `null` one — the same rule `serialiseRecord` applies to an
      // absent optional.
      const members = linesOf(filtered.dir, 'members.jsonl');
      expect(members).toHaveLength(1);
      expect(Object.keys(members[0] ?? {}).toSorted()).toEqual(['$redacted', '$type', '$v', 'id']);
      expect(JSON.stringify(members)).not.toContain('null');
      expect(JSON.stringify(linesOf(plain.dir, 'members.jsonl'))).toContain('displayName');

      // And the digests differ, because the manifest is over the bytes as written.
      const digestOf = (result: {
        manifest: { files: readonly { name: string; sha256: string }[] };
      }) => result.manifest.files.find((file) => file.name === 'messages.jsonl')?.sha256;
      expect(digestOf(filtered)).not.toBe(digestOf(plain));
    });
  });
});

describe('serialiseRecord (02 §3.15)', () => {
  const unresolvable = () => undefined;

  it('keeps a label id it cannot resolve, as a diagnostic', () => {
    // The row's foreign key guarantees the label exists, so this is a bug upstream — and the
    // choice is between dropping the field (an export that claims the record has no audience) and
    // keeping the integer (an export that says "ask about label 7"). The second is the one that
    // can be investigated.
    expect(serialiseRecord('message', { id: 'msg_x', labelId: 7 }, unresolvable)).toEqual({
      $type: 'message',
      $v: EXPORT_RECORD_VERSION,
      id: 'msg_x',
      labelId: 7,
    });
  });

  it('names the shape of a record that is not an object', () => {
    // `typeof` calls `null` and an array both "object", so the three cases are distinguished by
    // hand. A line a reader cannot parse as an object is worth a precise message.
    expect(() => serialiseRecord('message', 'text', unresolvable)).toThrow(
      /produced a string rather than an object/,
    );
    expect(() => serialiseRecord('message', null, unresolvable)).toThrow(
      /produced null rather than an object/,
    );
    expect(() => serialiseRecord('message', [1, 2], unresolvable)).toThrow(
      /produced an array rather than an object/,
    );
  });
});
