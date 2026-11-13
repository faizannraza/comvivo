/**
 * `FakeProviderServer` — a wire-level fake model provider (`11` §3.1.9, §3.2.4, §3.6 S10; `M2-T10`).
 *
 * ## Why a real socket and not a mock
 *
 * `11`'s Q21 answers this: "Kill -9 requires the platform and the model to live outside the
 * process. The real SDK retry paths get exercised." A `MockAgent` intercepts inside the process, so
 * it disappears with the process the chaos suite is about to kill — and it replaces the very code
 * whose behaviour is in question. The provider SDKs do the retrying, the backoff, the `retry-after`
 * honouring and the stream reassembly; a fake that bypasses them tests our mapping of a response we
 * wrote rather than our handling of a response that arrived.
 *
 * So this binds a loopback HTTP server, and an adapter points its `baseURL` at it.
 *
 * ## Built before the adapter, on purpose
 *
 * `M2-T10` lands before `M2-T6`. The sequencing is the point: the Anthropic adapter is written
 * against something that already returns 429s with a `retry-after`, 529 overloads, 5xx, hangs and
 * streams cut in the middle — so its error mapping and its stream handling exist from the first
 * commit rather than being added after a production incident. The faults are `11` §3.6 S10's
 * model-provider list, exactly.
 *
 * ## What it serves, and what it does not
 *
 * Two endpoints, matched by path **suffix** so any base path works:
 *
 *  - `POST …/v1/messages` — Anthropic Messages, JSON and SSE
 *  - `POST …/v1/chat/completions` — the OpenAI-compatible subset Ollama, LM Studio, llama.cpp and
 *    vLLM all implement (`05` §3.5.6), JSON and SSE
 *
 * Everything else answers **404 with a message naming the task that will add it**:
 * `/v1/messages/count_tokens` and `/v1/messages/batches` belong to `M2-T8`, `/v1/responses` to
 * `M2-T11` (whose adapter defines that shape and whose fixtures will verify it against the live
 * API), and `/v1/models` to `M2-T12`, where server identification differs per local runtime and
 * guessing now would be worse than a clear 404. A mystery 404 in a future task is a bad use of
 * somebody's afternoon; a 404 that says "`M2-T8` adds this" is not.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  anthropicError,
  anthropicMessage,
  anthropicStream,
  type FakeReply,
  frameSse,
  openaiCompletion,
  openaiError,
  openaiStream,
  type SseEvent,
  type WireIds,
} from './provider-wire.js';

export const PROVIDER_KINDS = ['anthropic', 'openai'] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Fixed, so a golden assertion over an OpenAI-compatible body is stable: 2026-01-01T00:00:00Z. */
export const FAKE_CREATED_EPOCH_SECONDS = 1_767_225_600;

/** The default status for `server_error`: 500 is the one the SDKs treat as retryable without a header. */
export const DEFAULT_SERVER_ERROR_STATUS = 500;

/** Anthropic's overload status (`overloaded_error`). Not 503 — the SDKs special-case this number. */
export const OVERLOADED_STATUS = 529;

/** Header names whose values are replaced in a capture. */
const SECRET_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'proxy-authorization',
]);

/** What a capture shows instead of a credential. */
export const CAPTURED_SECRET = '<redacted>';

interface FakeTurnBase {
  /** Delay before the first byte, so a test can assert a timeout or measure a budget. */
  readonly latencyMs?: number;
}

/**
 * One scripted outcome, consumed in order.
 *
 * A queue rather than a matcher: a chaos test's interesting property is the *sequence* — 429, then
 * 529, then success — and a matcher-keyed fake makes that sequence implicit. `M2-T7`'s
 * `ScriptedModel` is the matcher-shaped double, one layer up, where the request is a
 * `ModelTurnRequest` rather than bytes.
 */
export type FakeTurn =
  | (FakeTurnBase & { readonly kind: 'reply' } & FakeReply)
  | (FakeTurnBase & {
      readonly kind: 'raw';
      readonly status?: number;
      readonly body: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    })
  | (FakeTurnBase & { readonly kind: 'rate_limited'; readonly retryAfterSeconds?: number })
  | (FakeTurnBase & { readonly kind: 'overloaded' })
  | (FakeTurnBase & { readonly kind: 'server_error'; readonly status?: number })
  | (FakeTurnBase & { readonly kind: 'stream_cut'; readonly afterEvents?: number } & FakeReply)
  | (FakeTurnBase & { readonly kind: 'hang'; readonly ms?: number })
  | (FakeTurnBase & { readonly kind: 'socket_reset' });

