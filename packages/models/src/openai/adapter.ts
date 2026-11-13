/**
 * The OpenAI adapter (`05` §3.5.4; `M2-T11`).
 *
 * Mirrors the Anthropic adapter's shape deliberately: same stage order, same narrow `try`, same
 * content-free failure log. `M2-T14`'s contract suite asserts `01` §2.1's rules against **captured
 * requests** from every adapter, so the two converging on one structure is what makes that suite
 * able to say the same thing about both.
 *
 * ## Two differences from the Anthropic adapter, both forced by the provider
 *
 *  - **No prompt-cache breakpoints.** OpenAI's prefix caching is automatic; there is nothing to
 *    place. The capability registry says `promptCaching: 'automatic'` and `maxBreakpoints: 0`, and
 *    an adapter that tried to send a breakpoint would be sending a field that does not exist.
 *  - **No Batches, no `countTokens`.** Neither is offered for Responses, and the registry row says
 *    so (`batches: false`, `countTokens: false`). The gateway leaves those members **undefined**
 *    rather than throwing: they are optional on the port precisely so a caller can ask whether a
 *    provider has them, and a present member that always throws answers that question wrongly.
 */
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
import OpenAI from 'openai';
import type { RouteBinding } from '../registry/resolve.js';
import { toModelCallError } from './errors.js';
import { buildResponsesRequest } from './request.js';
import {
  assistantMessageOf,
  OPENAI_PROVIDER,
  readStop,
  toolCallsOf,
  usageIterationOf,
  visibleText,
} from './response.js';
import {
  buildStructuredRequest,
  readStructured,
  structuredResultOf,
  withRepairTurn,
} from './structured.js';

/** Client defaults. The SDK's own bounded retries, inside the turn's deadline (`05` §3.5.3.10). */
export const CLIENT_DEFAULTS = { maxRetries: 2, timeoutMs: 60_000 } as const;

export interface OpenAiAdapterDeps {
  readonly bindingFor: (route: ModelRoute, variant?: RouteVariant) => RouteBinding;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Absent means the SDK resolves `OPENAI_API_KEY` itself. */
  readonly apiKey?: SecretString;
  /** Proxies only. Host-only config (`01` §14 A14). */
  readonly baseUrl?: string;
  /** For `prompt_cache_key`. Omitted before the instance has an id. */
  readonly instanceId?: string;
  /** Injected in tests; the real client otherwise. */
  readonly client?: OpenAI;
}

/**
 * Build the SDK client.
 *
 * No `organization`, no `project`, no `defaultHeaders` carrying anything about the group. The one
 * identifier that reaches OpenAI is `prompt_cache_key`, which is instance-and-route and is
 * explained in `request.ts`.
 */
export function createOpenAiClient(deps: OpenAiAdapterDeps): OpenAI {
  if (deps.client !== undefined) return deps.client;
  return new OpenAI({
    ...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey.expose() }),
    ...(deps.baseUrl === undefined ? {} : { baseURL: deps.baseUrl }),
    maxRetries: CLIENT_DEFAULTS.maxRetries,
    timeout: CLIENT_DEFAULTS.timeoutMs,
  });
}

/** Log a failed call. The kind, the status and the request id — never the prompt (`01` §11.7). */
function logFailure(deps: OpenAiAdapterDeps, route: ModelRoute, mapped: ModelCallError): void {
  deps.logger.warn('model.call_failed', {
    provider: OPENAI_PROVIDER,
    route,
    outcome: mapped.kind,
    detail: {
      ...(mapped.detail.status === undefined ? {} : { status: mapped.detail.status }),
      ...(mapped.detail.requestId === undefined ? {} : { requestId: mapped.detail.requestId }),
    },
  });
}

/**
 * One chat turn.
 *
 * `responses.create` rather than `responses.stream`: `05` §3.5.4 names `create`, and unlike the
 * Anthropic path there is no 128K-output timeout pressure to stream around — `max_output_tokens`
 * is bounded by the route. That costs the `ttftMs` measurement, which is reported as absent rather
 * than estimated, because a time-to-first-token derived from the total is not one.
 */
