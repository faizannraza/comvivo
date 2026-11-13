/**
 * The wire formats, asserted on the bytes (`M2-T10`).
 *
 * These are the assertions that make `FakeProviderServer` trustworthy. An adapter written against
 * a fake whose SSE event is misnamed is an adapter written against a lie, and the lie only surfaces
 * on the first live call — which, with `H-2` still open, is weeks away. So every event name, every
 * delta kind and every usage field is named here explicitly rather than snapshotted: a snapshot
 * would have recorded the mistake just as faithfully.
 */
import { describe, expect, it } from 'vitest';
import {
  anthropicError,
  anthropicErrorType,
  anthropicMessage,
  anthropicStream,
  FAKE_THINKING_SIGNATURE,
  type FakeReply,
  type FakeUsage,
  frameSse,
  openaiCompletion,
  openaiError,
  openaiFinishReason,
  openaiStream,
  type SseEvent,
  type WireIds,
} from './provider-wire.js';

const IDS: WireIds = { messageId: 'msg_fake_1', created: 1_767_225_600 };
const MODEL = 'claude-opus-5-5';

/** The event names, in order, so an assertion reads like the stream it describes. */
function names(events: readonly SseEvent[]): string[] {
  return events.map((event) => event.event ?? '(unnamed)');
}

function dataOf(event: SseEvent): Record<string, unknown> {
  return event.data as Record<string, unknown>;
}

/** `choices[0]` of an OpenAI-compatible chunk, or `undefined` for a usage-only one. */
function choiceOf(chunk: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = chunk['choices'];
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  return typeof first === 'object' && first !== null
    ? (first as Record<string, unknown>)
    : undefined;
}

/** The `delta` of `choices[0]`, or an empty object. Flattens the double cast these chunks invite. */
function deltaOf(chunk: Record<string, unknown>): Record<string, unknown> {
  const delta = choiceOf(chunk)?.['delta'];
  return typeof delta === 'object' && delta !== null ? (delta as Record<string, unknown>) : {};
}

describe('frameSse', () => {
  it('writes a named event, one data line, and a blank line', () => {
    expect(frameSse({ event: 'ping', data: { type: 'ping' } })).toBe(
      'event: ping\ndata: {"type":"ping"}\n\n',
    );
  });

  it('omits the event line for the OpenAI-compatible format', () => {
    expect(frameSse({ data: { a: 1 } })).toBe('data: {"a":1}\n\n');
  });

  it('passes a string through unquoted, for the [DONE] terminator', () => {
    expect(frameSse({ data: '[DONE]' })).toBe('data: [DONE]\n\n');
  });
});

describe('anthropicMessage', () => {
  it('has the envelope the Messages API returns', () => {
    const body = anthropicMessage({ text: 'hi' }, IDS, MODEL);
    expect(body).toMatchObject({
      id: 'msg_fake_1',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      stop_reason: 'end_turn',
      stop_sequence: null,
    });
    expect(body['content']).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('defaults stop_reason to tool_use when there are tool calls', () => {
    const body = anthropicMessage(
      { toolCalls: [{ id: 'toolu_1', name: 'get_forecast', input: { city: 'Paris' } }] },
      IDS,
      MODEL,
    );
    expect(body['stop_reason']).toBe('tool_use');
    expect(body['content']).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'get_forecast', input: { city: 'Paris' } },
    ]);
  });

  it('emits thinking before text, with a stable signature', () => {
    const body = anthropicMessage({ thinking: 'hmm', text: 'hi' }, IDS, MODEL);
    expect(body['content']).toEqual([
      { type: 'thinking', thinking: 'hmm', signature: FAKE_THINKING_SIGNATURE },
      { type: 'text', text: 'hi' },
    ]);
  });

  it('lets a reply override the model, so a fallback can be observed', () => {
    expect(anthropicMessage({ text: 'x', model: 'claude-haiku-5-5' }, IDS, MODEL)['model']).toBe(
      'claude-haiku-5-5',
    );
  });

  it('reports every usage field, with the per-TTL cache breakdown', () => {
    const usage: FakeUsage = {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadInputTokens: 512,
      cacheWrite5mInputTokens: 100,
      cacheWrite1hInputTokens: 40,
    };
    expect(anthropicMessage({ text: 'x', usage }, IDS, MODEL)['usage']).toEqual({
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 512,
      cache_creation_input_tokens: 140,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 40 },
    });
  });

  it('omits cache_creation when nothing was written', () => {
    const usage = anthropicMessage({ text: 'x' }, IDS, MODEL)['usage'] as Record<string, unknown>;
    expect('cache_creation' in usage).toBe(false);
    expect(usage['cache_creation_input_tokens']).toBe(0);
    // Zero rather than absent, so an adapter reading it never has to tell "no cache" from "no field".
    expect(usage['cache_read_input_tokens']).toBe(0);
  });
});

