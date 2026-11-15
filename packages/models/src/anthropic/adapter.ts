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
  BatchHandle,
  BatchResultItem,
  BatchStatus,
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
import {
  cancelBatch,
  deleteBatch,
  pollBatch,
  batchResults as streamBatchResults,
  submitBatch,
} from './batches.js';
import { countTokens as countRequestTokens } from './count.js';
import { toModelCallError } from './errors.js';
import { type AnthropicChatParams, buildChatRequest } from './request.js';
import {
  ANTHROPIC_PROVIDER,
  assistantMessageOf,
  readStop,
  toolCallsAfterLastFallback,
  usageIterations,
  visibleTextAfterLastFallback,
} from './response.js';
import {
  buildStructuredRequest,
  readStructured,
  structuredResultOf,
  withRepairTurn,
} from './structured.js';

/** `05` §3.5.3.1's client defaults. The TS SDK's `timeout` is in **milliseconds**. */
export const CLIENT_DEFAULTS = {
  maxRetries: 2,
  timeoutMs: 120_000,
} as const;

/** `countTokens` is a `doctor` and nightly-CI call, not a turn-path one. */
export const COUNT_TOKENS_TIMEOUT_MS = 30_000;

/** Submitting or polling a batch is a small control-plane call. */
export const BATCH_CALL_TIMEOUT_MS = 60_000;

/** Reading a finished batch is a download, so the ceiling is the transfer rather than a deadline. */
export const BATCH_RESULTS_TIMEOUT_MS = 10 * 60_000;

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
 * One structured call, with `05` §3.5.3.3's single repair attempt.
 *
 * The repair is the part worth reading. A schema failure is usually a prompt problem rather than a
 * transient one, so retrying the *same* request is a second bill for the same answer. Re-asking
 * with the issues attached is different: the model is told what was wrong. One attempt, because a
 * second has a vanishing success rate and a turn has a deadline.
 *
 * **Both attempts' usage is reported**, because a failed call is a billed call (`02` §3.3.7) and a
 * ledger that lost the first attempt would under-report every repaired extraction.
 *
 * Only the network calls sit inside the `try`, for the same reason as `runChat`: a bug in our own
 * parsing must not be reported as a provider failure.
 */
export async function runStructured<T>(
  deps: AnthropicAdapterDeps,
  req: StructuredRequest<T>,
  signal: AbortSignal,
): Promise<StructuredResult<T>> {
  const binding = deps.bindingFor(req.route, req.variant);
  const built = buildStructuredRequest(req, {
    binding,
    availableBetas: deps.availableBetas,
  });
  const client = createAnthropicClient(deps);
  const attempts: Anthropic.Beta.Messages.BetaMessage[] = [];

  const ask = async (params: AnthropicChatParams): Promise<Anthropic.Beta.Messages.BetaMessage> => {
    try {
      // `create`, not `stream`: a structured route's output is one bounded JSON value, so there is
      // nothing to stream and the non-streaming path is one fewer moving part.
      return await client.beta.messages.create(params, {
        signal,
        timeout: binding.attemptTimeoutMs,
        maxRetries: binding.maxRetries,
      });
    } catch (error) {
      const mapped = toModelCallError(error, deps.clock.now().epochMilliseconds);
      deps.logger.warn('model.call_failed', {
        provider: ANTHROPIC_PROVIDER,
        route: req.route,
        outcome: mapped.kind,
        detail: {
          ...(mapped.detail.status === undefined ? {} : { status: mapped.detail.status }),
          ...(mapped.detail.requestId === undefined ? {} : { requestId: mapped.detail.requestId }),
        },
      });
      throw mapped;
    }
  };

  const first = await ask(built.params);
  attempts.push(first);
  let attempt = readStructured(first, req.schema);

  if (attempt.kind === 'invalid') {
    const repaired = await ask(withRepairTurn(built.params, first, attempt.issues));
    attempts.push(repaired);
    attempt = readStructured(repaired, req.schema);
  }

  const usage = attempts.flatMap((message) => usageIterations(message, binding.model));
  const last = attempts.at(-1) ?? first;
  return structuredResultOf(attempt, usage, last);
}

