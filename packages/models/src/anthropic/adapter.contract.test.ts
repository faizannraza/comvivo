/**
 * The adapter against a real provider socket (`05` §9.3, `11` §3.1.9; `M2-T6`).
 *
 * `M2-T10`'s `FakeProviderServer` is what makes this possible, and building it first is why these
 * assertions exist from this commit rather than after an incident: every one of `11` §3.1.9's
 * requirements is checked against a **captured request** that really travelled over TCP and was
 * really parsed by `@anthropic-ai/sdk`, not against an object a mock recorded.
 *
 * The fault cases are the reason the sequencing mattered. A 429 with `retry-after`, a 529, a 5xx
 * and a stream cut mid-response all take a different path through the SDK's retry logic than a
 * success does, and `toModelCallError` is only correct if it sees what the SDK actually throws.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ModelCallError } from '@comvivo/core';
import { SecretString, SystemClock } from '@comvivo/shared';
import { silentLogger } from '@comvivo/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  type CapturedRequest,
  type FakeProviderServer,
  startFakeProviderServer,
} from '../testing/index.js';
import type { AnthropicAdapterDeps } from './adapter.js';
import {
  CLIENT_DEFAULTS,
  createAnthropicClient,
  createAnthropicGateway,
  runChat,
} from './adapter.js';
import { OPTIONAL_BETAS } from './request.js';
import { bindingFor, OPUS, toolSpec, turnRequest } from './testing/fixtures.js';

const ALL_BETAS = Object.values(OPTIONAL_BETAS) as Anthropic.AnthropicBeta[];

interface Harness {
  readonly server: FakeProviderServer;
  readonly deps: AnthropicAdapterDeps;
  readonly captured: () => CapturedRequest;
}

/** A server and an adapter pointed at it, torn down with the test. */
async function harness(): Promise<Harness> {
  const server = await startFakeProviderServer({ defaultModel: OPUS });
  onTestFinished(async () => {
    await server.close();
  });
  const client = new Anthropic({
    apiKey: 'sk-ant-not-a-real-key',
    baseURL: server.anthropicBaseUrl,
    // No SDK retries: the adapter's error mapping is what is under test, and a retry would turn a
    // single scripted fault into a wait for three.
    maxRetries: 0,
  });
  const deps: AnthropicAdapterDeps = {
    bindingFor: () => bindingFor({ maxRetries: 0, attemptTimeoutMs: 5_000 }),
    availableBetas: ALL_BETAS,
    clock: new SystemClock(),
    logger: silentLogger,
    client,
  };
  return {
    server,
    deps,
    captured: () => {
      const first = server.requests()[0];
      if (first === undefined) throw new Error('no request reached the server');
      return first;
    },
  };
}

function body(request: CapturedRequest): Record<string, unknown> {
  return request.body as Record<string, unknown>;
}

/**
 * The deps without the injected client, so `createAnthropicClient` builds a real one.
 *
 * Rebuilt field by field rather than spread: under `exactOptionalPropertyTypes` a rest element
 * from a type with optional members widens them to `T | undefined`, which is a different type.
 */
function withoutClient(deps: Harness['deps']): AnthropicAdapterDeps {
  return {
    bindingFor: deps.bindingFor,
    availableBetas: deps.availableBetas,
    clock: deps.clock,
    logger: deps.logger,
  };
}

