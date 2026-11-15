/**
 * Structured outputs, the repair, token counting, Batches and the beta probe (`05` §3.5.3.3,
 * §3.5.3.7–§3.5.3.9; `M2-T8`).
 *
 * The decisive assertions are the ones about **what the adapter must not do**: it must not parse a
 * refusal's partial text, must not parse a thinking block as JSON, must not repair twice, must not
 * send `fallbacks` on a structured route or a batch, and must not lose the first attempt's usage
 * when it repairs. Each of those is a quiet failure in production — a wrong extraction, a double
 * bill, a 400 for a whole night's batch — rather than something that shows up as an error.
 */
import Anthropic, { AuthenticationError, BadRequestError } from '@anthropic-ai/sdk';
import { ModelCallError, type StructuredRequest } from '@comvivo/core';
import { BRAND, SystemClock } from '@comvivo/shared';
import { silentLogger } from '@comvivo/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  type CapturedRequest,
  type FakeProviderServer,
  startFakeProviderServer,
} from '../testing/index.js';
import type { AnthropicAdapterDeps } from './adapter.js';
import {
  cancelAnthropicBatch,
  createAnthropicGateway,
  deleteAnthropicBatch,
  runStructured,
} from './adapter.js';
import { batchResults, CUSTOM_ID_PATTERN, customIdFor, pollBatch, submitBatch } from './batches.js';
import { probeBetas } from './betas.js';
import { calibrateEstimator, countTokens } from './count.js';
import { OPTIONAL_BETAS } from './request.js';
import {
  firstTextBlock,
  invalidOutputEvent,
  readStructured,
  summariseIssues,
} from './structured.js';
import { bindingFor, OPUS, turnRequest } from './testing/fixtures.js';

const ALL_BETAS = Object.values(OPTIONAL_BETAS) as Anthropic.AnthropicBeta[];
const SIGNAL = (): AbortSignal => AbortSignal.timeout(5_000);

/** A schema that accepts `{ language: string }` and nothing else. */
const LANGUAGE_SCHEMA = {
  safeParse: (input: unknown) =>
    typeof input === 'object' &&
    input !== null &&
    'language' in input &&
    typeof (input as { language: unknown }).language === 'string'
      ? ({ success: true, data: input as { language: string } } as const)
      : ({
          success: false,
          issues: [{ path: ['language'], message: 'expected a string' }],
        } as const),
};

function structuredRequest(
  overrides: Partial<StructuredRequest<{ language: string }>> = {},
): StructuredRequest<{ language: string }> {
  return {
    route: 'route',
    purpose: 'route.classify',
    system: [{ id: 'router', text: 'classify the language' }],
    input: [{ type: 'text', text: 'hola' }],
    schema: LANGUAGE_SCHEMA,
    jsonSchema: {
      type: 'object',
      properties: { language: { type: 'string' } },
      required: ['language'],
      additionalProperties: false,
    },
    schemaName: 'route_v1',
    effort: 'low',
    maxOutputTokens: 512,
    correlation: {},
    ...overrides,
  };
}

interface Harness {
  readonly server: FakeProviderServer;
  readonly deps: AnthropicAdapterDeps;
  readonly requests: () => readonly CapturedRequest[];
}

async function harness(): Promise<Harness> {
  const server = await startFakeProviderServer({ defaultModel: OPUS });
  onTestFinished(async () => {
    await server.close();
  });
  const client = new Anthropic({
    apiKey: 'sk-ant-not-a-real-key',
    baseURL: server.anthropicBaseUrl,
    maxRetries: 0,
  });
  return {
    server,
    deps: {
      bindingFor: () => bindingFor({ maxRetries: 0, attemptTimeoutMs: 5_000 }),
      availableBetas: ALL_BETAS,
      clock: new SystemClock(),
      logger: silentLogger,
      client,
    },
    requests: () => server.requests(),
  };
}

