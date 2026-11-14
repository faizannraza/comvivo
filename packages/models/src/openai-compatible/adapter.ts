/**
 * The OpenAI-compatible local adapter (`05` §3.5.6; `M2-T12`).
 *
 * Fourth of the four, and the only one whose **capabilities are discovered rather than declared**.
 * The other three adapters read a registry row; this one probes a server the host chose, places it
 * on the L1–L4 ladder, and shapes every request to what that level permits.
 *
 * ## The level is held, not re-derived
 *
 * `deps.level` is supplied by whoever ran the probes, cached per `05` §3.5.6 for 168 hours and
 * keyed on `(baseUrl, model, serverVersion)`. The adapter does **not** probe lazily on first use:
 * a probe is four requests and a 16K prompt, and paying that inside a member's first turn would
 * make the first question of the day take thirty seconds. `comvivo doctor` and the wizard run the
 * probes; the adapter consumes the verdict.
 *
 * ## L4 is a real configuration and it refuses work
 *
 * At L4 there are no tools and no structured routes. A `structured()` call throws `local_no_tools`
 * rather than returning a plausible empty value, because every caller of `structured()` is a route
 * whose output drives a decision — an empty extraction silently means "nothing happened today" and
 * an empty declassification means "no constraints", which is the unsafe direction.
 */
import type {
  ModelGateway,
  ModelRoute,
  ModelTurnRequest,
  ModelTurnResult,
  RouteInfo,
  RouteVariant,
  SchemaLike,
  StructuredRequest,
  StructuredResult,
} from '@comvivo/core';
import { ModelCallError } from '@comvivo/core';
import type { Clock, Logger, SecretString } from '@comvivo/shared';
import OpenAI from 'openai';
import { toModelCallError } from '../openai/errors.js';
import type { RouteBinding } from '../registry/resolve.js';
import type { LocalServerKind } from './identify.js';
import { type LadderLevel, LEVEL_BEHAVIOUR } from './ladder.js';
import { buildLocalRequest } from './request.js';
import {
  assistantMessageOf,
  LOCAL_PROVIDER,
  nativeToolCalls,
  readEnvelope,
  readStop,
  usageIterationOf,
  visibleText,
} from './response.js';
import { buildLocalStructuredRequest, readLocalStructured } from './structured.js';

/**
 * Client defaults.
 *
 * `maxRetries: 0`, unlike the cloud adapters. A local server does not rate-limit and does not have
 * capacity blips; its failures are "not running", "model not loaded" and "out of memory", none of
 * which a retry fixes. Retrying an out-of-memory request on an 8 GB host makes it worse.
 *
 * The timeout is generous because a cold model load genuinely takes tens of seconds, which is the
 * one way a local server is slower than a cloud one in a way that is not a fault.
 */
export const LOCAL_CLIENT_DEFAULTS = { maxRetries: 0, timeoutMs: 120_000 } as const;

export interface LocalAdapterDeps {
  readonly bindingFor: (route: ModelRoute, variant?: RouteVariant) => RouteBinding;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The host's `models.local.baseUrl`. Required: there is no default local server. */
  readonly baseUrl: string;
  /** Which server answered, for the span flavour and for advice. */
  readonly serverKind: LocalServerKind;
  /** The probed level. Supplied by `doctor`/the wizard, never derived here. */
  readonly level: LadderLevel;
  /** From the probe. When false, `reasoning_effort` is omitted (`05` §3.5.6). */
  readonly reasoningEffortAccepted: boolean;
  /** Most local servers need no key; LM Studio and a proxied vLLM may. */
  readonly apiKey?: SecretString;
  /** Injected in tests. */
  readonly client?: OpenAI;
}

/**
 * Build the SDK client.
 *
 * A placeholder key when the host supplied none: the `openai` SDK **refuses to construct** without
 * one, and three of the four local servers ignore the header entirely. Sending a literal
 * placeholder to a loopback server is not a secret leak, and the alternative is an adapter that
 * cannot talk to Ollama.
 */
export function createLocalClient(deps: LocalAdapterDeps): OpenAI {
  if (deps.client !== undefined) return deps.client;
  return new OpenAI({
    apiKey: deps.apiKey?.expose() ?? 'local-no-key-required',
    baseURL: deps.baseUrl,
    maxRetries: LOCAL_CLIENT_DEFAULTS.maxRetries,
    timeout: LOCAL_CLIENT_DEFAULTS.timeoutMs,
  });
}

function logFailure(deps: LocalAdapterDeps, route: ModelRoute, mapped: ModelCallError): void {
  deps.logger.warn('model.call_failed', {
    provider: LOCAL_PROVIDER,
    route,
    outcome: mapped.kind,
    detail: {
      ...(mapped.detail.status === undefined ? {} : { status: mapped.detail.status }),
      server: deps.serverKind,
      level: deps.level,
    },
  });
}