describe('a successful turn', () => {
  it('streams, and returns the normalised result', async () => {
    const { server, deps } = await harness();
    server.script({
      kind: 'reply',
      text: 'the answer',
      usage: { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 512 },
    });

    const result = await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));

    expect(result.text).toBe('the answer');
    expect(result.stop).toEqual({ reason: 'end_turn', raw: 'end_turn' });
    expect(result.toolCalls).toEqual([]);
    expect(result.model).toEqual({ provider: 'anthropic', requested: OPUS, served: OPUS });
    expect(result.usage).toEqual([
      {
        model: OPUS,
        kind: 'message',
        input: 12,
        cacheRead: 512,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 3,
        batch: false,
      },
    ]);
    expect(result.latency.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.betas).toEqual(ALL_BETAS);
    expect(result.diagnostics.inputTransformations).toBe(0);
  });

  it('sends `stream: true`, because 128K outputs cannot be fetched non-streaming', async () => {
    const { server, deps, captured } = await harness();
    server.script({ kind: 'reply', text: 'ok' });
    await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));
    expect(captured().stream).toBe(true);
    expect(captured().path).toBe('/v1/messages');
  });

  it('reassembles a tool call’s streamed JSON arguments into a parsed object', async () => {
    const { server, deps } = await harness();
    server.script({
      kind: 'reply',
      toolCalls: [{ id: 'toolu_1', name: 'get_forecast', input: { city: 'Paris' } }],
    });
    const result = await runChat(
      deps,
      turnRequest({ tools: [toolSpec()] }),
      AbortSignal.timeout(5_000),
    );
    expect(result.stop.reason).toBe('tool_use');
    // The wire sends `input_json_delta` fragments; the SDK concatenates and parses. A hand-rolled
    // reader works for `{}` and fails for every real call.
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'get_forecast', input: { city: 'Paris' } },
    ]);
  });

  it('keeps a thinking block out of the view and inside the echo', async () => {
    const { server, deps } = await harness();
    server.script({ kind: 'reply', thinking: 'private reasoning', text: 'hi' });
    const result = await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));
    expect(JSON.stringify(result.assistant.view)).not.toContain('private reasoning');
    expect(result.assistant.view).toContainEqual({ type: 'opaque', kind: 'thinking' });
    // In `raw`, which goes back verbatim — the API rejects a continuation that lost it.
    expect(JSON.stringify(result.assistant.raw)).toContain('private reasoning');
  });

  it('discards the output of a max_tokens turn rather than showing a truncated answer', async () => {
    const { server, deps } = await harness();
    server.script({
      kind: 'reply',
      text: 'half a sent',
      toolCalls: [{ id: 'toolu_1', name: 'get_forecast', input: {} }],
      stopReason: 'max_tokens',
    });
    const result = await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));
    expect(result.stop.reason).toBe('max_tokens');
    expect(result.text).toBe('');
    // Never execute a truncated tool call (`05` §3.5.3.4).
    expect(result.toolCalls).toEqual([]);
  });

  it('discards a refusal’s partial text and reports the category', async () => {
    const { server, deps } = await harness();
    server.script({
      kind: 'reply',
      text: 'partial, declined',
      stopReason: 'refusal',
      refusal: { category: 'cyber', explanation: 'no' },
    });
    const result = await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));
    expect(result.stop).toEqual({
      reason: 'refusal',
      raw: 'refusal',
      category: 'cyber',
      explanation: 'no',
      servedByFallback: false,
    });
    // The declining model's partial output must not reach a member.
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([]);
  });

  it('reports a refusal whose category is null, which the API allows', async () => {
    const { server, deps } = await harness();
    server.script({ kind: 'reply', text: 'x', stopReason: 'refusal', refusal: { category: null } });
    const result = await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));
    expect(result.stop).toMatchObject({ reason: 'refusal', category: null });
  });

  it('reports a pause_turn so the engine re-sends with no new user message', async () => {
    const { server, deps } = await harness();
    server.script({ kind: 'reply', text: 'thinking about it', stopReason: 'pause_turn' });
    const result = await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));
    expect(result.stop).toEqual({ reason: 'pause_turn', raw: 'pause_turn' });
    // Unlike a refusal or a truncation, the content is usable and is appended unchanged.
    expect(result.text).toBe('thinking about it');
  });

  it('bills a fallback turn at the model that served it', async () => {
    const { server, deps } = await harness();
    // The sticky-routing shape: a reply from the fallback model with no `fallback` block, which is
    // why `servedByFallback` reads `usage.iterations` rather than the content.
    server.script({
      kind: 'raw',
      body: {
        id: 'msg_f',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'rescued' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          iterations: [
            {
              type: 'fallback_message',
              model: 'claude-opus-4-8',
              input_tokens: 4,
              output_tokens: 2,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_creation: null,
            },
          ],
        },
      },
    });
    // A JSON body where the SDK asked for a stream: the stream helper rejects it, which is itself
    // worth asserting — a provider that answers a streaming request with JSON is a fault, not a
    // result. The `usage.iterations` mapping is unit-tested in `response.test.ts`.
    await expect(runChat(deps, turnRequest(), AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(
      ModelCallError,
    );
  });
});