/** A non-streaming JSON body the SDK's `create()` accepts. */
function message(options: {
  readonly text?: string;
  readonly thinking?: string;
  readonly stop?: string;
  readonly refusal?: { category: string | null };
  readonly input?: number;
  readonly output?: number;
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (options.thinking !== undefined) {
    content.push({ type: 'thinking', thinking: options.thinking, signature: 'sig' });
  }
  if (options.text !== undefined) content.push({ type: 'text', text: options.text });
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: OPUS,
    content,
    stop_reason: options.stop ?? 'end_turn',
    stop_sequence: null,
    stop_details:
      options.refusal === undefined
        ? null
        : { type: 'refusal', category: options.refusal.category, explanation: null },
    usage: { input_tokens: options.input ?? 10, output_tokens: options.output ?? 4 },
  };
}

describe('reading a structured response (05 §3.5.3.3)', () => {
  it('skips leading thinking blocks to find the first text block', () => {
    expect(
      firstTextBlock({
        content: [
          { type: 'thinking', thinking: 'reasoning', signature: 's' },
          { type: 'text', text: '{"language":"es"}', citations: null },
        ],
      } as never),
    ).toBe('{"language":"es"}');
  });

  it('returns undefined when the first non-thinking block is not text', () => {
    // A structured request answered with a tool use has not produced JSON. Guessing would hide it.
    expect(
      firstTextBlock({
        content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }],
      } as never),
    ).toBeUndefined();
  });

  it('reads a refusal without parsing its partial text', () => {
    const attempt = readStructured(
      message({
        text: 'partial, declined',
        stop: 'refusal',
        refusal: { category: 'cyber' },
      }) as never,
      LANGUAGE_SCHEMA,
    );
    expect(attempt).toEqual({ kind: 'refused', category: 'cyber' });
  });

  it('distinguishes truncated from invalid', () => {
    // Collapsing these is how a caller retries a prompt that will never validate.
    expect(
      readStructured(message({ text: '{"lang', stop: 'max_tokens' }) as never, LANGUAGE_SCHEMA),
    ).toEqual({ kind: 'truncated' });
    expect(readStructured(message({ text: '{"lang' }) as never, LANGUAGE_SCHEMA).kind).toBe(
      'invalid',
    );
  });

  it('reports a schema mismatch as invalid, with the issues', () => {
    const attempt = readStructured(message({ text: '{"language":42}' }) as never, LANGUAGE_SCHEMA);
    expect(attempt.kind).toBe('invalid');
    expect(attempt.kind === 'invalid' ? attempt.issues : '').toContain(
      'language: expected a string',
    );
  });

  it('reports a response with no text block as invalid rather than throwing', () => {
    expect(readStructured(message({}) as never, LANGUAGE_SCHEMA)).toEqual({
      kind: 'invalid',
      issues: 'the response carried no text block to parse',
    });
  });

  it('bounds the issue summary, so it cannot crowd out the prompt', () => {
    const many = { issues: Array.from({ length: 200 }, () => ({ path: ['x'], message: 'bad' })) };
    expect(summariseIssues(many).length).toBeLessThanOrEqual(400);
  });
});

describe('the repair tag', () => {
  it('is derived from BRAND, not written out', () => {
    // A prompt tag is part of the cache prefix: hard-coding the codename would mean a rename
    // invalidated every cached prompt on every instance.
    expect(invalidOutputEvent('x')).toMatch(
      /^<[a-z0-9-]+_event kind="invalid_output" issues="x"\/>$/,
    );
  });

  it('escapes the issues, so a schema path cannot break the tag', () => {
    // Built from `BRAND`, like the tag itself: a literal here would be a second place a rename
    // has to touch, which is what `13` §3.A.6's guard exists to prevent.
    expect(invalidOutputEvent('a "quoted" <path> & more')).toBe(
      `<${BRAND.slug}_event kind="invalid_output" issues="a &quot;quoted&quot; &lt;path> &amp; more"/>`,
    );
  });
});

