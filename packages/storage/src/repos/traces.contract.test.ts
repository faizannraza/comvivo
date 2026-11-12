/**
 * `TraceReader`/`TraceRepository` (`M1-T21`; `02` §3.3.7, `05` §3.10).
 *
 * Two behaviours carry the weight here, and both are product decisions rather than plumbing:
 *
 *  - **A trace too big to store is truncated, not refused.** `05` §3.10 makes the trace an
 *    observability artefact, so failing a turn because its own trace overflowed would lose the
 *    answer *and* the explanation. The write says what it dropped, because a caller that silently
 *    lost half its tool calls would have no way to know its observability was incomplete.
 *  - **The rendered prompt is in a different table.** `turn_traces` is label-filtered and readable
 *    by a member; `turn_trace_debug` exists only under `COMVIVO_DEBUG_CONTENT=1`, is
 *    field-encrypted and host-only. The separation is the control — a trace can be shown because
 *    the prompt is not in it.
 */
import type { NotPromise } from '@comvivo/core';
import { expectWritten, TRACE_TOTAL_BUDGET_BYTES } from '@comvivo/core';
import { internedId, type ReaderSetId } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  eligibleAll,
  eligibleExcluding,
  eligibleNone,
  groupLabel,
  member,
  person,
  T0,
  traceId,
  turnId,
  withRepos,
} from './testing/harness.js';

const DAY = 86_400_000;
const at = (days: number) =>
  Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + days * DAY);

/** An eligible set over every label in the database. */

function withTraces<T>(
  fn: (
    world: Parameters<Parameters<typeof withRepos>[0]>[0],
    ids: { conversation: ReturnType<typeof conversationId>; readerSet: ReaderSetId },
  ) => NotPromise<T>,
): T {
  return withRepos((world) => {
    const ids = world.store.write((uow) => {
      expectWritten(world.repos.persons.create(uow, person('a')), 'a person');
      expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'a member');
      const conversation = expectWritten(
        world.repos.conversations.create(uow, {
          id: conversationId('a'),
          groupId: world.groupId,
          channel: 'simulator',
          platformChatId: 'chat-a',
          kind: 'group',
          boundAt: T0,
        }),
        'a conversation',
      ).id;
      world.repos.labels.intern(uow, groupLabel(world.groupId));
      const readerSet = internedId(
        (world.db.prepare('SELECT id FROM reader_sets ORDER BY id LIMIT 1').get() as { id: number })
          .id,
        'reader_sets',
      );
      return { conversation, readerSet };
    });
    return fn(world, ids);
  });
}

type World = Parameters<Parameters<typeof withTraces>[0]>[0];
type Ids = Parameters<Parameters<typeof withTraces>[0]>[1];

/** A turn to hang the trace on: `turn_traces.turn_id` is a foreign key and unique. */
function aTurn(world: World, ids: Ids, tag: string) {
  return world.store.write((uow) =>
    expectWritten(
      world.repos.journal.start(uow, {
        id: turnId(tag),
        groupId: world.groupId,
        conversationId: ids.conversation,
        kind: 'respond',
        triggerMessageIds: [],
        audienceReaderSetId: ids.readerSet,
        bootId: 'boot-01',
        startedAt: T0,
        deadlineAt: at(1),
      }),
      'a turn',
    ),
  ).id;
}

const trace = (tag: string, world: World, ids: Ids, overrides = {}) => ({
  id: traceId(tag),
  turnId: turnId(tag),
  groupId: world.groupId,
  conversationId: ids.conversation,
  trigger: { kind: 'mention' },
  disposition: 'replied',
  contextManifest: {
    messageIds: [],
    memoryIds: [],
    labelIds: [1],
    entityRefs: [],
    tokenEstimate: 1200,
    contextHash: 'c0ffee',
  },
  modelCalls: [{ requestHash: 'a' }],
  toolCalls: [{ name: 'calendar.create' }],
  policyDecisions: [{ outcome: 'allow' }],
  guardResults: [{ pass: true }],
  latency: {
    totalMs: 900,
    buildContextMs: 100,
    modelMs: 600,
    toolsMs: 150,
    guardMs: 30,
    commitMs: 20,
  },
  replay: {
    contextHash: 'c0ffee',
    promptVersion: 'p1',
    toolCatalogHash: 't1',
    constitutionVersionId: null,
    codeVersion: 'v1',
    otelTraceId: null,
  },
  expiresAt: at(7),
  ...overrides,
});

