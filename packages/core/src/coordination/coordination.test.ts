/**
 * The `07`-owned JSON column schemas (`02` §3.3.5).
 *
 * One suite for eight small modules, because the assertions that matter are the ones that encode a
 * *rule* — a poll's option count, a reminder's derived schedule, a task's `by_day` due — rather
 * than the shape of each object. Per-module files would be eight headers for the same point.
 */
import { describe, expect, it } from 'vitest';
import { EventPatchSchema, EventSourceSchema, LocationSchema } from './calendar.js';
import {
  DecidedBySchema,
  DecisionAlternativesSchema,
  DecisionSourceRefsSchema,
} from './decisions.js';
import {
  PlanBudgetNotesSchema,
  PlanSecrecySchema,
  PlanStepLinksSchema,
  StepDueSchema,
} from './plans.js';
import {
  PlatformPollRefSchema,
  PollOptionsSchema,
  PollOutcomeSchema,
  PollQuorumSchema,
} from './polls.js';
import {
  CandidatePayloadSchema,
  CandidateTargetSchema,
  ScoreBreakdownSchema,
  UrgencyInputsSchema,
} from './proactivity.js';
import { ReminderRecipientsSchema, ReminderScheduleSchema } from './reminders.js';
import { RotationCursorSchema, TaskDueSchema, TaskTemplateSchema } from './tasks.js';
import { DurationSchema, RecurrenceSchema, RecurringScheduleSchema } from './when.js';

const MEMBER = 'mbr_01jqw8z5h7e9r3t4y5v6k7p8q9';
const CONVERSATION = 'cnv_01jqw8z5h7e9r3t4y5v6k7p8q9';
const EVENT = 'evt_01jqw8z5h7e9r3t4y5v6k7p8q9';
const TASK = 'tsk_01jqw8z5h7e9r3t4y5v6k7p8q9';
const POLL = 'pol_01jqw8z5h7e9r3t4y5v6k7p8q9';

describe('recurrence (07 §3.1.2)', () => {
  it('expresses "the last Friday of the month" with a negative bySetPos', () => {
    const value = {
      freq: 'monthly' as const,
      interval: 1,
      byWeekday: ['FR' as const],
      byMonthDay: null,
      bySetPos: -1,
      until: null,
      count: null,
    };
    expect(RecurrenceSchema.parse(value)).toEqual(value);
  });

  it('refuses an interval of zero and a bySetPos out of range', () => {
    const base = {
      freq: 'weekly' as const,
      interval: 1,
      byWeekday: null,
      byMonthDay: null,
      bySetPos: null,
      until: null,
      count: null,
    };
    expect(RecurrenceSchema.safeParse({ ...base, interval: 0 }).success).toBe(false);
    expect(RecurrenceSchema.safeParse({ ...base, bySetPos: 6 }).success).toBe(false);
  });

  it('requires a stored schedule to carry a zone, and canonicalises it', () => {
    // `07` §56: the rule is evaluated in wall-clock time, so a daily 08:00 chore has no meaning
    // without knowing whose 08:00.
    const parsed = RecurringScheduleSchema.parse({
      rule: {
        freq: 'daily',
        interval: 1,
        byWeekday: null,
        byMonthDay: null,
        bySetPos: null,
        until: null,
        count: null,
      },
      dtstartLocal: '2026-11-13T08:00:00',
      zone: 'europe/london',
      dueTime: null,
    });
    expect(parsed.zone).toBe('Europe/London');
  });

  it('accepts an ISO duration and refuses a bare number', () => {
    expect(DurationSchema.parse('PT30M')).toBe('PT30M');
    expect(DurationSchema.safeParse('30').success).toBe(false);
  });
});

