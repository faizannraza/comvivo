/**
 * `ModelGateway` — the provider-neutral model port (`05` §4.1, `01` §7.5, `M2-T1`).
 *
 * Every model call in the product goes through this interface. `@comvivo/models` implements it for
 * Anthropic, OpenAI, Google and OpenAI-compatible local servers; `packages/evals` implements it
 * with fakes; and nothing else may know which provider answered. The purity rules in `CLAUDE.md`
 * §2 apply with full force here: **no SDK type appears in this file**, no `node:*` import, no
 * `Date`, no `Math.random`. `.dependency-cruiser.cjs` proves the first; the rest follow from the
 * package's rules.
 *
 * ## The type is the first guard on `01` §2.1
 *
 * §2.1 forbids sampling parameters (`temperature`, `top_p`, `top_k`), assistant prefill, and forced
 * tool choice. The cheapest enforcement is a request type that cannot express them: there is no
 * field to set, so a caller that wanted one has to change this file and a reviewer sees it.
 * `toolChoice` is `'auto' | 'none'` for the same reason — `'any'` and `{type:'tool'}` are not
 * representable. `M2-T6`'s `assertWireInvariants` is the second guard, over captured requests,
 * because an adapter can always add a field on its way out; and the live API is the third, since
 * current models reject all three with a 400.
 *
 * ## Facts verified against the live API on 2026-11-12, not recalled
 *
 * `CLAUDE.md` §6 asks for third-party facts to be re-checked at implementation time, and the
 * `claude-api` skill's own model table turned out to be cached from June and three releases stale.
 * Checked against `platform.claude.com/docs` instead:
 *
 *  - **Effort has five levels**, `low | medium | high | xhigh | max`, all five on Opus 5.5,
 *    Sonnet 5.5 and Haiku 5.5, set as `output_config.effort`, no beta header. `05` §4.1 declared
 *    three; `05` §3.5.2's capability registry already said five. The registry was right and §4.1
 *    is amended with this task.
 *  - **The API defaults differ per model**: `medium` on Opus 5.5 and Haiku 5.5, `high` on
 *    Sonnet 5.5 and Fable 5.2. That is why `effort` is **required** on `ModelTurnRequest` rather
 *    than optional: `CLAUDE.md` §3 says to set it explicitly, and an omitted value means a route's
 *    cost changes when its model does.
 *  - **`adaptive` is not an effort level.** It is a `thinking` mode. Adaptive thinking is always on
 *    for Opus 5.5 and cannot be disabled (a `thinking: {type:'disabled'}` request is a 400 at every
 *    effort level), which is why this port has no thinking field at all: there is nothing to
 *    choose. Adapters for models where it is a choice set it from the capability registry.
 *  - **Changing top-level effort invalidates the prompt cache**, and the three current models
 *    support a per-message effort change that does not. That is `SP-4`'s subject (`M2-T20`); the
 *    port expresses it as a `system`/`effort` message, which an adapter may render either way.
 */
import type { GroupId, JobId, StrictJsonSchema, TurnId } from '@comvivo/shared';
import type { ContextManifest } from '../runtime/traces.js';

/** Which implementation answered. `fake` is the deterministic family in `packages/evals`. */
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openai-compatible' | 'fake';

/** `05` §2.1's routes. Each resolves to its own model and its own budget share. */
export type ModelRoute = 'chat' | 'route' | 'extract' | 'declassify' | 'guard' | 'consolidate';

/** `economy` is the cost guard's step-down (`05` §3.9), and exists for `chat` only. */
export type RouteVariant = 'default' | 'economy';

/**
 * `output_config.effort` (`05` §3.5.2).
 *
 * Five levels, verified against the live documentation on 2026-11-12. `xhigh` sits between `high`
 * and `max` and is the level the docs recommend for long-horizon agentic work; `max` removes the
 * token ceiling altogether and is reserved for the rare case where correctness outweighs cost.
 * Not every model that accepts `max` accepts `xhigh`, so a route's level is validated against the
 * capability registry at boot (`M2-T2`) rather than assumed here.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Every effort level, lowest first — for a config validator and for a doctor listing. */
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * A cache breakpoint's lifetime (`05` §3.4.8).
 *
 * The 1-hour TTL costs more to write and is worth it for a prefix a group reuses all day; `SP-4`
 * measures which one each route should take.
 */
