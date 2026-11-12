/**
 * The `02`- and `05`-owned runtime JSON column schemas (`02` §3.3.7, §3.3.8).
 */
import { describe, expect, it } from 'vitest';
import { AuditDecisionSchema, AuditDetailsSchema } from './audit.js';
import { CronExprSchema, ScheduleSpecSchema, TzRefSchema } from './schedule.js';
import {
  ContextManifestSchema,
  LatencyTraceSchema,
  TRACE_JSON_COLUMNS,
  TRACE_TOTAL_BUDGET_BYTES,
  TraceReplayMetaSchema,
  traceBudgetOverage,
  traceRowBytes,
} from './traces.js';
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

describe('the combined trace budget (02 §3.3.9)', () => {
  // `02` §3.3.9 says `turn_traces.*` is "512 KiB **total**", and only the per-column caps existed:
  // 128 KiB each across seven columns, so a row could satisfy every individual cap and still be
  // ~896 KiB. `TRACE_TOTAL_BUDGET_BYTES` was exported with **no reader**, which made the combined
  // budget a number in a spec rather than a bound. Found by the M1 independent review.
  it('names the seven columns the budget covers', () => {
    expect(TRACE_JSON_COLUMNS).toEqual([
      'trigger',
      'context_manifest',
      'model_calls',
      'tool_calls',
      'policy_decisions',
      'guard_results',
      'latency',
    ]);
    expect(TRACE_TOTAL_BUDGET_BYTES).toBe(512 * 1024);
  });

  it('counts UTF-8 bytes, not string length', () => {
    // A trace carries member handles and group names. One emoji is four bytes where `.length`
    // says two, and `@comvivo/core` has neither `Buffer` nor `TextEncoder` — so the arithmetic is
    // hand-rolled and worth pinning against a known answer.
    const ascii = traceRowBytes({ trigger: 'abc' });
    // `JSON.stringify('abc')` is `"abc"` — five characters.
    expect(ascii).toBe(5);
    // A four-byte code point: `JSON.stringify` keeps it literal, so `"X"` is 2 quotes + 4 bytes.
    expect(traceRowBytes({ trigger: '👪' })).toBe(6);
    // Two bytes for a Latin-1 letter, three for a CJK one.
    expect(traceRowBytes({ trigger: 'é' })).toBe(4);
    expect(traceRowBytes({ trigger: '家' })).toBe(5);
  });

  it('adds every column together, which is the whole point', () => {
    const one = traceRowBytes({ trigger: 'abc' });
    const two = traceRowBytes({ trigger: 'abc', latency: 'abc' });
    expect(two).toBe(one * 2);
    // An absent column contributes nothing, so a sparse row is not penalised.
    expect(traceRowBytes({})).toBe(0);
  });

  it('reports the overage for a row that is inside every column cap and over the total', () => {
    // The failure the combined budget exists for, constructed: six columns of 100 KiB each. Every
    // one is under the 128 KiB per-column cap; together they are 600 KiB against a 512 KiB budget.
    const chunk = 'x'.repeat(100 * 1024);
    const row = {
      trigger: chunk,
      context_manifest: chunk,
      model_calls: chunk,
      tool_calls: chunk,
      policy_decisions: chunk,
      guard_results: chunk,
    };
    const bytes = traceRowBytes(row);
    expect(bytes).toBeGreaterThan(TRACE_TOTAL_BUDGET_BYTES);
    expect(traceBudgetOverage(row)).toBe(bytes - TRACE_TOTAL_BUDGET_BYTES);
    // And each column on its own is within its cap, so the per-column checks would have passed it.
    expect(traceRowBytes({ trigger: chunk })).toBeLessThan(128 * 1024);
  });

  it('reports no overage for a row that fits', () => {
    expect(traceBudgetOverage({ trigger: 'small' })).toBe(0);
    // Exactly at the budget is not over it.
    const exact = 'x'.repeat(TRACE_TOTAL_BUDGET_BYTES - 2);
    expect(traceRowBytes({ trigger: exact })).toBe(TRACE_TOTAL_BUDGET_BYTES);
    expect(traceBudgetOverage({ trigger: exact })).toBe(0);
  });

  it('returns an overage rather than throwing, so a trace cannot fail a turn', () => {
    // Deliberate: `05` §3.10 makes the trace an observability artefact, and a turn that failed
    // because its own trace was too big would be the worst possible trade. The writer (`M1-T22`)
    // truncates the longest list and records that it did.
    expect(() => traceBudgetOverage({ trigger: 'x'.repeat(2 * 1024 * 1024) })).not.toThrow();
    expect(traceBudgetOverage({ trigger: 'x'.repeat(2 * 1024 * 1024) })).toBeGreaterThan(0);
  });
});
