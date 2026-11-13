/**
 * `FakeProviderServer` over a real socket (`M2-T10`).
 *
 * Integration rather than unit, deliberately: the thing under test is a server, and the faults
 * `11` §3.6 S10 asks for — a truncated stream, a destroyed socket, a request that never answers —
 * have no meaning without one. A mocked transport would assert that we wrote the bytes we meant to
 * write, which `provider-wire.test.ts` already does; this asserts that a client on the other end of
 * a TCP connection sees them, and sees the failures as failures.
 *
 * Each test gets its **own** server, started inside the test and closed by `onTestFinished`. A
 * module-level `let` with a `beforeEach` would be shorter and is what `scripts/hygiene/check.ts`
 * refuses: mutable module state leaks between tests in a file, so the suite passes in file order
 * and fails under `--sequence.shuffle`, which `11` §3.1.11's flake hunt runs nightly. A port per
 * test also means a hung request in one cannot reach the next.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  CAPTURED_SECRET,
  type FakeProviderServer,
  startFakeProviderServer,
} from './fake-provider-server.js';

/** A server for this test only, closed when the test finishes however it finishes. */
async function freshServer(): Promise<FakeProviderServer> {
  const server = await startFakeProviderServer();
  onTestFinished(async () => {
    await server.close();
  });
  return server;
}

/** A request shaped like the one an SDK sends, with a fake credential. */
async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-not-a-real-key',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
}

function messagesUrl(server: FakeProviderServer): string {
  return `${server.anthropicBaseUrl}/v1/messages`;
}

function chatUrl(server: FakeProviderServer): string {
  return `${server.openaiBaseUrl}/chat/completions`;
}

/**
 * Read as much of a body as arrives, and keep the error that ended it.
 *
 * `response.text()` throws away everything received when the stream fails, which makes "the
 * connection never opened" and "the stream was cut after three events" look identical.
 */
async function drain(response: Response): Promise<{ text: string; error: unknown }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: '', error: new Error('no body') };
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text, error: undefined };
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return { text, error };
  }
}

describe('binding', () => {
  it('listens on loopback, so nothing can reach it from off the machine', async () => {
    const server = await freshServer();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('exposes a base URL per provider that the SDKs can append to', async () => {
    const server = await freshServer();
    expect(server.anthropicBaseUrl).toBe(server.url);
    expect(server.openaiBaseUrl).toBe(`${server.url}/v1`);
  });
});

describe('Anthropic Messages, JSON', () => {
  it('serves a scripted reply', async () => {
    const server = await freshServer();
    server.script({ kind: 'reply', text: 'hello', usage: { inputTokens: 5, outputTokens: 2 } });
    const response = await post(messagesUrl(server), { model: 'claude-opus-5-5', messages: [] });
    expect(response.status).toBe(200);
    expect(response.headers.get('request-id')).toMatch(/^req_fake_/);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['content']).toEqual([{ type: 'text', text: 'hello' }]);
    expect(body['stop_reason']).toBe('end_turn');
  });

  it('captures the request with the credential redacted', async () => {
    const server = await freshServer();
    server.script({ kind: 'reply', text: 'hello' });
    await post(messagesUrl(server), { model: 'claude-opus-5-5', messages: [], stream: false });
    const [captured] = server.requests();
    expect(captured).toMatchObject({
      ordinal: 1,
      method: 'POST',
      path: '/v1/messages',
      provider: 'anthropic',
      stream: false,
      hasCredential: true,
    });
    // The value never appears in a capture; its presence does, which is the assertion a contract
    // test actually wants.
    expect(captured?.headers['x-api-key']).toBe(CAPTURED_SECRET);
    expect(JSON.stringify(captured)).not.toContain('sk-ant-not-a-real-key');
    expect(captured?.headers['anthropic-version']).toBe('2023-06-01');
    expect(captured?.body).toEqual({ model: 'claude-opus-5-5', messages: [], stream: false });
  });

  it('consumes the queue in order and reports what is left', async () => {
    const server = await freshServer();
    server.script({ kind: 'reply', text: 'first' }, { kind: 'reply', text: 'second' });
    expect(server.pending()).toBe(2);
    const first = (await (await post(messagesUrl(server), {})).json()) as Record<string, unknown>;
    const second = (await (await post(messagesUrl(server), {})).json()) as Record<string, unknown>;
    expect([first['content'], second['content']]).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'second' }],
    ]);
    expect(server.pending()).toBe(0);
  });

  it('serves a raw body for a shape the neutral reply cannot express', async () => {
    const server = await freshServer();
    server.script({
      kind: 'raw',
      status: 200,
      body: { anything: true },
      headers: { 'x-note': '1' },
    });
    const response = await post(messagesUrl(server), {});
    expect(response.headers.get('x-note')).toBe('1');
    expect(await response.json()).toEqual({ anything: true });
  });
});

