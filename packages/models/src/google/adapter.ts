/**
 * The Google adapter (`05` §3.5.5; `M2-T13`).
 *
 * Third of the four, and the same shape as the other two on purpose: `M2-T14`'s contract suite
 * asserts `01` §2.1's rules against captured requests from every adapter, and that is only possible
 * if they agree on where the stop reason is read, what goes in `raw`, and which errors surface.
 *
 * ## What this provider does differently
 *
 *  - **Structured output is a response MIME type plus a schema**, not a tool and not a format
 *    object. `responseMimeType: 'application/json'` with `responseJsonSchema`.
 *  - **No prompt-cache breakpoints.** Gemini's caching is implicit; there is nothing to place and
 *    no billed write category.
 *  - **No Batches and no token counting through this adapter.** The registry row says so, and the
 *    gateway leaves those members undefined rather than throwing.
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
import { type GenerateContentResponse, GoogleGenAI } from '@google/genai';
import type { RouteBinding } from '../registry/resolve.js';
import { toModelCallError } from './errors.js';
import { assertNoPrefill, buildGenerateContentRequest } from './request.js';
import {
  assistantMessageOf,
  GOOGLE_PROVIDER,
  partsOf,
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

export interface GoogleAdapterDeps {
  readonly bindingFor: (route: ModelRoute, variant?: RouteVariant) => RouteBinding;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Absent means the SDK resolves `GEMINI_API_KEY`/`GOOGLE_API_KEY` itself. */
  readonly apiKey?: SecretString;
  /** Proxies only. Host-only config (`01` §14 A14). */
  readonly baseUrl?: string;
  /** Injected in tests; the real client otherwise. */
  readonly client?: GoogleGenAI;
}

/** Build the SDK client. No project, no location, no labels — nothing that names a group. */
export function createGoogleClient(deps: GoogleAdapterDeps): GoogleGenAI {
  if (deps.client !== undefined) return deps.client;
  return new GoogleGenAI({
    ...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey.expose() }),
    ...(deps.baseUrl === undefined ? {} : { httpOptions: { baseUrl: deps.baseUrl } }),
  });
}

function logFailure(deps: GoogleAdapterDeps, route: ModelRoute, mapped: ModelCallError): void {
  deps.logger.warn('model.call_failed', {
    provider: GOOGLE_PROVIDER,
    route,
    outcome: mapped.kind,
    detail: {
      ...(mapped.detail.status === undefined ? {} : { status: mapped.detail.status }),
      ...(mapped.detail.requestId === undefined ? {} : { requestId: mapped.detail.requestId }),
    },
  });
}

/** One chat turn. */
export async function runChat(
  deps: GoogleAdapterDeps,
  req: ModelTurnRequest,
  signal: AbortSignal,
): Promise<ModelTurnResult> {
  const binding = deps.bindingFor(req.route, req.variant);
  const built = buildGenerateContentRequest(req, { binding, signal });
  assertNoPrefill(built.contents);

  const client = createGoogleClient(deps);
  const startedAt = performance.now();

  // Only the network call inside the `try`, for the same reason as the other two adapters: a bug
  // in our own normalisation must not be reported as a provider failure and trip the breaker.
  let response: GenerateContentResponse;
  try {
    response = await client.models.generateContent({
      model: built.model,
      contents: [...built.contents],
      config: built.config,
    });
  } catch (error) {
    const mapped = toModelCallError(error);
    logFailure(deps, req.route, mapped);
    throw mapped;
  }

  const totalMs = performance.now() - startedAt;

  // The stop reason before any content is read. On this provider that also means checking
  // `promptFeedback.blockReason` first: a blocked prompt produces no candidate at all.
  const stop = readStop(response);
  const blocked = stop.reason === 'refusal' || stop.reason === 'max_tokens';
  const parts = partsOf(response);

  return {
    assistant: assistantMessageOf(response, binding.model),
    stop,
    text: blocked ? '' : visibleText(parts),
    toolCalls: blocked ? [] : toolCallsOf(parts),
    usage: usageIterationOf(response, binding.model),
    model: {
      provider: GOOGLE_PROVIDER,
      requested: binding.model,
      served: response.modelVersion ?? binding.model,
    },
    latency: { totalMs },
    diagnostics: {
      ...(response.responseId === undefined ? {} : { requestId: response.responseId }),
      inputTransformations: built.transformations,
      betas: [],
    },
  };
}

/** One structured call, with `05` §3.5.3.3's single repair attempt. */
export async function runStructured<T>(
  deps: GoogleAdapterDeps,
  req: StructuredRequest<T>,
  signal: AbortSignal,
): Promise<StructuredResult<T>> {
  const binding = deps.bindingFor(req.route, req.variant);
  const built = buildStructuredRequest(req, { binding, signal });
  const client = createGoogleClient(deps);
  const responses: GenerateContentResponse[] = [];

  const ask = async (contents: typeof built.contents): Promise<GenerateContentResponse> => {
    try {
      return await client.models.generateContent({
        model: built.model,
        contents: [...contents],
        config: built.config,
      });
    } catch (error) {
      const mapped = toModelCallError(error);
      logFailure(deps, req.route, mapped);
      throw mapped;
    }
  };

  const first = await ask(built.contents);
  responses.push(first);
  let attempt = readStructured(first, req.schema);

  if (attempt.kind === 'invalid') {
    const repaired = await ask(withRepairTurn(built.contents, first, attempt.issues));
    responses.push(repaired);
    attempt = readStructured(repaired, req.schema);
  }

  const usage = responses.flatMap((response) => usageIterationOf(response, binding.model));
  const last = responses.at(-1) ?? first;
  return structuredResultOf(attempt, usage, last.modelVersion ?? binding.model);
}

/** The gateway. Same absences as the OpenAI one, and for the same reason. */
export function createGoogleGateway(deps: GoogleAdapterDeps): ModelGateway {
  return {
    run: (req, signal) => runChat(deps, req, signal),
    structured: (req, signal) => runStructured(deps, req, signal),
    embed: (): never => {
      throw new ModelCallError('bad_request', GOOGLE_PROVIDER, {
        type: 'google_adapter.embed_lands_at_M4-T20',
      });
    },
    routeInfo: (route: ModelRoute, variant?: RouteVariant): RouteInfo => {
      const binding = deps.bindingFor(route, variant);
      return {
        provider: binding.provider,
        providerId: GOOGLE_PROVIDER,
        model: binding.model,
        supports: binding.features,
      };
    },
  };
}
