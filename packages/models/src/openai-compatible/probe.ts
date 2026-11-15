/**
 * Active capability probes (`05` §3.5.6 steps 3–4; `M2-T12`).
 *
 * ## These are the authoritative answer
 *
 * A server's metadata says what the *model* can do. A probe says what the **server plus its chat
 * template plus its flags** actually do, which is the only thing that matters — and the two
 * disagree often enough that `05` §3.5.6 calls the probes authoritative and the hints hints.
 *
 * Four probes, each two tiny requests at most, each capped at 20 s:
 *
 *  1. **Tool probe.** One tool, `probe_echo{value}`, and "call it with `v1`". Pass if the call
 *     comes back named correctly with parseable arguments. It also asks for **two** calls, which
 *     is how parallel support is measured rather than assumed.
 *  2. **Schema probe.** `response_format: json_schema` with `strict: true`, then a parse check. On
 *     failure, retry with `json_object` — that is the L2/L3 boundary.
 *  3. **Effort probe.** Whether `reasoning_effort` is accepted or 400s. Sent only if accepted
 *     (`05` §3.5.6), so this decides a request field rather than a feature.
 *  4. **Context probe.** A needle at ~16K tokens. A failure means the server **truncates**, which
 *     is the single most common local misconfiguration — Ollama's default window is far below what
 *     a turn needs, and the symptom is a bot that forgets the start of its own charter.
 *
 * ## The needle is the one that earns its cost
 *
 * The others answer a yes/no a host could almost guess. The needle catches silent truncation, which
 * produces no error at all: the server accepts a 16K prompt, drops the front of it, and answers
 * confidently from what is left. A group would experience that as a bot that ignores its
 * instructions, and nobody would suspect the context window. So the probe plants a token near the
 * **start** of a long prompt and asks for it back — if the front was dropped, the answer is wrong.
 */
import type { Logger } from '@comvivo/shared';
import { toModelCallError } from '../openai/errors.js';
import type { LocalServerKind } from './identify.js';
import type { LadderLevel, ProbedCapabilities } from './ladder.js';
import { levelFor } from './ladder.js';
import { LOCAL_PROVIDER } from './response.js';

/** `05` §3.5.6: each active probe is capped at 20 s. */
export const PROBE_TIMEOUT_MS = 20_000;

/** The needle sits at roughly this many tokens from the start of the context probe's prompt. */
export const NEEDLE_TOKENS = 16_000;

/** Characters per token for building the filler. Deliberately conservative: 4 would under-fill. */
const CHARS_PER_TOKEN = 3.5;

/** The tool the probe offers. Named so it cannot collide with a real tool. */
export const PROBE_TOOL_NAME = 'probe_echo';

/** The value the probe asks for, and the needle it asks to be echoed back. */
export const PROBE_VALUE = 'v1';

/**
 * Everything one probe run established.
 *
 * `LocalProbe*` rather than `Probe*` throughout this file: `M2-T8`'s Anthropic beta probe already
 * owns the shorter names, and one package exporting two different `ProbeResult`s would be a
 * collision waiting for whichever barrel was written second. The longer name also reads better —
 * one probes which betas an account has, the other which capabilities a server has.
 *
 * `level` is derived rather than stored separately so it cannot drift from the measurements — a
 * cached result whose level disagreed with its own capabilities would be worse than no cache.
 */
export interface LocalProbeResult extends ProbedCapabilities {
  readonly serverKind: LocalServerKind;
  readonly level: LadderLevel;
  /** The window the needle probe actually demonstrated, or `undefined` when it was not run. */
  readonly contextWindowProven?: number;
  /** True when the needle came back wrong — the server is silently truncating. */
  readonly truncates: boolean;
  /** The model and base URL this result is for, for the cache key. */
  readonly model: string;
  readonly baseUrl: string;
  /** The server version, when it reported one. Part of the cache key (`05` §3.5.6). */
  readonly serverVersion?: string;
  /** When the probe ran, ISO-8601. The cache's TTL is measured from here. */
  readonly probedAt: string;
}

