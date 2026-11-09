/**
 * The coordination domain rules (`02` §3.3.5; semantics in `07`, `03`).
 *
 * Six small predicates, each encoding a decision that is easy to get backwards and whose
 * backwards form is quiet: a snoozed reminder that fires immediately, a secret ballot shown while
 * people are still voting, a chore completion that never reaches the fairness ledger. They live in
 * `core` so one rule serves every caller, and they are tested here rather than through a
 * repository because that is where the rule is.
 */
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { EVENT_STATUSES, occupiesTime } from './calendar.js';
import { isActivePlan, PLAN_STATUSES } from './plans.js';
import { POLL_STATUSES, resultsVisibleNow } from './polls.js';
import { isDue, REMINDER_STATUSES } from './reminders.js';
import { chargesLedger, isOpenTask, TASK_STATUSES } from './tasks.js';

const NOW = Temporal.Instant.from('2026-11-08T12:00:00Z');
const EARLIER = Temporal.Instant.from('2026-11-08T11:00:00Z');
const LATER = Temporal.Instant.from('2026-11-08T13:00:00Z');

describe('occupiesTime', () => {
  it('is independent of the status, except for cancelled', () => {
    // `busy` is a column rather than derived from the status, because the two are independent: a
    // `tentative` event can still block a slot ("might be at the dentist"), and a `confirmed` one
    // can be free-time ("school term starts"). Conflating them would make every tentative plan
    // invisible to `07`'s conflict detection — which is when a conflict most needs catching.
    expect(occupiesTime({ busy: true, status: 'tentative' })).toBe(true);
    expect(occupiesTime({ busy: false, status: 'confirmed' })).toBe(false);
    expect(occupiesTime({ busy: true, status: 'proposed' })).toBe(true);
    // Cancelled is the one status that wins over `busy`: the slot is free again.
    expect(occupiesTime({ busy: true, status: 'cancelled' })).toBe(false);
  });

  it('answers for every declared status', () => {
    for (const status of EVENT_STATUSES) {
      expect(typeof occupiesTime({ busy: true, status }), status).toBe('boolean');
    }
  });
});

describe('isOpenTask', () => {
  it('counts a proposal as open', () => {
    // `07` treats a proposed chore as something the group has not settled, and leaving it out of
    // "what is open" would make a proposal invisible until somebody accepted it — which is exactly
    // when it needs to be visible.
    expect(isOpenTask({ status: 'proposed' })).toBe(true);
    expect(isOpenTask({ status: 'open' })).toBe(true);
    expect(isOpenTask({ status: 'done' })).toBe(false);
    expect(isOpenTask({ status: 'skipped' })).toBe(false);
    expect(isOpenTask({ status: 'cancelled' })).toBe(false);
  });

  it('is exhaustive over the declared statuses', () => {
    const open = TASK_STATUSES.filter((status) => isOpenTask({ status }));
    expect([...open]).toEqual(['proposed', 'open']);
  });
});

describe('chargesLedger', () => {
  it('charges a completed chore and nothing else', () => {
    // `03` §3.9.3: a one-off task is somebody doing a favour; a chore is a share of recurring work,
    // and the ledger exists to make that share visible. Charging a task would make a favour look
    // like an obligation met.
    expect(chargesLedger({ kind: 'chore', status: 'done' })).toBe(true);
    expect(chargesLedger({ kind: 'task', status: 'done' })).toBe(false);
    // Skipped and cancelled are not work done, so they post nothing — otherwise skipping a chore
    // would credit the member who skipped it.
    expect(chargesLedger({ kind: 'chore', status: 'skipped' })).toBe(false);
    expect(chargesLedger({ kind: 'chore', status: 'cancelled' })).toBe(false);
    expect(chargesLedger({ kind: 'chore', status: 'open' })).toBe(false);
  });
});

describe('isActivePlan', () => {
  it('counts a draft as active', () => {
    // A plan being drafted is a plan `07` should still surface — "we were going to book the
    // flights" is the thing a nudge is for. `archived` and the terminal states are not.
    expect(isActivePlan({ status: 'draft' })).toBe(true);
    expect(isActivePlan({ status: 'active' })).toBe(true);
    expect(isActivePlan({ status: 'done' })).toBe(false);
    expect(isActivePlan({ status: 'cancelled' })).toBe(false);
    expect(isActivePlan({ status: 'archived' })).toBe(false);
    expect(PLAN_STATUSES.filter((status) => isActivePlan({ status })).length).toBe(2);
  });
});

describe('resultsVisibleNow', () => {
  it('hides an after_close poll until it closes', () => {
    // The permissive direction is the one that changes the outcome rather than merely leaking it:
    // showing a secret ballot's tally **while people are still voting** tells the undecided which
    // way the room is going.
    expect(resultsVisibleNow({ resultsVisibility: 'after_close', status: 'open' })).toBe(false);
    expect(resultsVisibleNow({ resultsVisibility: 'after_close', status: 'closed' })).toBe(true);
    expect(resultsVisibleNow({ resultsVisibility: 'after_close', status: 'cancelled' })).toBe(true);
  });

  it('shows a live poll at any point', () => {
    for (const status of POLL_STATUSES) {
      expect(resultsVisibleNow({ resultsVisibility: 'live', status }), status).toBe(true);
    }
  });
});

describe('isDue', () => {
  it('fires a scheduled reminder at or before the instant', () => {
    expect(isDue({ status: 'scheduled', nextFireAt: EARLIER, snoozedUntil: undefined }, NOW)).toBe(
      true,
    );
    // At the instant, not only before it: a reminder for 12:00 fires at 12:00.
    expect(isDue({ status: 'scheduled', nextFireAt: NOW, snoozedUntil: undefined }, NOW)).toBe(
      true,
    );
    expect(isDue({ status: 'scheduled', nextFireAt: LATER, snoozedUntil: undefined }, NOW)).toBe(
      false,
    );
  });

  it('lets a snooze win over the schedule', () => {
    // Backwards here means a snoozed reminder firing immediately, which is the most annoying
    // possible failure of a snooze — the member asked for quiet and got the opposite.
    expect(isDue({ status: 'snoozed', nextFireAt: EARLIER, snoozedUntil: LATER }, NOW)).toBe(false);
    expect(isDue({ status: 'snoozed', nextFireAt: EARLIER, snoozedUntil: EARLIER }, NOW)).toBe(
      true,
    );
  });

  it('treats snoozed as live, not as finished', () => {
    // A snoozed reminder is waiting, not dealt with. Treating it as inactive would mean a snooze
    // silently cancelled the reminder.
    const live = REMINDER_STATUSES.filter((status) =>
      isDue({ status, nextFireAt: EARLIER, snoozedUntil: undefined }, NOW),
    );
    expect([...live]).toEqual(['scheduled', 'snoozed']);
  });

  it('never fires a reminder with nothing scheduled', () => {
    // `next_fire_at` is nullable — a `done` or `completed_series` reminder has no next time — and
    // a missing time must read as "not due" rather than as "due now".
    expect(
      isDue({ status: 'scheduled', nextFireAt: undefined, snoozedUntil: undefined }, NOW),
    ).toBe(false);
  });

  it('does not fire a cancelled or completed reminder', () => {
    for (const status of ['done', 'cancelled', 'completed_series'] as const) {
      expect(isDue({ status, nextFireAt: EARLIER, snoozedUntil: undefined }, NOW), status).toBe(
        false,
      );
    }
  });
});