export interface CacheHint {
  readonly ttl: '5m' | '1h';
}

/**
 * One layer of the system prompt, with its own cache decision.
 *
 * `id` is ours, not the provider's: `05` §3.4 assembles the system prompt from named layers (the
 * charter, the group's constitution, the tool preamble) and the ids are what a trace shows when a
 * cache miss has to be explained.
 */
export interface SystemBlock {
  readonly id: string;
  readonly text: string;
  readonly cache?: CacheHint;
}

/** What a user turn can carry. `04` §3.8 and `11` own the media parts. */
export type UserPart =
  | { readonly type: 'text'; readonly text: string; readonly cache?: CacheHint }
  | {
      readonly type: 'image';
      readonly mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      readonly data: Uint8Array;
    }
  | { readonly type: 'document'; readonly mime: 'application/pdf'; readonly data: Uint8Array }
  | {
      readonly type: 'tool_result';
      readonly toolCallId: string;
      readonly content: string;
      readonly isError: boolean;
      readonly cache?: CacheHint;
    };

/**
 * A provider-originated assistant turn.
 *
 * **`raw` is re-sent verbatim and never interpreted.** Thinking blocks, OpenAI reasoning items and
 * Google thought signatures are all provider-private state that must round-trip unchanged or the
 * next request is rejected (or, worse, silently loses the model's reasoning). `view` is the
 * read-only normalisation the engine reads, and the two must describe the same turn: an adapter
 * that built a `view` from somewhere other than `raw` would be reporting a turn that never
 * happened.
 *
 * `provider` and `servedModel` travel with the message because `raw` is only valid for the pair
 * that produced it — replaying an Anthropic turn to Google is a bug this field makes detectable.
 */
export interface AssistantMessage {
  readonly role: 'assistant';
  readonly provider: ProviderId;
  readonly servedModel: string;
  readonly raw: unknown;
  readonly view: readonly AssistantPart[];
}

/**
 * The engine's view of an assistant turn.
 *
 * `opaque` is deliberately coarse: the engine must know *that* a provider-private block is present
 * (it affects nothing it can act on, and it must not be dropped from `raw`) without being able to
 * read it. Giving thinking text a typed home here is how a disclosure guard ends up with model
 * reasoning in a log — `08` §3.16 and `11` §3.10.2 both forbid it.
 */
export type AssistantPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_call';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'opaque';
      readonly kind:
        | 'thinking'
        | 'redacted_thinking'
        | 'reasoning'
        | 'thought_signature'
        | 'fallback'
        | 'server_tool'
        | 'other';
    };

/**
 * One message in a turn.
 *
 * The two `system` variants are **mid-conversation** operator messages, which the current models
 * accept in `messages` without invalidating the cached prefix — `notes`/`notice` carries text and
 * `effort` carries a level change. An adapter whose model does not support them renders them the
 * way that model allows (a text block after the tool results, or a new top-level value that costs
 * the cache); `05` §3.5.2's `midConversationSystem` capability decides which.
 */
export type ModelMessage =
  | { readonly role: 'user'; readonly content: readonly UserPart[] }
  | AssistantMessage
  | {
      readonly role: 'system';
      readonly kind: 'notes' | 'notice';
      readonly text: string;
      readonly scope: 'persistent' | 'turn';
    }
  | { readonly role: 'system'; readonly kind: 'effort'; readonly effort: Effort };