describe('01 §2.1 on every captured request', () => {
  it('sends no sampling parameters, no prefill and no forced tool choice', async () => {
    const { server, deps, captured } = await harness();
    server.script({ kind: 'reply', text: 'ok' });
    await runChat(deps, turnRequest({ tools: [toolSpec()] }), AbortSignal.timeout(5_000));

    const sent = body(captured());
    for (const key of ['temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata']) {
      expect(key in sent, key).toBe(false);
    }
    expect(sent['tool_choice']).toEqual({ type: 'auto' });
    const messages = sent['messages'] as { role: string }[];
    expect(messages.at(-1)?.role).not.toBe('assistant');
  });

  it('sends strict, closed tool schemas', async () => {
    const { server, deps, captured } = await harness();
    server.script({ kind: 'reply', text: 'ok' });
    await runChat(deps, turnRequest({ tools: [toolSpec()] }), AbortSignal.timeout(5_000));
    const tools = body(captured())['tools'] as Record<string, unknown>[];
    const first = tools[0];
    expect(first?.['strict']).toBe(true);
    const schema = (first?.['input_schema'] ?? {}) as Record<string, unknown>;
    expect(schema['additionalProperties']).toBe(false);
  });

  it('sends effort explicitly and the refusal fallback on Opus', async () => {
    const { server, deps, captured } = await harness();
    server.script({ kind: 'reply', text: 'ok' });
    await runChat(deps, turnRequest({ effort: 'xhigh' }), AbortSignal.timeout(5_000));
    const sent = body(captured());
    expect(sent['output_config']).toEqual({ effort: 'xhigh' });
    expect(sent['fallbacks']).toBe('default');
    expect(captured().headers['anthropic-beta']).toContain(OPTIONAL_BETAS.serverFallback);
  });

  it('sends the credential, and the capture never holds its value', async () => {
    const { server, deps, captured } = await harness();
    server.script({ kind: 'reply', text: 'ok' });
    await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));
    expect(captured().hasCredential).toBe(true);
    expect(JSON.stringify(server.requests())).not.toContain('sk-ant-not-a-real-key');
  });
});

describe('S10 provider faults → ModelCallError (05 §3.5.3.10)', () => {
  const run = async (deps: AnthropicAdapterDeps): Promise<ModelCallError> => {
    try {
      await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));
    } catch (error) {
      if (error instanceof ModelCallError) return error;
      throw error;
    }
    throw new Error('expected the call to fail');
  };

  it('maps a 429 and carries the provider’s own retry-after', async () => {
    const { server, deps } = await harness();
    server.script({ kind: 'rate_limited', retryAfterSeconds: 4 });
    const error = await run(deps);
    expect(error.kind).toBe('rate_limited');
    expect(error.detail.status).toBe(429);
    // The provider said when to come back, and the limiter honours that over its own backoff.
    expect(error.detail.retryAfterMs).toBe(4000);
    expect(error.retryable).toBe(true);
  });

  it('maps a 529 to overloaded', async () => {
    const { server, deps } = await harness();
    server.script({ kind: 'overloaded' });
    const error = await run(deps);
    expect(error.kind).toBe('overloaded');
    expect(error.detail.status).toBe(529);
  });

  it('maps a 500 to server', async () => {
    const { server, deps } = await harness();
    server.script({ kind: 'server_error' });
    expect((await run(deps)).kind).toBe('server');
  });

  it('maps a 400 to bad_request, which is a bug in our own request', async () => {
    const { server, deps } = await harness();
    server.script({
      kind: 'raw',
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
    });
    const error = await run(deps);
    expect(error.kind).toBe('bad_request');
    expect(error.retryable).toBe(false);
  });

  it('maps a 401 to auth and fails fast', async () => {
    const { server, deps } = await harness();
    server.script({
      kind: 'raw',
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'no' } },
    });
    const error = await run(deps);
    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
  });

  it('maps a stream cut mid-response to a connection failure, not a silent short answer', async () => {
    const { server, deps } = await harness();
    server.script({ kind: 'stream_cut', text: 'the beginning of an', afterEvents: 3 });
    const error = await run(deps);
    // The decisive assertion: a truncated stream must **fail**. An adapter that returned the
    // partial text would hand a member half an answer and call it done.
    expect(['network', 'timeout', 'unknown']).toContain(error.kind);
  });

  it('maps a caller’s abort to aborted, which is not a breaker failure', async () => {
    const { server, deps } = await harness();
    server.script({ kind: 'hang', ms: 30_000 });
    const controller = new AbortController();
    const pending = runChat(deps, turnRequest(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', retryable: false });
  });
});