describe('calendar', () => {
  it('keeps a subscription event identified by uid and sequence', () => {
    // The fields that make a feed refresh a diff rather than a delete-and-insert, which loses RSVPs.
    const value = {
      kind: 'subscription' as const,
      subscriptionId: 'csub_01jqw8z5h7e9r3t4y5v6k7p8q9',
      uid: 'abc@example.com',
      recurrenceId: null,
      sequence: 3,
    };
    expect(EventSourceSchema.parse(value)).toEqual(value);
  });

  it('refuses a source kind it does not know', () => {
    expect(EventSourceSchema.safeParse({ kind: 'guessed' }).success).toBe(false);
  });

  it('lets an override patch one field without restating the others', () => {
    // A sparse diff: restating the title would mean a series rename stops applying here.
    expect(EventPatchSchema.parse({ startLocal: '2026-11-13T19:00:00' })).toEqual({
      startLocal: '2026-11-13T19:00:00',
    });
    expect(EventPatchSchema.parse({})).toEqual({});
  });

  it('requires a location to have non-empty text', () => {
    expect(LocationSchema.parse({ text: 'The park' })).toEqual({ text: 'The park' });
    expect(LocationSchema.safeParse({ text: '' }).success).toBe(false);
  });
});

describe('reminders (07 §3.2.1)', () => {
  it('distinguishes a private note from a group announcement', () => {
    expect(ReminderRecipientsSchema.parse({ kind: 'self' })).toEqual({ kind: 'self' });
    expect(ReminderRecipientsSchema.parse({ kind: 'group', conversationId: CONVERSATION })).toEqual(
      { kind: 'group', conversationId: CONVERSATION },
    );
  });

  it('refuses an empty member list, which would be a reminder for nobody', () => {
    expect(ReminderRecipientsSchema.safeParse({ kind: 'members', ids: [] }).success).toBe(false);
  });

  it('stores a derived schedule as a reference plus an offset, not a resolved time', () => {
    // The reason `lead` exists: moving the event moves the reminder. A resolved instant would
    // leave a reminder firing for a dinner that was rescheduled.
    const lead = { kind: 'lead' as const, eventId: EVENT, before: 'PT1H' };
    expect(ReminderScheduleSchema.parse(lead)).toEqual(lead);
    const taskDue = { kind: 'task_due' as const, taskId: TASK, before: 'P1D' };
    expect(ReminderScheduleSchema.parse(taskDue)).toEqual(taskDue);
  });

  it('refuses a lead schedule pointing at a task, and the reverse', () => {
    expect(
      ReminderScheduleSchema.safeParse({ kind: 'lead', eventId: TASK, before: 'PT1H' }).success,
    ).toBe(false);
    expect(
      ReminderScheduleSchema.safeParse({ kind: 'task_due', taskId: EVENT, before: 'PT1H' }).success,
    ).toBe(false);
  });
});

describe('tasks and rotations', () => {
  it('keeps "by Tuesday" distinct from "Tuesday at midnight"', () => {
    // Storing a by-day due as 00:00 would make it overdue all day, turning nudges into false
    // urgency.
    const byDay = { kind: 'by_day' as const, date: '2026-11-17', zone: 'Europe/London' };
    expect(TaskDueSchema.parse(byDay)).toEqual(byDay);
    expect(TaskDueSchema.parse({ kind: 'none' })).toEqual({ kind: 'none' });
  });

  it('bounds a rotation template effort to the fairness scale', () => {
    const template = {
      title: 'Bins out',
      effortPoints: 2,
      notes: null,
      proofPolicy: 'off' as const,
      category: 'chores.bins',
    };
    expect(TaskTemplateSchema.parse(template)).toEqual(template);
    expect(TaskTemplateSchema.safeParse({ ...template, effortPoints: 101 }).success).toBe(false);
  });

  it('lets a rotation cursor start before its first assignment', () => {
    const cursor = { lastPosition: -1, lastOccurrenceKey: null, lastAssignedMemberId: null };
    expect(RotationCursorSchema.parse(cursor)).toEqual(cursor);
    expect(RotationCursorSchema.safeParse({ ...cursor, lastPosition: -2 }).success).toBe(false);
  });
});

