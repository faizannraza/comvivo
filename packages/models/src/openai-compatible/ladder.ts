/**
 * The degradation ladder (`05` §3.5.6; `M2-T12`).
 *
 * ## Why a ladder rather than a capability set
 *
 * A local server either has native tool calling or it does not, and either honours a JSON schema
 * or it does not. Those two axes give four useful combinations, and `05` §3.5.6 names them L1–L4
 * because **each one changes what the product can do**, not just how a request is shaped:
 *
 *  - **L1** is the cloud behaviour.
 *  - **L2** keeps every feature but routes tool calls through a text **envelope** the model fills
 *    in under a JSON schema. Parallel calls stop being guaranteed.
 *  - **L3** is the same envelope with only `json_object` to constrain it, so one repair retry.
 *  - **L4** is chat only. Extraction off, declassification off (which means **no constraints**),
 *    the guard deterministic-only and fail-closed, interjections off.
 *
 * L4 is the one worth reading twice. A group on L4 has a bot that can talk and cannot act, and —
 * because declassification is off — cannot apply a member's privacy constraints either. `03`
 * requires the guard to fail closed there, which means the bot says less rather than risking
 * saying something private. That is why `doctor` and the wizard **refuse L4 for `chat` unless
 * `--force`**: it is a usable configuration, and it is not the product a host thinks they
 * installed.
 */

/** The four levels, best first. */
export const LADDER_LEVELS = ['L1', 'L2', 'L3', 'L4'] as const;

export type LadderLevel = (typeof LADDER_LEVELS)[number];

/** What a probe established about the server. Both fields are measurements, never hints. */
export interface ProbedCapabilities {
  /** Native `tools` with a parseable `tool_calls` response. */
  readonly nativeTools: boolean;
  /** Whether more than one tool call came back in one response. */
  readonly parallelTools: boolean;
  /** `response_format: {type:'json_schema', strict:true}` honoured. */
  readonly jsonSchema: boolean;
  /** `response_format: {type:'json_object'}` honoured. The fallback for `jsonSchema`. */
  readonly jsonObject: boolean;
  /** Whether `reasoning_effort` was accepted rather than rejected. */
  readonly reasoningEffort: boolean;
}

/**
 * Pick the level from what the probes measured.
 *
 * Deliberately **not** a lookup over the two booleans: the ordering matters and the order is the
 * specification. Native tools with no schema support is still L1 for tools and would be L3 for
 * structured routes, which is not a combination the ladder has — so the level is the **worse** of
 * the two axes, which is what makes it a ladder rather than a matrix.
 */
export function levelFor(probed: ProbedCapabilities): LadderLevel {
  if (probed.nativeTools && probed.jsonSchema) return 'L1';
  if (probed.jsonSchema) return 'L2';
  if (probed.jsonObject) return 'L3';
  return 'L4';
}

/** What each level permits. A total mapping, so adding a level is a compile error at every reader. */
export interface LevelBehaviour {
  /** Whether tools reach the model at all. */
  readonly tools: 'native' | 'envelope' | 'none';
  readonly structured: 'json_schema' | 'json_object' | 'none';
  /** Whether the envelope's output gets one repair attempt when it fails to validate. */
  readonly repairEnvelope: boolean;
  /** Whether `05` can promise that two tool calls in one response are both honoured. */
  readonly parallelToolsGuaranteed: boolean;
  /** Whether the extract, declassify and consolidate routes can run. */
  readonly structuredRoutes: boolean;
  /** Whether `doctor` and the wizard need `--force` to accept this level for `chat`. */
  readonly requiresForceForChat: boolean;
}

export const LEVEL_BEHAVIOUR: Readonly<Record<LadderLevel, LevelBehaviour>> = {
  L1: {
    tools: 'native',
    structured: 'json_schema',
    repairEnvelope: false,
    parallelToolsGuaranteed: true,
    structuredRoutes: true,
    requiresForceForChat: false,
  },
  L2: {
    tools: 'envelope',
    structured: 'json_schema',
    // The schema already constrains the envelope's shape, so a failure here is a *semantic* one in
    // a tool's own input — which the per-tool zod parse reports as an `is_error` envelope rather
    // than re-asking the model.
    repairEnvelope: false,
    parallelToolsGuaranteed: false,
    structuredRoutes: true,
    requiresForceForChat: false,
  },
  L3: {
    tools: 'envelope',
    structured: 'json_object',
    // `json_object` constrains the output to *some* JSON, not to our shape, so the envelope itself
    // can come back wrong. One repair, for `05` §3.5.3.3's reason: a second has a vanishing
    // success rate and a turn has a deadline.
    repairEnvelope: true,
    parallelToolsGuaranteed: false,
    structuredRoutes: true,
    requiresForceForChat: false,
  },
  L4: {
    tools: 'none',
    structured: 'none',
    repairEnvelope: false,
    parallelToolsGuaranteed: false,
    // Extraction off, declassification off — which means no member constraints are applied — and
    // the guard deterministic-only with fail-closed (`03`). A bot that can talk and cannot act.
    structuredRoutes: false,
    requiresForceForChat: true,
  },
};

/** One line for `doctor` and the wizard, in the product's voice. */
export function levelSummary(level: LadderLevel): string {
  switch (level) {
    case 'L1':
      return 'Full features: the server handles tools and JSON schemas natively.';
    case 'L2':
      return 'Tools work through a text protocol instead of natively. One tool at a time.';
    case 'L3':
      return 'Tools work through a text protocol with looser JSON support, so answers are retried once.';
    case 'L4':
      return 'Chat only. This server cannot use tools, so reminders, lists and the calendar are unavailable, and privacy constraints cannot be applied.';
  }
}