export interface CapturedRequest {
  /** 1-based, across every endpoint, so a test can assert what arrived in which order. */
  readonly ordinal: number;
  readonly method: string;
  readonly path: string;
  readonly provider: ProviderKind | 'unknown';
  /** Lower-cased names; credential values replaced with {@link CAPTURED_SECRET}. */
  readonly headers: Readonly<Record<string, string>>;
  /** True when a credential header was present — the assertion a test actually wants. */
  readonly hasCredential: boolean;
  /** The parsed JSON body, or `undefined` when there was none or it did not parse. */
  readonly body: unknown;
  readonly raw: string;
  /** `body.stream === true`. */
  readonly stream: boolean;
  /** Milliseconds since the server started listening, for latency and backoff assertions. */
  readonly offsetMs: number;
}

export interface FakeProviderServerOptions {
  /** Loopback only. Overridable for an IPv6-only runner. */
  readonly host?: string;
  /** The `model` echoed back when a reply does not name one. */
  readonly defaultModel?: string;
  readonly created?: number;
}

export interface FakeProviderServer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** For an Anthropic client's `baseURL`: the SDK appends `/v1/messages`. */
  readonly anthropicBaseUrl: string;
  /** For an OpenAI-compatible client's `baseURL`: the SDK appends `/chat/completions`. */
  readonly openaiBaseUrl: string;
  /** Append turns to the queue. */
  script(...turns: readonly FakeTurn[]): void;
  /** Everything captured, oldest first. */
  requests(): readonly CapturedRequest[];
  requestsFor(provider: ProviderKind): readonly CapturedRequest[];
  /** How many scripted turns are left — a test asserting the script was consumed reads this. */
  pending(): number;
  /** Clear the script and the captures. The port stays the same. */
  reset(): void;
  close(): Promise<void>;
}

/** Route by path **suffix**, so `/anthropic/v1/messages` and `/v1/messages` both work. */
function providerFor(path: string): ProviderKind | 'unknown' {
  const withoutQuery = path.split('?')[0] ?? path;
  if (withoutQuery.endsWith('/v1/messages')) return 'anthropic';
  if (withoutQuery.endsWith('/v1/chat/completions')) return 'openai';
  return 'unknown';
}

/** The task that owns an endpoint this task deliberately does not serve. */
function unservedBy(path: string): string | undefined {
  if (path.includes('/v1/messages/count_tokens') || path.includes('/v1/messages/batches')) {
    return 'M2-T8 (Anthropic structured(), countTokens(), Batches)';
  }
  if (path.includes('/v1/responses')) return 'M2-T11 (the OpenAI Responses adapter)';
  if (path.includes('/v1/models')) return 'M2-T12 (the OpenAI-compatible local adapter)';
  return undefined;
}

