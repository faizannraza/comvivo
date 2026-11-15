/**
 * Turn traces (`02` §3.3.7; `05` §3.10, `11` §12-1).
 *
 * A trace is what makes the agent's behaviour inspectable: `09`'s dashboard renders one per turn,
 * and `11`'s replay harness reproduces a turn from it. Two constraints shape every schema here.
 *
 * **The context manifest holds ids and label ids only** (`02` §3.3.9). A trace is retained for
 * days and read by anyone the trace's own `label_id` admits, so recording *what was in the context
 * window* as text would be a second, longer-lived copy of the most sensitive assembly the product
 * performs. Ids mean the dashboard re-reads each item through `canRead` at render time, which is
 * the only way a trace can be shown to one member and not another.
 *
 * **Rendered prompts and responses are not here at all.** `05` §3.10.1 puts them in
 * `turn_trace_debug`, behind `COMVIVO_DEBUG_CONTENT=1`, field-encrypted, host-only, never
 * exported, expiring in 24 hours.
 */
import { capped, idSchema, z } from '@comvivo/shared';
import { jsonObjectShape, storageContract } from '../domain/storage-contract.js';

/** `02` §3.3.9: all `turn_traces.*` columns together are capped at 512 KiB. */
const TRACE_TOTAL_MAX_BYTES = 512 * 1024;

/** Each individual trace column gets a share, so one list cannot consume the whole budget. */
const TRACE_COLUMN_MAX_BYTES = 128 * 1024;

/**
 * `turn_traces.context_manifest`: what the context window was built from, by reference.
 *
 * `labelIds` is the field invariant **I1** is audited through — it is the set of labels that were
 * eligible when the context was assembled, so a reviewer can check that nothing outside the
 * audience's eligible set reached the model.
 */
export const ContextManifestSchema = capped(
  z.object({
    /** Messages included, by id. Never their text. */
    messageIds: z.array(idSchema('msg')).max(500),
    /** Memory items included, by id. */
    memoryIds: z.array(idSchema('mem')).max(500),
    /** Interned label ids that were eligible. The I1 audit reads this. */
    labelIds: z.array(z.int()).max(500),
    /** Coordination entities included, by id string. */
    entityRefs: z.array(z.string().max(40)).max(200),
    tokenEstimate: z.int().min(0),
    /** `11` §12-1: identifies the assembly, so a replay can assert it reproduced it. */
    contextHash: z.string().max(64),
  }),
  TRACE_COLUMN_MAX_BYTES,
  'context manifest',
);

export type ContextManifest = z.infer<typeof ContextManifestSchema>;

/**
 * `turn_traces.latency`: where the time went.
 *
 * Named phases rather than a free map, because `11`'s performance budgets are stated per phase and
 * a budget you cannot read off a trace is a budget nobody checks.
 */
export const LatencyTraceSchema = capped(
  z.object({
    totalMs: z.int().min(0),
    buildContextMs: z.int().min(0),
    modelMs: z.int().min(0),
    toolsMs: z.int().min(0),
    guardMs: z.int().min(0),
    commitMs: z.int().min(0),
  }),
  TRACE_COLUMN_MAX_BYTES,
  'latency trace',
);

export type LatencyTrace = z.infer<typeof LatencyTraceSchema>;

/**
 * `turn_traces.replay` (`11` §12-1): everything needed to reproduce the turn.
 *
 * Every field is a version or a hash of an input, so a replay that diverges can say *which* input
 * moved. `otelTraceId` links the trace to a distributed trace when tracing is enabled, which is
 * the only field here that is about observing rather than reproducing.
 */
export const TraceReplayMetaSchema = capped(
  z.object({
    contextHash: z.string().max(64),
    promptVersion: z.string().max(60),
    toolCatalogHash: z.string().max(64),
    constitutionVersionId: z.string().max(40).nullable(),
    codeVersion: z.string().max(60),
    otelTraceId: z.string().max(64).nullable(),
  }),
  TRACE_COLUMN_MAX_BYTES,
  'trace replay meta',
);

