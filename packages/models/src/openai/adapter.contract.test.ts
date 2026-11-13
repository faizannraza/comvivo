/**
 * The OpenAI adapter against a real provider socket (`05` §3.5.4, `11` §3.1.9; `M2-T11`).
 *
 * Every assertion here is made against a **captured request** that really travelled over TCP and
 * was really parsed by `openai` 7.55.0, not against an object a mock recorded. That matters most
 * for the rules `01` §2.1 states and this provider makes easy to break: `temperature` and `top_p`
 * exist on `ResponseCreateParams`, unlike Anthropic's beta params where they are absent from the
 * type entirely, so the ban is only real if something checks it on the wire.
 *
 * The other load-bearing claim is **verbatim replay**. `ResponseOutputItem` is a 28-member union
 * and we understand three of them; a tool loop that filtered the output to what it recognised
 * would drop the reasoning item a stateless reasoning model needs to continue. So the test asserts
 * the bytes of the second request contain the first response's items unchanged.
 */
import { ModelCallError } from '@comvivo/core';
import { BRAND, SecretString, SystemClock } from '@comvivo/shared';
import { silentLogger } from '@comvivo/shared/testing';
import OpenAI from 'openai';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  type CapturedRequest,
  type FakeProviderServer,
  type FakeTurn,
  startFakeProviderServer,
} from '../testing/index.js';
import type { OpenAiAdapterDeps } from './adapter.js';
import { createOpenAiClient, createOpenAiGateway, runChat, runStructured } from './adapter.js';
import { OPENAI_MODEL, openaiBinding, openaiTurnRequest } from './testing/fixtures.js';

interface Harness {
  readonly server: FakeProviderServer;
  readonly deps: OpenAiAdapterDeps;
  readonly captured: (index?: number) => CapturedRequest;
  readonly body: (index?: number) => Record<string, unknown>;
}

async function harness(overrides: Partial<OpenAiAdapterDeps> = {}): Promise<Harness> {
  const server = await startFakeProviderServer({ defaultModel: OPENAI_MODEL });
  onTestFinished(async () => {
    await server.close();
  });
  const client = new OpenAI({
    apiKey: 'sk-not-a-real-key',
    baseURL: server.openaiBaseUrl,
    // No SDK retries: the adapter's error mapping is what is under test, and a retry would turn a
    // single scripted fault into a wait for three.
    maxRetries: 0,
  });
  const deps: OpenAiAdapterDeps = {
    bindingFor: () => openaiBinding({ maxRetries: 0, attemptTimeoutMs: 5_000 }),
    clock: new SystemClock(),
    logger: silentLogger,
    client,
    ...overrides,
  };
  const captured = (index = 0): CapturedRequest => {
    const request = server.requests()[index];
    if (request === undefined) throw new Error(`no request ${String(index)} reached the server`);
    return request;
  };
  return {
    server,
    deps,
    captured,
    // `CapturedRequest.body` is already parsed; `raw` is the string.
    body: (index = 0) => captured(index).body as Record<string, unknown>,
  };
}

const USAGE = {
  inputTokens: 100,
  outputTokens: 40,
  cacheReadInputTokens: 900,
  cacheWrite5mInputTokens: 60,
  cacheWrite1hInputTokens: 20,
  reasoningTokens: 25,
};

