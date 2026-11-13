/**
 * The OpenAI adapter's pure functions (`05` §3.5.4; `M2-T11`).
 *
 * The contract suite drives these through a real socket, which is the right place to assert the
 * shape that goes on the wire. This file covers what a round trip cannot reach cheaply: the
 * invariant assertions that are supposed to **throw**, the media parts, and the incomplete-status
 * reasons the fake has no way to produce.
 */
import { ModelCallError, type ModelMessage } from '@comvivo/core';
import type OpenAI from 'openai';
import { APIConnectionTimeoutError, APIUserAbortError } from 'openai';
import { ContentFilterFinishReasonError, LengthFinishReasonError } from 'openai/error';
import { describe, expect, it } from 'vitest';
import { toModelCallError } from './errors.js';
import {
  assertWireInvariants,
  buildResponsesRequest,
  inputItemsOf,
  instructionsOf,
  toolsOf,
  WireInvariantError,
} from './request.js';
import { readStop, toolCallsOf, usageIterationOf, visibleText } from './response.js';
import { firstOutputText, readStructured, structuredResultOf } from './structured.js';
import { openaiBinding, openaiTurnRequest } from './testing/fixtures.js';

type Params = Omit<OpenAI.Responses.ResponseCreateParams, 'stream'>;
type Response = OpenAI.Responses.Response;

const BASE: Params = { model: 'gpt-6.1-sol', input: [], store: false };

function response(overrides: Partial<Response> = {}): Response {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    model: 'gpt-6.1-sol',
    output: [],
    status: 'completed',
    incomplete_details: null,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    ...overrides,
  } as unknown as Response;
}

describe('the wire invariants refuse what 01 §2.1 forbids', () => {
  it('refuses each sampling parameter by name', () => {
    for (const key of ['temperature', 'top_p', 'top_logprobs', 'user']) {
      expect(() => assertWireInvariants({ ...BASE, [key]: 1 } as Params), key).toThrow(
        WireInvariantError,
      );
    }
  });

  it('refuses a request that would leave messages on the provider’s disk', () => {
    expect(() => assertWireInvariants({ ...BASE, store: true })).toThrow(/store/);
    // Absent is as wrong as `true`: the default is to store.
    const { store: _dropped, ...withoutStore } = BASE;
    expect(() => assertWireInvariants(withoutStore)).toThrow(/store/);
  });

  it('refuses a forced tool choice in either spelling', () => {
    expect(() => assertWireInvariants({ ...BASE, tool_choice: 'required' })).toThrow(/tool_choice/);
    expect(() =>
      assertWireInvariants({ ...BASE, tool_choice: { type: 'function', name: 'f' } }),
    ).toThrow(/tool_choice/);
  });

  it('accepts auto and none', () => {
    expect(() => assertWireInvariants({ ...BASE, tool_choice: 'auto' })).not.toThrow();
    expect(() => assertWireInvariants({ ...BASE, tool_choice: 'none' })).not.toThrow();
  });

  it('refuses a tool that is not strict, naming it', () => {
    expect(() =>
      assertWireInvariants({
        ...BASE,
        tools: [{ type: 'function', name: 'loose', parameters: {}, strict: false }],
      }),
    ).toThrow(/loose/);
  });

  it('refuses a prefilled assistant turn in the final position', () => {
    expect(() =>
      assertWireInvariants({
        ...BASE,
        input: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'Sure, here is' },
        ],
      }),
    ).toThrow(/prefill/);
  });

  it('allows an assistant message earlier in the history', () => {
    // A replayed turn mid-conversation is the normal shape; it is the **last** position that is
    // the model being told how to begin.
    expect(() =>
      assertWireInvariants({
        ...BASE,
        input: [
          { role: 'assistant', content: 'earlier' },
          { role: 'user', content: 'and?' },
        ],
      }),
    ).not.toThrow();
  });

  it('reports every violation at once, not just the first', () => {
    // A sentinel outside the `try`, per `scripts/hygiene`'s `no-self-satisfied-unreachable`:
    // `expect.unreachable` throws **into the same catch**, so a catch that only inspects the error
    // can pass when nothing was refused at all.
    let thrown: unknown;
    try {
      assertWireInvariants({ ...BASE, store: true, temperature: 0.5, tool_choice: 'required' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WireInvariantError);
    expect((thrown as WireInvariantError).violations).toHaveLength(3);
  });

  it('is applied by the builder, so no path reaches the wire around it', () => {
    expect(() =>
      buildResponsesRequest(openaiTurnRequest({ toolChoice: 'forced' as never }), {
        binding: openaiBinding(),
      }),
    ).toThrow(WireInvariantError);
  });
});

