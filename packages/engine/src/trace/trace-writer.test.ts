/**
 * The turn-trace writer (`05` §3.10.1; `11` §3.10.4; `M3-T20`).
 *
 * The acceptance criterion that needs the most care is "**no content in non-debug traces**", and
 * it is asserted the way a reviewer cannot: by serialising the whole row and looking for the
 * actual strings a turn handled. A field-by-field review passes for the fields that exist today
 * and says nothing about the one added next month with a plausible name, which is how content
 * reaches a trace in practice.
 *
 * The other three are the debug capture's fences: it exists only when the host-only flag is on,
 * it is sealed, and it expires in 24 hours rather than with the trace.
 */
import type { ContextManifest, Label, NewTurnTrace, TxToken, WriteResult } from '@comvivo/core';
import type { LogFields, TurnId, TurnTraceId } from '@comvivo/shared';
import { silentLogger } from '@comvivo/shared/testing';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  DEBUG_CAPTURE_TTL_MS,
  type TraceContext,
  type TraceSink,
  TraceWriter,
  type TraceWriterOptions,
} from './trace-writer.js';

const T0 = Temporal.Instant.from('2026-11-14T12:00:00Z');
const GROUP = 'grp_01jd8000000000000000000000' as TraceContext['groupId'];
const CONVERSATION = 'cnv_01jd8000000000000000000000' as TraceContext['conversationId'];
const TURN = 'trn_01jd8000000000000000000000' as TurnId;
const TRACE = 'trc_01jd8000000000000000000000' as TurnTraceId;

/**
 * Strings a real turn would have handled, none of which may appear in a trace.
 *
 * Deliberately a mix of the four kinds `05` §3.10.1 keeps out: a member's message, the rendered
 * prompt, the model's reply, and a tool's argument. A writer that leaked any one of them would
 * leak all four, because they travel together.
 */
const CONTENT = {
  message: 'can you move Leo’s recital to Thursday',
  prompt: 'You are Village, a group assistant. The Rahmans’ calendar contains…',
  reply: 'I moved *Leo’s recital* to Thursday 19:00.',
  toolArgument: 'Leo’s recital',
} as const;

const label: Label = {
  groupId: GROUP,
  readers: { kind: 'group', groupId: GROUP },
  owner: 'group',
  coOwners: [],
  sensitivity: 'normal',
  influence: 'none',
  untrusted: false,
};

const MESSAGE = 'msg_01jd8000000000000000000000' as ContextManifest['messageIds'][number];
const MEMORY = 'mem_01jd8000000000000000000000' as ContextManifest['memoryIds'][number];

const manifest: ContextManifest = {
  messageIds: [MESSAGE],
  memoryIds: [MEMORY],
  labelIds: [1, 2],
  entityRefs: ['event:evt_01jd8000000000000000000000'],
  tokenEstimate: 1_280,
  contextHash: 'a'.repeat(64),
};

function context(overrides: Partial<TraceContext> = {}): TraceContext {
  return {
    id: TRACE,
    turnId: TURN,
    groupId: GROUP,
    conversationId: CONVERSATION,
    trigger: { kind: 'direct', messageIds: [MESSAGE] },
    disposition: 'replied',
    contextManifest: manifest,
    latency: {
      totalMs: 2_400,
      buildContextMs: 120,
      modelMs: 1_900,
      toolsMs: 300,
      guardMs: 40,
      commitMs: 40,
    },
    replay: {
      contextHash: 'a'.repeat(64),
      promptVersion: 'charter.v1',
      toolCatalogHash: 'b'.repeat(64),
      constitutionVersionId: null,
      codeVersion: '0.1.0',
      otelTraceId: null,
    },
    label,
    ...overrides,
  };
}

/** The transaction token, with the one field this module reads. */
const uow = { now: T0, afterCommit: () => undefined } as unknown as TxToken;

interface Recorded {
  readonly traces: NewTurnTrace[];
  readonly debug: { turnId: TurnId; ciphertext: Uint8Array; expiresAt: Temporal.Instant }[];
  readonly sink: TraceSink;
}

