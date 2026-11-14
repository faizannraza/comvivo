/**
 * Reading a local server's Chat Completions response (`05` §3.5.6; `M2-T12`).
 *
 * Two readers, because L1 and L2/L3 produce genuinely different answers:
 *
 *  - **Native (L1).** `choices[0].message.tool_calls`, as any OpenAI-compatible server emits.
 *  - **Envelope (L2/L3).** The whole reply is one JSON object that has to be parsed, validated per
 *    tool, and turned into calls with ids we generate.
 *
 * The usage mapping is shared, and is the part most likely to be quietly wrong: these servers
 * report `prompt_tokens` **including** any cache hit, and most report `prompt_tokens_details`
 * either incompletely or not at all. A reader that assumed the field was present would report
 * every local turn as a full cache miss and make the dashboard's local cost line meaningless.
 */
import type {
  AssistantMessage,
  AssistantPart,
  SchemaLike,
  StopInfo,
  ToolSpec,
  UsageIteration,
} from '@comvivo/core';
import type OpenAI from 'openai';
import {
  type EnvelopeCall,
  envelopeCallId,
  parseEnvelope,
  type ValidatedCall,
  validateCalls,
} from './envelope.js';

type Completion = OpenAI.Chat.Completions.ChatCompletion;

export const LOCAL_PROVIDER = 'openai-compatible' as const;

function firstChoice(completion: Completion): Completion['choices'][number] | undefined {
  return completion.choices[0];
}

/**
 * Why the response stopped.
 *
 * `finish_reason` on these servers is the Chat Completions set, and the two that matter are
 * `length` (truncated) and `tool_calls`. `content_filter` exists on some and maps to a refusal.
 *
 * An **absent** `finish_reason` is read as `other`, not as `end_turn`: llama.cpp has shipped builds
 * that omit it, and reading a missing field as a successful completion is how a truncated answer
 * gets shown to a group as a finished one.
 */
/**
 * A wire value, as a short string safe to put in a trace.
 *
 * `String(unknown)` gives `[object Object]`, and reporting the **type** of a non-string is more
 * useful: a host reading `raw: "object"` learns their server sent a shape where a string belongs,
 * which on this adapter is a real possibility — four implementations, one loose contract.
 */
function describeWire(value: unknown): string {
  return typeof value === 'string' ? value : typeof value;
}

/** Every member of Chat Completions' `finish_reason`, measured against `openai` 7.55.0. */
type FinishReason = NonNullable<NonNullable<Completion['choices'][number]>['finish_reason']>;

/**
 * The members, as values, with completeness enforced by `satisfies` rather than by a comment.
 *
 * A member added to the SDK's union breaks the build here, which is where somebody has to decide
 * what the new reason means for a turn.
 */
const KNOWN_FINISH_REASONS = Object.freeze({
  stop: true,
  length: true,
  tool_calls: true,
  content_filter: true,
  function_call: true,
} satisfies Record<FinishReason, true>);

/** Whether the wire's `finish_reason` is one this build knows. `undefined` counts: it is handled. */
function isKnownFinishReason(value: unknown): value is FinishReason | undefined {
  if (value === undefined) return true;
  return typeof value === 'string' && Object.hasOwn(KNOWN_FINISH_REASONS, value);
}

export function readStop(completion: Completion): StopInfo {
  const wire: unknown = firstChoice(completion)?.finish_reason;
  if (!isKnownFinishReason(wire)) {
    // A `finish_reason` this build has never heard of — and on this adapter that is the *likely*
    // case, not the unlikely one: four different servers implement this field (Ollama, LM Studio,
    // llama.cpp, vLLM) and none of them is bound by OpenAI's union. Before this branch the switch
    // below was exhaustive to TypeScript and returned `undefined` at run time. Found at the M2
    // review, here and in the three other adapters.
    return { reason: 'other', raw: wire === null ? 'null' : describeWire(wire) };
  }
  const reason = wire;
  switch (reason) {
    case 'stop':
      return { reason: 'end_turn', raw: reason };
    case 'tool_calls':
    case 'function_call':
      return { reason: 'tool_use', raw: reason };
    case 'length':
      return { reason: 'max_tokens', raw: reason };
    case 'content_filter':
      return {
        reason: 'refusal',
        raw: reason,
        category: 'provider_filter',
        servedByFallback: false,
      };
    case undefined:
      return { reason: 'other', raw: 'missing_finish_reason' };
  }
}

/** The assistant's visible text. */
export function visibleText(completion: Completion): string {
  const content = firstChoice(completion)?.message.content;
  return typeof content === 'string' ? content : '';
}

export interface ParsedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** Native tool calls, with arguments parsed. A malformed one is dropped, as on OpenAI. */
export function nativeToolCalls(completion: Completion): readonly ParsedToolCall[] {
  const calls = firstChoice(completion)?.message.tool_calls ?? [];
  const parsed: ParsedToolCall[] = [];
  for (const call of calls) {
    if (call.type !== 'function') continue;
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      continue;
    }
    parsed.push({ id: call.id, name: call.function.name, input });
  }
  return parsed;
}

