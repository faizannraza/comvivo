/**
 * The local adapter against real sockets (`05` §3.5.6, `11` §3.1.9; `M2-T12`).
 *
 * Two things only a socket can establish, and both are the point of this file:
 *
 *  - **Identification works against each of the four servers**, including the `generic` case where
 *    nothing answers a recognised shape. The fake impersonates one server at a time, because a host
 *    runs Ollama *or* llama.cpp and a fake that could be both would let a test pass against a
 *    configuration that cannot exist.
 *  - **The probes measure rather than assume.** A server that refuses `tools` with a 400 is
 *    *answering* the question, so the probe has to come back with `nativeTools: false` and not with
 *    an error — which is only testable against something that really returns a 400.
 */
import { SystemClock } from '@comvivo/shared';
import { EMPTY_POLICY } from '@comvivo/shared/net';
import { recordingLogger, silentLogger } from '@comvivo/shared/testing';
import OpenAI from 'openai';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  type CapturedRequest,
  type FakeProviderServer,
  type LocalServerFacade,
  startFakeProviderServer,
} from '../testing/index.js';
import type { LocalAdapterDeps } from './adapter.js';
import { createLocalClient, createLocalGateway, runChat, runStructured } from './adapter.js';
import { staticHintsFor } from './hints.js';
import { hostPortOf, identifyServer } from './identify.js';
import type { LadderLevel } from './ladder.js';
import { type LocalProbeTransport, runProbes } from './probe.js';
import { LOCAL_PROVIDER } from './response.js';
import {
  LOCAL_MODEL,
  localBinding,
  localToolSpec,
  localTurnRequest,
  SERVER_FIXTURES,
} from './testing/fixtures.js';

interface Harness {
  readonly server: FakeProviderServer;
  readonly baseUrl: string;
  readonly deps: LocalAdapterDeps;
  readonly captured: (index?: number) => CapturedRequest;
  readonly body: (index?: number) => Record<string, unknown>;
  readonly policy: {
    readonly allowPrivate: readonly string[];
    readonly allowHttpHosts: readonly string[];
  };
}

async function harness(
  options: {
    readonly level?: LadderLevel;
    readonly localServer?: LocalServerFacade;
    readonly reasoningEffortAccepted?: boolean;
  } = {},
): Promise<Harness> {
  const server = await startFakeProviderServer({
    defaultModel: LOCAL_MODEL,
    ...(options.localServer === undefined ? {} : { localServer: options.localServer }),
  });
  onTestFinished(async () => {
    await server.close();
  });
  const baseUrl = server.openaiBaseUrl;
  const client = new OpenAI({ apiKey: 'local', baseURL: baseUrl, maxRetries: 0 });
  const deps: LocalAdapterDeps = {
    bindingFor: () => localBinding({ maxRetries: 0, attemptTimeoutMs: 5_000 }),
    clock: new SystemClock(),
    logger: silentLogger,
    baseUrl,
    serverKind: options.localServer?.kind ?? 'generic',
    level: options.level ?? 'L1',
    reasoningEffortAccepted: options.reasoningEffortAccepted ?? false,
    client,
  };
  const captured = (index = 0): CapturedRequest => {
    const request = server.requests()[index];
    if (request === undefined) throw new Error(`no request ${String(index)} reached the server`);
    return request;
  };
  return {
    server,
    baseUrl,
    deps,
    captured,
    body: (index = 0) => captured(index).body as Record<string, unknown>,
    // The host's own `host:port`, which is the mechanism for "I meant this loopback address".
    policy: { allowPrivate: [hostPortOf(baseUrl)], allowHttpHosts: [hostPortOf(baseUrl)] },
  };
}