/**
 * One Chat Completions call, as the probes need it.
 *
 * A narrow port rather than the OpenAI client: a probe sends shapes the typed client would refuse
 * (a `response_format` a server may reject, a `reasoning_effort` that may 400), and the probe's
 * whole job is to find out *whether* they are refused. Passing them through a type that models the
 * happy path would mean casting at every call site.
 */
export interface LocalProbeTransport {
  /**
   * Returns the parsed body on a 2xx, or throws.
   *
   * Throwing is how a rejection is reported, because that is what the SDK does and what the error
   * mapper already understands — a probe that had to distinguish "refused" from "failed" itself
   * would be a second error taxonomy.
   */
  readonly chat: (
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}

export interface LocalProbeDeps {
  readonly logger: Logger;
  readonly transport: LocalProbeTransport;
  /** For `probedAt`. Injected, as everywhere. */
  readonly now: () => string;
}

export interface LocalProbeOptions {
  readonly model: string;
  readonly baseUrl: string;
  readonly serverKind: LocalServerKind;
  readonly serverVersion?: string;
  /**
   * A context-window hint from the server's metadata.
   *
   * When it is present and **below** the needle's position, the needle probe is skipped and
   * `truncates` is set from the hint — there is no point spending 16K tokens to prove a server
   * cannot hold 16K tokens when it already said so. When it is present and above, the needle still
   * runs: the hint is GGUF metadata and the server's actual window is a flag.
   */
  readonly contextWindowHint?: number;
}

type Choice = { readonly message?: Record<string, unknown> };

function firstMessage(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = body['choices'];
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return undefined;
  // `Choice.message` is already `Record<string, unknown> | undefined`, so a `typeof` guard here is
  // the one the linter rightly calls redundant — the cast above is where the widening happened.
  return (first as Choice).message;
}

function textOf(body: Record<string, unknown>): string {
  const content = firstMessage(body)?.['content'];
  return typeof content === 'string' ? content : '';
}

/** The `tool_calls` of the first choice, as a list of `{name, arguments}`. */
function toolCallsOf(
  body: Record<string, unknown>,
): readonly { readonly name: string; readonly args: string }[] {
  const raw = firstMessage(body)?.['tool_calls'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const fn = (entry as Record<string, unknown>)['function'];
    if (typeof fn !== 'object' || fn === null) return [];
    const bag = fn as Record<string, unknown>;
    const name = bag['name'];
    const args = bag['arguments'];
    return typeof name === 'string' ? [{ name, args: typeof args === 'string' ? args : '' }] : [];
  });
}

/**
 * The tool probe.
 *
 * `tool_choice` is **omitted**, as `05` §3.5.6 requires throughout — Ollama does not support it, so
 * a probe that sent it would measure whether the server tolerates an unsupported field rather than
 * whether it can call a tool.
 */
