/**
 * The `02`- and `05`-owned runtime JSON column schemas (`02` §3.3.7, §3.3.8).
 */
import { describe, expect, it } from 'vitest';
import { AuditDecisionSchema, AuditDetailsSchema } from './audit.js';
import { CronExprSchema, ScheduleSpecSchema, TzRefSchema } from './schedule.js';
import { ContextManifestSchema, LatencyTraceSchema, TraceReplayMetaSchema } from './traces.js';
import { EffectSummaryParamsSchema, OutboxPartsSchema, TurnFailureSchema } from './turns.js';

const MEMBER = 'mbr_01jqw8z5h7e9r3t4y5v6k7p8q9';
const GROUP = 'grp_01jqw8z5h7e9r3t4y5v6k7p8q9';

describe('audit payloads (02 §3.3.9: ids and enums, never content)', () => {
  it('records a decision as a closed reason, not a message', () => {
    const decision = {
      outcome: 'deny' as const,
      reason: 'capability_missing' as const,
      capability: 'calendar.write',
      constitutionVersionId: 'cnst_01jqw8z5h7e9r3t4y5v6k7p8q9',
    };
    expect(AuditDecisionSchema.parse(decision)).toEqual(decision);
    expect(AuditDecisionSchema.safeParse({ ...decision, reason: 'felt wrong' }).success).toBe(
      false,
    );
  });

  it('allows a null reason for an allow', () => {
    expect(
      AuditDecisionSchema.safeParse({
        outcome: 'allow',
        reason: null,
        capability: 'calendar.write',
        constitutionVersionId: null,
      }).success,
    ).toBe(true);
  });

  it('bounds a detail value to 120 characters, so the column cannot hold a sentence', () => {
    // The enforcement of "NEVER content": long enough for a TypeID or a capability name, far too
    // short for a message. The bound is structural rather than a rule each call site remembers.
    expect(AuditDetailsSchema.parse({ memberId: MEMBER, count: 3, ok: true })).toEqual({
      memberId: MEMBER,
      count: 3,
      ok: true,
    });
    // Boundary **and** one past it. Only 121 was tried, so the cap could have tightened to any
    // value and nothing would have noticed — the test would still have refused 121 characters and
    // still have been named for 120. Found by the M1 independent review; `rich-text.test.ts` does
    // boundary-and-one-past throughout and is the model.
    expect(AuditDetailsSchema.parse({ note: 'x'.repeat(120) })).toEqual({ note: 'x'.repeat(120) });
    expect(AuditDetailsSchema.safeParse({ note: 'x'.repeat(121) }).success).toBe(false);
  });

  it('refuses a nested object in details', () => {
    expect(AuditDetailsSchema.safeParse({ nested: { a: 1 } }).success).toBe(false);
  });
});

