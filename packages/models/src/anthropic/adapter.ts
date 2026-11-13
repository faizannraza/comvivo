/**
 * The Anthropic adapter's `run()` (`05` §3.5.3.1; `M2-T6`).
 *
 * The reference adapter: every other provider is measured against this one, and `11` §3.1.9's
 * contract suite asserts `01` §2.1's rules on the requests it actually puts on the wire.
 *
 * ## Streaming, through the SDK's own accumulator
 *
 * `client.beta.messages.stream(params).finalMessage()` rather than hand-wiring `.on()` events into
 * a promise. Three reasons, in order of how much they would cost to get wrong: the SDK reassembles
 * `input_json_delta` fragments into parsed tool inputs (a reader that concatenates by hand works
 * for an empty input and fails for every real call), it tolerates `ping` frames and partial
 * frames, and it is the path the SDK's retry logic is written for. Streaming at all is required
 * rather than preferred: these models allow up to 128K output tokens and a non-streaming request
 * that large hits the HTTP timeout.
 *
 * ## What `run()` does not do
 *
 * No retries of its own beyond the SDK's `maxRetries` (`05` §3.5.3.10: interactive routes rely on
 * the SDK, background routes on the job queue). No breaker, no limiter, no usage persistence —
 * `M2-T9`'s middleware wraps this. No `structured()`, `countTokens()` or Batches — `M2-T8`. The
 * adapter's job is one request, one normalised result, and an error whose kind is this project's
 * rather than somebody's SDK.
 *
 * ## Time
 *
 * `clock` is injected for the same reason it is everywhere else, and `performance.now()` is used
 * for the two latency numbers: a wall clock can step backwards under NTP, which would produce a
 * negative `ttftMs` in a trace. `05` §3.5.3.1's `timeout × (maxRetries + 1)` worst case is bounded
 * by the turn's `AbortSignal`, which the caller owns.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelGateway,
  ModelRoute,
  ModelTurnRequest,
  ModelTurnResult,
  RouteInfo,
  RouteVariant,
  StructuredRequest,
  StructuredResult,
} from '@comvivo/core';
import { ModelCallError } from '@comvivo/core';
import type { Clock, Logger, SecretString } from '@comvivo/shared';
import type { RouteBinding } from '../registry/resolve.js';
import { toModelCallError } from './errors.js';
import { buildChatRequest } from './request.js';
import {
  ANTHROPIC_PROVIDER,
  assistantMessageOf,
  readStop,
  toolCallsAfterLastFallback,
  usageIterations,
  visibleTextAfterLastFallback,
} from './response.js';

/** `05` §3.5.3.1's client defaults. The TS SDK's `timeout` is in **milliseconds**. */
export const CLIENT_DEFAULTS = {
  maxRetries: 2,
  timeoutMs: 120_000,
} as const;

export interface AnthropicAdapterDeps {
  /** Resolve a route to its binding. `M2-T2`'s resolver, curried by the composition root. */
  readonly bindingFor: (route: ModelRoute, variant?: RouteVariant) => RouteBinding;
  /** The betas the probe found available (`M2-T8`). Empty is a valid, fully functional adapter. */
  readonly availableBetas: readonly Anthropic.AnthropicBeta[];
  readonly clock: Clock;
  readonly logger: Logger;
  /** Absent means the SDK resolves credentials itself (`ANTHROPIC_API_KEY`, or an `ant` profile). */
  readonly apiKey?: SecretString;
  /** Proxies only (`05` §3.5.3.1). Host-only config (`01` §14 A14). */
  readonly baseUrl?: string;
  /** Injected in tests; the real client otherwise. */
  readonly client?: Anthropic;
}

/**
 * Build the SDK client.
 *
 * No `logLevel`, no `metadata.user_id`, no `service_tier`, no `speed`, no `inference_geo`
 * (`05` §3.5.3.1). Those are not omissions: `user_id` would send a member identifier to a
 * provider, and the three routing fields are either unavailable on our models or change pricing
 * without changing behaviour.
 */
export function createAnthropicClient(deps: AnthropicAdapterDeps): Anthropic {
  if (deps.client !== undefined) return deps.client;
  return new Anthropic({
    ...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey.expose() }),
    ...(deps.baseUrl === undefined ? {} : { baseURL: deps.baseUrl }),
    maxRetries: CLIENT_DEFAULTS.maxRetries,
    timeout: CLIENT_DEFAULTS.timeoutMs,
  });
}

export interface RunOptions {
  /** True when the previous response stopped with `pause_turn` (`05` §3.5.3.4). */
  readonly resumingPausedTurn?: boolean;
}

/**
 * One chat turn.
 *
 * Exported on its own as well as through the gateway, because `M2-T9`'s middleware wraps a function
 * and `M2-T14`'s contract tests call one — neither needs a whole gateway object to assert what went
 * on the wire.
 */