describe('polls (07 §3.5)', () => {
  const option = (index: number) => ({
    id: `o${String(index)}`,
    text: `Option ${String(index)}`,
    position: index,
  });

  it('requires between two and ten options', () => {
    // Ten is `07` §1058's Discord limit; one option is not a poll.
    expect(PollOptionsSchema.parse([option(0), option(1)])).toHaveLength(2);
    expect(PollOptionsSchema.safeParse([option(0)]).success).toBe(false);
    expect(
      PollOptionsSchema.safeParse(Array.from({ length: 11 }, (_, i) => option(i))).success,
    ).toBe(false);
  });

  it('gives every option a stable id, so reordering cannot reassign votes', () => {
    const parsed = PollOptionsSchema.parse([option(0), option(1)]);
    expect(parsed.map((entry) => entry.id)).toEqual(['o0', 'o1']);
    expect(PollOptionsSchema.safeParse([{ text: 'a', position: 0 }, option(1)]).success).toBe(
      false,
    );
  });

  it('bounds a fractional quorum to (0, 1]', () => {
    expect(PollQuorumSchema.parse({ kind: 'fraction', f: 0.5 })).toEqual({
      kind: 'fraction',
      f: 0.5,
    });
    expect(PollQuorumSchema.safeParse({ kind: 'fraction', f: 0 }).success).toBe(false);
    expect(PollQuorumSchema.safeParse({ kind: 'fraction', f: 1.5 }).success).toBe(false);
  });

  it('keeps the four non-results distinct from a decision', () => {
    // Each asks for different follow-up; collapsing them to "no decision" would leave the product
    // unable to say what to do next.
    for (const kind of ['no_quorum', 'blocked', 'no_rule'] as const) {
      expect(PollOutcomeSchema.safeParse({ kind }).success, kind).toBe(true);
    }
    expect(PollOutcomeSchema.safeParse({ kind: 'tie', optionIds: ['o0', 'o1'] }).success).toBe(
      true,
    );
    // A tie of one option is not a tie.
    expect(PollOutcomeSchema.safeParse({ kind: 'tie', optionIds: ['o0'] }).success).toBe(false);
    // A decision of none is not a decision.
    expect(PollOutcomeSchema.safeParse({ kind: 'decided', optionIds: [] }).success).toBe(false);
  });

  it('keeps a platform poll reference opaque but channel-tagged', () => {
    expect(PlatformPollRefSchema.parse({ channel: 'discord', data: { messageId: '1' } })).toEqual({
      channel: 'discord',
      data: { messageId: '1' },
    });
    expect(PlatformPollRefSchema.safeParse({ data: {} }).success).toBe(false);
  });
});

describe('plans (07 §3.7)', () => {
  it('requires a secrecy record to exclude at least one member', () => {
    // A surprise with nobody to keep it from is not a surprise, and an empty `excluded` would make
    // the guard scan for terms it never needs to suppress.
    const value = { excluded: [MEMBER], sealedTerms: ['cake'] };
    expect(PlanSecrecySchema.parse(value)).toEqual(value);
    expect(PlanSecrecySchema.safeParse({ excluded: [], sealedTerms: [] }).success).toBe(false);
  });

  it('keeps a budget estimate as free text', () => {
    // `07` §1202's own example is `~€400`. People plan in approximations.
    const notes = [{ item: 'Flights', estimate: '~€400', note: null }];
    expect(PlanBudgetNotesSchema.parse(notes)).toEqual(notes);
  });

  it('links a step only to entities that exist as such', () => {
    expect(PlanStepLinksSchema.parse({ taskId: TASK, pollId: POLL })).toEqual({
      taskId: TASK,
      pollId: POLL,
    });
    expect(PlanStepLinksSchema.safeParse({ taskId: EVENT }).success).toBe(false);
    expect(PlanStepLinksSchema.parse({})).toEqual({});
  });

  it('offers a step the same two due shapes a task has', () => {
    expect(
      StepDueSchema.safeParse({ kind: 'by_day', date: '2026-11-17', zone: 'UTC' }).success,
    ).toBe(true);
    expect(StepDueSchema.safeParse({ kind: 'none' }).success).toBe(false);
  });
});

