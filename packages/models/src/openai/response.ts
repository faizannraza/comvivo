/**
 * Reading a Responses API response (`05` §3.5.4; `M2-T11`).
 *
 * ## The stop reason comes first
 *
 * Same rule as the Anthropic adapter and for the same reason (`05` §3.5.3.4): a truncated or
 * filtered response's partial text must never be shown and its partial tool call must never be
 * executed. `readStop` reads `status` and `incomplete_details` and nothing else, so it cannot be
 * confused by content.
 *
 * Measured against openai 7.55.0 on 2026-11-13: `IncompleteDetails.reason` has **four** members —
 * `max_output_tokens | max_messages | content_filter | steered` — where `05` §3.5.4 names two.
 * `steered` is new and is *not* a failure: it means the response stopped at a safe boundary after
 * a WebSocket steer and the server will continue it, which is the same control flow as Anthropic's
 * `pause_turn`.
 *
 * ## Opaque items are the majority
 *
 * `ResponseOutputItem` is a 28-member union. We read three kinds and keep every item whole in
 * `raw`, which is what `05` §3.5.4's "replayed verbatim" requires and what the `opaque` part in
 * `AssistantPart` exists for. Giving reasoning text a typed home here is how model reasoning ends
 * up in a disclosure guard's log (`08` §3.16).
 */

import type { AssistantMessage, AssistantPart, StopInfo, UsageIteration } from '@comvivo/core';
import type OpenAI from 'openai';

type Response = OpenAI.Responses.Response;
type OutputItem = OpenAI.Responses.ResponseOutputItem;

export const OPENAI_PROVIDER = 'openai' as const;

/**
 * Why a response stopped.
 *
 * `status: 'completed'` with tool calls is `tool_use`; without them, `end_turn`. An incomplete
 * response maps by its reason. `failed` and `cancelled` are not stop reasons at all — the SDK
 * raises for the first and the caller caused the second — so they map to `other` rather than being
 * silently read as a finished turn.
 */
export function readStop(response: Response): StopInfo {
  const raw = response.status ?? 'completed';

  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    switch (reason) {
      case 'max_output_tokens':
        return { reason: 'max_tokens', raw: `incomplete:${reason}` };
      case 'content_filter':
        // `05` §3.5.4 maps a content filter to a refusal. `provider_filter` rather than a category
        // of our own, because the provider did not tell us which policy fired and inventing one
        // would put a wrong label in the trace a host reads.
        return {
          reason: 'refusal',
          raw: `incomplete:${reason}`,
          category: 'provider_filter',
          servedByFallback: false,
        };
      case 'max_messages':
        return { reason: 'context_overflow', raw: `incomplete:${reason}` };
      case 'steered':
        // Added to the SDK after `05` §3.5.4 was written. The server stopped at a safe boundary
        // and will continue with the queued input, which is the same control flow as Anthropic's
        // `pause_turn` — so the engine calls again rather than treating it as a finished turn.
        return { reason: 'pause_turn', raw: `incomplete:${reason}` };
      case undefined:
        return { reason: 'other', raw: 'incomplete' };
    }
  }

  // A refusal can also arrive on a *completed* response, as refusal content inside the message.
  const refusal = firstRefusal(response.output);
  if (refusal !== undefined) {
    return {
      reason: 'refusal',
      raw,
      category: null,
      explanation: refusal,
      servedByFallback: false,
    };
  }

  if (response.output.some((item) => item.type === 'function_call')) {
    return { reason: 'tool_use', raw };
  }
  if (response.status === 'completed' || response.status === undefined) {
    return { reason: 'end_turn', raw };
  }
  // `failed`, `cancelled`, `queued`, `in_progress`: not a finished turn, and not something to
  // report as one.
  return { reason: 'other', raw };
}

function firstRefusal(output: readonly OutputItem[]): string | undefined {
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const content of item.content) {
      if (content.type === 'refusal') return content.refusal;
    }
  }
  return undefined;
}

/** Visible assistant text: every `output_text` of every message item, in order. */
export function visibleText(output: readonly OutputItem[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const content of item.content) {
      if (content.type === 'output_text') parts.push(content.text);
    }
  }
  return parts.join('');
}