describe('the request reaches /v1/responses in the documented shape', () => {
  it('sends instructions, input items and the route’s model', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: 'hi' });
    await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));

    expect(h.captured().path).toContain('/v1/responses');
    const body = h.body();
    expect(body['model']).toBe(OPENAI_MODEL);
    expect(body['instructions']).toBe('be useful');
    expect(body['max_output_tokens']).toBe(8_000);
    expect(body['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ]);
  });

  it('always sends store:false and asks for the encrypted reasoning', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: 'hi' });
    await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));

    const body = h.body();
    // `08` §3.11: a family's messages are not left on a provider's disk. There is no config key
    // that turns this on.
    expect(body['store']).toBe(false);
    // Without this, a stateless reasoning turn loses its chain of thought between tool steps.
    expect(body['include']).toEqual(['reasoning.encrypted_content']);
  });

  it('sends none of the three sampling parameters (01 §2.1)', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: 'hi' });
    await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));

    const body = h.body();
    // The reason this test exists on this adapter and not on Anthropic's: here the fields are
    // real, settable and one line away.
    for (const key of ['temperature', 'top_p', 'top_logprobs', 'user']) {
      expect(key in body, key).toBe(false);
    }
  });

  it('sends effort explicitly on every call', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: 'hi' }, { kind: 'reply', text: 'x' });
    await runChat(h.deps, openaiTurnRequest({ effort: 'low' }), AbortSignal.timeout(5_000));
    await runChat(h.deps, openaiTurnRequest({ effort: 'xhigh' }), AbortSignal.timeout(5_000));

    expect(h.body(0)['reasoning']).toEqual({ effort: 'low' });
    expect(h.body(1)['reasoning']).toEqual({ effort: 'xhigh' });
  });

  it('declares every tool strict and never forces a choice', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: 'hi' });
    await runChat(
      h.deps,
      openaiTurnRequest({
        tools: [
          {
            name: 'get_forecast',
            description: 'Return a short weather summary for one city.',
            inputSchema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
              additionalProperties: false,
            },
          },
        ],
      }),
      AbortSignal.timeout(5_000),
    );

    const body = h.body();
    expect(body['tool_choice']).toBe('auto');
    expect(body['parallel_tool_calls']).toBe(true);
    expect(body['tools']).toEqual([
      {
        type: 'function',
        name: 'get_forecast',
        description: 'Return a short weather summary for one city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        strict: true,
      },
    ]);
  });

  it('sends a cache key that names the instance and the route, never a group', async () => {
    const h = await harness({ instanceId: 'inst_abc' });
    h.server.script({ kind: 'reply', text: 'hi' });
    await runChat(
      h.deps,
      openaiTurnRequest({ correlation: { groupId: 'grp_secret' as never } }),
      AbortSignal.timeout(5_000),
    );

    const body = h.body();
    expect(body['prompt_cache_key']).toBe(`${BRAND.slug}:inst_abc:chat`);
    // A per-group key would tell OpenAI how many groups this host runs, and would stop two groups
    // with the same catalogue from sharing a prefix — which is the point of `01` §14 A13.
    expect(h.captured().raw).not.toContain('grp_secret');
  });

  it('turns a mid-conversation system message into a developer item', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: 'hi' });
    await runChat(
      h.deps,
      openaiTurnRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          {
            role: 'system',
            kind: 'notes',
            text: 'The requester may read calendars.',
            scope: 'turn',
          },
        ],
      }),
      AbortSignal.timeout(5_000),
    );

    const input = h.body()['input'] as Record<string, unknown>[];
    expect(input.at(-1)).toEqual({
      role: 'developer',
      content: 'The requester may read calendars.',
    });
  });

  it('never carries a credential into a captured request', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: 'hi' });
    await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));
    const request = h.captured();
    expect(request.hasCredential).toBe(true);
    expect(JSON.stringify(request.headers)).not.toContain('sk-not-a-real-key');
  });
});

