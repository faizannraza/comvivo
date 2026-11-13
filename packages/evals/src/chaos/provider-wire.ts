/**
 * The two provider wire formats `FakeProviderServer` speaks, as pure functions (`11` §3.1.9, §3.2.4;
 * `M2-T10`).
 *
 * Separate from the server because **this is the part that has to be exactly right**. If an SSE
 * event is named `content_block_started` instead of `content_block_start`, every adapter written
 * against this fake is written against a lie, and the mistake only surfaces on the first live call
 * — after `H-2` arrives, in `M2-T19`, long after `M2-T6` was "done". Testing the bytes through an
 * HTTP round-trip would make that assertion slower and noisier for no benefit, so the renderers are
 * functions over a value and the server only writes what they return.
 *
 * ## One neutral reply, two formats
 *
 * A test describes what the model *said* — some text, a tool call, a stop reason, a usage block —
 * and both renderers turn it into their own shape. That is deliberate: the adapter contract suite
 * (`M2-T14`) asserts `01` §2.1's rules on **every** adapter, so a test that had to hand-write two
 * JSON blobs would be a test that drifts between them. The `raw` escape hatch in
 * `fake-provider-server.ts` covers the shapes this neutral model cannot express.
 *
 * ## Where the shapes come from
 *
 * Re-verified at implementation time (`CLAUDE.md` §6) against the Anthropic API's documented wire
 * format rather than recalled: the six SSE event names, the `input_json_delta` /`thinking_delta`
 * /`signature_delta` block deltas, the error envelope's `{ type, error: { type, message },
 * request_id }`, the `429`/`500`/`529` → `rate_limit_error`/`api_error`/`overloaded_error` mapping,
 * and `usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` as the
 * per-TTL breakdown of `cache_creation_input_tokens`. The OpenAI-compatible half is the
 * `/v1/chat/completions` subset that Ollama, LM Studio, llama.cpp and vLLM all implement
 * (`05` §3.5.6), which is what `M2-T12` talks to.
 */

/** Everything the fake can be told to say, independent of which wire it goes out on. */
export interface FakeUsage {
  /** The **uncached remainder** only, as the real API reports it. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWrite5mInputTokens?: number;
  readonly cacheWrite1hInputTokens?: number;
}

export interface FakeToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * The stop reasons worth faking.
 *
 * `refusal` and `pause_turn` are Anthropic-only concepts; the OpenAI renderer maps both to `stop`
 * and says so, because inventing an equivalent would let a test pass against a shape no local
 * server produces. A test for either uses the Anthropic endpoint.
 */
export type FakeStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn';

export interface FakeReply {
  /** A summarized thinking block, emitted before the text. Replayed unchanged by `05`. */
  readonly thinking?: string;
  readonly text?: string;
  readonly toolCalls?: readonly FakeToolCall[];
  /** Defaults to `tool_use` when there are tool calls, `end_turn` otherwise. */
  readonly stopReason?: FakeStopReason;
  readonly usage?: FakeUsage;
  readonly model?: string;
}

/** One Server-Sent Event, before framing. */
export interface SseEvent {
  /** Anthropic sends a named event; the OpenAI-compatible format sends only `data:`. */
  readonly event?: string;
  /** `'[DONE]'` for the OpenAI terminator, which is a bare string rather than JSON. */
  readonly data: unknown;
}

/** RFC 8895 framing: `event:` when named, one `data:` line, then a blank line. */
export function frameSse(event: SseEvent): string {
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  const name = event.event === undefined ? '' : `event: ${event.event}\n`;
  return `${name}data: ${data}\n\n`;
}

export interface WireIds {
  readonly messageId: string;
  /** Unix seconds, for the OpenAI-compatible `created` field. Fixed, so goldens are stable. */
  readonly created: number;
}

const DEFAULT_USAGE: FakeUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * The opaque thinking signature the fake emits.
 *
 * Stable, so a test can assert the block survived the adapter's round trip unchanged — which is
 * `05` §3.5.3's rule that `response.content` is appended back verbatim, thinking blocks included.
 */
export const FAKE_THINKING_SIGNATURE = 'sig_fake';

function stopReasonOf(reply: FakeReply): FakeStopReason {
  if (reply.stopReason !== undefined) return reply.stopReason;
  return (reply.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn';
}

/* ────────────────────────────── Anthropic Messages ────────────────────────────── */

/** `usage`, with the cache fields present only when the reply named them. */
function anthropicUsage(usage: FakeUsage): Record<string, unknown> {
  const writes5m = usage.cacheWrite5mInputTokens ?? 0;
  const writes1h = usage.cacheWrite1hInputTokens ?? 0;
  const creation = writes5m + writes1h;
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
    cache_creation_input_tokens: creation,
    // The per-TTL breakdown of `cache_creation_input_tokens`. Emitted whenever there is a write,
    // because `M2-T14`'s AC asks for the 5m and 1h fields to be mapped and a field that is absent
    // in the fake is a field the adapter is never tested against.
    ...(creation > 0
      ? {
          cache_creation: {
            ephemeral_5m_input_tokens: writes5m,
            ephemeral_1h_input_tokens: writes1h,
          },
        }
      : {}),
  };
}

/**
 * One content block, typed.
 *
 * A union rather than `Record<string, unknown>`: the block kind decides which SSE delta carries it,
 * and an untyped map meant `String(block['text'])` — which the `no-base-to-string` rule correctly
 * refused, because it would have silently emitted `[object Object]` for a malformed block instead
 * of failing.
 */
export type AnthropicBlock =
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    };