export type TraceReplayMeta = z.infer<typeof TraceReplayMetaSchema>;

/**
 * `turn_traces.trigger` — a **storage contract**.
 *
 * What started the turn. `05` §3.2's router produces it, and its arms mirror `turns.kind`, which
 * is already a column — so the useful interior is the router's own classification output, defined
 * by `M5`. Pinned: a JSON object capped at 128 KiB.
 */
export const TraceTriggerSchema = storageContract(
  'TraceTriggerSchema',
  jsonObjectShape,
  'trace trigger',
);

/**
 * `turn_traces.model_calls`: one row of `05` §3.10.1's `modelCalls[]`.
 *
 * Tightened from a free-form object at `M3-T20`, which owns `05` §3.10. Every field is a number,
 * an enum or a hash — **nothing here is content**, which is what lets a trace be shown to a member
 * whose own message produced the call.
 *
 * `cacheReadRatio` is stored rather than derived, and that is deliberate: it is the number
 * `01` §14 A32 is about, and deriving it at render time means every reader has to agree on the
 * denominator. Here it is `cacheRead / (input + cacheRead)` computed once, by the writer that had
 * the iteration in hand.
 *
 * The four token fields are separate for the reason `02` §3.3.7 gives about `usage_records`:
 * cache writes are charged by TTL and cache reads at a tenth of input, so a single `inputTokens`
 * would make the cost unreproducible from the record.
 */
export const ModelCallTraceSchema = capped(
  z.object({
    /** `05` §3.5's `ModelRoute`, as a string so `traces.ts` does not import the model port. */
    route: z.string().max(24),
    variant: z.enum(['default', 'economy']),
    provider: z.string().max(32),
    requestedModel: z.string().max(80),
    /** `05` S9: the model that **answered**, which the refusal fallback can change. */
    servedModel: z.string().max(80),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    /** Which step of the agent loop this call was, from 1. */
    step: z.int().min(1).max(100),
    stopReason: z.string().max(32),
    /** `05` §3.5.3.2's refusal category, when the stop reason was `refusal`. */
    refusalCategory: z.string().max(60).nullable(),
    inputTokens: z.int().min(0),
    cacheReadTokens: z.int().min(0),
    cacheWriteTokens: z.int().min(0),
    outputTokens: z.int().min(0),
    reasoningTokens: z.int().min(0),
    /** `cacheRead / (input + cacheRead)`, or 0 when there was no input at all. */
    cacheReadRatio: z.number().min(0).max(1),
    ttftMs: z.int().min(0).nullable(),
    latencyMs: z.int().min(0),
    /** `11` §12-1: what a replay compares to decide whether the request itself moved. */
    requestHash: z.string().max(64),
    /** How many times the adapter rewrote the request (betas withdrawn, parts dropped). */
    inputTransformations: z.int().min(0),
  }),
  TRACE_COLUMN_MAX_BYTES,
  'model call trace',
);

export type ModelCallTrace = z.infer<typeof ModelCallTraceSchema>;

/**
 * `turn_traces.router`: `05` §3.10.1's `router` row.
 *
 * Written by `M3-T21`. Here because §3.10.1 is `M3-T20`'s section and the trace has to have
 * somewhere to put it — `02` §3.3.9's column list predated §3.10.1 being implemented, and five of
 * its thirteen rows had no column. `/why` reads this one first: "You asked me directly" is
 * `ruleId` plus `reason`.
 *
 * `classifierSignals` is a bounded map of numbers, not the classifier's output text. A signal is a
 * score; the message that produced it is in `contextManifest.messageIds`.
 */