describe('turn payloads', () => {
  it('records which phase a turn died in, because recovery differs by phase', () => {
    // A turn that died while committing may have external effects journaled as intent (A23); one
    // that died building context cannot.
    const failure = {
      code: 'MODEL_TIMEOUT',
      message: 'the provider did not respond within the deadline',
      phase: 'model_step' as const,
      retryable: true,
      at: '2026-11-06T19:04:00Z',
    };
    expect(TurnFailureSchema.parse(failure)).toEqual(failure);
    expect(TurnFailureSchema.safeParse({ ...failure, phase: 'thinking' }).success).toBe(false);
  });

  it('bounds a failure message, which must never carry the model or user text', () => {
    expect(
      TurnFailureSchema.safeParse({
        code: 'X',
        message: 'x'.repeat(501),
        phase: null,
        retryable: false,
        at: '2026-11-06T19:04:00Z',
      }).success,
    ).toBe(false);
  });

  it('caps effect summary params at twenty keys', () => {
    const keys = (count: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${String(index)}`, index]));
    // Twenty is accepted and twenty-one is not. Only 21 was tried, so the cap could have tightened
    // to one key undetected.
    expect(Object.keys(EffectSummaryParamsSchema.parse(keys(20)))).toHaveLength(20);
    expect(EffectSummaryParamsSchema.safeParse(keys(21)).success).toBe(false);
    expect(EffectSummaryParamsSchema.parse({ title: 'Soccer practice' })).toEqual({
      title: 'Soccer practice',
    });
  });

  it('marks a part whose delivery is unknown', () => {
    // The honest flag for the case that cannot be resolved: the send timed out, so the platform
    // may or may not have delivered it.
    const parts = [
      { index: 0, platformMessageId: '12', sentAt: '2026-11-06T19:04:00Z' },
      { index: 1, platformMessageId: null, sentAt: null, possibleDuplicate: true },
    ];
    expect(OutboxPartsSchema.parse(parts)).toEqual(parts);
  });
});

describe('traces (02 §3.3.9: ids and label ids only)', () => {
  it('records the context by reference, never as text', () => {
    // A trace is retained for days and readable by whoever its label admits, so recording what was
    // in the context window as text would be a second, longer-lived copy of the most sensitive
    // assembly the product performs.
    const manifest = {
      messageIds: ['msg_01jqw8z5h7e9r3t4y5v6k7p8q9'],
      memoryIds: [],
      labelIds: [1, 2, 3],
      entityRefs: [],
      tokenEstimate: 1200,
      contextHash: 'a'.repeat(64),
    };
    expect(ContextManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('strips a stray content field rather than storing it', () => {
    const outcome = ContextManifestSchema.safeParse({
      messageIds: [],
      memoryIds: [],
      labelIds: [],
      entityRefs: [],
      tokenEstimate: 0,
      contextHash: 'a',
      renderedPrompt: 'You are a helpful assistant…',
    });
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    expect('renderedPrompt' in outcome.data).toBe(false);
  });

  it('names each latency phase, so 11s budgets are readable off a trace', () => {
    const latency = {
      totalMs: 900,
      buildContextMs: 40,
      modelMs: 700,
      toolsMs: 100,
      guardMs: 20,
      commitMs: 40,
    };
    expect(LatencyTraceSchema.parse(latency)).toEqual(latency);
    expect(LatencyTraceSchema.safeParse({ ...latency, modelMs: -1 }).success).toBe(false);
  });

  it('carries every replay input 11 §12-1 names', () => {
    const replay = {
      contextHash: 'a'.repeat(64),
      promptVersion: 'chat-2.1.0',
      toolCatalogHash: 'b'.repeat(64),
      constitutionVersionId: null,
      codeVersion: '1.0.0',
      otelTraceId: null,
    };
    expect(TraceReplayMetaSchema.parse(replay)).toEqual(replay);
  });
});

describe('schedules (02 §3.10.5)', () => {
  it('resolves a member schedule at fire time rather than storing a zone', () => {
    // So someone who moves gets their digest at their new local time without the schedule being
    // rewritten.
    expect(TzRefSchema.parse({ member: MEMBER })).toEqual({ member: MEMBER });
    expect(TzRefSchema.parse({ group: GROUP })).toEqual({ group: GROUP });
    const fixed = TzRefSchema.parse({ fixed: 'europe/london' });
    expect(fixed).toEqual({ fixed: 'Europe/London' });
  });

  it('accepts a five-field cron and refuses one with seconds', () => {
    // Seconds are excluded deliberately: `02` §3.10.5's evaluator works to the minute, so a
    // seconds field would be silently ignored — worse than refusing it.
    expect(CronExprSchema.parse('30 7 * * 1-5')).toBe('30 7 * * 1-5');
    expect(CronExprSchema.parse('*/15 * * * *')).toBe('*/15 * * * *');
    expect(CronExprSchema.safeParse('0 30 7 * * 1-5').success).toBe(false);
    expect(CronExprSchema.safeParse('30 7 * *').success).toBe(false);
    expect(CronExprSchema.safeParse('every morning').success).toBe(false);
  });

  it('requires HH:mm for a daily schedule', () => {
    expect(
      ScheduleSpecSchema.safeParse({ kind: 'daily', at: '07:30', tz: { group: GROUP } }).success,
    ).toBe(true);
    expect(
      ScheduleSpecSchema.safeParse({ kind: 'daily', at: '7:30', tz: { group: GROUP } }).success,
    ).toBe(false);
    expect(
      ScheduleSpecSchema.safeParse({ kind: 'daily', at: '24:00', tz: { group: GROUP } }).success,
    ).toBe(false);
  });

  it('floors an interval at one minute, the evaluator resolution', () => {
    expect(ScheduleSpecSchema.safeParse({ kind: 'interval', everyMs: 60_000 }).success).toBe(true);
    expect(ScheduleSpecSchema.safeParse({ kind: 'interval', everyMs: 59_999 }).success).toBe(false);
  });

  it('requires at least one weekday for a weekly schedule', () => {
    expect(
      ScheduleSpecSchema.safeParse({
        kind: 'weekly',
        weekdays: [],
        at: '09:00',
        tz: { group: GROUP },
      }).success,
    ).toBe(false);
  });
});