/** A sink that keeps what it was handed, so the row itself can be inspected. */
function recordingSink(truncation: unknown = { truncated: false, dropped: [] }): Recorded {
  const traces: NewTurnTrace[] = [];
  const debug: { turnId: TurnId; ciphertext: Uint8Array; expiresAt: Temporal.Instant }[] = [];
  const sink: TraceSink = {
    writeTrace(
      _tx,
      trace,
    ): WriteResult<{
      readonly trace: { readonly id: TurnTraceId };
      readonly truncation: unknown;
    }> {
      traces.push(trace);
      return { kind: 'ok', value: { trace: { id: trace.id }, truncation } };
    },
    writeDebug(_tx, turnId, ciphertext, expiresAt): WriteResult<TurnId> {
      debug.push({ turnId, ciphertext, expiresAt });
      return { kind: 'ok', value: turnId };
    },
  };
  return { traces, debug, sink };
}

/** A logger that keeps its warnings, so the banner and the truncation line can be asserted. */
function recordingLogger(): {
  readonly logger: TraceWriterOptions['logger'];
  readonly warnings: { event: string; fields: LogFields | undefined }[];
} {
  const warnings: { event: string; fields: LogFields | undefined }[] = [];
  const logger = {
    ...silentLogger,
    warn(event: string, fields?: LogFields) {
      warnings.push({ event, fields });
    },
    child() {
      return logger;
    },
  } as unknown as TraceWriterOptions['logger'];
  return { logger, warnings };
}

/** A draft filled the way a real turn would fill it, content and all. */
function filledDraft(writer: TraceWriter) {
  const draft = writer.draft();
  draft.router({
    ruleId: 'R2',
    reason: 'addressed_directly',
    planning: false,
    effort: 'medium',
    languageHint: 'en',
  });
  draft.binding({
    requesterPrincipal: 'member:mbr_01jd8000000000000000000000',
    audienceReaderSetId: 7,
    includesMinor: true,
    capabilitySetHash: 'c'.repeat(64),
  });
  draft.prompt({
    charterVersion: 'charter.v1',
    profile: 'family',
    catalogHash: 'd'.repeat(64),
    globalHash: 'e'.repeat(64),
    groupLayerHash: 'f'.repeat(64),
    turnSkeletonHash: '0'.repeat(64),
    partTokens: [1_800, 420, 60, 12],
  });
  draft.output({ partCount: 1, mentionsCount: 0, linksStripped: 2, reactionAck: false });
  draft.modelCall(
    {
      route: 'chat',
      variant: 'default',
      provider: 'anthropic',
      requestedModel: 'claude-opus-5-5',
      servedModel: 'claude-opus-5-5',
      effort: 'medium',
      step: 1,
      stopReason: 'tool_use',
      refusalCategory: null,
      inputTokens: 400,
      cacheReadTokens: 1_600,
      cacheWriteTokens: 0,
      outputTokens: 120,
      reasoningTokens: 48,
      cacheReadRatio: 0.8,
      ttftMs: 640,
      latencyMs: 1_200,
      requestHash: '1'.repeat(64),
      inputTransformations: 0,
    },
    4_200,
  );
  draft.modelCall(
    {
      route: 'guard',
      variant: 'default',
      provider: 'anthropic',
      requestedModel: 'claude-haiku-5-5',
      servedModel: 'claude-haiku-5-5',
      effort: 'low',
      step: 2,
      stopReason: 'end_turn',
      refusalCategory: null,
      inputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
      cacheReadRatio: 0,
      ttftMs: 90,
      latencyMs: 180,
      requestHash: '2'.repeat(64),
      inputTransformations: 1,
    },
    80,
  );
  // The interiors of these three belong to `M3-T23`, `M4` and `M5-T16`, so the writer takes them
  // as objects. Filled with ids and codes here — which is what those tasks will put in them.
  draft.toolCall({ name: 'calendar_update', ok: true, durationMs: 300 });
  draft.policyDecision({
    kind: 'allow',
    reason: 'capability_granted',
    capability: 'calendar.write',
  });
  draft.guardResult({ result: 'pass', recordId: 'grd_01jd8000000000000000000000', latencyMs: 40 });
  // The rendered prompt and reply. Offered unconditionally; the writer decides.
  draft.debugCapture(`${CONTENT.prompt}\n---\n${CONTENT.reply}`);
  return draft;
}