export async function runChat(
  deps: OpenAiAdapterDeps,
  req: ModelTurnRequest,
  signal: AbortSignal,
): Promise<ModelTurnResult> {
  const binding = deps.bindingFor(req.route, req.variant);
  const built = buildResponsesRequest(req, {
    binding,
    ...(deps.instanceId === undefined ? {} : { instanceId: deps.instanceId }),
  });
  const client = createOpenAiClient(deps);
  const startedAt = performance.now();

  // Only the network call is inside the `try`. A bug in our own normalisation below would
  // otherwise be reported as a provider failure of kind `unknown` — a breaker trip and a
  // misleading trace for a defect that is entirely ours. The Anthropic adapter learned this the
  // expensive way at `M2-T6`.
  let response: OpenAI.Responses.Response;
  try {
    response = await client.responses.create(
      { ...built.params, stream: false },
      { signal, timeout: binding.attemptTimeoutMs, maxRetries: binding.maxRetries },
    );
  } catch (error) {
    const mapped = toModelCallError(error, deps.clock.now().epochMilliseconds);
    logFailure(deps, req.route, mapped);
    throw mapped;
  }

  const totalMs = performance.now() - startedAt;

  // The stop reason **before** any content is read (`05` §3.5.3.4's rule, which is not
  // Anthropic-specific): a filtered response's partial text must be discarded and a truncated
  // tool call must never be executed.
  const stop = readStop(response);
  const blocked = stop.reason === 'refusal' || stop.reason === 'max_tokens';

  return {
    assistant: assistantMessageOf(response),
    stop,
    text: blocked ? '' : visibleText(response.output),
    toolCalls: blocked ? [] : toolCallsOf(response.output),
    usage: usageIterationOf(response, binding.model),
    model: {
      provider: OPENAI_PROVIDER,
      requested: binding.model,
      served: response.model === '' ? binding.model : response.model,
    },
    latency: { totalMs },
    diagnostics: {
      ...(response.id === '' ? {} : { requestId: response.id }),
      inputTransformations: built.transformations,
      // No betas on this provider. An empty array rather than an omitted field, so a trace row
      // reads the same shape for every adapter.
      betas: [],
    },
  };
}

/**
 * One structured call, with `05` §3.5.3.3's single repair attempt.
 *
 * The repair rule is the provider-independent one: a schema failure is usually a prompt problem,
 * so retrying the same request is a second bill for the same answer, while re-asking *with the
 * issues attached* tells the model what was wrong. One attempt, because a second has a vanishing
 * success rate and a turn has a deadline. Both attempts' usage is reported — a failed call is a
 * billed call (`02` §3.3.7).
 */
export async function runStructured<T>(
  deps: OpenAiAdapterDeps,
  req: StructuredRequest<T>,
  signal: AbortSignal,
): Promise<StructuredResult<T>> {
  const binding = deps.bindingFor(req.route, req.variant);
  const built = buildStructuredRequest(req, {
    binding,
    ...(deps.instanceId === undefined ? {} : { instanceId: deps.instanceId }),
  });
  const client = createOpenAiClient(deps);
  const responses: OpenAI.Responses.Response[] = [];

  const ask = async (
    params: Omit<OpenAI.Responses.ResponseCreateParams, 'stream'>,
  ): Promise<OpenAI.Responses.Response> => {
    try {
      return await client.responses.create(
        { ...params, stream: false },
        { signal, timeout: binding.attemptTimeoutMs, maxRetries: binding.maxRetries },
      );
    } catch (error) {
      const mapped = toModelCallError(error, deps.clock.now().epochMilliseconds);
      logFailure(deps, req.route, mapped);
      throw mapped;
    }
  };

  const first = await ask(built.params);
  responses.push(first);
  let attempt = readStructured(first, req.schema);

  if (attempt.kind === 'invalid') {
    const repaired = await ask(withRepairTurn(built.params, first, attempt.issues));
    responses.push(repaired);
    attempt = readStructured(repaired, req.schema);
  }

  const usage = responses.flatMap((response) => usageIterationOf(response, binding.model));
  const last = responses.at(-1) ?? first;
  return structuredResultOf(attempt, usage, last.model === '' ? binding.model : last.model);
}

/**
 * The gateway.
 *
 * `countTokens`, `submitBatch`, `pollBatch` and `batchResults` are **absent**, not throwing stubs:
 * the Responses API offers none of them, the registry row says so, and the port made them optional
 * so a caller can ask. `embed` cannot be absent — the port requires it — so it fails loudly and
 * names its owning task rather than returning a plausible empty vector.
 */
export function createOpenAiGateway(deps: OpenAiAdapterDeps): ModelGateway {
  return {
    run: (req, signal) => runChat(deps, req, signal),
    structured: (req, signal) => runStructured(deps, req, signal),
    embed: (): never => {
      throw new ModelCallError('bad_request', OPENAI_PROVIDER, {
        // The owning task is in the `type`, so a caller that reaches this reads which task
        // implements it rather than guessing from a generic failure.
        type: 'openai_adapter.embed_lands_at_M4-T20',
      });
    },
    routeInfo: (route: ModelRoute, variant?: RouteVariant): RouteInfo => {
      const binding = deps.bindingFor(route, variant);
      return { provider: binding.provider, model: binding.model, supports: binding.features };
    },
  };
}