/**
 * A tool as the model sees it.
 *
 * `inputSchema` is a `StrictJsonSchema` and nothing else: `01` §2.1 requires `strict: true` tools,
 * which in turn require `additionalProperties: false` and an exhaustive `required`. The type is in
 * `@comvivo/shared` so `@comvivo/plugin-sdk` and `@comvivo/models` share one definition.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: StrictJsonSchema;
}

/**
 * One model call.
 *
 * `effort` is required and `toolChoice` cannot be forced — see the header. `maxOutputTokens` is a
 * hard ceiling that **includes thinking** on every current model, which is why it is required
 * rather than defaulted: a value chosen for a reply that did not account for thinking is how a
 * turn gets truncated mid-sentence.
 */
export interface ModelTurnRequest {
  readonly route: ModelRoute;
  readonly variant?: RouteVariant;
  /** A stable label for cost attribution and `UsageRecord.purpose` (`02` §3.3.7). */
  readonly purpose: string;
  readonly system: readonly SystemBlock[];
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
  readonly toolChoice: 'auto' | 'none';
  readonly effort: Effort;
  readonly maxOutputTokens: number;
  readonly correlation: {
    readonly groupId?: GroupId;
    readonly turnId?: TurnId;
    readonly step?: number;
  };
  /**
   * Ours, and **never sent to a provider**.
   *
   * The manifest describes what the context builder chose to include, which is exactly the kind of
   * metadata that must not leak into a prompt. `M2-T6`'s wire test asserts the request it builds
   * carries no field derived from here.
   */
  readonly meta?: { readonly manifest?: ContextManifest };
}

/**
 * Why the model stopped.
 *
 * `raw` is the provider's own string, kept because this union is a normalisation and a trace has to
 * be able to show what actually came back. Two notes on the mapping:
 *
 *  - **`stop_sequence` is absent** because we never send `stop_sequences`; if one ever arrives it
 *    maps to `other` with the raw value preserved rather than silently becoming `end_turn`.
 *  - **`context_overflow` is ours, not the wire's.** It is what an adapter reports when a request
 *    is refused for length (a 400, or a `countTokens` check before sending), so the engine has one
 *    branch for "this turn cannot be sent as composed" instead of inspecting error codes.
 *
 * The `refusal` variant is the only one with extra fields, and that matches the API: `stop_details`
 * is populated **only** for a refusal and is `null` for every other reason, so a reader must narrow
 * before touching `category`. `servedByFallback` records whether the server-side refusal fallback
 * answered (`01` §2.1 requires it enabled on Opus requests), because a reply from the fallback
 * model is a different model's output and `05` §3.9.2 bills it at that model's rates.
 */
export type StopInfo =
  | {
      readonly reason:
        | 'end_turn'
        | 'tool_use'
        | 'max_tokens'
        | 'pause_turn'
        | 'context_overflow'
        | 'other';
      readonly raw: string;
    }
  | {
      readonly reason: 'refusal';
      readonly raw: string;
      readonly category: string | null;
      readonly explanation?: string;
      readonly servedByFallback: boolean;
    };

/** Every stop reason, for a total mapping (`shared/assert-never.ts` explains the idiom). */
export type StopReason = StopInfo['reason'];

/**
 * Does this stop reason mean the engine should run the tools and call again?
 *
 * A total `Record` rather than a `switch`: the house idiom (`shared/src/assert-never.ts`) is that a
 * mapping over a closed union requires every key, so adding a reason is a compile error here
 * instead of a silent `false`. Getting this wrong in the permissive direction is an infinite tool
 * loop; in the strict direction it is a turn that drops the model's tool calls on the floor.
 */
const CONTINUES_TOOL_LOOP: Readonly<Record<StopReason, boolean>> = {
  end_turn: false,
  tool_use: true,
  // `pause_turn` is the provider asking to be called again with the same messages, which is the
  // same control flow as a tool round trip even though no tool ran.
  pause_turn: true,
  max_tokens: false,
  context_overflow: false,
  refusal: false,
  other: false,
};

/** True when the engine must send another request to finish the turn. */
export function continuesToolLoop(stop: StopInfo): boolean {
  return CONTINUES_TOOL_LOOP[stop.reason];
}

/** Narrow to the refusal variant, which is the only one carrying a category. */
export function isRefusal(
  stop: StopInfo,
): stop is Extract<StopInfo, { readonly reason: 'refusal' }> {
  return stop.reason === 'refusal';
}