export const TraceRouterSchema = capped(
  z.object({
    /** `05` §3.2.1's R0–R13. */
    ruleId: z.string().max(16),
    /** A reason **code**, not a sentence: `05` §3.11's copy renders the sentence. */
    reason: z.string().max(60),
    planning: z.boolean(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    /** A BCP 47 tag the router inferred, or `null` when it could not tell. */
    languageHint: z.string().max(35).nullable(),
    classifierSignals: z.record(z.string().max(40), z.number()).optional(),
  }),
  TRACE_COLUMN_MAX_BYTES,
  'trace router',
);

export type TraceRouter = z.infer<typeof TraceRouterSchema>;

/**
 * `turn_traces.binding`: `05` §3.10.1's `binding` row — who asked, and who could read the answer.
 *
 * This is the **I3 (requester authority)** record. `requesterPrincipal` is the principal the turn
 * ran as, `audienceReaderSetId` is the interned audience, and `capabilitySetHash` is what the
 * requester was allowed to do at that moment — so a reviewer can tell a turn that was permitted
 * from one that would be permitted now.
 *
 * `includesMinor` is a boolean and not a list of ids, because `03` §3.5's rules turn on *whether*
 * a minor was in the audience and naming them in a retained artefact would be the leak the rule
 * exists to prevent.
 */
export const TraceBindingSchema = capped(
  z.object({
    requesterPrincipal: z.string().max(60),
    audienceReaderSetId: z.int().min(1),
    includesMinor: z.boolean(),
    capabilitySetHash: z.string().max(64),
  }),
  TRACE_COLUMN_MAX_BYTES,
  'trace binding',
);

export type TraceBinding = z.infer<typeof TraceBindingSchema>;

/**
 * `turn_traces.prompt`: `05` §3.10.1's `prompt` row — which prompt, by version and hash.
 *
 * Separate from `replay` even though both hold hashes, because they answer different questions.
 * `replay` is `11` §12-1's reproduction set — the inputs a replay pins. This is the prompt's own
 * **structure**: which charter, which profile, and the four cache-breakpoint hashes `05` §3.4.8
 * keys the prompt cache on, so a cache miss can be attributed to the layer that moved.
 *
 * `partTokens` is per cache breakpoint rather than per message: `05` §3.4.8 has four, and the
 * estimate is what makes a cache-read ratio interpretable.
 */
export const TracePromptSchema = capped(
  z.object({
    charterVersion: z.string().max(40),
    profile: z.string().max(40),
    catalogHash: z.string().max(64),
    globalHash: z.string().max(64),
    groupLayerHash: z.string().max(64),
    turnSkeletonHash: z.string().max(64),
    partTokens: z.array(z.int().min(0)).max(16),
  }),
  TRACE_COLUMN_MAX_BYTES,
  'trace prompt',
);

export type TracePrompt = z.infer<typeof TracePromptSchema>;

/**
 * `turn_traces.output`: `05` §3.10.1's `output` row — the shape of what was sent.
 *
 * Counts only. `05` §3.10.1 writes "Part count, mentions count, links stripped, reaction ack", and
 * every one of those is a number because the **text** of the reply is the one thing a member can
 * already see and a trace must not outlive: the reply is in `messages`, which has its own
 * retention, and `03` §3.7's erasure removes it there.
 */
export const TraceOutputSchema = capped(
  z.object({
    partCount: z.int().min(0),
    mentionsCount: z.int().min(0),
    linksStripped: z.int().min(0),
    reactionAck: z.boolean(),
  }),
  TRACE_COLUMN_MAX_BYTES,
  'trace output',
);

export type TraceOutput = z.infer<typeof TraceOutputSchema>;

/**
 * `turn_traces.cost_by_route`: `05` §3.10.1's `cost` row — micro-USD **by route**.
 *
 * `cost_micros` already holds the total, and a reader could sum this to get it. Both exist because
 * they are read by different things for different reasons: the total is a column a budget query
 * aggregates (Q-USE-1), and the breakdown is what tells a host that a turn cost what it did
 * because the guard ran four times. Summing a JSON column per row is not a query `02` wants on
 * the budget path.
 */
export const TraceCostSchema = capped(
  z.record(z.string().max(24), z.int().min(0)),
  TRACE_COLUMN_MAX_BYTES,
  'trace cost by route',
);

export type TraceCost = z.infer<typeof TraceCostSchema>;

/** `turn_traces.tool_calls` — a **storage contract**; `M5` owns the interior. */
export const ToolCallTraceSchema = storageContract(
  'ToolCallTraceSchema',
  jsonObjectShape,
  'tool call trace',
);

/** `turn_traces.policy_decisions` — a **storage contract**; `M4` owns the interior. */
export const PolicyDecisionTraceSchema = storageContract(
  'PolicyDecisionTraceSchema',
  jsonObjectShape,
  'policy decision trace',
);

/** `turn_traces.guard_results` — a **storage contract**; `M5` owns the interior. */
export const GuardResultTraceSchema = storageContract(
  'GuardResultTraceSchema',
  jsonObjectShape,
  'guard result trace',
);

/** The combined budget `02` §3.3.9 sets for one trace row's JSON columns. */
export const TRACE_TOTAL_BUDGET_BYTES = TRACE_TOTAL_MAX_BYTES;

/** The twelve `turn_traces` JSON columns the combined budget covers (`02` §3.3.9). */
export const TRACE_JSON_COLUMNS = [
  'trigger',
  // `M3-T20`: `05` §3.10.1's five rows that had no column. The combined budget covers them for
  // the same reason it covers the others — twelve columns at 128 KiB each is 1.5 MiB, and the
  // 512 KiB cap is what makes the writer's truncation the bound that actually holds.
  'router',
  'binding',
  'prompt',
  'output',
  'cost_by_route',
  'context_manifest',
  'model_calls',
  'tool_calls',
  'policy_decisions',
  'guard_results',
  'latency',
] as const;

export type TraceJsonColumn = (typeof TRACE_JSON_COLUMNS)[number];

/** How many UTF-8 bytes a trace row's JSON columns occupy together. */
export function traceRowBytes(row: Partial<Record<TraceJsonColumn, unknown>>): number {
  let total = 0;
  for (const column of TRACE_JSON_COLUMNS) {
    const value = row[column];
    if (value === undefined) continue;
    // Byte length, not string length: a trace carries member handles and group names, and one
    // emoji is four bytes where `.length` says two.
    // No `?? ''`: in `core`'s lib (`ES2024`, `types: []`) `JSON.stringify` is typed as returning
    // `string`, so a fallback is an unnecessary condition the lint rejects — and `value` is never
    // `undefined` here, because the branch above skipped it. `shared/src/zod.ts` needs a helper
    // for this and `core` does not, which is a difference in `lib`, not in the runtime.
    total += utf8Bytes(JSON.stringify(value));
  }
  return total;
}

/**
 * Whether a trace row fits `02` §3.3.9's **combined** 512 KiB budget.
 *
 * The per-column caps are 128 KiB each and there are twelve columns, so a row can satisfy every
 * individual cap and still be ~1.5 MiB — the combined budget was published as a constant with
 * nothing reading it, which made it a number in a spec rather than a bound. Found by the M1
 * independent review.
 *
 * Returns the overage rather than throwing, because the caller's right response is to **drop
 * detail and keep the trace**, not to fail the turn: `05` §3.10 makes the trace an observability
 * artefact, and a turn that failed because its own trace was too big would be the worst possible
 * trade. The writer (`M1-T21`'s `SqliteTraceRepository`) halves the longest list until the row
 * fits and returns what it dropped, so a caller cannot lose half its tool calls silently.
 * `M1-T22` is the outbox, not the trace — a mis-reference corrected when the writer landed.
 */
export function traceBudgetOverage(row: Partial<Record<TraceJsonColumn, unknown>>): number {
  return Math.max(0, traceRowBytes(row) - TRACE_TOTAL_BUDGET_BYTES);
}

/**
 * UTF-8 byte length, without `Buffer` or `TextEncoder`.
 *
 * `@comvivo/core` is pure (`CLAUDE.md` §2): no `node:*`, and its `lib` is `ES2024` with `types: []`
 * so `TextEncoder` is not declared either. Counting code points by range is the arithmetic those
 * would have done.
 */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