/**
 * The gateway.
 *
 * `embed` is the one member still unimplemented: `04` §3.2 owns the embedding model, and it is a
 * different provider (a local ONNX model) rather than a different method on this one. It throws a
 * `ModelCallError` naming the task instead of returning a plausible empty vector — `CLAUDE.md` §8
 * forbids a stub in a production path, and what makes this not one is that it **fails loudly and
 * names its owner**: nothing can call it and believe it worked.
 *
 * The optional members are all present for Anthropic, which is why they are optional on the port:
 * `countTokens` needs a provider endpoint and Batches is Anthropic-only in 1.0.
 */
export function createAnthropicGateway(deps: AnthropicAdapterDeps): ModelGateway {
  const notYet = (member: string, task: string): never => {
    throw new ModelCallError('bad_request', ANTHROPIC_PROVIDER, {
      // The owning task is in the `type`, so a caller that hits this reads which task implements
      // it rather than guessing from a generic failure.
      type: `anthropic_adapter.${member}_lands_at_${task}`,
    });
  };
  const batchDeps = (): Parameters<typeof submitBatch>[0] => ({
    client: createAnthropicClient(deps),
    bindingFor: (route) => deps.bindingFor(route),
    availableBetas: deps.availableBetas,
  });

  return {
    run: (req, signal) => runChat(deps, req, signal),
    structured: (req, signal) => runStructured(deps, req, signal),
    embed: (_texts, _purpose) => notYet('embed', 'M4-T20'),
    countTokens: (req) =>
      countRequestTokens(
        {
          client: createAnthropicClient(deps),
          bindingFor: (route) => deps.bindingFor(route),
          availableBetas: deps.availableBetas,
        },
        req,
        // No caller-supplied signal on this port member, and that is right: `countTokens` is used
        // by `doctor` and by a nightly budget test, neither of which is inside a turn. A generous
        // own timeout keeps a hung probe from hanging a boot.
        AbortSignal.timeout(COUNT_TOKENS_TIMEOUT_MS),
      ),
    submitBatch: (reqs) =>
      submitBatch(batchDeps(), reqs, AbortSignal.timeout(BATCH_CALL_TIMEOUT_MS)),
    pollBatch: (handle: BatchHandle): Promise<BatchStatus> =>
      pollBatch(batchDeps(), handle, AbortSignal.timeout(BATCH_CALL_TIMEOUT_MS)),
    batchResults: (handle, schemaFor): AsyncIterable<BatchResultItem> =>
      streamBatchResults(
        batchDeps(),
        handle,
        schemaFor,
        // The results of a night's consolidation can be large; this is a read of a finished batch,
        // not a model call, so the ceiling is the download rather than a turn's deadline.
        AbortSignal.timeout(BATCH_RESULTS_TIMEOUT_MS),
      ),
    routeInfo: (route: ModelRoute, variant?: RouteVariant): RouteInfo => {
      const binding = deps.bindingFor(route, variant);
      return {
        provider: binding.provider,
        providerId: ANTHROPIC_PROVIDER,
        model: binding.model,
        priceId: binding.priceId,
        supports: binding.features,
      };
    },
  };
}

/** Cancel a batch that has outrun `05` §3.5.3.7's 20-hour window. Not a port member: `06`'s job calls it. */
export function cancelAnthropicBatch(
  deps: AnthropicAdapterDeps,
  handle: BatchHandle,
  signal: AbortSignal,
): Promise<BatchStatus> {
  return cancelBatch(
    {
      client: createAnthropicClient(deps),
      bindingFor: (route) => deps.bindingFor(route),
      availableBetas: deps.availableBetas,
    },
    handle,
    signal,
  );
}

/** Delete a batch's stored results, for a host who batches but will not leave them behind. */
export function deleteAnthropicBatch(
  deps: AnthropicAdapterDeps,
  handle: BatchHandle,
  signal: AbortSignal,
): Promise<void> {
  return deleteBatch(
    {
      client: createAnthropicClient(deps),
      bindingFor: (route) => deps.bindingFor(route),
      availableBetas: deps.availableBetas,
    },
    handle,
    signal,
  );
}