describe('identifying each of the four servers (05 §3.5.6 step 1)', () => {
  for (const [name, facade] of Object.entries(SERVER_FIXTURES)) {
    it(`identifies ${name}`, async () => {
      const h = await harness({ localServer: facade });
      const identity = await identifyServer(
        { logger: silentLogger, policy: h.policy },
        h.baseUrl,
        AbortSignal.timeout(5_000),
      );
      expect(identity.kind).toBe(facade.kind);
    });
  }

  it('reports generic when nothing answers a recognised shape', async () => {
    // A server that serves only `/v1/chat/completions` is a real, supported configuration — which
    // is why the fake can be started without a facade at all.
    const h = await harness();
    const identity = await identifyServer(
      { logger: silentLogger, policy: h.policy },
      h.baseUrl,
      AbortSignal.timeout(5_000),
    );
    expect(identity).toEqual({ kind: 'generic' });
  });

  it('reads the context window llama.cpp and LM Studio volunteer', async () => {
    // `05` §3.5.6 lists these only as identification probes. Three of the four also report a
    // window, which is what lets the 16K needle be skipped and a host be warned before a turn runs.
    for (const facade of [SERVER_FIXTURES.llama_cpp, SERVER_FIXTURES.lmstudio]) {
      const h = await harness({ localServer: facade });
      const identity = await identifyServer(
        { logger: silentLogger, policy: h.policy },
        h.baseUrl,
        AbortSignal.timeout(5_000),
      );
      expect(identity.contextWindowHint, facade.kind).toBe(facade.contextWindow);
    }
  });

  it('refuses a loopback URL the host did not allowlist', async () => {
    // The reason these probes go through `safeFetch`: a typo in `models.local.baseUrl` must not
    // become an SSRF probe of the host's LAN. With an empty policy, loopback is denied.
    const h = await harness({ localServer: SERVER_FIXTURES.ollama });
    const identity = await identifyServer(
      { logger: silentLogger, policy: EMPTY_POLICY },
      h.baseUrl,
      AbortSignal.timeout(5_000),
    );
    // Every probe was blocked, so nothing was recognised — and no request reached the server.
    expect(identity).toEqual({ kind: 'generic' });
    expect(h.server.requests()).toHaveLength(0);
  });
});

describe('static hints (05 §3.5.6 step 2)', () => {
  it('reads Ollama’s capability list and architecture-prefixed context length', async () => {
    const facade = SERVER_FIXTURES.ollama;
    const h = await harness({ localServer: facade });
    const identity = await identifyServer(
      { logger: silentLogger, policy: h.policy },
      h.baseUrl,
      AbortSignal.timeout(5_000),
    );
    const hints = await staticHintsFor(
      { logger: silentLogger, policy: h.policy },
      identity,
      h.baseUrl,
      LOCAL_MODEL,
      AbortSignal.timeout(5_000),
    );
    expect(hints).toMatchObject({
      tools: true,
      thinking: true,
      vision: true,
      contextWindow: facade.contextWindow,
    });
  });

  it('asks no second question of the three servers that already answered', async () => {
    // llama.cpp and LM Studio reported their window during identification; re-asking would be a
    // round trip for data we hold.
    const facade = SERVER_FIXTURES.llama_cpp;
    const h = await harness({ localServer: facade });
    const identity = await identifyServer(
      { logger: silentLogger, policy: h.policy },
      h.baseUrl,
      AbortSignal.timeout(5_000),
    );
    const before = h.server.requests().length;
    const hints = await staticHintsFor(
      { logger: silentLogger, policy: h.policy },
      identity,
      h.baseUrl,
      LOCAL_MODEL,
      AbortSignal.timeout(5_000),
    );
    expect(h.server.requests()).toHaveLength(before);
    expect(hints.contextWindow).toBe(facade.contextWindow);
  });
});