describe('decisions (07 §3.6)', () => {
  it('records "we agreed in chat" as informal rather than as consensus', () => {
    // Recording an informal agreement as `consensus` would claim a process that did not happen,
    // and `03` treats a recorded strategy as precedent.
    expect(DecidedBySchema.parse({ rule: 'informal', memberIds: [MEMBER] })).toEqual({
      rule: 'informal',
      memberIds: [MEMBER],
    });
    expect(DecidedBySchema.safeParse({ rule: 'coin_toss', memberIds: [] }).success).toBe(false);
  });

  it('cites a source by hash, never by excerpt', () => {
    // `07` §1334 re-reads excerpts at render time so an expired message shows "source expired"
    // instead of the product keeping a copy the platform was asked to forget.
    const refs = [
      {
        messageId: 'msg_01jqw8z5h7e9r3t4y5v6k7p8q9',
        platformMessageRef: null,
        authorMemberId: MEMBER,
        sentAt: '2026-11-06T19:04:00Z',
        excerptHash: 'a'.repeat(64),
      },
    ];
    expect(DecisionSourceRefsSchema.parse(refs)).toEqual(refs);
  });

  it('bounds the rejected alternatives', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      option: `o${String(i)}`,
      reason: null,
    }));
    expect(DecisionAlternativesSchema.safeParse(many).success).toBe(false);
  });
});

describe('proactivity (07 §3.10)', () => {
  it('prices a group target differently from a DM', () => {
    expect(CandidateTargetSchema.parse({ kind: 'member_dm', memberId: MEMBER })).toEqual({
      kind: 'member_dm',
      memberId: MEMBER,
    });
    expect(
      CandidateTargetSchema.safeParse({ kind: 'conversation', conversationId: MEMBER }).success,
    ).toBe(false);
  });

  it('carries age or tau, whichever its type decays by', () => {
    expect(UrgencyInputsSchema.parse({ ageSeconds: 60, tauSeconds: null })).toEqual({
      ageSeconds: 60,
      tauSeconds: null,
    });
    // Tau may be negative: an overdue task is past due.
    expect(UrgencyInputsSchema.safeParse({ ageSeconds: null, tauSeconds: -3600 }).success).toBe(
      true,
    );
    expect(UrgencyInputsSchema.safeParse({ ageSeconds: -1, tauSeconds: null }).success).toBe(false);
  });

  it('holds entity refs only, never content', () => {
    // `07` §3.10.1. A candidate outlives its turn and is re-read by the scorer, so content here
    // would be an unlabelled copy of group text with a long lifetime.
    expect(CandidatePayloadSchema.parse({ refs: [{ kind: 'event', id: EVENT }] })).toEqual({
      refs: [{ kind: 'event', id: EVENT }],
    });
    const outcome = CandidatePayloadSchema.safeParse({
      refs: [],
      question: 'What time is dinner?',
    });
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    // The stray field is dropped rather than stored: `z.object` strips unknown keys, so content
    // cannot ride along even if a caller tries.
    expect(outcome.data).toEqual({ refs: [] });
  });

  it('records every term of 07 §3.10.3s score, not just the verdict', () => {
    const breakdown = {
      wType: 1,
      v: 0.9,
      u: 0.6,
      c: 0.95,
      sRaw: 0.513,
      aAud: 0.2,
      n24: 0,
      r7: 0,
      a: 0.2,
      s: 0.313,
      thetaNow: 0.3,
      thetaDigest: 0.12,
      gate: null,
    };
    expect(ScoreBreakdownSchema.parse(breakdown)).toEqual(breakdown);
    // `07` §3.10.4: gates are ordered and the first failure decides, so one gate is the answer.
    expect(
      ScoreBreakdownSchema.safeParse({
        ...breakdown,
        gate: { name: 'ifc', reason: 'cannot_read' },
      }).success,
    ).toBe(true);
    expect(
      ScoreBreakdownSchema.safeParse({ ...breakdown, gate: { name: 'vibes', reason: 'x' } })
        .success,
    ).toBe(false);
  });
});