describe('Anthropic Messages, SSE', () => {
  it('streams the documented events when stream: true', async () => {
    const server = await freshServer();
    server.script({ kind: 'reply', text: 'hi', usage: { inputTokens: 1, outputTokens: 1 } });
    const response = await post(messagesUrl(server), { stream: true });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text.split('\n\n').filter((block) => block !== '')).toHaveLength(7);
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: ping');
    expect(text).toContain('"type":"text_delta","text":"hi"');
    expect(text.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
    expect(server.requests()[0]?.stream).toBe(true);
  });
});

describe('the endpoints M2-T8 added', () => {
  it('serves a token count from a raw turn', async () => {
    const server = await freshServer();
    server.script({ kind: 'raw', body: { input_tokens: 1234, context_management: null } });
    const response = await post(`${server.anthropicBaseUrl}/v1/messages/count_tokens`, {
      model: 'claude-opus-5-5',
      messages: [],
    });
    expect(await response.json()).toMatchObject({ input_tokens: 1234 });
    expect(server.requests()[0]?.endpoint).toBe('count_tokens');
  });

  it('serves a batch submission and labels the capture', async () => {
    const server = await freshServer();
    server.script({
      kind: 'raw',
      body: {
        id: 'msgbatch_1',
        type: 'message_batch',
        processing_status: 'in_progress',
        created_at: '2026-11-13T00:00:00Z',
        expires_at: '2026-11-14T00:00:00Z',
        ended_at: null,
        cancel_initiated_at: null,
        archived_at: null,
        results_url: null,
        request_counts: { succeeded: 0, errored: 0, canceled: 0, expired: 0, processing: 1 },
      },
    });
    const response = await post(`${server.anthropicBaseUrl}/v1/messages/batches`, { requests: [] });
    expect(await response.json()).toMatchObject({ id: 'msgbatch_1' });
    expect(server.requests()[0]?.endpoint).toBe('batches');
  });

  it('labels an ordinary message capture as the messages endpoint', async () => {
    const server = await freshServer();
    server.script({ kind: 'reply', text: 'ok' });
    await post(messagesUrl(server), {});
    expect(server.requests()[0]?.endpoint).toBe('messages');
  });
});