/** The content blocks, in the order the real API emits them: thinking, then text, then tool uses. */
function anthropicContent(reply: FakeReply): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  if (reply.thinking !== undefined) {
    // `signature` is opaque and must be replayed verbatim (`05` §3.5.3). A stable fake value is
    // what lets a test assert it survived the round trip.
    blocks.push({ type: 'thinking', thinking: reply.thinking, signature: FAKE_THINKING_SIGNATURE });
  }
  if (reply.text !== undefined) blocks.push({ type: 'text', text: reply.text });
  for (const call of reply.toolCalls ?? []) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
  }
  return blocks;
}

export function anthropicMessage(
  reply: FakeReply,
  ids: WireIds,
  defaultModel: string,
): Record<string, unknown> {
  return {
    id: ids.messageId,
    type: 'message',
    role: 'assistant',
    model: reply.model ?? defaultModel,
    content: anthropicContent(reply),
    stop_reason: stopReasonOf(reply),
    stop_sequence: null,
    usage: anthropicUsage(reply.usage ?? DEFAULT_USAGE),
  };
}

/**
 * The SSE stream for one reply.
 *
 * A `ping` is emitted after `message_start`, which the real API also does at intervals. It is here
 * on purpose: an adapter that treats every event as meaningful breaks on the first long response in
 * production, and this is the cheapest place to find out.
 */
export function anthropicStream(
  reply: FakeReply,
  ids: WireIds,
  defaultModel: string,
): readonly SseEvent[] {
  const usage = reply.usage ?? DEFAULT_USAGE;
  const blocks = anthropicContent(reply);
  const events: SseEvent[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: ids.messageId,
          type: 'message',
          role: 'assistant',
          model: reply.model ?? defaultModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // `output_tokens` starts at 0 and arrives for real in `message_delta`.
          usage: { ...anthropicUsage(usage), output_tokens: 0 },
        },
      },
    },
    { event: 'ping', data: { type: 'ping' } },
  ];

  for (const [index, block] of blocks.entries()) {
    events.push(...anthropicBlockEvents(block, index));
  }

  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: stopReasonOf(reply), stop_sequence: null },
      usage: { output_tokens: usage.outputTokens },
    },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}

/** One content block's start / delta / stop triple, with the delta kind its type requires. */
function anthropicBlockEvents(block: AnthropicBlock, index: number): SseEvent[] {
  const start = (contentBlock: Record<string, unknown>): SseEvent => ({
    event: 'content_block_start',
    data: { type: 'content_block_start', index, content_block: contentBlock },
  });
  const delta = (payload: Record<string, unknown>): SseEvent => ({
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index, delta: payload },
  });
  const stop: SseEvent = {
    event: 'content_block_stop',
    data: { type: 'content_block_stop', index },
  };

  switch (block.type) {
    case 'thinking':
      return [
        start({ type: 'thinking', thinking: '' }),
        delta({ type: 'thinking_delta', thinking: block.thinking }),
        delta({ type: 'signature_delta', signature: block.signature }),
        stop,
      ];
    case 'tool_use':
      // Arguments stream as a **JSON string** in fragments, not as an object. An adapter that
      // forgets to concatenate and parse works for an empty input and fails for every real call.
      return [
        start({ type: 'tool_use', id: block.id, name: block.name, input: {} }),
        delta({ type: 'input_json_delta', partial_json: JSON.stringify(block.input) }),
        stop,
      ];
    case 'text':
      return [
        start({ type: 'text', text: '' }),
        delta({ type: 'text_delta', text: block.text }),
        stop,
      ];
  }
}