describe('runStructured over a socket', () => {
  it('returns a validated value and sends the schema as a format', async () => {
    const h = await harness();
    h.server.script({ kind: 'raw', body: message({ text: '{"language":"es"}' }) });
    const result = await runStructured(h.deps, structuredRequest(), SIGNAL());
    expect(result).toMatchObject({ kind: 'ok', value: { language: 'es' } });

    const sent = h.requests()[0]?.body as Record<string, unknown>;
    const output = sent['output_config'] as Record<string, unknown>;
    expect(output['effort']).toBe('low');
    expect(output['format']).toMatchObject({ type: 'json_schema' });
  });

  it('sends no tools and no fallbacks on a structured route', async () => {
    const h = await harness();
    h.server.script({ kind: 'raw', body: message({ text: '{"language":"es"}' }) });
    await runStructured(h.deps, structuredRequest(), SIGNAL());
    const sent = h.requests()[0]?.body as Record<string, unknown>;
    // A structured route asks for one JSON value; a tool catalogue would sit in the cache prefix
    // for no benefit. `fallbacks` is rejected on the models these routes run on.
    expect('tools' in sent).toBe(false);
    expect('tool_choice' in sent).toBe(false);
    expect('fallbacks' in sent).toBe(false);
    expect(h.requests()[0]?.headers['anthropic-beta'] ?? '').not.toContain(
      OPTIONAL_BETAS.serverFallback,
    );
  });

  it('repairs once, attaching the issues, and bills both attempts', async () => {
    const h = await harness();
    h.server.script(
      { kind: 'raw', body: message({ text: '{"language":42}', input: 10, output: 4 }) },
      { kind: 'raw', body: message({ text: '{"language":"es"}', input: 12, output: 5 }) },
    );
    const result = await runStructured(h.deps, structuredRequest(), SIGNAL());
    expect(result.kind).toBe('ok');
    // A failed call is a billed call (`02` §3.3.7): both attempts are in the ledger.
    expect(result.usage).toHaveLength(2);
    expect(result.usage.map((u) => u.output)).toEqual([4, 5]);

    const repair = h.requests()[1]?.body as Record<string, unknown>;
    const messages = repair['messages'] as Record<string, unknown>[];
    // The model's own answer goes back unchanged, then the issues.
    expect(messages).toHaveLength(3);
    expect(messages[1]?.['role']).toBe('assistant');
    expect(JSON.stringify(messages[2])).toContain('invalid_output');
  });

  it('repairs at most once, then reports invalid', async () => {
    const h = await harness();
    h.server.script(
      { kind: 'raw', body: message({ text: '{"language":42}' }) },
      { kind: 'raw', body: message({ text: '{"language":43}' }) },
    );
    const result = await runStructured(h.deps, structuredRequest(), SIGNAL());
    expect(result.kind).toBe('invalid');
    // Two requests, not three: a second repair has a vanishing success rate and a turn has a
    // deadline.
    expect(h.requests()).toHaveLength(2);
  });

  it('does not repair a refusal or a truncation', async () => {
    const refused = await harness();
    refused.server.script({
      kind: 'raw',
      body: message({ text: 'no', stop: 'refusal', refusal: { category: null } }),
    });
    expect((await runStructured(refused.deps, structuredRequest(), SIGNAL())).kind).toBe('refused');
    expect(refused.requests()).toHaveLength(1);

    const truncated = await harness();
    truncated.server.script({ kind: 'raw', body: message({ text: '{"lang', stop: 'max_tokens' }) });
    expect((await runStructured(truncated.deps, structuredRequest(), SIGNAL())).kind).toBe(
      'truncated',
    );
    expect(truncated.requests()).toHaveLength(1);
  });

  it('maps a provider failure to a ModelCallError', async () => {
    const h = await harness();
    h.server.script({ kind: 'overloaded' });
    await expect(runStructured(h.deps, structuredRequest(), SIGNAL())).rejects.toBeInstanceOf(
      ModelCallError,
    );
  });

  it('refuses a non-object output schema at build time', async () => {
    const h = await harness();
    await expect(
      runStructured(
        h.deps,
        structuredRequest({ jsonSchema: { type: 'array' } as never }),
        SIGNAL(),
      ),
    ).rejects.toThrow(/non-object output schema/);
  });
});

