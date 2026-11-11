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
 * `turn_traces.model_calls` — a **storage contract**.
 *
 * `M5` owns what a model call records; `11` §12-1 already fixes one field of it (`requestHash`).
 * Pinned here: an array of JSON objects, bounded in both length and bytes, so a runaway tool loop
 * cannot write an unbounded trace.
 */
export const ModelCallTraceSchema = storageContract(
  'ModelCallTraceSchema',
  jsonObjectShape,
  'model call trace',
);

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

/** The seven `turn_traces` JSON columns the combined budget covers (`02` §3.3.9). */
export const TRACE_JSON_COLUMNS = [
  'trigger',
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
 * The per-column caps are 128 KiB each and there are seven columns, so a row can satisfy every
 * individual cap and still be ~896 KiB — the combined budget was published as a constant with
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