describe('writing and reading a trace', () => {
  it('stores one trace per turn and finds it through the label', () => {
    withTraces((world, ids) => {
      aTurn(world, ids, 'a1f');
      const written = world.store.write((uow) =>
        expectWritten(
          world.repos.traces.writeTrace(uow, trace('a1f', world, ids), groupLabel(world.groupId)),
          'a trace',
        ),
      );
      expect(written.truncation.truncated).toBe(false);
      expect(written.trace.costMicros).toBe(0);
      expect(written.trace.contextManifest.tokenEstimate).toBe(1200);
      expect(world.repos.traces.trace(world.groupId, turnId('a1f'), eligibleAll(world))?.id).toBe(
        traceId('a1f'),
      );
      // A trace is a datum like any other: an audience that cannot read its label cannot read it.
      // Both forms, and the second is the one that matters: an **empty** eligible set is refused by
      // an early return, so it proves nothing about the `label_id IN (…)` predicate. A set that is
      // non-empty and simply does not contain this label is what reaches it.
      expect(
        world.repos.traces.trace(world.groupId, turnId('a1f'), eligibleNone(world)),
      ).toBeUndefined();
      // A second **real** label, so the excluding set below is one `computeEligible` can produce.
      // The forged helper this replaced fell back to the id `999_999` when the group had nothing
      // else — which is the path this test was taking, so its "non-empty eligible set" was an id
      // that exists in no database. Found by the M1 exit gate's reviewer, confirmed by the harness
      // helper refusing to invent one.
      world.store.write((uow) =>
        world.repos.labels.intern(uow, groupLabel(world.groupId, { sensitivity: 'personal' })),
      );
      const excluding = eligibleExcluding(world, written.trace.labelId);
      expect(world.repos.traces.trace(world.groupId, turnId('a1f'), excluding)).toBeUndefined();
      expect(
        world.repos.traces.recentTraces({
          groupId: world.groupId,
          limit: 10,
          eligible: eligibleNone(world),
        }),
      ).toEqual([]);
      expect(
        world.repos.traces.recentTraces({
          groupId: world.groupId,
          limit: 10,
          eligible: excluding,
        }),
      ).toEqual([]);
      // And it is not another group's to read.
      expect(
        world.repos.traces.trace(world.otherGroupId, turnId('a1f'), eligibleAll(world)),
      ).toBeUndefined();
    });
  });

  it('lists a group`s traces newest first (Q-DASH-2)', () => {
    withTraces((world, ids) => {
      const label = groupLabel(world.groupId);
      for (const tag of ['b1f', 'b2f', 'b3f']) aTurn(world, ids, tag);
      world.store.write((uow) => {
        for (const [tag, day] of [
          ['b1f', 0],
          ['b2f', 2],
          ['b3f', 1],
        ] as const) {
          // `createdAt` comes from the transaction clock, so three traces written in one
          // transaction share it — which is why each gets its own, with a distinct `expiresAt` to
          // order by instead. Written separately so the clock advances.
          world.repos.traces.writeTrace(
            uow,
            trace(tag, world, ids, { expiresAt: at(day + 7) }),
            label,
          );
        }
      });
      const listed = world.repos.traces.recentTraces({
        groupId: world.groupId,
        limit: 10,
        eligible: eligibleAll(world),
      });
      expect(listed).toHaveLength(3);
      // Same `created_at` for all three (one transaction), so the tiebreak on `id` is what gives a
      // stable order — without it the list would shuffle between reads and the dashboard's
      // pagination would skip rows.
      expect(listed.map((row) => row.id)).toEqual([traceId('b3f'), traceId('b2f'), traceId('b1f')]);
    });
  });

  it('answers `duplicate` for a second trace of the same turn', () => {
    withTraces((world, ids) => {
      const label = groupLabel(world.groupId);
      aTurn(world, ids, 'c1f');
      world.store.write((uow) =>
        expectWritten(
          world.repos.traces.writeTrace(uow, trace('c1f', world, ids), label),
          'a trace',
        ),
      );
      const second = world.store.write((uow) =>
        world.repos.traces.writeTrace(
          uow,
          { ...trace('c1f', world, ids), id: traceId('c2f') },
          label,
        ),
      );
      // `turn_traces.turn_id` is unique: one trace per turn. A second write is a retry, and the
      // existing row is the one `11`'s replay will read — so the caller needs *its* id.
      expect(second.kind).toBe('duplicate');
      if (second.kind !== 'duplicate') return;
      expect(second.existingId).toBe(traceId('c1f'));
    });
  });

  it('refuses a label from another group', () => {
    withTraces((world, ids) => {
      aTurn(world, ids, 'd1f');
      expect(() =>
        world.store.write((uow) =>
          world.repos.traces.writeTrace(
            uow,
            trace('d1f', world, ids),
            groupLabel(world.otherGroupId),
          ),
        ),
      ).toThrow(/another group/);
    });
  });
});