describe('rendering the canonical request', () => {
  it('joins system blocks with a blank line, in order', () => {
    // Stable bytes: OpenAI's prefix caching is automatic and keyed on the literal prefix, so a
    // join that varied would miss the cache on every turn.
    expect(
      instructionsOf([
        { id: 'a', text: 'one' },
        { id: 'b', text: 'two' },
      ]),
    ).toBe('one\n\ntwo');
    expect(instructionsOf([])).toBeUndefined();
  });

  it('renders an image as a data URL and a PDF as an input file', () => {
    const { items } = inputItemsOf([
      {
        role: 'user',
        content: [
          { type: 'image', mime: 'image/png', data: new Uint8Array([1, 2, 3]) },
          { type: 'document', mime: 'application/pdf', data: new Uint8Array([4, 5]) },
        ],
      },
    ]);
    const content = (items[0] as unknown as { content: Record<string, string>[] }).content;
    expect(content[0]).toMatchObject({ type: 'input_image', detail: 'auto' });
    expect(content[0]?.['image_url']).toMatch(/^data:image\/png;base64,/);
    expect(content[1]).toMatchObject({ type: 'input_file', filename: 'document.pdf' });
  });

  it('renders an effort change as a developer item', () => {
    const { items } = inputItemsOf([{ role: 'system', kind: 'effort', effort: 'high' }]);
    expect(items[0]).toEqual({
      role: 'developer',
      content: 'Reasoning effort for this turn: high.',
    });
  });

  it('falls back to the typed view and counts it, dropping opaque parts', () => {
    const assistant: ModelMessage = {
      role: 'assistant',
      provider: 'anthropic',
      servedModel: 'claude-opus-5-5',
      raw: [],
      view: [
        { type: 'opaque', kind: 'thinking' },
        { type: 'text', text: 'earlier' },
        { type: 'tool_call', id: 'call_1', name: 'f', input: { a: 1 } },
      ],
    };
    const { items, transformations } = inputItemsOf([assistant]);
    expect(transformations).toBe(1);
    // The opaque part has no bytes to replay — that loss is what the count reports.
    expect(items).toEqual([
      { role: 'assistant', content: 'earlier' },
      { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"a":1}' },
    ]);
  });

  it('emits no user item for a message that is only tool results', () => {
    const { items } = inputItemsOf([
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'ok', isError: false }],
      },
    ]);
    expect(items).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }]);
  });

  it('passes a strict schema through without re-deriving it', () => {
    const schema = {
      type: 'object' as const,
      properties: { city: { type: 'string' as const } },
      required: ['city'],
      additionalProperties: false as const,
    };
    expect(toolsOf([{ name: 'f', description: 'd', inputSchema: schema }])).toEqual([
      { type: 'function', name: 'f', description: 'd', parameters: schema, strict: true },
    ]);
  });
});