describe('anthropicStream', () => {
  it('emits the six documented event names, with a ping after message_start', () => {
    expect(names(anthropicStream({ text: 'hi' }, IDS, MODEL))).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('starts with zero output tokens and reports them in message_delta', () => {
    const events = anthropicStream(
      { text: 'hi', usage: { inputTokens: 7, outputTokens: 4 } },
      IDS,
      MODEL,
    );
    const start = dataOf(events[0] as SseEvent)['message'] as Record<string, unknown>;
    expect((start['usage'] as Record<string, unknown>)['output_tokens']).toBe(0);
    expect((start['usage'] as Record<string, unknown>)['input_tokens']).toBe(7);
    expect(start['content']).toEqual([]);
    expect(start['stop_reason']).toBeNull();

    const delta = dataOf(events.at(-2) as SseEvent);
    expect(delta['delta']).toEqual({ stop_reason: 'end_turn', stop_sequence: null });
    expect(delta['usage']).toEqual({ output_tokens: 4 });
  });

  it('streams tool arguments as a JSON string in input_json_delta', () => {
    const events = anthropicStream(
      { toolCalls: [{ id: 'toolu_1', name: 'add', input: { a: 1 } }] },
      IDS,
      MODEL,
    );
    const start = events.find((event) => event.event === 'content_block_start');
    expect(dataOf(start as SseEvent)['content_block']).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'add',
      // Empty at the start: the arguments arrive as fragments, which is the part adapters forget.
      input: {},
    });
    const delta = events.find((event) => event.event === 'content_block_delta');
    expect(dataOf(delta as SseEvent)['delta']).toEqual({
      type: 'input_json_delta',
      partial_json: '{"a":1}',
    });
  });

  it('streams a thinking block as thinking_delta then signature_delta', () => {
    const events = anthropicStream({ thinking: 'hmm' }, IDS, MODEL);
    const deltas = events
      .filter((event) => event.event === 'content_block_delta')
      .map((event) => dataOf(event)['delta']);
    expect(deltas).toEqual([
      { type: 'thinking_delta', thinking: 'hmm' },
      { type: 'signature_delta', signature: FAKE_THINKING_SIGNATURE },
    ]);
  });

  it('indexes each content block, so a reader can assemble them', () => {
    const reply: FakeReply = {
      thinking: 'hmm',
      text: 'hi',
      toolCalls: [{ id: 'toolu_1', name: 'add', input: {} }],
    };
    const indices = anthropicStream(reply, IDS, MODEL)
      .filter((event) => event.event === 'content_block_start')
      .map((event) => dataOf(event)['index']);
    expect(indices).toEqual([0, 1, 2]);
  });
});

describe('anthropicError', () => {
  it('uses the documented envelope', () => {
    expect(anthropicError(429, 'req_1')).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Number of requests has exceeded your rate limit.',
      },
      request_id: 'req_1',
    });
  });

  it('maps every status this fake can serve', () => {
    const mapped = [400, 401, 404, 413, 429, 500, 502, 529].map((status) => [
      status,
      anthropicErrorType(status),
    ]);
    expect(mapped).toEqual([
      [400, 'invalid_request_error'],
      [401, 'authentication_error'],
      [404, 'not_found_error'],
      [413, 'request_too_large'],
      [429, 'rate_limit_error'],
      [500, 'api_error'],
      [502, 'api_error'],
      [529, 'overloaded_error'],
    ]);
  });
});

