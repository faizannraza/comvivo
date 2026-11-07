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