describe('reading the response status', () => {
  it('maps each incomplete reason', () => {
    const cases = [
      ['max_output_tokens', 'max_tokens'],
      ['content_filter', 'refusal'],
      ['max_messages', 'context_overflow'],
      // Added to the SDK after `05` §3.5.4 was written: the server stopped at a safe boundary and
      // will continue, which is the same control flow as Anthropic's `pause_turn`.
      ['steered', 'pause_turn'],
    ] as const;
    for (const [reason, expected] of cases) {
      const stop = readStop(response({ status: 'incomplete', incomplete_details: { reason } }));
      expect(stop.reason, reason).toBe(expected);
    }
  });

  it('labels a content filter as a provider filter rather than inventing a category', () => {
    const stop = readStop(
      response({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
    );
    expect(stop).toMatchObject({ reason: 'refusal', category: 'provider_filter' });
  });

  it('maps an incomplete response with no reason to other', () => {
    expect(readStop(response({ status: 'incomplete', incomplete_details: null })).reason).toBe(
      'other',
    );
  });

  it('does not read a failed or cancelled response as a finished turn', () => {
    expect(readStop(response({ status: 'failed' })).reason).toBe('other');
    expect(readStop(response({ status: 'cancelled' })).reason).toBe('other');
  });

  it('treats an absent status as completed', () => {
    // `status` is optional on the SDK's `Response`, and `exactOptionalPropertyTypes` makes
    // "absent" a different thing from "undefined" — so the key is removed rather than overridden.
    const { status: _absent, ...withoutStatus } = response();
    expect(readStop(withoutStatus as Response).reason).toBe('end_turn');
  });
});

describe('reading the response content', () => {
  const message = (content: unknown[]): unknown => ({
    type: 'message',
    id: 'm',
    role: 'assistant',
    status: 'completed',
    content,
  });

  it('concatenates text across message items', () => {
    const output = [
      message([{ type: 'output_text', text: 'one ', annotations: [] }]),
      message([{ type: 'output_text', text: 'two', annotations: [] }]),
    ] as Response['output'];
    expect(visibleText(output)).toBe('one two');
  });

  it('drops a tool call whose arguments are not JSON rather than passing a string through', () => {
    // The tools are strict, so this should not happen. If it does, a tool executed with a
    // malformed input is worse than a tool that did not run.
    const output = [
      { type: 'function_call', id: 'f', call_id: 'c1', name: 'f', arguments: 'not json' },
      { type: 'function_call', id: 'g', call_id: 'c2', name: 'g', arguments: '{"a":1}' },
    ] as Response['output'];
    expect(toolCallsOf(output)).toEqual([{ id: 'c2', name: 'g', input: { a: 1 } }]);
  });

  it('reports no usage at all when the provider sent none', () => {
    expect(usageIterationOf(response(), 'gpt-6.1-sol')).toEqual([]);
  });

  it('falls back to the requested model when the response names none', () => {
    const withUsage = response({
      model: '',
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 12,
      },
    } as Partial<Response>);
    expect(usageIterationOf(withUsage, 'gpt-6.1-sol')[0]?.model).toBe('gpt-6.1-sol');
  });

  it('handles a cache write with no TTL breakdown', () => {
    // An older server, or one that reports the total without the split. The whole write lands in
    // the short slot rather than being lost, which is the conservative direction for a bill.
    const withUsage = response({
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 105,
      },
    } as Partial<Response>);
    expect(usageIterationOf(withUsage, 'm')[0]).toMatchObject({
      input: 50,
      cacheRead: 20,
      cacheWrite5m: 30,
      cacheWrite1h: 0,
    });
  });

  it('never reports a negative input count', () => {
    const inconsistent = response({
      usage: {
        input_tokens: 5,
        input_tokens_details: { cached_tokens: 50, cache_write_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 6,
      },
    } as Partial<Response>);
    expect(usageIterationOf(inconsistent, 'm')[0]?.input).toBe(0);
  });
});

describe('the structured reader', () => {
  const schema = {
    safeParse: (input: unknown) =>
      typeof input === 'object' && input !== null && 'ok' in input
        ? { success: true as const, data: input as { ok: boolean } }
        : { success: false as const, issues: [{ path: ['ok'], message: 'required' }] },
  };

  const textResponse = (text: string): Response =>
    response({
      output: [
        {
          type: 'message',
          id: 'm',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ] as Response['output'],
    });

  it('skips a reasoning item to reach the answer', () => {
    const withReasoning = response({
      output: [
        { type: 'reasoning', id: 'r', summary: [] },
        {
          type: 'message',
          id: 'm',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }],
        },
      ] as Response['output'],
    });
    expect(firstOutputText(withReasoning)).toBe('{"ok":true}');
    expect(readStructured(withReasoning, schema).kind).toBe('ok');
  });

  it('reports invalid rather than crashing on a non-JSON answer', () => {
    const attempt = readStructured(textResponse('sorry, I cannot'), schema);
    expect(attempt).toMatchObject({ kind: 'invalid' });
    expect((attempt as { issues: string }).issues).toContain('not JSON');
  });

  it('reports invalid when there is no text at all', () => {
    expect(readStructured(response(), schema)).toMatchObject({ kind: 'invalid' });
    expect(readStructured(textResponse('   '), schema)).toMatchObject({ kind: 'invalid' });
  });

  it('returns undefined for an output whose first item is not a message', () => {
    const toolCall = response({
      output: [
        { type: 'function_call', id: 'f', call_id: 'c', name: 'f', arguments: '{}' },
      ] as Response['output'],
    });
    expect(firstOutputText(toolCall)).toBeUndefined();
  });

  it('reports invalid when the value is schema-valid JSON but fails the zod type', () => {
    expect(readStructured(textResponse('{"nope":1}'), schema)).toMatchObject({ kind: 'invalid' });
  });

  it('keeps the four outcomes distinct', () => {
    // Collapsing them is how a caller ends up retrying a prompt that will never validate.
    expect(structuredResultOf({ kind: 'ok', value: 1 }, [], 'm').kind).toBe('ok');
    expect(structuredResultOf({ kind: 'truncated' }, [], 'm').kind).toBe('truncated');
    expect(structuredResultOf({ kind: 'refused', category: null }, [], 'm').kind).toBe('refused');
    expect(structuredResultOf({ kind: 'invalid', issues: 'x' }, [], 'm').kind).toBe('invalid');
  });
});

describe('the error mapper', () => {
  it('passes a ModelCallError through unchanged', () => {
    const original = new ModelCallError('timeout', 'openai');
    expect(toModelCallError(original, 0)).toBe(original);
  });

  it('maps an abort and a client timeout before the connection base class', () => {
    expect(toModelCallError(new APIUserAbortError(), 0).kind).toBe('aborted');
    expect(toModelCallError(new APIConnectionTimeoutError({ message: 'slow' }), 0).kind).toBe(
      'timeout',
    );
  });

  it('maps the parsing-helper errors, which are not APIErrors', () => {
    // Falling through to `unknown` would make a truncated structured output look like a provider
    // outage and trip the circuit breaker on a healthy provider.
    expect(toModelCallError(new LengthFinishReasonError(), 0)).toMatchObject({
      kind: 'bad_request',
      detail: { type: 'length' },
    });
    expect(toModelCallError(new ContentFilterFinishReasonError(), 0)).toMatchObject({
      kind: 'bad_request',
      detail: { type: 'content_filter' },
    });
  });

  it('maps something that is not an SDK error at all to unknown', () => {
    expect(toModelCallError(new TypeError('boom'), 0).kind).toBe('unknown');
    expect(toModelCallError('a string', 0).kind).toBe('unknown');
  });
});