/** What the envelope reader produced. */
export interface EnvelopeRead {
  readonly reply: string;
  readonly calls: readonly ParsedToolCall[];
  /** Calls whose input failed its tool's schema. These become `is_error` results (`05` §3.5.6). */
  readonly rejected: readonly {
    readonly id: string;
    readonly name: string;
    readonly issue: string;
  }[];
  /** Set when the envelope itself could not be parsed. `L3` retries once on this. */
  readonly malformed?: string;
}

/**
 * Read an envelope response.
 *
 * `step` seeds the generated call ids, so two steps of one turn cannot produce the same id — which
 * would attach a tool result to the wrong call.
 */
export function readEnvelope(
  completion: Completion,
  tools: readonly ToolSpec[],
  step: number,
  schemas: ReadonlyMap<string, SchemaLike<unknown>> = new Map(),
): EnvelopeRead {
  const outcome = parseEnvelope(visibleText(completion));
  if (outcome.kind === 'malformed') {
    return { reply: '', calls: [], rejected: [], malformed: outcome.issue };
  }

  const validated = validateCalls(outcome.envelope.toolCalls, tools, schemas);
  const calls: ParsedToolCall[] = [];
  const rejected: { id: string; name: string; issue: string }[] = [];
  for (const [index, entry] of validated.entries()) {
    const id = envelopeCallId(step, index);
    if (entry.kind === 'ok') calls.push({ id, name: entry.name, input: entry.input });
    else rejected.push({ id, name: entry.name, issue: entry.issue });
  }

  return { reply: outcome.envelope.reply ?? '', calls, rejected };
}

/** The envelope's own calls, before validation. For a test and for a diagnostic. */
export function envelopeCallsOf(completion: Completion): readonly EnvelopeCall[] {
  const outcome = parseEnvelope(visibleText(completion));
  return outcome.kind === 'ok' ? outcome.envelope.toolCalls : [];
}

/** The typed view. */
function viewOf(text: string, calls: readonly ParsedToolCall[]): readonly AssistantPart[] {
  return [
    ...(text === '' ? [] : [{ type: 'text' as const, text }]),
    ...calls.map((call) => ({
      type: 'tool_call' as const,
      id: call.id,
      name: call.name,
      input: call.input,
    })),
  ];
}

/**
 * The assistant message.
 *
 * `raw` is the completion's own `message` object. There is no opaque provider state on these
 * servers — no thought signature, no encrypted reasoning — so `raw` exists for the trace and for a
 * cassette rather than for replay, and `request.ts` rebuilds the turn from the typed view.
 */
export function assistantMessageOf(
  completion: Completion,
  text: string,
  calls: readonly ParsedToolCall[],
): AssistantMessage {
  return {
    role: 'assistant',
    provider: LOCAL_PROVIDER,
    servedModel: completion.model,
    raw: firstChoice(completion)?.message ?? {},
    view: viewOf(text, calls),
  };
}

/**
 * Usage.
 *
 * Three defensive readings, each because a real server does it:
 *
 *  - `usage` itself can be **absent** (llama.cpp without the right flag, some vLLM versions).
 *    Absent means no iteration at all rather than a zero-token one: a zero row in the ledger would
 *    read as a free turn.
 *  - `prompt_tokens_details.cached_tokens` is often absent even when the server has a KV cache hit,
 *    so a missing value is `0` rather than an error.
 *  - `prompt_tokens` **includes** the cached count where both are present, so `input` is the
 *    remainder — the same convention as OpenAI and Google, which is what lets `02` §3.3.7 roll all
 *    four providers up in one table.
 *
 * There is no cache-**write** category on any of the four: a KV prefix cache is not billed, and a
 * local model is not billed at all. Both write columns are zero, and the price table carries a
 * **`local/*` row at zero** — which the M2 review caught this comment denying: it said "the price
 * table carries no `local/*` row, so `costIteration` falls back conservatively", and the row is in
 * all three shipped tables. The denial was not harmless. The free row is reachable only through
 * the `local/` prefix, and the served model this function reports is bare (`llama3.2:3b`), so
 * until `RouteInfo.priceId` carried the prefix a host's own hardware was billed at the
 * unknown-model fallback's rates.
 */
export function usageIterationOf(
  completion: Completion,
  requestedModel: string,
): readonly UsageIteration[] {
  const usage = completion.usage;
  if (usage === undefined) return [];

  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = usage.prompt_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;

  return [
    {
      model: completion.model === '' ? requestedModel : completion.model,
      kind: 'message',
      input: Math.max(0, prompt - cacheRead),
      cacheRead,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: usage.completion_tokens,
      ...(reasoning === 0 ? {} : { reasoning }),
      batch: false,
    },
  ];
}

/** `validateCalls`'s rejections, as the `is_error` tool results the engine sends back. */
export function rejectionResults(
  rejected: EnvelopeRead['rejected'],
): readonly { readonly toolCallId: string; readonly content: string; readonly isError: true }[] {
  return rejected.map((entry) => ({
    toolCallId: entry.id,
    // The tool's name and the issue, and **not** the input: an input that failed validation is
    // still member data, and this string goes back into a prompt.
    content: JSON.stringify({ error: 'invalid_tool_input', tool: entry.name, issue: entry.issue }),
    isError: true,
  }));
}

/** Re-exported so the adapter's callers do not have to reach into `envelope.ts`. */
export type { ValidatedCall };