describe('the combined 512 KiB budget (02 §3.3.9)', () => {
  /**
   * A tool call big enough that the column's own 100-entry limit still overflows the budget.
   *
   * 6 KiB each, because `turn_traces.tool_calls` is `z.array(…).max(100)` — so the only way to get
   * over 512 KiB within the column's own bound is for the entries to be large. A trace with 100
   * tool calls is not far-fetched: `05`'s loop can make dozens, and a tool result echoed into the
   * trace carries whatever the tool was asked about.
   */
  const fatCall = (index: number) => ({
    name: `tool.${String(index)}`,
    padding: 'x'.repeat(6_000),
  });

  it('truncates the longest list and says what it dropped', () => {
    withTraces((world, ids) => {
      aTurn(world, ids, 'e1f');
      const toolCalls = Array.from({ length: 100 }, (_unused, index) => fatCall(index));
      const written = world.store.write((uow) =>
        expectWritten(
          world.repos.traces.writeTrace(
            uow,
            trace('e1f', world, ids, { toolCalls }),
            groupLabel(world.groupId),
          ),
          'a fat trace',
        ),
      );
      // Over the budget before, under it after, and the row exists — which is the point: `05`
      // §3.10 makes the trace an observability artefact, so a turn that *failed* because its own
      // trace was too big would be the worst available trade.
      expect(written.truncation.truncated).toBe(true);
      expect(written.truncation.dropped).toEqual(['tool_calls']);
      expect(written.truncation.bytesBefore).toBeGreaterThan(TRACE_TOTAL_BUDGET_BYTES);
      expect(written.truncation.bytesAfter).toBeLessThanOrEqual(TRACE_TOTAL_BUDGET_BYTES);
      // The **start** of the list is kept, because that is what `11`'s replay reads.
      const stored = world.repos.traces.trace(world.groupId, turnId('e1f'), eligibleAll(world));
      expect(stored?.toolCalls.length).toBeGreaterThan(0);
      expect(stored?.toolCalls.length).toBeLessThan(100);
      expect((stored?.toolCalls[0] as { name: string } | undefined)?.name).toBe('tool.0');
      // And the lists that fit are untouched, so truncation is not a blanket haircut.
      expect(stored?.modelCalls).toHaveLength(1);
      expect(stored?.guardResults).toHaveLength(1);
    });
  });

  it('leaves a trace that fits entirely alone', () => {
    withTraces((world, ids) => {
      aTurn(world, ids, 'f1f');
      const written = world.store.write((uow) =>
        expectWritten(
          world.repos.traces.writeTrace(
            uow,
            trace('f1f', world, ids, {
              toolCalls: Array.from({ length: 20 }, (_unused, index) => fatCall(index)),
            }),
            groupLabel(world.groupId),
          ),
          'a trace',
        ),
      );
      expect(written.truncation.truncated).toBe(false);
      expect(written.truncation.dropped).toEqual([]);
      expect(written.trace.toolCalls).toHaveLength(20);
    });
  });

  it('refuses a trace whose fixed columns alone exceed the budget', () => {
    withTraces((world, ids) => {
      aTurn(world, ids, 'g1f');
      // A context manifest over the whole budget on its own. Refusing is right: a caller that
      // produced this has a bug in the **context builder**, and silently storing a row that
      // violates a cap the spec states would hide it behind a truncation flag nobody reads.
      expect(() =>
        world.store.write((uow) =>
          world.repos.traces.writeTrace(
            uow,
            trace('g1f', world, ids, {
              contextManifest: {
                messageIds: [],
                memoryIds: [],
                labelIds: [1],
                entityRefs: [],
                tokenEstimate: 1,
                contextHash: 'x'.repeat(64),
                padding: 'y'.repeat(TRACE_TOTAL_BUDGET_BYTES + 1_000),
              },
            }),
            groupLabel(world.groupId),
          ),
        ),
      ).toThrow(/exceeds its budget/);
    });
  });
});