describe('the OpenAI-compatible endpoint', () => {
  it('serves a chat completion', async () => {
    const server = await freshServer();
    server.script({ kind: 'reply', text: 'hi' });
    const body = (await (await post(chatUrl(server), { model: 'llama' })).json()) as Record<
      string,
      unknown
    >;
    expect(body['object']).toBe('chat.completion');
    expect(server.requestsFor('openai')).toHaveLength(1);
    expect(server.requestsFor('anthropic')).toHaveLength(0);
  });

  it('streams and terminates with [DONE]', async () => {
    const server = await freshServer();
    server.script({ kind: 'reply', text: 'hi', usage: { inputTokens: 1, outputTokens: 1 } });
    const text = await (
      await post(chatUrl(server), { stream: true, stream_options: { include_usage: true } })
    ).text();
    expect(text).not.toContain('event:');
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"prompt_tokens":1');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('S10 fault plans', () => {
  it('serves 429 with retry-after in seconds', async () => {
    const server = await freshServer();
    server.script({ kind: 'rate_limited', retryAfterSeconds: 3 });
    const response = await post(messagesUrl(server), {});
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toMatchObject({ error: { type: 'rate_limit_error' } });
  });

  it('serves 529 overloaded, the status the SDKs special-case', async () => {
    const server = await freshServer();
    server.script({ kind: 'overloaded' });
    const response = await post(messagesUrl(server), {});
    expect(response.status).toBe(529);
    expect(await response.json()).toMatchObject({ error: { type: 'overloaded_error' } });
  });

  it('serves 5xx, defaulting to 500', async () => {
    const server = await freshServer();
    server.script({ kind: 'server_error' }, { kind: 'server_error', status: 502 });
    expect((await post(messagesUrl(server), {})).status).toBe(500);
    expect((await post(messagesUrl(server), {})).status).toBe(502);
  });

  it('uses the OpenAI error envelope on the OpenAI endpoint', async () => {
    const server = await freshServer();
    server.script({ kind: 'rate_limited' });
    const body = (await (await post(chatUrl(server), {})).json()) as Record<string, unknown>;
    expect(body['error']).toMatchObject({ type: 'rate_limit_exceeded' });
    expect('type' in body).toBe(false);
  });

  it('cuts a stream mid-response: the early events arrive, message_stop never does', async () => {
    const server = await freshServer();
    server.script({ kind: 'stream_cut', text: 'hi', afterEvents: 3 });
    const response = await post(messagesUrl(server), { stream: true });
    // The status line arrives before the cut, so the failure is a truncated body rather than an
    // error code — the shape that breaks a reader assuming `message_stop` always comes.
    expect(response.status).toBe(200);
    const { text, error } = await drain(response);
    // Both halves matter. Bytes received proves this is a *truncated stream* and not a connection
    // that never opened; the error proves the stream really was cut. The first version of the
    // server destroyed the socket before the write flushed and produced the second without the
    // first, which is a different fault than the one S10 asks for.
    expect(text).toContain('event: message_start');
    expect(text).not.toContain('message_stop');
    expect(error).toBeDefined();
  });

  it('truncates a non-streaming body, which is the same failure a layer down', async () => {
    const server = await freshServer();
    server.script({ kind: 'stream_cut', text: 'a'.repeat(200) });
    const response = await post(messagesUrl(server), {});
    const { text, error } = await drain(response);
    expect(text.startsWith('{')).toBe(true);
    expect(() => JSON.parse(text) as unknown).toThrow();
    expect(error).toBeDefined();
  });

  it('destroys the socket on socket_reset', async () => {
    const server = await freshServer();
    server.script({ kind: 'socket_reset' });
    await expect(post(messagesUrl(server), {})).rejects.toThrow();
  });

  it('delays the first byte by latencyMs', async () => {
    const server = await freshServer();
    server.script({ kind: 'reply', text: 'slow', latencyMs: 120 });
    const started = Date.now();
    await (await post(messagesUrl(server), {})).json();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('hangs until the client gives up', async () => {
    const server = await freshServer();
    server.script({ kind: 'hang', ms: 30_000 });
    await expect(
      fetch(messagesUrl(server), {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(150),
      }),
    ).rejects.toThrow();
  });

  it('drops the connection once the hang elapses, if the client is still waiting', async () => {
    const server = await freshServer();
    // A short hang the client outlives: the server reaches the end of the delay and closes the
    // connection itself, which is the other half of S10's long-poll hang — the client that waits
    // patiently and gets nothing.
    server.script({ kind: 'hang', ms: 60 });
    await expect(post(messagesUrl(server), {})).rejects.toThrow();
  });

  it('close() cancels a pending hang rather than waiting it out', async () => {
    const server = await freshServer();
    server.script({ kind: 'hang', ms: 300_000 });
    // Not awaited: the request is still in flight when the server closes, and the rejection is
    // expected. Without the timer bookkeeping in `close()`, this test would take five minutes.
    const inFlight = post(messagesUrl(server), {}).catch(() => undefined);
    const started = Date.now();
    await server.close();
    await inFlight;
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('failing loudly', () => {
  it('answers 500 with a message naming the ordinal when nothing is scripted', async () => {
    const server = await freshServer();
    const response = await post(messagesUrl(server), {});
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string } };
    // Loud, like `CassetteModel`'s strict mode (`11` §3.2.4): a fake that invented a reply would
    // make a test pass for a request nobody scripted.
    expect(body.error.message).toContain('no turn scripted for request #1');
    expect(body.error.message).toContain('POST /v1/messages');
  });

  it('still captures the request it could not answer', async () => {
    const server = await freshServer();
    await post(messagesUrl(server), { model: 'x' });
    expect(server.requests()).toHaveLength(1);
  });

  it('names the task that owns an endpoint it does not serve', async () => {
    const server = await freshServer();
    // `count_tokens` and `batches` were on this list until `M2-T8` added them, which is the
    // pointer working as intended: the task that owned them served them.
    const cases: readonly [string, string][] = [
      ['/v1/responses', 'M2-T11'],
      ['/v1/models', 'M2-T12'],
    ];
    for (const [path, owner] of cases) {
      const response = await post(`${server.url}${path}`, {});
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain(owner);
    }
  });

  it('explains what it does serve for an unrecognised path', async () => {
    const server = await freshServer();
    const response = await post(`${server.url}/v1/nonsense`, {});
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('/v1/chat/completions');
  });

  it('captures a body that is not JSON without throwing', async () => {
    const server = await freshServer();
    server.script({ kind: 'reply', text: 'ok' });
    await fetch(messagesUrl(server), { method: 'POST', body: 'not json' });
    const [captured] = server.requests();
    expect(captured?.body).toBeUndefined();
    expect(captured?.raw).toBe('not json');
  });
});

describe('reset', () => {
  it('clears the script and the captures, keeping the port', async () => {
    const server = await freshServer();
    server.script({ kind: 'reply', text: 'hi' });
    await post(messagesUrl(server), {});
    const url = server.url;
    server.reset();
    expect(server.requests()).toEqual([]);
    expect(server.pending()).toBe(0);
    expect(server.url).toBe(url);
    // The ordinal restarts, so a reset test reads the same as a fresh one.
    const response = await post(messagesUrl(server), {});
    expect(response.status).toBe(500);
    expect(server.requests()[0]?.ordinal).toBe(1);
  });
});