describe('countTokens (05 §3.5.3.8)', () => {
  it('counts through the same builder the real call uses', async () => {
    const h = await harness();
    h.server.script({ kind: 'raw', body: { input_tokens: 1234, context_management: null } });
    const counted = await countTokens(
      {
        client: h.deps.client as Anthropic,
        bindingFor: () => bindingFor(),
        availableBetas: ALL_BETAS,
      },
      turnRequest(),
      SIGNAL(),
    );
    expect(counted).toBe(1234);
    const sent = h.requests()[0]?.body as Record<string, unknown>;
    expect(h.requests()[0]?.path).toBe('/v1/messages/count_tokens');
    // The fields that have no meaning for a count are dropped rather than rejected by the API.
    expect('max_tokens' in sent).toBe(false);
    expect('output_config' in sent).toBe(false);
    expect('fallbacks' in sent).toBe(false);
  });
});

describe('countTokens with a minimal request', () => {
  it('omits system, tools, tool_choice and betas when there are none', async () => {
    const h = await harness();
    h.server.script({ kind: 'raw', body: { input_tokens: 7, context_management: null } });
    const counted = await countTokens(
      { client: h.deps.client as Anthropic, bindingFor: () => bindingFor(), availableBetas: [] },
      turnRequest({ system: [], tools: [] }),
      SIGNAL(),
    );
    expect(counted).toBe(7);
    const sent = h.requests()[0]?.body as Record<string, unknown>;
    // Absent, not empty: an empty `tools` array and an absent one are different requests, and the
    // count has to be of the request that would actually be sent.
    for (const key of ['tools', 'tool_choice', 'betas']) {
      expect(key in sent, key).toBe(false);
    }
    expect(sent['system']).toEqual([]);
  });
});

describe('batch custom ids (05 §3.5.3.7)', () => {
  it('builds an id the API accepts', () => {
    expect(customIdFor('job_abc', 3)).toBe('job_abc_3');
    expect(CUSTOM_ID_PATTERN.test(customIdFor('job_abc', 3))).toBe(true);
  });

  it('refuses an id the API would', () => {
    expect(() => customIdFor('a'.repeat(80), 1)).toThrow(/not a usable batch custom_id/);
  });

  it('refuses a duplicate id, which would make the results unkeyable', async () => {
    const h = await harness();
    const request = { ...structuredRequest(), customId: 'same' };
    await expect(
      submitBatch(
        {
          client: h.deps.client as Anthropic,
          bindingFor: () => bindingFor(),
          availableBetas: ALL_BETAS,
        },
        [request, request],
        SIGNAL(),
      ),
    ).rejects.toThrow(/appears twice/);
  });

  it('refuses an empty batch', async () => {
    const h = await harness();
    await expect(
      submitBatch(
        {
          client: h.deps.client as Anthropic,
          bindingFor: () => bindingFor(),
          availableBetas: ALL_BETAS,
        },
        [],
        SIGNAL(),
      ),
    ).rejects.toThrow(/at least one request/);
  });
});