describe('the debug capture (05 §3.10.1)', () => {
  it('stores the ciphertext in its own table, replaceable and expiring', () => {
    withTraces((world, ids) => {
      aTurn(world, ids, 'h1f');
      world.store.write((uow) =>
        expectWritten(
          world.repos.traces.writeDebug(uow, turnId('h1f'), new Uint8Array([9, 9]), at(1)),
          'the capture',
        ),
      );
      expect(
        Buffer.from(world.repos.traces.debugCiphertext(turnId('h1f')) ?? new Uint8Array()).toString(
          'hex',
        ),
      ).toBe('0909');
      // Replaced rather than refused: a turn that ran its model twice has one debug row, and the
      // row is a 24-hour debugging aid rather than a record of anything.
      world.store.write((uow) =>
        world.repos.traces.writeDebug(uow, turnId('h1f'), new Uint8Array([1]), at(2)),
      );
      expect(
        Buffer.from(world.repos.traces.debugCiphertext(turnId('h1f')) ?? new Uint8Array()).toString(
          'hex',
        ),
      ).toBe('01');
      expect(world.repos.traces.debugCiphertext(turnId('h9f'))).toBeUndefined();
      // The trace row carries no prompt at all, which is what lets the trace be shown to a member
      // while the capture is host-only. Asserted on the stored JSON rather than on the type,
      // because the claim is about the row a backup would copy.
      world.store.write((uow) =>
        world.repos.traces.writeTrace(uow, trace('h1f', world, ids), groupLabel(world.groupId)),
      );
      const json = JSON.stringify(
        world.db.prepare('SELECT * FROM turn_traces WHERE turn_id = ?').get(turnId('h1f')),
      );
      expect(json).not.toContain('0909');
    });
  });
});

describe('expiry (Q-RET-2)', () => {
  it('finds and deletes expired traces in bounded batches', () => {
    withTraces((world, ids) => {
      const label = groupLabel(world.groupId);
      for (const tag of ['j1f', 'j2f', 'j3f']) aTurn(world, ids, tag);
      world.store.write((uow) => {
        for (const [tag, day] of [
          ['j1f', 1],
          ['j2f', 2],
          ['j3f', 30],
        ] as const) {
          world.repos.traces.writeTrace(uow, trace(tag, world, ids, { expiresAt: at(day) }), label);
        }
      });
      expect(world.repos.traces.expiredTraces(at(3), 10)).toEqual([traceId('j1f'), traceId('j2f')]);
      // Bounded: the retention sweep runs in batches, and `limit` has to mean what it says or the
      // sweep's batch size would be a suggestion. SQLite has no portable `DELETE … LIMIT`, so the
      // delete goes by id.
      expect(world.store.write((uow) => world.repos.traces.deleteExpired(uow, at(3), 1))).toBe(1);
      expect(world.repos.traces.expiredTraces(at(3), 10)).toEqual([traceId('j2f')]);
      expect(world.store.write((uow) => world.repos.traces.deleteExpired(uow, at(3), 10))).toBe(1);
      expect(world.repos.traces.expiredTraces(at(3), 10)).toEqual([]);
      // The unexpired one is still there, so the sweep did not take more than it was asked for.
      expect(
        world.repos.traces.recentTraces({
          groupId: world.groupId,
          limit: 10,
          eligible: eligibleAll(world),
        }),
      ).toHaveLength(1);
      expect(world.store.write((uow) => world.repos.traces.deleteExpired(uow, T0, 10))).toBe(0);
    });
  });
});