function redactHeaders(raw: IncomingMessage['headers']): {
  headers: Record<string, string>;
  hasCredential: boolean;
} {
  const headers: Record<string, string> = {};
  let hasCredential = false;
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(', ') : value;
    if (SECRET_HEADERS.has(name)) {
      hasCredential = true;
      headers[name] = CAPTURED_SECRET;
      continue;
    }
    headers[name] = text;
  }
  return { headers, hasCredential };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function parseJson(raw: string): unknown {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wantsStream(body: unknown): boolean {
  return isRecord(body) && body['stream'] === true;
}

function wantsUsageChunk(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const options = body['stream_options'];
  return isRecord(options) && options['include_usage'] === true;
}

export async function startFakeProviderServer(
  options: FakeProviderServerOptions = {},
): Promise<FakeProviderServer> {
  const host = options.host ?? '127.0.0.1';
  const defaultModel = options.defaultModel ?? 'claude-opus-5-5';
  const created = options.created ?? FAKE_CREATED_EPOCH_SECONDS;

  const queue: FakeTurn[] = [];
  const captured: CapturedRequest[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let sequence = 0;
  let startedAt = 0;

  /** A delay that a `close()` cancels, so a `hang` cannot keep the process alive. */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });

  const idsFor = (provider: ProviderKind | 'unknown', ordinal: number): WireIds => ({
    messageId:
      provider === 'openai' ? `chatcmpl_fake_${String(ordinal)}` : `msg_fake_${String(ordinal)}`,
    created,
  });

  function sendJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): void {
    response.writeHead(status, {
      'content-type': 'application/json',
      'request-id': `req_fake_${String(captured.length)}`,
      ...headers,
    });
    response.end(JSON.stringify(body));
  }

  function openStream(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'request-id': `req_fake_${String(captured.length)}`,
    });
  }

  function writeEvents(response: ServerResponse, events: readonly SseEvent[]): void {
    for (const event of events) response.write(frameSse(event));
  }

  function faultStatus(turn: FakeTurn): number {
    if (turn.kind === 'rate_limited') return 429;
    if (turn.kind === 'overloaded') return OVERLOADED_STATUS;
    return turn.kind === 'server_error'
      ? (turn.status ?? DEFAULT_SERVER_ERROR_STATUS)
      : DEFAULT_SERVER_ERROR_STATUS;
  }

  function errorBody(provider: ProviderKind | 'unknown', status: number): unknown {
    return provider === 'openai'
      ? openaiError(status)
      : anthropicError(status, `req_fake_${String(captured.length)}`);
  }

  function eventsFor(
    provider: ProviderKind | 'unknown',
    reply: FakeReply,
    ids: WireIds,
    body: unknown,
  ): readonly SseEvent[] {
    return provider === 'openai'
      ? openaiStream(reply, ids, defaultModel, { includeUsage: wantsUsageChunk(body) })
      : anthropicStream(reply, ids, defaultModel);
  }

  function bodyFor(
    provider: ProviderKind | 'unknown',
    reply: FakeReply,
    ids: WireIds,
  ): Record<string, unknown> {
    return provider === 'openai'
      ? openaiCompletion(reply, ids, defaultModel)
      : anthropicMessage(reply, ids, defaultModel);
  }

  /** The whole scripted reply, streamed or not. */
  function respondWithReply(
    response: ServerResponse,
    provider: ProviderKind | 'unknown',
    reply: FakeReply,
    ids: WireIds,
    body: unknown,
  ): void {
    if (!wantsStream(body)) {
      sendJson(response, 200, bodyFor(provider, reply, ids));
      return;
    }
    openStream(response);
    writeEvents(response, eventsFor(provider, reply, ids, body));
    response.end();
  }

  /**
   * `11` §3.6 S10's "stream cut mid-response".
   *
   * For a streaming request: write `afterEvents` events and destroy the socket, so the client sees
   * a truncated stream rather than an error status — the shape that breaks a reader which assumes
   * `message_stop` always arrives. For a non-streaming one: write half the JSON body and destroy,
   * which is the same failure at a different layer and equally worth handling.
   */
  function cutStream(
    response: ServerResponse,
    provider: ProviderKind | 'unknown',
    reply: FakeReply,
    ids: WireIds,
    body: unknown,
    afterEvents: number,
  ): void {
    let payload: string;
    if (wantsStream(body)) {
      openStream(response);
      payload = eventsFor(provider, reply, ids, body)
        .slice(0, afterEvents)
        .map((event) => frameSse(event))
        .join('');
    } else {
      const json = JSON.stringify(bodyFor(provider, reply, ids));
      response.writeHead(200, { 'content-type': 'application/json' });
      payload = json.slice(0, Math.max(1, Math.floor(json.length / 2)));
    }
    // The close has to happen **after** the partial bytes have flushed, which is what the write
    // callback is for. Destroying immediately sent an RST that discarded them, and the client saw
    // `bytesRead: 0` — a connection failure rather than a truncated body, which is a different
    // fault and not the one S10 asks for. Measured, not reasoned: the first version of this test
    // failed on the request promise instead of on the body read.
    //
    // `end()` rather than `destroy()`: a FIN mid-chunked-body is a premature close, and the bytes
    // already delivered stay delivered. `socket_reset` is the turn that sends an RST.
    response.write(payload, () => {
      response.socket?.end();
    });
  }

  async function dispatch(
    turn: FakeTurn,
    response: ServerResponse,
    provider: ProviderKind | 'unknown',
    body: unknown,
    ordinal: number,
  ): Promise<void> {
    if (turn.latencyMs !== undefined && turn.latencyMs > 0) await sleep(turn.latencyMs);
    const ids = idsFor(provider, ordinal);

    switch (turn.kind) {
      case 'reply':
        respondWithReply(response, provider, turn, ids, body);
        return;
      case 'raw':
        sendJson(response, turn.status ?? 200, turn.body, turn.headers ?? {});
        return;
      case 'rate_limited': {
        const seconds = turn.retryAfterSeconds ?? 1;
        // `retry-after` in seconds, which both SDKs honour. Asserting that they do is `M2-T9`'s
        // job; serving it is this one's.
        sendJson(response, 429, errorBody(provider, 429), {
          'retry-after': String(seconds),
          'anthropic-ratelimit-requests-remaining': '0',
        });
        return;
      }
      case 'overloaded':
      case 'server_error': {
        const status = faultStatus(turn);
        sendJson(response, status, errorBody(provider, status));
        return;
      }
      case 'stream_cut':
        cutStream(response, provider, turn, ids, body, turn.afterEvents ?? 2);
        return;
      case 'hang':
        // No response at all until the client gives up or `close()` cancels the timer. This is
        // S10's "long-poll hang", and it is what proves a request timeout is configured.
        await sleep(turn.ms ?? 60_000);
        if (!response.writableEnded) response.socket?.destroy();
        return;
      case 'socket_reset':
        response.socket?.destroy();
        return;
    }
  }

  function unscripted(response: ServerResponse, request: CapturedRequest): void {
    // Loud, like `CassetteModel`'s strict mode (`11` §3.2.4). A fake that invented a reply would
    // make a test pass for a request nobody scripted.
    sendJson(response, 500, {
      type: 'error',
      error: {
        type: 'api_error',
        message:
          `FakeProviderServer has no turn scripted for request #${String(request.ordinal)} ` +
          `(${request.method} ${request.path}). Call server.script(...) with one turn per ` +
          'expected request; the queue is consumed in order.',
      },
    });
  }

  const server: Server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const raw = await readBody(request);
      const path = request.url ?? '/';
      const provider = providerFor(path);
      const { headers, hasCredential } = redactHeaders(request.headers);
      const body = parseJson(raw);
      sequence += 1;
      const entry: CapturedRequest = {
        ordinal: sequence,
        method: request.method ?? 'GET',
        path,
        provider,
        headers,
        hasCredential,
        body,
        raw,
        stream: wantsStream(body),
        offsetMs: Date.now() - startedAt,
      };
      captured.push(entry);

      if (provider === 'unknown') {
        const owner = unservedBy(path);
        sendJson(response, 404, {
          type: 'error',
          error: {
            type: 'not_found_error',
            message:
              owner === undefined
                ? `FakeProviderServer serves POST …/v1/messages and POST …/v1/chat/completions; ${path} is neither.`
                : `FakeProviderServer does not serve ${path} yet — it is owned by ${owner}.`,
          },
        });
        return;
      }

      const turn = queue.shift();
      if (turn === undefined) {
        unscripted(response, entry);
        return;
      }
      await dispatch(turn, response, provider, body, sequence);
    })().catch(() => {
      // The socket is gone (a cut or a reset we caused, or a client that hung up). Nothing to say
      // on a connection that no longer exists, and an unhandled rejection here would fail an
      // unrelated test.
      if (!response.writableEnded) response.socket?.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      startedAt = Date.now();
      resolve();
    });
  });

  // `server.address()`'s own return type carries the port, so there is no `node:net` import here
  // — which keeps the dependency-cruiser exemption below to `node:http` alone.
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('FakeProviderServer: listen() produced no TCP address');
  }
  const url = `http://${host}:${String(address.port)}`;

  return {
    url,
    anthropicBaseUrl: url,
    openaiBaseUrl: `${url}/v1`,
    script(...turns) {
      queue.push(...turns);
    },
    requests() {
      return [...captured];
    },
    requestsFor(provider) {
      return captured.filter((request) => request.provider === provider);
    },
    pending() {
      return queue.length;
    },
    reset() {
      queue.length = 0;
      captured.length = 0;
      sequence = 0;
      startedAt = Date.now();
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      return new Promise<void>((resolve) => {
        // `closeAllConnections` is what makes this return: a kept-alive socket from a client that
        // is still open would otherwise hold the server for its idle timeout, and every chaos test
        // would pay that in teardown.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