/**
 * Is this stop reason a failure the caller has to handle rather than a finished turn?
 *
 * `max_tokens` and `context_overflow` are *successful* requests whose output is unusable as-is, so
 * they are failures to the engine and not to the gateway. A total mapping again, for the same
 * reason as above.
 */
const IS_INCOMPLETE: Readonly<Record<StopReason, boolean>> = {
  end_turn: false,
  tool_use: false,
  pause_turn: false,
  max_tokens: true,
  context_overflow: true,
  refusal: true,
  other: true,
};

/** True when the turn did not finish with usable output. */
export function isIncomplete(stop: StopInfo): boolean {
  return IS_INCOMPLETE[stop.reason];
}

/**
 * One billed provider round trip.
 *
 * An array of these rather than one total, because `05` §3.9.2 bills **per iteration**: a request
 * that was refused and answered by the server-side fallback produced two iterations at two
 * different prices, and a single `usage` object cannot express that. `kind` distinguishes them.
 *
 * The two cache-write fields are separate because the TTLs are priced separately. On the wire they
 * arrive as one `cache_creation_input_tokens` plus a `cache_creation` breakdown
 * (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`); `M2-T6` maps them and `M2-T3` prices
 * them. `01` §14 A32 is the reason `input` is defined as the **uncached** count here and summed
 * with the cache fields for the GenAI `gen_ai.usage.input_tokens` attribute: reading the
 * provider's `input_tokens` alone under-reports input by the cache hit rate, in the direction that
 * looks reassuring on a cost dashboard.
 */
export interface UsageIteration {
  readonly model: string;
  readonly kind: 'message' | 'fallback_message';
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly output: number;
  readonly reasoning?: number;
  readonly batch: boolean;
}

/** The result of one `run`. */
export interface ModelTurnResult {
  readonly assistant: AssistantMessage;
  readonly stop: StopInfo;
  /**
   * Visible text **after the last fallback boundary**.
   *
   * Not a concatenation of every text block: when a refusal fallback answered, the declining
   * model's partial output is in `assistant.raw` and must not be shown to anybody. `05` §3.5.3.2
   * owns the boundary rule.
   */
  readonly text: string;
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[];
  readonly usage: readonly UsageIteration[];
  readonly model: {
    readonly provider: ProviderId;
    readonly requested: string;
    readonly served: string;
  };
  readonly latency: { readonly ttftMs?: number; readonly totalMs: number };
  readonly diagnostics: {
    readonly requestId?: string;
    /** How many times the adapter rewrote the request (betas withdrawn, parts dropped). */
    readonly inputTransformations: number;
    readonly betas: readonly string[];
  };
}

/**
 * A schema-constrained call (`05` §3.6).
 *
 * `schema` is a zod type rather than a `StrictJsonSchema`: the caller owns the parse, the converter
 * derives the wire schema from it (`M2-T4`), and the response is re-validated through the same zod
 * type. One source of truth for the shape, and a provider that returns something schema-valid but
 * semantically wrong still fails the parse.
 *
 * Typed as a structural minimum rather than importing zod's `ZodType`, because `@comvivo/core` must
 * not depend on a validation library's type surface for a port's shape — the engine passes whatever
 * zod gives it and `@comvivo/models` does the parsing.
 */
export interface SchemaLike<T> {
  readonly safeParse: (
    input: unknown,
  ) => { readonly success: true; readonly data: T } | { readonly success: false };
}

export interface StructuredRequest<T> {
  readonly route: ModelRoute;
  readonly variant?: RouteVariant;
  readonly purpose: string;
  readonly system: readonly SystemBlock[];
  readonly input: readonly UserPart[];
  readonly schema: SchemaLike<T>;
  /** Names the schema on the wire; part of the cache prefix, so it must be stable. */
  readonly schemaName: string;
  readonly effort: Effort;
  readonly maxOutputTokens: number;
  readonly correlation: {
    readonly groupId?: GroupId;
    readonly turnId?: TurnId;
    readonly jobId?: JobId;
  };
}