describe('a trace with the debug flag off (M3-T20 AC)', () => {
  const writer = new TraceWriter({
    logger: silentLogger,
    retentionDays: 30,
    debugContent: false,
  });

  it('holds no message, prompt, response or tool argument anywhere in the row', () => {
    const { traces, debug, sink } = recordingSink();
    writer.write(uow, sink, context(), filledDraft(writer));
    expect(traces).toHaveLength(1);
    // Serialised, not reviewed field by field. A field added later with a plausible name is how
    // content reaches a trace, and this assertion does not care what it is called.
    const serialised = JSON.stringify(traces[0]);
    for (const [kind, text] of Object.entries(CONTENT)) {
      expect(serialised, `the trace contains the ${kind}`).not.toContain(text);
    }
    // And the capture itself was dropped rather than stored anywhere.
    expect(debug).toEqual([]);
  });

  it('still records every section 05 §3.10.1 names', () => {
    // The complement of the test above, and the reason it is not vacuous: a writer that recorded
    // *nothing* would pass the content scan.
    const { traces, sink } = recordingSink();
    writer.write(uow, sink, context(), filledDraft(writer));
    const trace = traces[0];
    expect(trace?.router?.ruleId).toBe('R2');
    expect(trace?.binding?.includesMinor).toBe(true);
    expect(trace?.prompt?.partTokens).toEqual([1_800, 420, 60, 12]);
    expect(trace?.output?.linksStripped).toBe(2);
    expect(trace?.modelCalls).toHaveLength(2);
    expect(trace?.toolCalls).toHaveLength(1);
    expect(trace?.policyDecisions).toHaveLength(1);
    expect(trace?.guardResults).toHaveLength(1);
    expect(trace?.contextManifest.messageIds).toEqual(manifest.messageIds);
  });

  it('breaks the cost down by route and totals it', () => {
    const { traces, sink } = recordingSink();
    writer.write(uow, sink, context(), filledDraft(writer));
    // `05` §3.10.1's `cost` row is "Micro-USD by route", and the total is the column a budget
    // query aggregates. Both, because a guard that ran four times is the explanation for a turn
    // that cost what it did.
    expect(traces[0]?.costByRoute).toEqual({ chat: 4_200, guard: 80 });
    expect(traces[0]?.costMicros).toBe(4_280);
  });

  it('expires the trace at the configured retention, not at a fixed 30 days', () => {
    const seven = new TraceWriter({ logger: silentLogger, retentionDays: 7, debugContent: false });
    const { traces, sink } = recordingSink();
    seven.write(uow, sink, context(), seven.draft());
    expect(traces[0]?.expiresAt.epochMilliseconds).toBe(
      T0.add({ hours: 7 * 24 }).epochMilliseconds,
    );
  });

  it('omits a section the turn never reached, rather than inventing an empty one', () => {
    // `11` §3.10.4's range is 7–365 and a turn refused at a gate has no prompt and no output.
    // An empty object there would read as "the prompt was built and was empty".
    const { traces, sink } = recordingSink();
    const draft = writer.draft();
    draft.router({
      ruleId: 'R0',
      reason: 'unbound_chat',
      planning: false,
      effort: 'low',
      languageHint: null,
    });
    writer.write(uow, sink, context({ disposition: 'silent' }), draft);
    expect(traces[0]?.router?.ruleId).toBe('R0');
    expect(traces[0]?.prompt).toBeUndefined();
    expect(traces[0]?.output).toBeUndefined();
    expect(traces[0]?.binding).toBeUndefined();
    expect(traces[0]?.modelCalls).toEqual([]);
    expect(traces[0]?.costByRoute).toEqual({});
  });

  it('warns when the repository had to truncate, naming the columns it shortened', () => {
    const { logger, warnings } = recordingLogger();
    const loud = new TraceWriter({ logger, retentionDays: 30, debugContent: false });
    const { sink } = recordingSink({ truncated: true, dropped: ['tool_calls', 'model_calls'] });
    loud.write(uow, sink, context(), filledDraft(loud));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.event).toBe('trace.truncated');
    // Token-shaped, because `LogFields.detail` refuses a value with a space in it.
    expect(warnings[0]?.fields?.detail).toEqual({ dropped: 'tool_calls,model_calls' });
  });
});