export async function probeTools(
  deps: LocalProbeDeps,
  options: LocalProbeOptions,
  signal: AbortSignal,
): Promise<{ readonly nativeTools: boolean; readonly parallelTools: boolean }> {
  const tool = {
    type: 'function',
    function: {
      name: PROBE_TOOL_NAME,
      description: 'Echo a value back. Used only to check that tool calling works.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  };

  try {
    const body = await deps.transport.chat(
      {
        model: options.model,
        messages: [
          {
            role: 'system',
            content: 'You call tools when asked. Answer only with the tool call.',
          },
          {
            role: 'user',
            content: `Call ${PROBE_TOOL_NAME} twice: once with value '${PROBE_VALUE}' and once with value '${PROBE_VALUE}b'.`,
          },
        ],
        tools: [tool],
        max_tokens: 256,
      },
      signal,
    );

    const calls = toolCallsOf(body);
    const named = calls.filter((call) => call.name === PROBE_TOOL_NAME);
    const parseable = named.filter((call) => {
      try {
        const parsed: unknown = JSON.parse(call.args);
        return typeof parsed === 'object' && parsed !== null && 'value' in parsed;
      } catch {
        return false;
      }
    });
    return {
      nativeTools: parseable.length > 0,
      // Two correct calls in one response. Measured rather than assumed, because `05` §3.5.6 says
      // L2 and L3 give no parallel guarantee and the engine reads that flag.
      parallelTools: parseable.length >= 2,
    };
  } catch (error) {
    // A 400 here is the answer, not a failure: the server refused the `tools` field. Logged at
    // `debug` with the mapped kind only, because a probe failing is expected on three of four
    // servers and an `info` line per probe would make a boot look broken.
    deps.logger.debug('model.local_probe', {
      outcome: toModelCallError(error, 0, LOCAL_PROVIDER).kind,
      detail: { probe: 'tools', server: options.serverKind },
    });
    return { nativeTools: false, parallelTools: false };
  }
}

/** The schema probe's two attempts, in order. `json_schema` then `json_object`. */
export async function probeStructured(
  deps: LocalProbeDeps,
  options: LocalProbeOptions,
  signal: AbortSignal,
): Promise<{ readonly jsonSchema: boolean; readonly jsonObject: boolean }> {
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  };
  const messages = [
    { role: 'system', content: 'Answer only with JSON.' },
    { role: 'user', content: 'Reply with {"ok": true}.' },
  ];

  const parsesToObject = (body: Record<string, unknown>): boolean => {
    try {
      const parsed: unknown = JSON.parse(textOf(body));
      return typeof parsed === 'object' && parsed !== null;
    } catch {
      return false;
    }
  };

  let jsonSchema = false;
  try {
    const body = await deps.transport.chat(
      {
        model: options.model,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'probe', schema, strict: true },
        },
        max_tokens: 128,
      },
      signal,
    );
    jsonSchema = parsesToObject(body);
  } catch (error) {
    deps.logger.debug('model.local_probe', {
      outcome: toModelCallError(error, 0, LOCAL_PROVIDER).kind,
      detail: { probe: 'json_schema', server: options.serverKind },
    });
  }

  // A server that honours `json_schema` honours `json_object` by construction, so the second
  // request is skipped. One fewer model load on a cold 8 GB host.
  if (jsonSchema) return { jsonSchema: true, jsonObject: true };

  let jsonObject = false;
  try {
    const body = await deps.transport.chat(
      { model: options.model, messages, response_format: { type: 'json_object' }, max_tokens: 128 },
      signal,
    );
    jsonObject = parsesToObject(body);
  } catch (error) {
    deps.logger.debug('model.local_probe', {
      outcome: toModelCallError(error, 0, LOCAL_PROVIDER).kind,
      detail: { probe: 'json_object', server: options.serverKind },
    });
  }

  return { jsonSchema: false, jsonObject };
}

/** Whether `reasoning_effort` is accepted. Decides a request field, not a feature. */
export async function probeReasoningEffort(
  deps: LocalProbeDeps,
  options: LocalProbeOptions,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await deps.transport.chat(
      {
        model: options.model,
        messages: [{ role: 'user', content: 'Say ok.' }],
        reasoning_effort: 'low',
        max_tokens: 16,
      },
      signal,
    );
    return true;
  } catch (error) {
    deps.logger.debug('model.local_probe', {
      outcome: toModelCallError(error, 0, LOCAL_PROVIDER).kind,
      detail: { probe: 'reasoning_effort', server: options.serverKind },
    });
    return false;
  }
}

/**
 * Build the needle prompt.
 *
 * The needle goes near the **start**, which is the whole design: a server that truncates drops the
 * front of the context, so a needle at the end would come back correctly from a server that had
 * silently discarded the charter. Exported so a test can assert the needle's position rather than
 * trusting a comment.
 */
export function needlePrompt(needle: string, tokens: number = NEEDLE_TOKENS): string {
  const filler = 'The group discussed logistics. '.repeat(
    Math.ceil((tokens * CHARS_PER_TOKEN) / 31),
  );
  return [
    `Remember this passcode: ${needle}.`,
    '',
    filler,
    '',
    'What was the passcode? Answer with the passcode and nothing else.',
  ].join('\n');
}

/**
 * The context probe.
 *
 * Returns the window it **proved**, not the one the server claims. A `truncates: true` result is
 * the actionable one: `doctor` pairs it with `contextAdviceFor` and names the knob.
 */