export async function runChat(
  deps: AnthropicAdapterDeps,
  req: ModelTurnRequest,
  signal: AbortSignal,
  options: RunOptions = {},
): Promise<ModelTurnResult> {
  const binding = deps.bindingFor(req.route, req.variant);
  const built = buildChatRequest(req, {
    binding,
    availableBetas: deps.availableBetas,
    ...(options.resumingPausedTurn === undefined
      ? {}
      : { resumingPausedTurn: options.resumingPausedTurn }),
  });

  const client = createAnthropicClient(deps);
  const startedAt = performance.now();
  let ttftMs: number | undefined;

  // **Only the network call is inside the try.** A bug in our own normalisation below would
  // otherwise be caught here and reported as a provider failure of kind `unknown` — which is a
  // breaker trip, a retry, and a misleading trace for a defect that is entirely ours. Found while
  // writing the contract tests: every success-path assertion failed with `ModelCallError: unknown`
  // and the provider was innocent.
  let message: Anthropic.Beta.Messages.BetaMessage;
  try {
    const stream = client.beta.messages.stream(built.params, {
      signal,
      timeout: binding.attemptTimeoutMs,
      maxRetries: binding.maxRetries,
    });
    // Time to first token, for `11` §3.10.2's span. `once` rather than `on`: the handler must not
    // keep firing for every text delta, and a listener that outlives the stream is a leak.
    stream.once('text', () => {
      ttftMs = performance.now() - startedAt;
    });
    message = await stream.finalMessage();
  } catch (error) {
    const mapped = toModelCallError(error, deps.clock.now().epochMilliseconds);
    // Content-free (`01` §11.7): the kind, the status and the request id, never the prompt or the
    // provider's message — which has carried prompt fragments before.
    deps.logger.warn('model.call_failed', {
      provider: ANTHROPIC_PROVIDER,
      route: req.route,
      // `outcome` rather than a new named field: the error's `kind` **is** the call's outcome, and
      // `LogFields` is a closed set on purpose. The status and the request id are token-shaped, so
      // they belong in `detail`, which `isSafeDetailValue` checks at runtime.
      outcome: mapped.kind,
      detail: {
        ...(mapped.detail.status === undefined ? {} : { status: mapped.detail.status }),
        ...(mapped.detail.requestId === undefined ? {} : { requestId: mapped.detail.requestId }),
      },
    });
    throw mapped;
  }

  const totalMs = performance.now() - startedAt;

  // `readStop` **before** any content is read (`05` §3.5.3.4). A refusal's partial text must be
  // discarded and a truncated `tool_use` must never be executed; reading content first has
  // already made both mistakes.
  const stop = readStop(message);
  const refusalBlocksOutput = stop.reason === 'refusal' || stop.reason === 'max_tokens';

  return {
    assistant: assistantMessageOf(message),
    stop,
    // `max_tokens` output is truncated mid-thought and a refusal's is the declining model's, so
    // neither is text anybody may see. `05` §3.5.3.4's table says so for both rows.
    text: refusalBlocksOutput ? '' : visibleTextAfterLastFallback(message.content),
    toolCalls: refusalBlocksOutput ? [] : toolCallsAfterLastFallback(message.content),
    usage: usageIterations(message, binding.model),
    model: {
      provider: ANTHROPIC_PROVIDER,
      requested: binding.model,
      // The **served** model, which differs from the requested one whenever the refusal fallback
      // answered — and `05` §3.9.2 bills at the served model's rates.
      served: message.model,
    },
    latency: { ...(ttftMs === undefined ? {} : { ttftMs }), totalMs },
    diagnostics: {
      ...(message.id === '' ? {} : { requestId: message.id }),
      inputTransformations: built.transformations,
      betas: built.betas,
    },
  };
}

/**
 * The gateway, with `M2-T8`'s members still to come.
 *
 * `structured`, `embed`, `countTokens` and the Batches trio throw a `ModelCallError` naming the
 * task that implements them rather than returning a plausible-looking empty result. `CLAUDE.md` §8
 * forbids a stub in a production path, and the distinction that makes this not one is that it
 * **fails loudly and names its owner**: nothing can call it and believe it worked. `embed` belongs
 * to `04` §3.2's embedding model and is wired at `M4`.
 */
export function createAnthropicGateway(deps: AnthropicAdapterDeps): ModelGateway {
  const notYet = (member: string, task: string): never => {
    throw new ModelCallError('bad_request', ANTHROPIC_PROVIDER, {
      // The owning task is in the `type`, so a caller that hits this reads which task implements
      // it rather than guessing from a generic failure.
      type: `anthropic_adapter.${member}_lands_at_${task}`,
    });
  };
  return {
    run: (req, signal) => runChat(deps, req, signal),
    structured: <T>(
      _req: StructuredRequest<T>,
      _signal: AbortSignal,
    ): Promise<StructuredResult<T>> => notYet('structured', 'M2-T8'),
    embed: (_texts, _purpose) => notYet('embed', 'M4-T20'),
    routeInfo: (route: ModelRoute, variant?: RouteVariant): RouteInfo => {
      const binding = deps.bindingFor(route, variant);
      return { provider: binding.provider, model: binding.model, supports: binding.features };
    },
  };
}