/**
 * The four outcomes of a structured call.
 *
 * `invalid` and `truncated` are distinct on purpose: the first means the model answered and the
 * answer did not match the schema (retry differently, or give up), the second means it ran out of
 * output tokens (retry with a larger ceiling). Collapsing them is how a caller ends up retrying a
 * prompt that will never validate. Every variant carries `usage`, because a failed call is a billed
 * call and `02` §3.3.7's ledger must not lose it.
 */
export type StructuredResult<T> =
  | {
      readonly kind: 'ok';
      readonly value: T;
      readonly usage: readonly UsageIteration[];
      readonly model: string;
    }
  | {
      readonly kind: 'refused';
      readonly category: string | null;
      readonly usage: readonly UsageIteration[];
      readonly model: string;
    }
  | {
      readonly kind: 'invalid';
      readonly issues: string;
      readonly usage: readonly UsageIteration[];
      readonly model: string;
    }
  | {
      readonly kind: 'truncated';
      readonly usage: readonly UsageIteration[];
      readonly model: string;
    };

/** Every structured outcome, for a total mapping. */
export type StructuredKind = StructuredResult<unknown>['kind'];

/** Narrow to the success variant without a `switch` at every call site. */
export function isStructuredOk<T>(
  result: StructuredResult<T>,
): result is Extract<StructuredResult<T>, { readonly kind: 'ok' }> {
  return result.kind === 'ok';
}

/**
 * Is retrying this outcome capable of producing a different answer?
 *
 * A total mapping, so a new outcome has to decide. `refused` is `false` deliberately: a policy
 * decline is a decision, and a retry loop around it is both a cost leak and a way to launder a
 * refusal into an answer.
 */
const IS_RETRYABLE: Readonly<Record<StructuredKind, boolean>> = {
  ok: false,
  refused: false,
  invalid: true,
  truncated: true,
};

/** True when a second attempt could succeed (`05` §3.6.2 allows exactly one repair). */
export function isStructuredRetryable(result: StructuredResult<unknown>): boolean {
  return IS_RETRYABLE[result.kind];
}

/** The usage of any outcome, so the cost ledger needs no narrowing. */
export function usageOf(result: StructuredResult<unknown>): readonly UsageIteration[] {
  return result.usage;
}

/** A submitted batch (`05` §3.5.3's Batches mapping). */
export interface BatchHandle {
  readonly provider: ProviderId;
  readonly batchId: string;
  readonly customIds: readonly string[];
  /** ISO-8601, from the provider. A string because this is a provider-reported instant. */
  readonly submittedAt: string;
}

export interface BatchStatus {
  readonly state: 'in_progress' | 'canceling' | 'ended';
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * What a route's model can do (`05` §3.5.2's capability registry).
 *
 * The registry's JSON is validated into this at boot and a route whose requirements are unmet fails
 * the boot with a `doctor` hint rather than at the first call. The fields are the ones a *caller*
 * has to branch on; everything else the registry knows stays inside `@comvivo/models`.
 */
export interface ModelFeatureSet {
  readonly contextWindow: number;
  readonly maxOutput: number;
  /** Which effort levels this model accepts — not every model that takes `max` takes `xhigh`. */
  readonly effort: readonly Effort[];
  readonly defaultEffort: Effort;
  readonly tools: 'native_strict' | 'native' | 'envelope' | 'probe' | 'none';
  readonly structured: 'native' | 'envelope' | 'probe' | 'none';
  readonly parallelTools: boolean;
  /** Whether a `system` message inside `messages` is accepted (`ModelMessage`'s two variants). */
  readonly midConversationSystem: boolean;
  /** Whether effort can change mid-conversation without discarding the cached prefix. */
  readonly perMessageEffort: boolean;
  readonly promptCaching: 'explicit' | 'automatic' | 'implicit' | 'server_prefix' | 'none';
  readonly minCacheableTokens: number;
  readonly maxBreakpoints: number;
  readonly vision: boolean;
  readonly pdf: boolean;
  readonly batches: boolean;
  readonly countTokens: boolean;
}

