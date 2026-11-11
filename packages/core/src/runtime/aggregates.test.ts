/**
 * The three rules the runtime aggregates carry as functions (`02` §3.3.7, §3.8).
 *
 * `isOrphaned` is the interesting one: it is Q-TRN-1's predicate, and the two halves of it answer
 * different failures. Written here as well as in SQL because boot recovery reads the rows and then
 * decides, and a decision made twice in two languages is a decision that can disagree.
 */
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { chainKeyFor, INSTANCE_CHAIN_KEY, isOrphaned, usageGroupKey } from './aggregates.js';

const compare = Temporal.Instant.compare;
const NOW = Temporal.Instant.from('2026-11-11T12:00:00Z');
const GROUP = 'grp_01jqw8z5h7e9r3t4y5v6k7p8q9' as never;

describe('isOrphaned (Q-TRN-1)', () => {
  const running = { status: 'running' as const, bootId: 'boot-01', deadlineAt: NOW };

  it('is true for a running turn from another process incarnation', () => {
    // A `running` row means nothing on its own after a restart: the process that was running it is
    // gone, and nothing updated the row on the way out. `boot_id` is what distinguishes a live turn
    // from a corpse, and a timestamp heuristic would either abandon slow turns or adopt dead ones.
    expect(isOrphaned(running, 'boot-02', NOW, compare)).toBe(true);
    expect(isOrphaned(running, 'boot-01', NOW, compare)).toBe(false);
  });

  it('is true for a running turn past its deadline, in this very process', () => {
    // The other half, and it covers a case the boot check cannot: this process is still running the
    // turn and should not be. Either half alone leaves a real failure unrecovered.
    expect(
      isOrphaned(
        { ...running, deadlineAt: Temporal.Instant.from('2026-11-11T11:59:59Z') },
        'boot-01',
        NOW,
        compare,
      ),
    ).toBe(true);
    // Exactly at the deadline is not yet past it: a turn gets the whole of its budget.
    expect(isOrphaned({ ...running, deadlineAt: NOW }, 'boot-01', NOW, compare)).toBe(false);
  });

  it('is false for every status but `running`', () => {
    // A completed turn from an old boot is not an orphan — it finished. Recovering it would send a
    // second summary for a turn the group was already told about.
    for (const status of [
      'queued',
      'completed',
      'failed',
      'timed_out',
      'cancelled',
      'recovered',
    ] as const) {
      expect(isOrphaned({ ...running, status, bootId: 'boot-02' }, 'boot-01', NOW, compare)).toBe(
        false,
      );
    }
  });
});

describe('the chain and rollup keys', () => {
  it('sends an action with no group to the instance chain', () => {
    // `02` §3.3.7 keys both tables on the group id or `'_instance'`. One chain per group is what
    // lets a group's deletion remove its chain **whole** rather than leaving a gap in a shared one
    // — and a gap is indistinguishable from tampering.
    expect(chainKeyFor(GROUP)).toBe(GROUP);
    expect(chainKeyFor(undefined)).toBe(INSTANCE_CHAIN_KEY);
    expect(usageGroupKey(GROUP)).toBe(GROUP);
    expect(usageGroupKey(undefined)).toBe(INSTANCE_CHAIN_KEY);
  });
});