describe('the debug capture (05 §3.10.1)', () => {
  it('is sealed, bound to its turn, and lives 24 hours', () => {
    const sealed: { turnId: TurnId; plaintext: string }[] = [];
    const { logger, warnings } = recordingLogger();
    const writer = new TraceWriter({
      logger,
      retentionDays: 30,
      debugContent: true,
      sealDebug: (turnId, plaintext) => {
        sealed.push({ turnId, plaintext: new TextDecoder().decode(plaintext) });
        return new Uint8Array([1, 2, 3]);
      },
    });
    const { traces, debug, sink } = recordingSink();
    writer.write(uow, sink, context(), filledDraft(writer));

    // The seal saw the plaintext and the turn it belongs to — the turn is what the AAD binds, so
    // a ciphertext cannot be moved between rows.
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.turnId).toBe(TURN);
    expect(sealed[0]?.plaintext).toContain(CONTENT.prompt);
    // What reached the database is the **ciphertext**, and nothing else.
    expect(debug).toHaveLength(1);
    expect([...(debug[0]?.ciphertext ?? [])]).toEqual([1, 2, 3]);
    // 24 hours from now, not the trace's 30 days: a debugging aid must disappear whether or not
    // anybody remembers to turn the flag off.
    expect(debug[0]?.expiresAt.epochMilliseconds).toBe(T0.epochMilliseconds + DEBUG_CAPTURE_TTL_MS);
    expect(debug[0]?.expiresAt.epochMilliseconds).toBeLessThan(
      traces[0]?.expiresAt.epochMilliseconds ?? 0,
    );
    // And the banner, once.
    expect(warnings.filter((each) => each.event === 'debug.content_enabled')).toHaveLength(1);
  });

  it('leaves the trace itself content-free even with the flag on', () => {
    // The flag widens what is captured, not what a *trace* holds: the trace is readable by
    // members through `09`, the debug row is host-only.
    const writer = new TraceWriter({
      logger: silentLogger,
      retentionDays: 30,
      debugContent: true,
      sealDebug: () => new Uint8Array([0]),
    });
    const { traces, sink } = recordingSink();
    writer.write(uow, sink, context(), filledDraft(writer));
    const serialised = JSON.stringify(traces[0]);
    for (const [kind, text] of Object.entries(CONTENT)) {
      expect(serialised, `the trace contains the ${kind}`).not.toContain(text);
    }
  });

  it('logs the banner once however many turns are captured', () => {
    const { logger, warnings } = recordingLogger();
    const writer = new TraceWriter({
      logger,
      retentionDays: 30,
      debugContent: true,
      sealDebug: () => new Uint8Array([0]),
    });
    const { sink } = recordingSink();
    for (let turn = 0; turn < 3; turn += 1) {
      writer.write(uow, sink, context(), filledDraft(writer));
    }
    expect(warnings.filter((each) => each.event === 'debug.content_enabled')).toHaveLength(1);
  });

  it('refuses to run with the flag on and no seal, rather than storing cleartext', () => {
    // Refused at construction, not at the first capture. A writer that accepted the flag without
    // a seal would run normally until a turn finished and then either silently drop the capture
    // the host asked for, or — written the obvious way — store the prompt in the clear.
    expect(
      () => new TraceWriter({ logger: silentLogger, retentionDays: 30, debugContent: true }),
    ).toThrow(/refusing to run unsealed/);
  });

  it('refuses a retention that is not a positive whole number of days', () => {
    for (const retentionDays of [0, -1, 1.5, Number.NaN]) {
      expect(
        () => new TraceWriter({ logger: silentLogger, retentionDays, debugContent: false }),
        String(retentionDays),
      ).toThrow(/positive integer/);
    }
  });
});