describe('openaiCompletion', () => {
  it('has the chat.completion envelope', () => {
    const body = openaiCompletion({ text: 'hi' }, IDS, 'local-model');
    expect(body).toMatchObject({
      id: 'msg_fake_1',
      object: 'chat.completion',
      created: 1_767_225_600,
      model: 'local-model',
    });
    expect(body['choices']).toEqual([
      {
        index: 0,
        message: { role: 'assistant', content: 'hi' },
        logprobs: null,
        finish_reason: 'stop',
      },
    ]);
  });

  it('uses null content and a tool_calls array for a tool call', () => {
    const body = openaiCompletion(
      { toolCalls: [{ id: 'call_1', name: 'add', input: { a: 1 } }] },
      IDS,
      'local-model',
    );
    const choice = (body['choices'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(choice['finish_reason']).toBe('tool_calls');
    expect(choice['message']).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        // `arguments` is a **string**, which is the single most common place an adapter written
        // from memory gets this format wrong.
        { id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":1}' } },
      ],
    });
  });

  it('sums every prompt category into prompt_tokens and reports cached_tokens', () => {
    const usage: FakeUsage = {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadInputTokens: 20,
      cacheWrite5mInputTokens: 5,
    };
    expect(openaiCompletion({ text: 'x', usage }, IDS, 'local-model')['usage']).toEqual({
      prompt_tokens: 35,
      completion_tokens: 3,
      total_tokens: 38,
      prompt_tokens_details: { cached_tokens: 20 },
    });
  });

  it('maps finish_reason, collapsing the two Anthropic-only reasons', () => {
    expect(
      (['end_turn', 'tool_use', 'max_tokens', 'refusal', 'pause_turn'] as const).map(
        openaiFinishReason,
      ),
    ).toEqual(['stop', 'tool_calls', 'length', 'stop', 'stop']);
  });
});

describe('openaiStream', () => {
  it('opens with a role delta and ends with [DONE]', () => {
    const events = openaiStream({ text: 'hi' }, IDS, 'local-model', { includeUsage: false });
    expect(deltaOf(dataOf(events[0] as SseEvent))).toEqual({ role: 'assistant', content: '' });
    expect(events.at(-1)?.data).toBe('[DONE]');
  });

  it('closes the last content chunk with a finish_reason', () => {
    const events = openaiStream({ text: 'hi' }, IDS, 'local-model', { includeUsage: false });
    expect(choiceOf(dataOf(events.at(-2) as SseEvent))).toMatchObject({
      delta: {},
      finish_reason: 'stop',
    });
  });

  it('emits a usage-only chunk with no choices when include_usage was asked for', () => {
    const events = openaiStream(
      { text: 'hi', usage: { inputTokens: 2, outputTokens: 1 } },
      IDS,
      'local-model',
      { includeUsage: true },
    );
    const usageChunk = dataOf(events.at(-2) as SseEvent);
    // No choices at all, which is the shape that breaks a reader assuming `choices[0]` exists.
    expect(usageChunk['choices']).toEqual([]);
    expect(usageChunk['usage']).toMatchObject({ prompt_tokens: 2, completion_tokens: 1 });
  });

  it('omits the usage chunk when it was not asked for', () => {
    const events = openaiStream({ text: 'hi' }, IDS, 'local-model', { includeUsage: false });
    // The `[DONE]` terminator is a bare string, so filter to the JSON chunks first.
    const chunks = events.filter((event) => typeof event.data !== 'string').map(dataOf);
    expect(chunks.filter((chunk) => 'usage' in chunk)).toEqual([]);
  });

  it('streams a tool call with its index, as the format requires', () => {
    const events = openaiStream(
      { toolCalls: [{ id: 'call_1', name: 'add', input: { a: 1 } }] },
      IDS,
      'local-model',
      { includeUsage: false },
    );
    const chunk = events.map(dataOf).find((data) => 'tool_calls' in deltaOf(data));
    expect(deltaOf(chunk ?? {})['tool_calls']).toEqual([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":1}' } },
    ]);
  });
});

describe('openaiError', () => {
  it('uses one error object with no sibling type', () => {
    expect(openaiError(429)).toEqual({
      error: {
        message: 'Number of requests has exceeded your rate limit.',
        type: 'rate_limit_exceeded',
        param: null,
        code: 'rate_limit_exceeded',
      },
    });
    expect(openaiError(500)).toMatchObject({ error: { type: 'server_error', code: null } });
  });
});