export interface ParsedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Tool calls, with their arguments parsed.
 *
 * `call_id` and not `id`: `call_id` is the one `function_call_output` matches on, and the two are
 * different fields. Getting it wrong produces a tool result the model cannot attach to its call,
 * which the API rejects on the next turn.
 *
 * A call whose arguments do not parse is **dropped**, not passed through with a string input. The
 * tools are strict, so this should not happen; if it does, a tool executed with a malformed input
 * is worse than a tool that did not run, and `01` §2.1's `strict: true` is what makes dropping the
 * right answer rather than a guess.
 */
export function toolCallsOf(output: readonly OutputItem[]): readonly ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const item of output) {
    if (item.type !== 'function_call') continue;
    let input: unknown;
    try {
      input = JSON.parse(item.arguments);
    } catch {
      continue;
    }
    calls.push({ id: item.call_id, name: item.name, input });
  }
  return calls;
}

/** Which `AssistantPart` an output item becomes in the engine's typed view. */
function partsOf(item: OutputItem): readonly AssistantPart[] {
  if (item.type === 'message') {
    return item.content.flatMap((content): readonly AssistantPart[] =>
      content.type === 'output_text' ? [{ type: 'text', text: content.text }] : [],
    );
  }
  if (item.type === 'function_call') {
    let input: unknown;
    try {
      input = JSON.parse(item.arguments);
    } catch {
      input = undefined;
    }
    return [{ type: 'tool_call', id: item.call_id, name: item.name, input }];
  }
  if (item.type === 'reasoning') {
    // Coarse on purpose. The engine must know a reasoning item is present — it must not be dropped
    // from `raw` — without being able to read it.
    return [{ type: 'opaque', kind: 'reasoning' }];
  }
  // Every other item kind: web search, shell, apply-patch, program, MCP, compaction. We do not
  // model them, and `raw` carries them whole.
  return [{ type: 'opaque', kind: 'other' }];
}

/**
 * The assistant message.
 *
 * `raw` is the **output item array**, which is exactly what `inputItemsOf` replays. Storing the
 * whole `Response` object instead would replay `id`, `usage` and `status` as input items, which
 * the API rejects.
 */
export function assistantMessageOf(response: Response): AssistantMessage {
  return {
    role: 'assistant',
    provider: OPENAI_PROVIDER,
    servedModel: response.model,
    raw: response.output,
    view: response.output.flatMap((item) => partsOf(item)),
  };
}

/**
 * Usage, as one billed iteration.
 *
 * Measured against openai 7.55.0 (2026-11-13), and `05` §3.5.4's account is **out of date**:
 * `input_tokens_details` now carries `cache_write_tokens` as well as `cached_tokens`, with a
 * `cache_write_tokens_details` split into `ttl_30m_tokens` and `ttl_12h_tokens`. Cache writes are
 * billed, so a cost model that only subtracted `cached_tokens` — which is what §3.5.4's formula
 * does — would under-report every cold prefix.
 *
 * `input_tokens` **includes** cached tokens, so `UsageIteration.input` is the remainder after both
 * the reads and the writes are taken out. That matches the Anthropic mapping, where `input` is
 * likewise the uncached part, which is what lets `02` §3.3.7 roll both providers up in one table.
 */
export function usageIterationOf(
  response: Response,
  requestedModel: string,
): readonly UsageIteration[] {
  const usage = response.usage;
  if (usage === undefined) return [];

  const details = usage.input_tokens_details;
  const cacheRead = details.cached_tokens;
  const writes = details.cache_write_tokens_details;
  // The two TTLs map onto our 5m/1h columns by *which is shorter*, not by equal duration: the
  // columns are priced slots, and 30m is this provider's short slot while 12h is its long one.
  // `05` §3.9.2 prices per provider, so the slot is what has to line up, not the number.
  const cacheWrite5m =
    writes?.ttl_30m_tokens ?? (writes === undefined ? details.cache_write_tokens : 0);
  const cacheWrite1h = writes?.ttl_12h_tokens ?? 0;
  const input = Math.max(0, usage.input_tokens - cacheRead - cacheWrite5m - cacheWrite1h);

  return [
    {
      model: response.model === '' ? requestedModel : response.model,
      kind: 'message',
      input,
      cacheRead,
      cacheWrite5m,
      cacheWrite1h,
      output: usage.output_tokens,
      ...(usage.output_tokens_details.reasoning_tokens === 0
        ? {}
        : { reasoning: usage.output_tokens_details.reasoning_tokens }),
      batch: false,
    },
  ];
}