/** `05` §3.5.6's `err.local_no_tools`, as an error the engine can surface as copy. */
function noToolsError(what: string): ModelCallError {
  return new ModelCallError('bad_request', LOCAL_PROVIDER, {
    // `local_no_tools` is the template key `05` §3.5.6 names, so the engine can render the host's
    // own copy rather than an adapter's sentence.
    type: `local_no_tools.${what}`,
  });
}

/** One chat turn. */
export async function runChat(
  deps: LocalAdapterDeps,
  req: ModelTurnRequest,
  signal: AbortSignal,
  options: {
    readonly step?: number;
    readonly schemas?: ReadonlyMap<string, SchemaLike<unknown>>;
  } = {},
): Promise<ModelTurnResult> {
  const binding = deps.bindingFor(req.route, req.variant);
  const behaviour = LEVEL_BEHAVIOUR[deps.level];

  // L4 with tools asked for is a refusal, not a silently tool-free turn: the engine needs to know
  // the write it intended cannot happen so it can say so (`05` §3.5.6's `err.local_no_tools`).
  if (behaviour.tools === 'none' && req.tools.length > 0) throw noToolsError('tools');

  const built = buildLocalRequest(req, {
    binding,
    level: deps.level,
    reasoningEffortAccepted: deps.reasoningEffortAccepted,
  });

  const client = createLocalClient(deps);
  const startedAt = performance.now();

  // Only the network call inside the `try`, as in every adapter: a bug in our own envelope parsing
  // must not be reported as a provider failure and trip the breaker.
  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = await client.chat.completions.create(
      { ...built.params, stream: false },
      { signal, timeout: binding.attemptTimeoutMs, maxRetries: 0 },
    );
  } catch (error) {
    const mapped = toModelCallError(error, deps.clock.now().epochMilliseconds, LOCAL_PROVIDER);
    logFailure(deps, req.route, mapped);
    throw mapped;
  }

  const totalMs = performance.now() - startedAt;
  const stop = readStop(completion);
  const blocked = stop.reason === 'refusal' || stop.reason === 'max_tokens';

  if (built.envelope) {
    return envelopeResult(deps, { binding, completion, built, stop, blocked, totalMs }, options);
  }

  const calls = blocked ? [] : nativeToolCalls(completion);
  const text = blocked ? '' : visibleText(completion);
  return {
    assistant: assistantMessageOf(completion, text, calls),
    stop,
    text,
    toolCalls: calls,
    usage: usageIterationOf(completion, binding.model),
    model: { provider: LOCAL_PROVIDER, requested: binding.model, served: completion.model },
    latency: { totalMs },
    diagnostics: {
      ...(completion.id === '' ? {} : { requestId: completion.id }),
      inputTransformations: built.transformations,
      betas: [],
    },
  };
}

/**
 * The envelope path's result.
 *
 * A malformed envelope is reported as `other` with **no** text and no calls, which is what sends
 * the engine down its retry path rather than showing a group a JSON blob. `L3` is where that
 * happens often enough to matter, and `LEVEL_BEHAVIOUR.repairEnvelope` says so.
 */
function envelopeResult(
  deps: LocalAdapterDeps,
  context: {
    readonly binding: RouteBinding;
    readonly completion: OpenAI.Chat.Completions.ChatCompletion;
    readonly built: ReturnType<typeof buildLocalRequest>;
    readonly stop: ReturnType<typeof readStop>;
    readonly blocked: boolean;
    readonly totalMs: number;
  },
  options: { readonly step?: number; readonly schemas?: ReadonlyMap<string, SchemaLike<unknown>> },
): ModelTurnResult {
  const { binding, completion, built, blocked, totalMs } = context;
  const read = readEnvelope(completion, options.schemas ?? new Map(), options.step ?? 0);

  const malformed = read.malformed !== undefined;
  if (malformed) {
    deps.logger.debug('model.local_probe', {
      outcome: 'envelope_malformed',
      detail: { server: deps.serverKind, level: deps.level },
    });
  }

  const text = blocked || malformed ? '' : read.reply;
  const calls = blocked || malformed ? [] : read.calls;
  const stop: ReturnType<typeof readStop> = malformed
    ? { reason: 'other', raw: 'envelope_malformed' }
    : calls.length > 0
      ? { reason: 'tool_use', raw: 'envelope_tool_calls' }
      : context.stop;

  return {
    assistant: assistantMessageOf(completion, text, calls),
    stop,
    text,
    toolCalls: calls,
    usage: usageIterationOf(completion, binding.model),
    model: { provider: LOCAL_PROVIDER, requested: binding.model, served: completion.model },
    latency: { totalMs },
    diagnostics: {
      ...(completion.id === '' ? {} : { requestId: completion.id }),
      // Each rejected call is a transformation: the model asked for something that did not
      // validate and will get an `is_error` back instead of a result.
      inputTransformations: built.transformations + read.rejected.length,
      betas: [],
    },
  };
}