describe('the response is read before its content', () => {
  it('reads text, the served model and the request id', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: 'Six people said yes.', usage: USAGE });
    const result = await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));

    expect(result.text).toBe('Six people said yes.');
    expect(result.model).toEqual({
      provider: 'openai',
      requested: OPENAI_MODEL,
      served: OPENAI_MODEL,
    });
    expect(result.diagnostics.requestId).toMatch(/^resp_/);
    expect(result.diagnostics.betas).toEqual([]);
  });

  it('parses tool calls off call_id, not id', async () => {
    const h = await harness();
    h.server.script({
      kind: 'reply',
      toolCalls: [{ id: 'call_42', name: 'get_forecast', input: { city: 'Lisbon' } }],
    });
    const result = await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));

    expect(result.stop.reason).toBe('tool_use');
    // `call_id` is what a `function_call_output` matches on, and it differs from the item's `id`.
    // Reading the wrong one produces a tool result the model cannot attach to its call.
    expect(result.toolCalls).toEqual([
      { id: 'call_42', name: 'get_forecast', input: { city: 'Lisbon' } },
    ]);
  });

  it('discards a truncated response’s partial text and its tool calls', async () => {
    const h = await harness();
    h.server.script({
      kind: 'reply',
      text: 'I was about to say',
      toolCalls: [{ id: 'call_1', name: 'get_forecast', input: { city: 'L' } }],
      stopReason: 'max_tokens',
    });
    const result = await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));

    expect(result.stop.reason).toBe('max_tokens');
    // Truncated mid-thought, and a truncated tool call must never be executed.
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([]);
    // The raw items survive, because the caller may still need to show that something happened.
    expect(result.assistant.raw).toBeDefined();
  });

  it('reads a refusal out of the message content and shows none of its text', async () => {
    const h = await harness();
    h.server.script({
      kind: 'reply',
      stopReason: 'refusal',
      refusal: { category: null, explanation: 'I can’t help.' },
    });
    const result = await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));

    // On this provider a refusal is content inside the message, not a status.
    expect(result.stop.reason).toBe('refusal');
    expect(result.text).toBe('');
  });

  it('keeps every output item in raw, including the ones it does not understand', async () => {
    const h = await harness();
    h.server.script({
      kind: 'reply',
      thinking: 'weighing the options',
      text: 'Yes.',
      usage: USAGE,
    });
    const result = await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));

    const raw = result.assistant.raw as Record<string, unknown>[];
    expect(raw.map((item) => item['type'])).toEqual(['reasoning', 'message']);
    // The reasoning item's encrypted content is what a stateless reasoning model needs back.
    expect(raw[0]?.['encrypted_content']).toBeDefined();
    // And it is `opaque` in the typed view: the engine must know it is there without reading it.
    expect(result.assistant.view).toEqual([
      { type: 'opaque', kind: 'reasoning' },
      { type: 'text', text: 'Yes.' },
    ]);
    expect(JSON.stringify(result.assistant.view)).not.toContain('weighing');
  });

  it('replays the previous turn’s items verbatim on the next request', async () => {
    const h = await harness();
    h.server.script(
      {
        kind: 'reply',
        thinking: 'thinking about it',
        toolCalls: [{ id: 'call_7', name: 'get_forecast', input: { city: 'Lisbon' } }],
      },
      { kind: 'reply', text: 'It will rain.' },
    );

    const first = await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));
    await runChat(
      h.deps,
      openaiTurnRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          first.assistant,
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                toolCallId: 'call_7',
                content: '{"rain":true}',
                isError: false,
              },
            ],
          },
        ],
      }),
      AbortSignal.timeout(5_000),
    );

    const input = h.body(1)['input'] as Record<string, unknown>[];
    // The reasoning item and the function_call go back unchanged — `01` §2.1's "append
    // `response.content` unchanged", and what the encrypted reasoning is for.
    expect(input.map((item) => item['type'] ?? item['role'])).toEqual([
      'user',
      'reasoning',
      'function_call',
      'function_call_output',
    ]);
    expect(input[1]?.['encrypted_content']).toBe(
      (first.assistant.raw as Record<string, unknown>[])[0]?.['encrypted_content'],
    );
    expect(input.at(-1)).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_7',
      output: '{"rain":true}',
    });
  });

  it('counts a transformation when there are no raw items to replay', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: 'ok' });
    const result = await runChat(
      h.deps,
      openaiTurnRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          // A cassette or another provider's turn: the typed view is lossy, so the trace says so.
          {
            role: 'assistant',
            provider: 'anthropic',
            servedModel: 'claude-opus-5-5',
            raw: [],
            view: [{ type: 'text', text: 'earlier reply' }],
          },
          { role: 'user', content: [{ type: 'text', text: 'and?' }] },
        ],
      }),
      AbortSignal.timeout(5_000),
    );
    expect(result.diagnostics.inputTransformations).toBe(1);
  });
});