describe('the probes measure rather than assume (05 §3.5.6 steps 3–4)', () => {
  /** A transport over the fake, so the probes send shapes the typed client would refuse. */
  function transport(h: Harness): LocalProbeTransport {
    return {
      chat: async (body, signal) => {
        const response = await fetch(`${h.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          throw new OpenAI.APIError(
            response.status,
            undefined,
            `fake refused with ${String(response.status)}`,
            undefined,
          );
        }
        return (await response.json()) as Record<string, unknown>;
      },
    };
  }

  it('reaches L1 when the server answers every probe', async () => {
    const h = await harness();
    h.server.script(
      // Tool probe: two correct calls, so parallel support is measured rather than assumed.
      {
        kind: 'reply',
        toolCalls: [
          { id: 'c1', name: 'probe_echo', input: { value: 'v1' } },
          { id: 'c2', name: 'probe_echo', input: { value: 'v1b' } },
        ],
      },
      // Schema probe.
      { kind: 'reply', text: '{"ok":true}' },
      // Effort probe.
      { kind: 'reply', text: 'ok' },
      // Needle probe: the passcode comes back.
      { kind: 'reply', text: 'v1-16000' },
    );

    const result = await runProbes(
      { logger: silentLogger, transport: transport(h), now: () => '2026-11-13T10:00:00.000Z' },
      { model: LOCAL_MODEL, baseUrl: h.baseUrl, serverKind: 'ollama' },
      AbortSignal.timeout(10_000),
    );

    expect(result).toMatchObject({
      level: 'L1',
      nativeTools: true,
      parallelTools: true,
      jsonSchema: true,
      jsonObject: true,
      reasoningEffort: true,
      truncates: false,
    });
    // Four probes, and the schema probe's second attempt was skipped because the first succeeded.
    expect(h.server.requests()).toHaveLength(4);
  });

  it('reads a 400 on the tools field as the answer, not as a failure', async () => {
    const h = await harness();
    h.server.script(
      { kind: 'server_error', status: 400 },
      { kind: 'reply', text: '{"ok":true}' },
      { kind: 'reply', text: 'ok' },
      { kind: 'reply', text: 'v1-16000' },
    );
    const logger = recordingLogger();
    const result = await runProbes(
      { logger: logger.logger, transport: transport(h), now: () => '2026-11-13T10:00:00.000Z' },
      { model: LOCAL_MODEL, baseUrl: h.baseUrl, serverKind: 'llama_cpp' },
      AbortSignal.timeout(10_000),
    );
    // A server that refuses `tools` is answering, so L2 — the envelope keeps every feature.
    expect(result).toMatchObject({ level: 'L2', nativeTools: false, jsonSchema: true });
    // At `debug`, because a failed probe is the expected case on three of four servers.
    expect(logger.lines().some((line) => line.event === 'model.local_probe')).toBe(true);
  });

  it('falls back to json_object and reaches L3', async () => {
    const h = await harness();
    h.server.script(
      { kind: 'server_error', status: 400 },
      // `json_schema` refused…
      { kind: 'server_error', status: 400 },
      // …and `json_object` accepted.
      { kind: 'reply', text: '{"ok":true}' },
      { kind: 'server_error', status: 400 },
      { kind: 'reply', text: 'v1-16000' },
    );
    const result = await runProbes(
      { logger: silentLogger, transport: transport(h), now: () => '2026-11-13T10:00:00.000Z' },
      { model: LOCAL_MODEL, baseUrl: h.baseUrl, serverKind: 'generic' },
      AbortSignal.timeout(10_000),
    );
    expect(result).toMatchObject({ level: 'L3', jsonSchema: false, jsonObject: true });
  });

  it('reaches L4 when neither tools nor JSON works', async () => {
    const h = await harness();
    h.server.script(
      { kind: 'server_error', status: 400 },
      { kind: 'server_error', status: 400 },
      { kind: 'server_error', status: 400 },
      { kind: 'server_error', status: 400 },
      { kind: 'reply', text: 'v1-16000' },
    );
    const result = await runProbes(
      { logger: silentLogger, transport: transport(h), now: () => '2026-11-13T10:00:00.000Z' },
      { model: LOCAL_MODEL, baseUrl: h.baseUrl, serverKind: 'generic' },
      AbortSignal.timeout(10_000),
    );
    expect(result.level).toBe('L4');
  });

  it('detects silent truncation, which produces no error at all', async () => {
    const h = await harness();
    h.server.script(
      { kind: 'reply', toolCalls: [{ id: 'c1', name: 'probe_echo', input: { value: 'v1' } }] },
      { kind: 'reply', text: '{"ok":true}' },
      { kind: 'reply', text: 'ok' },
      // The request succeeded and the answer is wrong: the front of the prompt was dropped. This
      // is the signature a group would experience as a bot that ignores its own instructions.
      { kind: 'reply', text: 'I do not recall a passcode.' },
    );
    const result = await runProbes(
      { logger: silentLogger, transport: transport(h), now: () => '2026-11-13T10:00:00.000Z' },
      { model: LOCAL_MODEL, baseUrl: h.baseUrl, serverKind: 'ollama' },
      AbortSignal.timeout(10_000),
    );
    expect(result.truncates).toBe(true);
    expect(result.contextWindowProven).toBeUndefined();
  });

  it('skips the needle when the server already said its window is too small', async () => {
    const h = await harness();
    h.server.script(
      { kind: 'reply', toolCalls: [{ id: 'c1', name: 'probe_echo', input: { value: 'v1' } }] },
      { kind: 'reply', text: '{"ok":true}' },
      { kind: 'reply', text: 'ok' },
    );
    const result = await runProbes(
      { logger: silentLogger, transport: transport(h), now: () => '2026-11-13T10:00:00.000Z' },
      { model: LOCAL_MODEL, baseUrl: h.baseUrl, serverKind: 'llama_cpp', contextWindowHint: 8_192 },
      AbortSignal.timeout(10_000),
    );
    expect(result.truncates).toBe(true);
    // Three requests, not four: spending 16K tokens to prove a server cannot hold 16K tokens
    // would cost a cold model load for an answer we already hold.
    expect(h.server.requests()).toHaveLength(3);
  });
});

describe('a turn at each level', () => {
  it('L1 sends native tools and reads native tool calls', async () => {
    const h = await harness({ level: 'L1' });
    h.server.script({
      kind: 'reply',
      toolCalls: [{ id: 'c1', name: 'reminder_create', input: { text: 'milk', at: 'tomorrow' } }],
    });
    const result = await runChat(
      h.deps,
      localTurnRequest({ tools: [localToolSpec()] }),
      AbortSignal.timeout(5_000),
    );
    expect(h.body()['tools']).toBeDefined();
    expect('tool_choice' in h.body()).toBe(false);
    expect(result.stop.reason).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      { id: 'c1', name: 'reminder_create', input: { text: 'milk', at: 'tomorrow' } },
    ]);
  });

  it('L2 sends no tools and reads the envelope', async () => {
    const h = await harness({ level: 'L2' });
    h.server.script({
      kind: 'reply',
      text: '{"reply":null,"tool_calls":[{"name":"reminder_create","input":{"text":"milk","at":"tomorrow"}}]}',
    });
    const result = await runChat(
      h.deps,
      localTurnRequest({ tools: [localToolSpec()] }),
      AbortSignal.timeout(5_000),
      {
        schemas: new Map([
          [
            'reminder_create',
            {
              safeParse: (input: unknown) => ({ success: true as const, data: input }),
            },
          ],
        ]),
      },
    );
    expect(h.body()['tools']).toBeUndefined();
    // The catalogue went into the system message as text.
    expect(JSON.stringify(h.body()['messages'])).toContain('reminder_create');
    expect(result.stop.reason).toBe('tool_use');
    expect(result.toolCalls[0]).toMatchObject({ id: 'env_0_0', name: 'reminder_create' });
  });

  it('L2 reports a malformed envelope as other, showing no JSON to the group', async () => {
    const h = await harness({ level: 'L2' });
    h.server.script({ kind: 'reply', text: 'I think I should create a reminder?' });
    const result = await runChat(
      h.deps,
      localTurnRequest({ tools: [localToolSpec()] }),
      AbortSignal.timeout(5_000),
    );
    expect(result.stop.raw).toBe('envelope_malformed');
    // Not the raw text: a group must not be shown a half-formed protocol message.
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([]);
  });

  it('L2 counts a rejected call as a transformation', async () => {
    const h = await harness({ level: 'L2' });
    h.server.script({
      kind: 'reply',
      text: '{"reply":null,"tool_calls":[{"name":"reminder_create","input":{"text":"milk"}}]}',
    });
    const result = await runChat(
      h.deps,
      localTurnRequest({ tools: [localToolSpec()] }),
      AbortSignal.timeout(5_000),
      {
        schemas: new Map([['reminder_create', { safeParse: () => ({ success: false as const }) }]]),
      },
    );
    expect(result.toolCalls).toEqual([]);
    expect(result.diagnostics.inputTransformations).toBeGreaterThan(0);
  });

  it('L4 refuses a turn that asked for tools, naming the copy key', async () => {
    const h = await harness({ level: 'L4' });
    await expect(
      runChat(h.deps, localTurnRequest({ tools: [localToolSpec()] }), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      detail: { type: 'local_no_tools.tools' },
    });
    // Refused before the request, so nothing was spent.
    expect(h.server.requests()).toHaveLength(0);
  });

  it('L4 still answers a chat turn with no tools', async () => {
    const h = await harness({ level: 'L4' });
    h.server.script({ kind: 'reply', text: 'Six people said yes.' });
    const result = await runChat(h.deps, localTurnRequest(), AbortSignal.timeout(5_000));
    expect(result.text).toBe('Six people said yes.');
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

  it('sends the schema in response_format and in the prompt', async () => {
    const h = await harness({ level: 'L2' });
    h.server.script({ kind: 'reply', text: '{"ok":true}' });
    await runStructured(h.deps, structuredRequest(), AbortSignal.timeout(5_000));
    const body = h.body();
    expect(JSON.stringify(body['response_format'])).toContain('json_schema');
    // Written out in the prompt as well: a 12B model given only a constraint produces valid JSON
    // of the wrong shape, and the shape in the prompt is what gets it right.
    expect(JSON.stringify(body['messages'])).toContain('must match this schema');
  });

  it('repairs once at L3 and not at L2', async () => {
    const atL3 = await harness({ level: 'L3' });
    atL3.server.script(
      { kind: 'reply', text: '{"nope":1}' },
      { kind: 'reply', text: '{"ok":true}' },
    );
    const repaired = await runStructured(
      atL3.deps,
      structuredRequest(),
      AbortSignal.timeout(5_000),
    );
    expect(repaired.kind).toBe('ok');
    expect(repaired.usage).toHaveLength(2);
    expect(JSON.stringify(atL3.body(1)['messages'])).toContain('invalid_output');

    const atL2 = await harness({ level: 'L2' });
    atL2.server.script({ kind: 'reply', text: '{"nope":1}' });
    const notRepaired = await runStructured(
      atL2.deps,
      structuredRequest(),
      AbortSignal.timeout(5_000),
    );
    // At L2 the schema already constrained the shape, so an invalid value is semantic and a
    // repair would not fix it — one request, not two.
    expect(notRepaired.kind).toBe('invalid');
    expect(atL2.server.requests()).toHaveLength(1);
  });

  it('refuses outright at L4', async () => {
    const h = await harness({ level: 'L4' });
    await expect(
      runStructured(h.deps, structuredRequest(), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ detail: { type: 'local_no_tools.structured' } });
    // An empty extraction reads as "nothing happened today" and an empty declassification as "no
    // constraints" — both the unsafe direction, so the call fails loudly.
    expect(h.server.requests()).toHaveLength(0);
  });
});

describe('the gateway', () => {
  it('reports the ladder’s capabilities, not the registry’s wildcard row', async () => {
    const native = createLocalGateway((await harness({ level: 'L1' })).deps);
    expect(native.routeInfo('chat').supports).toMatchObject({
      tools: 'native_strict',
      structured: 'native',
      parallelTools: true,
    });

    const envelope = createLocalGateway((await harness({ level: 'L3' })).deps);
    expect(envelope.routeInfo('chat').supports).toMatchObject({
      tools: 'envelope',
      structured: 'envelope',
      parallelTools: false,
    });

    const chatOnly = createLocalGateway((await harness({ level: 'L4' })).deps);
    // A caller asking `supports.tools` before building a catalogue must not be told `probe`.
    expect(chatOnly.routeInfo('chat').supports).toMatchObject({ structured: 'none' });
  });

  it('reports the host’s provider name and the adapter’s id, which differ only here', async () => {
    const gateway = createLocalGateway((await harness()).deps);
    const info = gateway.routeInfo('chat');
    // What the host wrote in `models.routes.chat: local/…`, and the key for `models.baseUrls.local`.
    expect(info.provider).toBe('local');
    // Which adapter speaks the protocol — the same string every error, span and metric from this
    // adapter carries. Before the M2 review the gateway reported only `provider`, and the
    // middleware used it as a `ProviderId` through an `as never` cast: this route's circuit
    // breaker, spans and metrics were filed under `local` while its failures said
    // `openai-compatible`, so the breaker counted one provider's failures under a name nothing
    // else used. The two must stay pinned together, which is what this asserts.
    expect(info.providerId).toBe(LOCAL_PROVIDER);
    expect(info.providerId).not.toBe(info.provider);
  });

  it('declares none of the members no local server offers', async () => {
    const gateway = createLocalGateway((await harness()).deps);
    expect(gateway.countTokens).toBeUndefined();
    expect(gateway.submitBatch).toBeUndefined();
    expect(gateway.batchResults).toBeUndefined();
  });

  it('builds a client without a key, because three of four servers need none', async () => {
    const h = await harness();
    const { client: _injected, ...withoutClient } = h.deps;
    // The `openai` SDK refuses to construct without a key, and sending a literal placeholder to a
    // loopback server is not a secret leak — the alternative is an adapter that cannot talk to
    // Ollama.
    const client = createLocalClient(withoutClient);
    expect(client.baseURL).toBe(h.baseUrl);
  });

  it('maps a server that is not running to a network failure', async () => {
    const h = await harness();
    h.server.script({ kind: 'socket_reset' });
    await expect(
      runChat(h.deps, localTurnRequest(), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('records the server and the level on a failure, with no prompt', async () => {
    const logger = recordingLogger();
    const h = await harness({ level: 'L2', localServer: SERVER_FIXTURES.ollama });
    h.server.script({ kind: 'server_error', status: 500 });
    await expect(
      runChat({ ...h.deps, logger: logger.logger }, localTurnRequest(), AbortSignal.timeout(5_000)),
    ).rejects.toThrow();
    const line = logger.lines().find((entry) => entry.event === 'model.call_failed');
    expect(JSON.stringify(line?.fields)).toContain('ollama');
    expect(JSON.stringify(line?.fields)).toContain('L2');
    expect(JSON.stringify(line?.fields)).not.toContain('hello');
  });
});