export async function probeContext(
  deps: LocalProbeDeps,
  options: LocalProbeOptions,
  signal: AbortSignal,
): Promise<{ readonly truncates: boolean; readonly contextWindowProven?: number }> {
  // The server already said its window is too small. Spending 16K tokens to confirm it would cost
  // a cold model load for an answer we hold.
  if (options.contextWindowHint !== undefined && options.contextWindowHint < NEEDLE_TOKENS) {
    return { truncates: true };
  }

  const needle = `${PROBE_VALUE}-${String(NEEDLE_TOKENS)}`;
  try {
    const body = await deps.transport.chat(
      {
        model: options.model,
        messages: [{ role: 'user', content: needlePrompt(needle) }],
        max_tokens: 64,
      },
      signal,
    );
    const answered = textOf(body).includes(needle);
    return answered
      ? { truncates: false, contextWindowProven: NEEDLE_TOKENS }
      : // The request succeeded and the answer is wrong, which is exactly the silent-truncation
        // signature: no error, confident answer, front of the prompt gone.
        { truncates: true };
  } catch (error) {
    // A refusal here is usually the server rejecting the prompt length outright, which is also
    // truncation-adjacent and equally actionable.
    deps.logger.debug('model.local_probe', {
      outcome: toModelCallError(error, 0, LOCAL_PROVIDER).kind,
      detail: { probe: 'context', server: options.serverKind },
    });
    return { truncates: true };
  }
}

/**
 * Run every probe and settle the level.
 *
 * Sequential, and the order matters for cost rather than correctness: the cheap yes/no probes run
 * first, so a server that turns out to be L4 is known before the 16K needle is sent. A host with a
 * chat-only server should not wait for a long-context probe to find out their bot cannot use tools.
 */
export async function runProbes(
  deps: LocalProbeDeps,
  options: LocalProbeOptions,
  signal: AbortSignal,
): Promise<LocalProbeResult> {
  const tools = await probeTools(deps, options, signal);
  const structured = await probeStructured(deps, options, signal);
  const reasoningEffort = await probeReasoningEffort(deps, options, signal);
  const context = await probeContext(deps, options, signal);

  const capabilities: ProbedCapabilities = {
    nativeTools: tools.nativeTools,
    parallelTools: tools.parallelTools,
    jsonSchema: structured.jsonSchema,
    jsonObject: structured.jsonObject,
    reasoningEffort,
  };

  return {
    ...capabilities,
    serverKind: options.serverKind,
    level: levelFor(capabilities),
    truncates: context.truncates,
    ...(context.contextWindowProven === undefined
      ? {}
      : { contextWindowProven: context.contextWindowProven }),
    model: options.model,
    baseUrl: options.baseUrl,
    ...(options.serverVersion === undefined ? {} : { serverVersion: options.serverVersion }),
    probedAt: deps.now(),
  };
}

/**
 * The cache key (`05` §3.5.6): base URL, model and server version.
 *
 * The **version** is the part that matters. A host who upgrades Ollama to a build that fixed tool
 * calling should get a fresh probe, not a week-old L4 verdict — and a host who did not upgrade
 * should not pay for a probe on every boot. Without the version in the key, the 168-hour TTL would
 * be the only thing standing between a fixed server and a week of degraded behaviour.
 */
export function probeCacheKey(baseUrl: string, model: string, serverVersion?: string): string {
  return `${baseUrl}|${model}|${serverVersion ?? 'unknown'}`;
}

/** `models.local.probeTtlHours`'s default (`05` §3.5.6). One week. */
export const PROBE_TTL_HOURS = 168;

/**
 * Whether a cached result is still usable.
 *
 * A result from the *future* is treated as stale rather than fresh. That is not pedantry: a host
 * whose clock was wrong when the probe ran, or who restored a backup from another machine, would
 * otherwise hold a cache entry that never expires.
 */
export function isProbeFresh(
  result: LocalProbeResult,
  nowMs: number,
  ttlHours: number = PROBE_TTL_HOURS,
): boolean {
  const probedAtMs = Date.parse(result.probedAt);
  if (Number.isNaN(probedAtMs)) return false;
  const ageMs = nowMs - probedAtMs;
  return ageMs >= 0 && ageMs < ttlHours * 60 * 60 * 1000;
}