describe('usage maps to the canonical split', () => {
  it('subtracts cached and written tokens from the provider’s input total', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: 'hi', usage: USAGE });
    const result = await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));

    // `input_tokens` **includes** cached tokens here, the opposite of Anthropic's split. Reading
    // it as the uncached remainder would over-report input by the hit rate on every warm turn.
    expect(result.usage).toEqual([
      {
        model: OPENAI_MODEL,
        kind: 'message',
        input: 100,
        cacheRead: 900,
        cacheWrite5m: 60,
        cacheWrite1h: 20,
        output: 40,
        reasoning: 25,
        batch: false,
      },
    ]);
  });

  it('maps the 30-minute and 12-hour write slots onto the two priced columns', async () => {
    const h = await harness();
    h.server.script({
      kind: 'reply',
      text: 'hi',
      usage: {
        inputTokens: 0,
        outputTokens: 1,
        cacheWrite5mInputTokens: 7,
        cacheWrite1hInputTokens: 3,
      },
    });
    const result = await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));
    expect(result.usage[0]).toMatchObject({ cacheWrite5m: 7, cacheWrite1h: 3 });
  });

  it('omits reasoning when the provider reported none', async () => {
    const h = await harness();
    h.server.script({
      kind: 'reply',
      text: 'hi',
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const result = await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));
    expect('reasoning' in (result.usage[0] ?? {})).toBe(false);
  });
});

describe('errors map to the canonical kinds', () => {
  // `FakeTurn` directly, not `Parameters<script>[0]`: `script` takes a rest parameter, so that
  // lookup resolves to `never` and the tuple silently accepts anything — which is how a
  // mis-shaped fixture gets past the typechecker.
  const cases: readonly (readonly [string, FakeTurn, string])[] = [
    ['a 429', { kind: 'rate_limited', retryAfterSeconds: 2 }, 'rate_limited'],
    ['a 503', { kind: 'server_error', status: 503 }, 'overloaded'],
    ['a 500', { kind: 'server_error', status: 500 }, 'server'],
    ['a 400', { kind: 'server_error', status: 400 }, 'bad_request'],
    ['a 401', { kind: 'server_error', status: 401 }, 'auth'],
    ['a 403', { kind: 'server_error', status: 403 }, 'permission'],
    ['a 404', { kind: 'server_error', status: 404 }, 'model_not_found'],
    ['a 413', { kind: 'server_error', status: 413 }, 'request_too_large'],
    ['a 402', { kind: 'server_error', status: 402 }, 'billing'],
  ];

  for (const [name, turn, kind] of cases) {
    it(`maps ${name} to ${kind}`, async () => {
      const h = await harness();
      h.server.script(turn);
      await expect(
        runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000)),
      ).rejects.toMatchObject({ kind, provider: 'openai' });
    });
  }

  it('honours retry-after', async () => {
    const h = await harness();
    h.server.script({ kind: 'rate_limited', retryAfterSeconds: 3 });
    let thrown: unknown;
    try {
      await runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelCallError);
    expect((thrown as ModelCallError).detail.retryAfterMs).toBe(3_000);
  });

  it('maps a socket reset to a network failure, not an unknown one', async () => {
    const h = await harness();
    h.server.script({ kind: 'socket_reset' });
    await expect(
      runChat(h.deps, openaiTurnRequest(), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('maps a caller abort to aborted', async () => {
    const h = await harness();
    h.server.script({ kind: 'hang' });
    const controller = new AbortController();
    const promise = runChat(h.deps, openaiTurnRequest(), controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
  });
});

describe('the structured path', () => {
  const schema = {
    safeParse: (input: unknown) =>
      typeof input === 'object' && input !== null && 'ok' in input
        ? { success: true as const, data: input as { ok: boolean } }
        : { success: false as const, issues: [{ path: ['ok'], message: 'required' }] },
  };

  function structuredRequest(): Parameters<typeof runStructured>[1] {
    return {
      route: 'extract',
      purpose: 'extract.facts',
      system: [{ id: 'x', text: 'Extract.' }],
      input: [{ type: 'text', text: 'six said yes' }],
      schema,
      jsonSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      schemaName: 'facts',
      effort: 'low',
      maxOutputTokens: 512,
      correlation: {},
    };
  }

  it('sends a strict json_schema format and no tools', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: '{"ok":true}' });
    await runStructured(h.deps, structuredRequest(), AbortSignal.timeout(5_000));

    const body = h.body();
    expect(body['text']).toEqual({
      format: {
        type: 'json_schema',
        name: 'facts',
        strict: true,
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    });
    expect('tools' in body).toBe(false);
    // A structured call is one round trip; nobody replays its reasoning, so the encrypted blob
    // would be bytes for nothing.
    expect('include' in body).toBe(false);
  });

  it('repairs once with the issues attached and bills both attempts', async () => {
    const h = await harness();
    h.server.script(
      { kind: 'reply', text: '{"nope":1}', usage: { inputTokens: 10, outputTokens: 5 } },
      { kind: 'reply', text: '{"ok":true}', usage: { inputTokens: 12, outputTokens: 4 } },
    );
    const result = await runStructured(h.deps, structuredRequest(), AbortSignal.timeout(5_000));

    expect(result.kind).toBe('ok');
    // A failed call is a billed call (`02` §3.3.7); a ledger that lost the first attempt would
    // under-report every repaired extraction.
    expect(result.usage).toHaveLength(2);

    const repair = h.body(1)['input'] as Record<string, unknown>[];
    // The model's own output goes back, then the issues — which is what makes a repair different
    // from a retry.
    expect(repair.map((item) => item['type'] ?? item['role'])).toEqual(['user', 'message', 'user']);
    expect(JSON.stringify(repair.at(-1))).toContain('invalid_output');
  });

  it('gives up after one repair rather than billing a third time', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: '{"nope":1}' }, { kind: 'reply', text: '{"still":2}' });
    const result = await runStructured(h.deps, structuredRequest(), AbortSignal.timeout(5_000));
    expect(result.kind).toBe('invalid');
    expect(h.server.requests()).toHaveLength(2);
  });

  it('never parses a truncated answer', async () => {
    const h = await harness();
    h.server.script({ kind: 'reply', text: '{"ok":tr', stopReason: 'max_tokens' });
    const result = await runStructured(h.deps, structuredRequest(), AbortSignal.timeout(5_000));
    // `truncated`, not `invalid`: collapsing them is how a caller retries a prompt that will
    // never validate.
    expect(result.kind).toBe('truncated');
    expect(h.server.requests()).toHaveLength(1);
  });
});