/**
 * One structured call.
 *
 * Refused outright at L4: `05` §3.5.6 disables the structured routes there, and every caller of
 * `structured()` drives a decision from its output. An empty extraction reads as "nothing happened
 * today" and an empty declassification as "no constraints" — both are the unsafe direction, so the
 * call fails loudly and the engine falls back to its deterministic path.
 */
export async function runStructured<T>(
  deps: LocalAdapterDeps,
  req: StructuredRequest<T>,
  signal: AbortSignal,
): Promise<StructuredResult<T>> {
  const behaviour = LEVEL_BEHAVIOUR[deps.level];
  if (!behaviour.structuredRoutes) throw noToolsError('structured');

  const binding = deps.bindingFor(req.route, req.variant);
  const built = buildLocalStructuredRequest(req, {
    binding,
    level: deps.level,
    reasoningEffortAccepted: deps.reasoningEffortAccepted,
  });
  const client = createLocalClient(deps);
  const completions: OpenAI.Chat.Completions.ChatCompletion[] = [];

  const ask = async (
    params: typeof built.params,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
    try {
      return await client.chat.completions.create(
        { ...params, stream: false },
        { signal, timeout: binding.attemptTimeoutMs, maxRetries: 0 },
      );
    } catch (error) {
      const mapped = toModelCallError(error, deps.clock.now().epochMilliseconds, LOCAL_PROVIDER);
      logFailure(deps, req.route, mapped);
      throw mapped;
    }
  };

  const first = await ask(built.params);
  completions.push(first);
  let attempt = readLocalStructured(first, req.schema);

  // One repair, and only where the level needs it. At L2 the schema already constrains the shape,
  // so an invalid value is a semantic failure the repair would not fix; at L3 `json_object` lets
  // the shape itself come back wrong, which a repair does fix.
  if (attempt.kind === 'invalid' && behaviour.repairEnvelope) {
    const repaired = await ask(built.repair(first, attempt.issues));
    completions.push(repaired);
    attempt = readLocalStructured(repaired, req.schema);
  }

  const usage = completions.flatMap((completion) => usageIterationOf(completion, binding.model));
  const last = completions.at(-1) ?? first;
  const model = last.model === '' ? binding.model : last.model;
  switch (attempt.kind) {
    case 'ok':
      return { kind: 'ok', value: attempt.value, usage, model };
    case 'refused':
      return { kind: 'refused', category: attempt.category, usage, model };
    case 'truncated':
      return { kind: 'truncated', usage, model };
    case 'invalid':
      return { kind: 'invalid', issues: attempt.issues, usage, model };
  }
}

/**
 * The gateway.
 *
 * `countTokens` and the Batches trio are absent: no local server offers either. `embed` is absent
 * from the *reason* list but present on the port, so it fails loudly and names its owner — and on
 * a local install `04` §3.2's embedder is genuinely a different local model rather than this one.
 */
export function createLocalGateway(deps: LocalAdapterDeps): ModelGateway {
  return {
    run: (req, signal) => runChat(deps, req, signal),
    structured: (req, signal) => runStructured(deps, req, signal),
    embed: (): never => {
      throw new ModelCallError('bad_request', LOCAL_PROVIDER, {
        type: 'local_adapter.embed_lands_at_M4-T20',
      });
    },
    routeInfo: (route: ModelRoute, variant?: RouteVariant): RouteInfo => {
      const binding = deps.bindingFor(route, variant);
      return {
        // What the host wrote (`local`) and which adapter serves it (`openai-compatible`). These
        // differ only here, and conflating them filed this route's breaker, spans and metrics
        // under a name no other part of the model layer uses.
        provider: binding.provider,
        providerId: LOCAL_PROVIDER,
        model: binding.model,
        supports: {
          ...binding.features,
          // The ladder is the truth about this server, not the registry's wildcard row. A caller
          // asking `supports.tools` before building a catalogue must not be told `probe`.
          tools: LEVEL_BEHAVIOUR[deps.level].tools === 'native' ? 'native_strict' : 'envelope',
          structured:
            LEVEL_BEHAVIOUR[deps.level].structured === 'none'
              ? 'none'
              : LEVEL_BEHAVIOUR[deps.level].structured === 'json_schema'
                ? 'native'
                : 'envelope',
          parallelTools: LEVEL_BEHAVIOUR[deps.level].parallelToolsGuaranteed,
        },
      };
    },
  };
}