describe('the beta probe (05 §3.5.3.9)', () => {
  /** A client whose every request is answered by a function of the beta header. */
  function probingClient(accepts: (betas: readonly string[]) => boolean): {
    readonly client: Anthropic;
    readonly calls: readonly string[][];
  } {
    const calls: string[][] = [];
    const client = {
      beta: {
        messages: {
          create: (params: { betas?: string[] }) => {
            const betas = params.betas ?? [];
            calls.push([...betas]);
            if (accepts(betas)) return Promise.resolve({ id: 'msg_probe' });
            return Promise.reject(
              new BadRequestError(
                400,
                { type: 'error', error: { type: 'invalid_request_error', message: 'no' } },
                'no',
                new Headers(),
              ),
            );
          },
        },
      },
    } as unknown as Anthropic;
    return { client, calls };
  }

  it('returns every beta when they are all accepted, in one request', async () => {
    const { client, calls } = probingClient(() => true);
    const result = await probeBetas({ client }, OPUS, ALL_BETAS, SIGNAL());
    expect(result.available).toEqual(ALL_BETAS);
    expect(result.unavailable).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('bisects to the one beta an organisation lacks', async () => {
    const missing = OPTIONAL_BETAS.thinkingBinding;
    const { client, calls } = probingClient((betas) => !betas.includes(missing));
    const warned: string[] = [];
    const result = await probeBetas(
      { client, onUnavailable: (beta) => warned.push(beta) },
      OPUS,
      ALL_BETAS,
      SIGNAL(),
    );
    expect(result.unavailable).toEqual([missing]);
    expect(result.available).toEqual(ALL_BETAS.filter((beta) => beta !== missing));
    expect(warned).toEqual([missing]);
    // Bounded, not "faster than linear": at this list size a group test costs about as much as
    // probing one at a time, and the reason to prefer it is that the result is complete. The bound
    // is what keeps a boot from paying for a pathological search.
    expect(calls.length).toBeLessThanOrEqual(2 * ALL_BETAS.length);
  });

  it('finds two unavailable betas', async () => {
    const a = OPTIONAL_BETAS.serverFallback;
    const b = OPTIONAL_BETAS.turnScopedSystem;
    const { client } = probingClient((betas) => !betas.includes(a) && !betas.includes(b));
    const result = await probeBetas({ client }, OPUS, ALL_BETAS, SIGNAL());
    expect([...result.unavailable].sort()).toEqual([a, b].sort());
  });

  it('degrades rather than throwing, so a boot never fails on a missing beta', async () => {
    const { client } = probingClient((betas) => betas.length === 0);
    const result = await probeBetas({ client }, OPUS, ALL_BETAS, SIGNAL());
    expect(result.available).toEqual([]);
    expect(result.unavailable).toEqual(ALL_BETAS);
  });

  it('throws when even a bare request is refused, rather than blaming the headers', async () => {
    // Reporting five unavailable betas for a bad model id would send the host looking in the
    // wrong place.
    const { client } = probingClient(() => false);
    await expect(probeBetas({ client }, 'nonexistent-model', ALL_BETAS, SIGNAL())).rejects.toThrow(
      /refused even with no beta headers/,
    );
  });

  it('rethrows a non-400, because the probe is not a connectivity check', async () => {
    const client = {
      beta: {
        messages: {
          create: () =>
            Promise.reject(
              new AuthenticationError(
                401,
                { type: 'error', error: { type: 'authentication_error', message: 'no' } },
                'no',
                new Headers(),
              ),
            ),
        },
      },
    } as unknown as Anthropic;
    // Swallowing a 401 here would turn "your key is wrong" into "no betas available" at boot.
    await expect(probeBetas({ client }, OPUS, ALL_BETAS, SIGNAL())).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('makes no request when nothing is wanted', async () => {
    const { client, calls } = probingClient(() => true);
    const result = await probeBetas({ client }, OPUS, [], SIGNAL());
    expect(result).toMatchObject({ available: [], unavailable: [], requests: 0 });
    expect(calls).toEqual([]);
  });
});

describe('the gateway’s optional members', () => {
  it('exposes countTokens, submitBatch, pollBatch and batchResults', async () => {
    const h = await harness();
    const gateway = createAnthropicGateway(h.deps);
    expect(typeof gateway.countTokens).toBe('function');
    expect(typeof gateway.submitBatch).toBe('function');
    expect(typeof gateway.pollBatch).toBe('function');
    expect(typeof gateway.batchResults).toBe('function');
  });

  it('still refuses embed, which belongs to 04’s embedding model', async () => {
    const h = await harness();
    const gateway = createAnthropicGateway(h.deps);
    try {
      void gateway.embed(['x'], 'query');
      expect.unreachable('embed should refuse');
    } catch (error) {
      expect((error as ModelCallError).detail.type).toContain('M4-T20');
    }
  });
});

/** A batch envelope the SDK accepts, with the counts a test wants to assert on. */
function batchBody(
  options: {
    readonly status?: 'in_progress' | 'canceling' | 'ended';
    readonly counts?: Partial<
      Record<'succeeded' | 'errored' | 'canceled' | 'expired' | 'processing', number>
    >;
  } = {},
): Record<string, unknown> {
  return {
    id: 'msgbatch_1',
    type: 'message_batch',
    processing_status: options.status ?? 'in_progress',
    created_at: '2026-11-13T00:00:00Z',
    expires_at: '2026-11-14T00:00:00Z',
    ended_at: null,
    cancel_initiated_at: null,
    archived_at: null,
    results_url: null,
    request_counts: {
      succeeded: 0,
      errored: 0,
      canceled: 0,
      expired: 0,
      processing: 0,
      ...options.counts,
    },
  };
}

/**
 * Script a results read.
 *
 * The SDK's `results()` makes **two** requests: it retrieves the batch to learn `results_url`, then
 * fetches that URL as JSONL. A test that scripted only the JSONL got
 * "No batch `results_url`; Has it finished processing?" — which is the SDK being right and worth
 * reproducing, because a caller that reads results before a batch has ended gets the same message.
 */
function scriptResults(h: Harness, lines: readonly unknown[]): void {
  h.server.script(
    {
      kind: 'raw',
      body: {
        ...batchBody({ status: 'ended', counts: { succeeded: lines.length } }),
        results_url: `${h.server.anthropicBaseUrl}/v1/messages/batches/msgbatch_1/results`,
      },
    },
    { kind: 'jsonl', lines },
  );
}

function batchDepsFor(h: Harness): Parameters<typeof submitBatch>[0] {
  return {
    client: h.deps.client as Anthropic,
    bindingFor: () => bindingFor(),
    availableBetas: ALL_BETAS,
  };
}

describe('the batch lifecycle (05 §3.5.3.7)', () => {
  it('submits, keyed by custom_id, with no fallbacks on any item', async () => {
    const h = await harness();
    h.server.script({ kind: 'raw', body: batchBody({ counts: { processing: 2 } }) });
    const handle = await submitBatch(
      batchDepsFor(h),
      [
        { ...structuredRequest(), customId: customIdFor('job_a', 0) },
        { ...structuredRequest(), customId: customIdFor('job_a', 1) },
      ],
      SIGNAL(),
    );
    expect(handle).toMatchObject({
      provider: 'anthropic',
      batchId: 'msgbatch_1',
      customIds: ['job_a_0', 'job_a_1'],
      submittedAt: '2026-11-13T00:00:00Z',
    });

    const sent = h.requests()[0]?.body as { requests: Record<string, unknown>[] };
    expect(sent.requests.map((request) => request['custom_id'])).toEqual(['job_a_0', 'job_a_1']);
    for (const request of sent.requests) {
      const params = request['params'] as Record<string, unknown>;
      // `fallbacks` is rejected on Batches — for the whole batch, not for one item.
      expect('fallbacks' in params).toBe(false);
      expect('betas' in params).toBe(false);
      expect(params['output_config']).toMatchObject({ format: { type: 'json_schema' } });
    }
  });

  it('polls, returning the state and the counts for the trace', async () => {
    const h = await harness();
    h.server.script({
      kind: 'raw',
      body: batchBody({ status: 'ended', counts: { succeeded: 3, errored: 1 } }),
    });
    const status = await pollBatch(
      batchDepsFor(h),
      { provider: 'anthropic', batchId: 'msgbatch_1', customIds: [], submittedAt: 'x' },
      SIGNAL(),
    );
    expect(status.state).toBe('ended');
    expect(status.counts).toMatchObject({ succeeded: 3, errored: 1 });
  });

  it('streams results keyed by custom_id, in whatever order they arrive', async () => {
    const h = await harness();
    // Deliberately out of submission order: reading positionally works with one item and fails the
    // first night with two.
    scriptResults(h, [
      {
        custom_id: 'job_a_1',
        result: { type: 'succeeded', message: message({ text: '{"language":"fr"}' }) },
      },
      {
        custom_id: 'job_a_0',
        result: { type: 'succeeded', message: message({ text: '{"language":"es"}' }) },
      },
    ]);
    const requests = new Map([
      ['job_a_0', structuredRequest()],
      ['job_a_1', structuredRequest()],
    ]);
    const items: { id: string; language: string }[] = [];
    for await (const item of batchResults(
      batchDepsFor(h),
      {
        provider: 'anthropic',
        batchId: 'msgbatch_1',
        customIds: [...requests.keys()],
        submittedAt: 'x',
      },
      (customId) => requests.get(customId),
      SIGNAL(),
    )) {
      const result = item.result;
      if (result?.kind === 'ok') {
        items.push({
          id: item.customId,
          language: (result.value as { language: string }).language,
        });
      }
    }
    expect(items).toEqual([
      { id: 'job_a_1', language: 'fr' },
      { id: 'job_a_0', language: 'es' },
    ]);
  });

  it('marks every batched iteration as batched, which is what the 50% multiplier reads', async () => {
    const h = await harness();
    scriptResults(h, [
      {
        custom_id: 'job_a_0',
        result: { type: 'succeeded', message: message({ text: '{"language":"es"}' }) },
      },
    ]);
    const items = [];
    for await (const item of batchResults(
      batchDepsFor(h),
      { provider: 'anthropic', batchId: 'msgbatch_1', customIds: ['job_a_0'], submittedAt: 'x' },
      () => structuredRequest(),
      SIGNAL(),
    )) {
      items.push(item);
    }
    expect(items[0]?.result?.usage.every((usage) => usage.batch)).toBe(true);
  });

  it('separates a permanent failure from one worth resubmitting', async () => {
    const h = await harness();
    scriptResults(h, [
      {
        custom_id: 'bad_request',
        result: {
          type: 'errored',
          error: { type: 'error', error: { type: 'invalid_request_error', message: 'no' } },
        },
      },
      {
        custom_id: 'overloaded',
        result: {
          type: 'errored',
          error: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
        },
      },
      { custom_id: 'expired', result: { type: 'expired' } },
      { custom_id: 'canceled', result: { type: 'canceled' } },
    ]);
    const failures = new Map<string, string>();
    for await (const item of batchResults(
      batchDepsFor(h),
      { provider: 'anthropic', batchId: 'msgbatch_1', customIds: [], submittedAt: 'x' },
      () => structuredRequest(),
      SIGNAL(),
    )) {
      if (item.failure !== undefined) failures.set(item.customId, item.failure.kind);
    }
    // `05` §3.5.3.7: an `invalid_request` will never succeed, so it is dropped and traced;
    // everything else is resubmitted once in the next window.
    expect(Object.fromEntries(failures)).toEqual({
      bad_request: 'invalid_request',
      overloaded: 'retryable',
      expired: 'retryable',
      canceled: 'canceled',
    });
  });

  it('reports a result for an id nobody submitted, rather than abandoning the rest', async () => {
    const h = await harness();
    scriptResults(h, [
      {
        custom_id: 'stranger',
        result: { type: 'succeeded', message: message({ text: '{"language":"es"}' }) },
      },
    ]);
    const items = [];
    for await (const item of batchResults(
      batchDepsFor(h),
      { provider: 'anthropic', batchId: 'msgbatch_1', customIds: [], submittedAt: 'x' },
      () => undefined,
      SIGNAL(),
    )) {
      items.push(item);
    }
    // One unexpected id must not abandon a whole night's output.
    expect(items[0]?.failure).toEqual({
      kind: 'invalid_request',
      detail: 'no pending request for this custom_id',
    });
  });

  it('validates a batched result against the schema, like a synchronous one', async () => {
    const h = await harness();
    scriptResults(h, [
      {
        custom_id: 'job_a_0',
        result: { type: 'succeeded', message: message({ text: '{"language":42}' }) },
      },
    ]);
    const items = [];
    for await (const item of batchResults(
      batchDepsFor(h),
      { provider: 'anthropic', batchId: 'msgbatch_1', customIds: ['job_a_0'], submittedAt: 'x' },
      () => structuredRequest(),
      SIGNAL(),
    )) {
      items.push(item);
    }
    // No repair in a batch: there is nothing to re-ask until the next window.
    expect(items[0]?.result?.kind).toBe('invalid');
  });

  it('cancels a batch that outran its window', async () => {
    const h = await harness();
    h.server.script({ kind: 'raw', body: batchBody({ status: 'canceling' }) });
    const status = await cancelAnthropicBatch(
      h.deps,
      { provider: 'anthropic', batchId: 'msgbatch_1', customIds: [], submittedAt: 'x' },
      SIGNAL(),
    );
    expect(status.state).toBe('canceling');
    expect(h.requests()[0]?.path).toContain('/cancel');
  });

  it('deletes stored results, which is the privacy half of useBatches', async () => {
    const h = await harness();
    h.server.script({ kind: 'raw', body: { id: 'msgbatch_1', type: 'message_batch_deleted' } });
    await deleteAnthropicBatch(
      h.deps,
      { provider: 'anthropic', batchId: 'msgbatch_1', customIds: [], submittedAt: 'x' },
      SIGNAL(),
    );
    // Results are retained by the provider for 29 days; a host who batches need not leave them.
    expect(h.requests()[0]?.method).toBe('DELETE');
  });
});

describe('calibrateEstimator (05 §3.5.3.8)', () => {
  it('derives characters per token from a synthetic corpus', async () => {
    const h = await harness();
    h.server.script({ kind: 'raw', body: { input_tokens: 10, context_management: null } });
    const calibration = await calibrateEstimator(
      {
        client: h.deps.client as Anthropic,
        bindingFor: () => bindingFor(),
        availableBetas: ALL_BETAS,
      },
      ['abcd', 'efgh', 'ij'],
      turnRequest(),
      SIGNAL(),
    );
    // 'abcd\nefgh\nij' is 12 characters; 10 tokens gives 1.2 characters per token.
    expect(calibration.chars).toBe(12);
    expect(calibration.tokens).toBe(10);
    expect(calibration.charsPerToken).toBeCloseTo(1.2, 5);
    expect(calibration.model).toBe(OPUS);
  });

  it('reports zero rather than infinity when a provider says zero tokens', async () => {
    const h = await harness();
    h.server.script({ kind: 'raw', body: { input_tokens: 0, context_management: null } });
    const calibration = await calibrateEstimator(
      {
        client: h.deps.client as Anthropic,
        bindingFor: () => bindingFor(),
        availableBetas: ALL_BETAS,
      },
      ['abc'],
      turnRequest(),
      SIGNAL(),
    );
    // An infinite ratio would make the estimator report every prompt as free.
    expect(calibration.charsPerToken).toBe(0);
  });

  it('sends no group data: the corpus is the only text in the request', async () => {
    const h = await harness();
    h.server.script({ kind: 'raw', body: { input_tokens: 5, context_management: null } });
    await calibrateEstimator(
      {
        client: h.deps.client as Anthropic,
        bindingFor: () => bindingFor(),
        availableBetas: ALL_BETAS,
      },
      ['synthetic corpus'],
      turnRequest({ system: [{ id: 'charter', text: 'a real charter' }] }),
      SIGNAL(),
    );
    const sent = JSON.stringify(h.requests()[0]?.body);
    expect(sent).toContain('synthetic corpus');
    // The system prompt is dropped: `05` §3.5.3.8 says group data is never sent to count_tokens.
    expect(sent).not.toContain('a real charter');
  });
});