/** What a route resolves to, for `doctor` and for a trace. */
export interface RouteInfo {
  readonly provider: string;
  readonly model: string;
  readonly supports: ModelFeatureSet;
}

/**
 * Every way a model call can fail (`05` §3.5.3.10).
 *
 * Mapped from the provider's typed exceptions by the adapter, so the middleware above it can decide
 * to retry, degrade or surface without knowing whose SDK threw. `aborted` is separate from
 * `timeout` because one is the caller's decision and the other is ours.
 */
export type ModelCallErrorKind =
  | 'aborted'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'overloaded'
  | 'server'
  | 'auth'
  | 'permission'
  | 'billing'
  | 'model_not_found'
  | 'bad_request'
  | 'request_too_large'
  | 'unknown';

/** Which kinds are worth retrying, as a total mapping (`05` §3.5.3.10's table). */
const KIND_IS_RETRYABLE: Readonly<Record<ModelCallErrorKind, boolean>> = {
  aborted: false,
  timeout: true,
  network: true,
  rate_limited: true,
  overloaded: true,
  server: true,
  auth: false,
  permission: false,
  billing: false,
  model_not_found: false,
  bad_request: false,
  request_too_large: false,
  unknown: false,
};

/**
 * A failed model call.
 *
 * `detail.retryAfterMs` is the provider's own `retry-after` where it sent one; the limiter honours
 * it rather than its own backoff, because a server that said when to come back has better
 * information than we do.
 */
export class ModelCallError extends Error {
  readonly kind: ModelCallErrorKind;
  readonly provider: ProviderId;
  readonly detail: {
    readonly status?: number;
    readonly type?: string;
    readonly retryAfterMs?: number;
    readonly requestId?: string;
  };

  constructor(
    kind: ModelCallErrorKind,
    provider: ProviderId,
    detail: ModelCallError['detail'] = {},
  ) {
    // The message is the kind, so a log line is useful without the structured fields. Provider
    // messages are deliberately not interpolated: they have carried prompt fragments before.
    super(kind);
    this.name = 'ModelCallError';
    this.kind = kind;
    this.provider = provider;
    this.detail = detail;
  }

  /** Whether the middleware should try again (`05` §3.5.3.10). */
  get retryable(): boolean {
    return KIND_IS_RETRYABLE[this.kind];
  }
}

/**
 * The port (`01` §7.5).
 *
 * The optional members are optional because not every provider has them: `countTokens` needs a
 * provider endpoint, and Batches is Anthropic-only in 1.0. A caller that needs one asks
 * `routeInfo` first — `05` §3.5.2's `consolidate` route "prefers `batches`, else synchronous" is
 * exactly that check.
 *
 * `run` and `structured` both take an `AbortSignal` and no timeout: `01` §8 gives every turn a
 * deadline and plumbs one signal through the whole call tree, so a second timeout here would be a
 * second answer to the same question.
 */
export interface ModelGateway {
  run(req: ModelTurnRequest, signal: AbortSignal): Promise<ModelTurnResult>;
  structured<T>(req: StructuredRequest<T>, signal: AbortSignal): Promise<StructuredResult<T>>;
  /** `04` §3.2 owns the embedding model; `purpose` picks the asymmetric prefix it needs. */
  embed(texts: readonly string[], purpose: 'query' | 'document'): Promise<readonly Float32Array[]>;
  countTokens?(req: ModelTurnRequest): Promise<number>;
  submitBatch?(
    reqs: readonly (StructuredRequest<unknown> & { readonly customId: string })[],
  ): Promise<BatchHandle>;
  pollBatch?(handle: BatchHandle): Promise<BatchStatus>;
  batchResults?(
    handle: BatchHandle,
  ): AsyncIterable<{ readonly customId: string; readonly result: StructuredResult<unknown> }>;
  routeInfo(route: ModelRoute, variant?: RouteVariant): RouteInfo;
}