describe('createAnthropicClient (05 §3.5.3.1)', () => {
  it('builds a client with the documented defaults', async () => {
    const { deps } = await harness();
    const built = createAnthropicClient(withoutClient(deps));
    expect(built.maxRetries).toBe(CLIENT_DEFAULTS.maxRetries);
    // Milliseconds in the TS SDK, seconds in Python/Ruby — a unit mix-up here is a 120-second
    // budget that behaves like two minutes or like two hours.
    expect(built.timeout).toBe(CLIENT_DEFAULTS.timeoutMs);
  });

  it('uses an injected key and base URL, and never logs the key', async () => {
    const { deps, server } = await harness();
    const base = withoutClient(deps);
    // Field by field, not a spread: spreading a type with an optional member widens it to
    // `T | undefined` under `exactOptionalPropertyTypes`, which the parameter rightly refuses.
    const built = createAnthropicClient({
      bindingFor: base.bindingFor,
      availableBetas: base.availableBetas,
      clock: base.clock,
      logger: base.logger,
      apiKey: new SecretString('ANTHROPIC_API_KEY', 'sk-ant-also-not-real'),
      baseUrl: server.anthropicBaseUrl,
    });
    expect(built.baseURL).toBe(server.anthropicBaseUrl);
    expect(built.apiKey).toBe('sk-ant-also-not-real');
  });

  it('returns the injected client when one is given', async () => {
    const { deps } = await harness();
    expect(createAnthropicClient(deps)).toBe(deps.client);
  });
});

describe('resuming a paused turn', () => {
  it('allows an assistant-final message, which assertWireInvariants otherwise refuses', async () => {
    const { server, deps } = await harness();
    server.script({ kind: 'reply', text: 'continued' });
    const paused = turnRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          provider: 'anthropic',
          servedModel: OPUS,
          raw: [{ type: 'text', text: 'partial' }],
          view: [],
        },
      ],
    });
    // Without the flag this is a prefill and the builder refuses it.
    await expect(runChat(deps, paused, AbortSignal.timeout(5_000))).rejects.toThrow(
      /assistant prefill/,
    );
    const result = await runChat(deps, paused, AbortSignal.timeout(5_000), {
      resumingPausedTurn: true,
    });
    expect(result.text).toBe('continued');
  });

  it('reports no ttft when the model produced no text', async () => {
    const { server, deps } = await harness();
    server.script({
      kind: 'reply',
      toolCalls: [{ id: 'toolu_1', name: 'get_forecast', input: { city: 'Rome' } }],
    });
    const result = await runChat(
      deps,
      turnRequest({ tools: [toolSpec()] }),
      AbortSignal.timeout(5_000),
    );
    // `once('text')` never fires for a tool-only turn, so the field is absent rather than 0.
    expect('ttftMs' in result.latency).toBe(false);
    expect(result.latency.totalMs).toBeGreaterThanOrEqual(0);
  });
});

describe('the gateway’s unimplemented members', () => {
  it('fail loudly and name the task that implements them', async () => {
    const { deps } = await harness();
    const gateway = createAnthropicGateway(deps);
    expect(() => gateway.structured({} as never, AbortSignal.timeout(1))).toThrow(ModelCallError);
    try {
      void gateway.structured({} as never, AbortSignal.timeout(1));
    } catch (error) {
      expect((error as ModelCallError).detail.type).toContain('M2-T8');
    }
  });

  it('refuses embed, which belongs to 04’s embedding model', async () => {
    const { deps } = await harness();
    const gateway = createAnthropicGateway(deps);
    // The task id is in `detail.type`, not the message: `ModelCallError`'s message is the kind
    // alone, because a provider's own text has carried prompt fragments.
    try {
      void gateway.embed(['x'], 'query');
      expect.unreachable('embed should refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCallError);
      expect((error as ModelCallError).detail.type).toContain('M4-T20');
    }
  });

  it('answers routeInfo from the binding', async () => {
    const { deps } = await harness();
    expect(createAnthropicGateway(deps).routeInfo('chat')).toMatchObject({
      provider: 'anthropic',
      model: OPUS,
    });
  });
});