/** `11` §3.6 S10's model-provider faults, in the envelope the real API uses. */
export function anthropicError(status: number, requestId: string): Record<string, unknown> {
  return {
    type: 'error',
    error: { type: anthropicErrorType(status), message: anthropicErrorMessage(status) },
    request_id: requestId,
  };
}

export function anthropicErrorType(status: number): string {
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status === 401) return 'authentication_error';
  if (status === 400) return 'invalid_request_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  return 'api_error';
}

function anthropicErrorMessage(status: number): string {
  if (status === 429) return 'Number of requests has exceeded your rate limit.';
  if (status === 529) return 'Overloaded';
  return 'Internal server error';
}

/* ─────────────────────────── OpenAI-compatible chat ─────────────────────────── */

/**
 * `finish_reason`, with the two Anthropic-only reasons collapsed.
 *
 * `refusal` and `pause_turn` have no equivalent in this format — a local server never produces
 * either — so both become `stop`. Mapping them to `content_filter` would let an adapter test pass
 * against a shape nothing emits.
 */
export function openaiFinishReason(reason: FakeStopReason): string {
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'length';
  return 'stop';
}

function openaiUsage(usage: FakeUsage): Record<string, unknown> {
  const prompt =
    usage.inputTokens +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheWrite5mInputTokens ?? 0) +
    (usage.cacheWrite1hInputTokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    // vLLM and newer OpenAI-compatible servers report cache hits here. Zero rather than absent, so
    // an adapter reading it does not have to distinguish "no cache" from "no field".
    prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens ?? 0 },
  };
}

function openaiToolCalls(reply: FakeReply): Record<string, unknown>[] {
  return (reply.toolCalls ?? []).map((call, index) => ({
    index,
    id: call.id,
    type: 'function',
    // `arguments` is a **string** of JSON in this format, which is the single most common place an
    // adapter written from memory gets it wrong.
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }));
}

export function openaiCompletion(
  reply: FakeReply,
  ids: WireIds,
  defaultModel: string,
): Record<string, unknown> {
  const calls = openaiToolCalls(reply);
  return {
    id: ids.messageId,
    object: 'chat.completion',
    created: ids.created,
    model: reply.model ?? defaultModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: reply.text ?? null,
          ...(reply.thinking === undefined ? {} : { reasoning_content: reply.thinking }),
          ...(calls.length > 0
            ? { tool_calls: calls.map(({ index: _index, ...rest }) => rest) }
            : {}),
        },
        logprobs: null,
        finish_reason: openaiFinishReason(stopReasonOf(reply)),
      },
    ],
    usage: openaiUsage(reply.usage ?? DEFAULT_USAGE),
  };
}

export interface OpenaiStreamOptions {
  /** `stream_options: { include_usage: true }`: emit a usage-only chunk before `[DONE]`. */
  readonly includeUsage: boolean;
}

export function openaiStream(
  reply: FakeReply,
  ids: WireIds,
  defaultModel: string,
  options: OpenaiStreamOptions,
): readonly SseEvent[] {
  const model = reply.model ?? defaultModel;
  const chunk = (delta: Record<string, unknown>, finish: string | null): SseEvent => ({
    data: {
      id: ids.messageId,
      object: 'chat.completion.chunk',
      created: ids.created,
      model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    },
  });

  const events: SseEvent[] = [chunk({ role: 'assistant', content: '' }, null)];
  if (reply.thinking !== undefined) events.push(chunk({ reasoning_content: reply.thinking }, null));
  if (reply.text !== undefined) events.push(chunk({ content: reply.text }, null));
  for (const call of openaiToolCalls(reply)) events.push(chunk({ tool_calls: [call] }, null));
  events.push(chunk({}, openaiFinishReason(stopReasonOf(reply))));

  if (options.includeUsage) {
    events.push({
      data: {
        id: ids.messageId,
        object: 'chat.completion.chunk',
        created: ids.created,
        model,
        // A usage-only chunk carries no choices, which is the shape that breaks an adapter
        // assuming `choices[0]` always exists.
        choices: [],
        usage: openaiUsage(reply.usage ?? DEFAULT_USAGE),
      },
    });
  }
  events.push({ data: '[DONE]' });
  return events;
}

/** The OpenAI-compatible error envelope: one `error` object, no `type` sibling. */
export function openaiError(status: number): Record<string, unknown> {
  return {
    error: {
      message: anthropicErrorMessage(status),
      type: status === 429 ? 'rate_limit_exceeded' : 'server_error',
      param: null,
      code: status === 429 ? 'rate_limit_exceeded' : null,
    },
  };
}