describe('the gateway', () => {
  it('declares the members this provider actually has', async () => {
    const h = await harness();
    const gateway = createOpenAiGateway(h.deps);

    expect(typeof gateway.run).toBe('function');
    expect(typeof gateway.structured).toBe('function');
    expect(gateway.routeInfo('chat')).toMatchObject({ provider: 'openai', model: OPENAI_MODEL });
    // Absent, not throwing stubs: the Responses API offers none of these, the registry row says
    // so, and the port made them optional precisely so a caller can ask.
    expect(gateway.countTokens).toBeUndefined();
    expect(gateway.submitBatch).toBeUndefined();
    expect(gateway.pollBatch).toBeUndefined();
    expect(gateway.batchResults).toBeUndefined();
  });

  it('fails loudly on embed and names the task that implements it', async () => {
    const h = await harness();
    const gateway = createOpenAiGateway(h.deps);
    let thrown: unknown;
    try {
      void gateway.embed(['a'], 'query');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelCallError);
    expect((thrown as ModelCallError).detail.type).toContain('M4-T20');
  });

  it('plumbs an injected key and base URL into the client', async () => {
    const h = await harness();
    const secret = new SecretString('OPENAI_API_KEY', 'sk-should-not-leak');
    // Destructured rather than overridden with `undefined`: `exactOptionalPropertyTypes` makes
    // `client: undefined` a different thing from an absent `client`, and the point here is the
    // absent one — the path that actually constructs a client.
    const { client: _injected, ...withoutClient } = h.deps;
    const client = createOpenAiClient({
      ...withoutClient,
      apiKey: secret,
      baseUrl: h.server.openaiBaseUrl,
    });
    expect(client.baseURL).toBe(h.server.openaiBaseUrl);
    // The key is exposed exactly once, at the client boundary, which is what `SecretString` is
    // for. That the wrapper itself cannot be printed is `M0-T8`'s claim and is tested there
    // through ten routes; asserting it again over a circular SDK object would test `JSON.stringify`.
    expect(client.apiKey).toBe('sk-should-not-leak');
    expect(String(secret)).not.toContain('sk-should-not-leak');
  });

  it('reuses an injected client rather than building a second one', async () => {
    const h = await harness();
    expect(createOpenAiClient(h.deps)).toBe(h.deps.client);
  });
});
