/**
 * Model spans and metrics (`11` §3.10.2–§3.10.3; `M2-T15`).
 *
 * Three claims, in order of what they protect:
 *
 *  1. **No content, ever.** A test walks every attribute of every span this module can emit — the
 *     success path, the error path, structured, embeddings — and fails if any key falls in an
 *     opt-in content family. Checked by prefix, so a content attribute the GenAI registry adds
 *     after this was written is caught without anybody updating a list.
 *  2. **The span says what `11` §3.10.2 says it says.** Names, kinds and the attribute set, against
 *     an in-memory recorder. A dashboard built on a wrong attribute name is silently empty.
 *  3. **The numbers are right.** `gen_ai.usage.input_tokens` follows the Anthropic convention and
 *     *includes* cached tokens, while the four `model_tokens_total` series are disjoint and add up
 *     to the bill. Those two rules point in opposite directions and both are easy to get wrong.
 */
import { ModelCallError, type UsageIteration } from '@comvivo/core';
import {
  ATTR,
  FORBIDDEN_ATTRIBUTE_FAMILIES,
  GENAI,
  GENAI_OPT_IN_CONTENT_ATTRIBUTES,
  isForbiddenAttribute,
  mergeAttributes,
  noopMetrics,
  noopTracer,
  OTEL,
  type RecordedSpan,
  recordingMetrics,
  recordingTracer,
  SPAN_NS,
} from '@comvivo/shared/observability';
import { describe, expect, it } from 'vitest';
import { PRICES, pickTable } from './pricing/index.js';
import {
  costUsd,
  endpointAttributes,
  errorAttributes,
  type ModelSpanContext,
  outcomeOf,
  providerSpanName,
  recordModelMetrics,
  requestAttributes,
  resultAttributes,
  usageTotals,
  withEmbeddingsSpan,
  withModelSpan,
  withStructuredSpan,
} from './telemetry.js';

const TABLE = pickTable([PRICES], '2026-11-13');

const ITERATION: UsageIteration = {
  model: 'claude-opus-5-5',
  kind: 'message',
  input: 1_000,
  cacheRead: 4_000,
  cacheWrite5m: 500,
  cacheWrite1h: 0,
  output: 300,
  reasoning: 120,
  batch: false,
};

const CONTEXT: ModelSpanContext = {
  route: 'chat',
  provider: 'anthropic',
  requestedModel: 'claude-opus-5-5',
  effort: 'medium',
  maxOutputTokens: 4_096,
  stream: true,
  baseUrl: 'https://api.anthropic.com',
  outputType: 'text',
};

const RESULT = {
  assistant: {
    role: 'assistant' as const,
    provider: 'anthropic' as const,
    servedModel: 'claude-opus-5-5',
    raw: [],
    view: [],
  },
  stop: { reason: 'end_turn' as const, raw: 'end_turn' },
  // Content, deliberately: every scan below must find none of it on a span.
  text: 'Maria will collect Theo from the recital at 18:30.',
  toolCalls: [],
  usage: [ITERATION],
  model: {
    provider: 'anthropic' as const,
    requested: 'claude-opus-5-5',
    served: 'claude-opus-5-5',
  },
  latency: { ttftMs: 120, totalMs: 900 },
  diagnostics: { requestId: 'req_abc123', inputTransformations: 0, betas: [] },
};

describe('provider names (11 §3.10.2)', () => {
  it('spells each provider as the conventions do', () => {
    expect(providerSpanName('anthropic')).toBe('anthropic');
    expect(providerSpanName('openai')).toBe('openai');
    // The one with a dot. A span saying `google` would not match a GCP dashboard's filter.
    expect(providerSpanName('google')).toBe('gcp.gen_ai');
  });

  it('prefers a known local flavour over the generic compatible name', () => {
    expect(providerSpanName('openai-compatible')).toBe('openai-compatible');
    expect(providerSpanName('openai-compatible', 'ollama')).toBe('ollama');
    expect(providerSpanName('openai-compatible', 'vllm')).toBe('vllm');
  });

  it('ignores a flavour that is not a known local server', () => {
    // Otherwise a stray config value becomes a `gen_ai.provider.name` nobody can group by.
    expect(providerSpanName('anthropic', 'something-else')).toBe('anthropic');
  });

  it('never claims a real provider for the fake gateway', () => {
    // An eval run and a live run must be distinguishable in a trace view.
    expect(providerSpanName('fake')).toBe('fake');
  });

  it('passes an unknown configured provider through unchanged', () => {
    expect(providerSpanName('some-proxy')).toBe('some-proxy');
  });
});

describe('endpoint attributes', () => {
  it('fills in the default port for each scheme', () => {
    expect(endpointAttributes('https://api.anthropic.com')).toEqual({
      [OTEL.SERVER_ADDRESS]: 'api.anthropic.com',
      [OTEL.SERVER_PORT]: 443,
    });
    expect(endpointAttributes('http://localhost')).toEqual({
      [OTEL.SERVER_ADDRESS]: 'localhost',
      [OTEL.SERVER_PORT]: 80,
    });
  });

  it('keeps an explicit port', () => {
    expect(endpointAttributes('http://127.0.0.1:11434/v1')).toEqual({
      [OTEL.SERVER_ADDRESS]: '127.0.0.1',
      [OTEL.SERVER_PORT]: 11434,
    });
  });

  it('emits nothing rather than a guess when there is no usable URL', () => {
    expect(endpointAttributes(undefined)).toEqual({});
    expect(endpointAttributes('')).toEqual({});
    expect(endpointAttributes('not a url')).toEqual({});
  });

  it('carries no credentials from a URL that embeds them', () => {
    // A base URL with a token in it is a real configuration mistake, and `server.address` is the
    // attribute most likely to be copied into a ticket.
    const attributes = endpointAttributes('https://user:sk-secret@proxy.example:8443/v1');
    expect(attributes).toEqual({
      [OTEL.SERVER_ADDRESS]: 'proxy.example',
      [OTEL.SERVER_PORT]: 8443,
    });
    expect(JSON.stringify(attributes)).not.toContain('sk-secret');
  });
});

describe('usage totals (11 §3.10.2, the Anthropic convention)', () => {
  it('includes cached tokens in the convention input and reports the split separately', () => {
    const totals = usageTotals([ITERATION]);
    // 1000 uncached + 4000 read + 500 written. Reporting 1000 here would under-report a warm
    // prompt by the cache hit rate, which 11 §8 puts near 60% — wrong in the reassuring direction.
    expect(totals.input).toBe(5_500);
    expect(totals.cacheRead).toBe(4_000);
    expect(totals.cacheWrite).toBe(500);
    expect(totals.output).toBe(300);
    expect(totals.reasoning).toBe(120);
  });

  it('sums every billed iteration, so a fallback turn is not free', () => {
    const totals = usageTotals([ITERATION, { ...ITERATION, kind: 'fallback_message' }]);
    expect(totals.input).toBe(11_000);
    expect(totals.output).toBe(600);
  });

  it('treats a missing reasoning count as zero rather than NaN', () => {
    const { reasoning: _dropped, ...withoutReasoning } = ITERATION;
    expect(usageTotals([withoutReasoning]).reasoning).toBe(0);
  });
});

describe('the chat span (11 §3.10.2)', () => {
  async function run(): Promise<RecordedSpan> {
    const tracer = recordingTracer();
    await withModelSpan({ tracer, metrics: noopMetrics() }, CONTEXT, () => Promise.resolve(RESULT));
    const span = tracer.spans[0];
    if (span === undefined) throw new Error('no span was recorded');
    return span;
  }

  it('is named `{operation} {model}` and is a CLIENT span', async () => {
    const span = await run();
    expect(span.name).toBe('chat claude-opus-5-5');
    // CLIENT, not INTERNAL: the call leaves the process, and a reader uses the kind to tell a slow
    // network from a slow CPU.
    expect(span.kind).toBe('client');
    expect(span.ended).toBe(true);
    expect(span.status).toBe('ok');
  });

  it('carries every attribute 11 §3.10.2 lists for the inference span', async () => {
    const span = await run();
    expect(span.attributes).toMatchObject({
      [GENAI.OPERATION_NAME]: 'chat',
      [GENAI.PROVIDER_NAME]: 'anthropic',
      [GENAI.REQUEST_MODEL]: 'claude-opus-5-5',
      [GENAI.RESPONSE_MODEL]: 'claude-opus-5-5',
      [GENAI.RESPONSE_ID]: 'req_abc123',
      [GENAI.RESPONSE_FINISH_REASONS]: ['end_turn'],
      [GENAI.USAGE_INPUT_TOKENS]: 5_500,
      [GENAI.USAGE_OUTPUT_TOKENS]: 300,
      [GENAI.USAGE_CACHE_READ_INPUT_TOKENS]: 4_000,
      [GENAI.USAGE_CACHE_WRITE_INPUT_TOKENS]: 500,
      [GENAI.USAGE_REASONING_OUTPUT_TOKENS]: 120,
      [OTEL.SERVER_ADDRESS]: 'api.anthropic.com',
      [OTEL.SERVER_PORT]: 443,
      [ATTR.MODEL_ROUTE]: 'chat',
      [ATTR.MODEL_EFFORT]: 'medium',
    });
  });

  it('emits the brand-namespaced attributes at all', async () => {
    // A regression guard. These were unemittable until `M2-T15`: `BRAND.slug` was typed `string`,
    // so `ATTR.MODEL_ROUTE` was a `` `${string}.model.route` ``, a computed key of that type gave
    // the bag a `string` index signature, and an index signature can never satisfy
    // `Partial<Record<ForbiddenAttributeName, never>>`. The whole `ATTR` table typechecked and
    // nothing could put it on a span.
    const span = await run();
    expect(Object.keys(span.attributes).filter((key) => key.startsWith(SPAN_NS))).toEqual(
      expect.arrayContaining([ATTR.MODEL_ROUTE, ATTR.MODEL_EFFORT]),
    );
  });

  it('sets the request attributes before the call, so a hung call still describes itself', () => {
    const tracer = recordingTracer();
    // Never resolves. The span must already know its model and route.
    void withModelSpan({ tracer, metrics: noopMetrics() }, CONTEXT, () => new Promise(() => {}));
    expect(tracer.spans[0]?.attributes).toMatchObject({
      [GENAI.REQUEST_MODEL]: 'claude-opus-5-5',
      [GENAI.REQUEST_MAX_TOKENS]: 4_096,
      [GENAI.REQUEST_STREAM]: true,
      [GENAI.REQUEST_REASONING_LEVEL]: 'medium',
      [GENAI.OUTPUT_TYPE]: 'text',
      [ATTR.MODEL_ROUTE]: 'chat',
    });
  });

  it('omits the reasoning count when it is zero', () => {
    const { reasoning: _dropped, ...plain } = ITERATION;
    const attributes = resultAttributes({ ...RESULT, usage: [plain] });
    // A `reasoning.output_tokens=0` on every Haiku span is noise on a series that only matters
    // when it is large.
    expect(GENAI.USAGE_REASONING_OUTPUT_TOKENS in attributes).toBe(false);
  });

  it('omits the response id when the provider did not give one', () => {
    const attributes = resultAttributes({
      ...RESULT,
      diagnostics: { inputTransformations: 0, betas: [] },
    });
    expect(GENAI.RESPONSE_ID in attributes).toBe(false);
  });

  it('records the error kind and not its message', async () => {
    const tracer = recordingTracer();
    await expect(
      withModelSpan({ tracer, metrics: noopMetrics() }, CONTEXT, () =>
        Promise.reject(
          // The provider's own error type, which can carry a prompt fragment. It must not reach
          // the span: only the mapped `kind` does.
          new ModelCallError('rate_limited', 'anthropic', {
            type: 'quota exceeded for organisation acme about the recital',
          }),
        ),
      ),
    ).rejects.toThrow(ModelCallError);

    const span = tracer.spans[0];
    expect(span?.attributes[OTEL.ERROR_TYPE]).toBe('rate_limited');
    expect(span?.status).toBe('error');
    expect(span?.ended).toBe(true);
    expect(JSON.stringify(span?.attributes)).not.toContain('recital');
  });

  it('falls back to the error name for something that is not a ModelCallError', () => {
    expect(errorAttributes(new TypeError('boom'))).toEqual({ [OTEL.ERROR_TYPE]: 'TypeError' });
    expect(errorAttributes('a string')).toEqual({ [OTEL.ERROR_TYPE]: 'unknown' });
  });

  it('costs nothing when tracing is off', async () => {
    // The no-op tracer hands back a frozen singleton, so there is no span to inspect and no
    // allocation per call. A product that runs on a Pi 5 cannot pay for a feature nobody enabled.
    const result = await withModelSpan(
      { tracer: noopTracer(), metrics: noopMetrics() },
      CONTEXT,
      () => Promise.resolve(RESULT),
    );
    expect(result.text).toBe(RESULT.text);
  });
});

describe('the structured span', () => {
  it('stays a chat operation and declares a JSON output type', async () => {
    const tracer = recordingTracer();
    await withStructuredSpan(
      { tracer, metrics: noopMetrics() },
      { ...CONTEXT, route: 'extract', requestedModel: 'claude-haiku-5-5', stream: false },
      () => Promise.resolve({ kind: 'ok' as const, value: 1, usage: [ITERATION], model: 'm' }),
    );
    const span = tracer.spans[0];
    expect(span?.name).toBe('chat claude-haiku-5-5');
    expect(span?.attributes).toMatchObject({
      // The conventions have no separate structured operation; `gen_ai.output.type` is how they
      // say it.
      [GENAI.OPERATION_NAME]: 'chat',
      [GENAI.OUTPUT_TYPE]: 'json',
      [GENAI.REQUEST_STREAM]: false,
      [GENAI.RESPONSE_FINISH_REASONS]: ['ok'],
      [ATTR.MODEL_ROUTE]: 'extract',
    });
  });

  it('forces the JSON output type even if the caller said text', async () => {
    const tracer = recordingTracer();
    await withStructuredSpan({ tracer, metrics: noopMetrics() }, CONTEXT, () =>
      Promise.resolve({ kind: 'truncated' as const, usage: [], model: 'm' }),
    );
    expect(tracer.spans[0]?.attributes[GENAI.OUTPUT_TYPE]).toBe('json');
  });

  it('reports a non-ok structured kind as the outcome rather than hiding it', async () => {
    const metrics = recordingMetrics();
    await withStructuredSpan({ tracer: recordingTracer(), metrics }, CONTEXT, () =>
      Promise.resolve({
        kind: 'invalid' as const,
        issues: 'name: required',
        usage: [],
        model: 'm',
      }),
    );
    expect(metrics.of('model_requests_total')[0]?.labels['outcome']).toBe('invalid');
  });

  it('records the error kind when a structured call fails', async () => {
    const tracer = recordingTracer();
    const metrics = recordingMetrics();
    await expect(
      withStructuredSpan({ tracer, metrics, prices: TABLE }, CONTEXT, () =>
        Promise.reject(new ModelCallError('server', 'anthropic', { status: 500 })),
      ),
    ).rejects.toThrow(ModelCallError);
    expect(tracer.spans[0]?.attributes[OTEL.ERROR_TYPE]).toBe('server');
    expect(tracer.spans[0]?.status).toBe('error');
    expect(metrics.of('model_requests_total')[0]?.labels['outcome']).toBe('server');
  });

  it('carries no part of the extracted value', async () => {
    const tracer = recordingTracer();
    await withStructuredSpan({ tracer, metrics: noopMetrics() }, CONTEXT, () =>
      Promise.resolve({
        kind: 'ok' as const,
        value: { attendee: 'Maria', venue: 'the recital hall' },
        usage: [ITERATION],
        model: 'm',
      }),
    );
    const dumped = JSON.stringify(tracer.spans[0]?.attributes);
    expect(dumped).not.toContain('Maria');
    expect(dumped).not.toContain('recital');
  });
});

describe('the embeddings span (11 §3.10.2)', () => {
  it('is INTERNAL for a local model and reports the dimension from the result', async () => {
    const tracer = recordingTracer();
    await withEmbeddingsSpan(
      { tracer, metrics: noopMetrics() },
      { provider: 'fake', model: 'bge-small-en-v1.5', count: 3 },
      () => Promise.resolve([new Float32Array(384), new Float32Array(384), new Float32Array(384)]),
    );
    const span = tracer.spans[0];
    expect(span?.name).toBe('embeddings bge-small-en-v1.5');
    // INTERNAL: a local embedder makes no network call, and 400 ms here is a slow CPU.
    expect(span?.kind).toBe('internal');
    expect(span?.attributes).toMatchObject({
      [GENAI.OPERATION_NAME]: 'embeddings',
      [GENAI.REQUEST_MODEL]: 'bge-small-en-v1.5',
      [ATTR.EMBED_COUNT]: 3,
      [GENAI.EMBEDDINGS_DIMENSION_COUNT]: 384,
    });
  });

  it('is CLIENT when there is an endpoint', async () => {
    const tracer = recordingTracer();
    await withEmbeddingsSpan(
      { tracer, metrics: noopMetrics() },
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        count: 1,
        baseUrl: 'https://api.openai.com',
      },
      () => Promise.resolve([new Float32Array(1_536)]),
    );
    expect(tracer.spans[0]?.kind).toBe('client');
    expect(tracer.spans[0]?.attributes[OTEL.SERVER_ADDRESS]).toBe('api.openai.com');
  });

  it('omits the dimension rather than guessing when the batch was empty', async () => {
    const tracer = recordingTracer();
    await withEmbeddingsSpan(
      { tracer, metrics: noopMetrics() },
      { provider: 'fake', model: 'm', count: 0 },
      () => Promise.resolve([]),
    );
    expect(GENAI.EMBEDDINGS_DIMENSION_COUNT in (tracer.spans[0]?.attributes ?? {})).toBe(false);
  });
});

describe('model metrics (11 §3.10.3)', () => {
  const LABELS = { route: 'chat', provider: 'anthropic', model: 'claude-opus-5-5' };

  it('splits the four token series so they add up to the bill', async () => {
    const metrics = recordingMetrics();
    await withModelSpan({ tracer: recordingTracer(), metrics, prices: TABLE }, CONTEXT, () =>
      Promise.resolve(RESULT),
    );
    const byType = new Map(
      metrics.of('model_tokens_total').map((o) => [o.labels['type'], o.value] as const),
    );
    // Disjoint, unlike `gen_ai.usage.input_tokens`: `input` here is the **uncached remainder**, so
    // a dashboard summing the four series gets the prompt exactly once.
    expect(byType.get('input')).toBe(1_000);
    expect(byType.get('cache_read')).toBe(4_000);
    expect(byType.get('cache_write')).toBe(500);
    expect(byType.get('output')).toBe(300);
    const summed = [...byType.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBe(1_000 + 4_000 + 500 + 300);
  });

  it('records the request, its duration and its cost', async () => {
    const metrics = recordingMetrics();
    await withModelSpan({ tracer: recordingTracer(), metrics, prices: TABLE }, CONTEXT, () =>
      Promise.resolve(RESULT),
    );
    expect(metrics.of('model_requests_total')[0]).toMatchObject({
      labels: { ...LABELS, outcome: 'ok' },
      value: 1,
    });
    // The adapter's own measurement, in seconds: 900 ms.
    expect(metrics.of('model_request_duration_seconds')[0]?.value).toBeCloseTo(0.9, 6);
    const cost = metrics.of('model_cost_usd_total')[0];
    expect(cost?.value).toBeGreaterThan(0);
    expect(cost?.value).toBe(costUsd([ITERATION], TABLE));
  });

  it('uses our own provider id as the metric label, not the conventions spelling', async () => {
    // The span says `gcp.gen_ai` for portable tooling; a scrape is read beside `comvivo doctor`
    // and the costs screen, both of which say `google`.
    const metrics = recordingMetrics();
    await withModelSpan(
      { tracer: recordingTracer(), metrics, prices: TABLE },
      { ...CONTEXT, provider: 'google', requestedModel: 'gemini-3-pro' },
      () => Promise.resolve(RESULT),
    );
    expect(metrics.of('model_requests_total')[0]?.labels['provider']).toBe('google');
  });

  it('attaches a group label only when the host asked for one', () => {
    const withoutGroup = recordingMetrics();
    recordModelMetrics({ metrics: withoutGroup, prices: TABLE }, LABELS, {
      outcome: 'ok',
      durationSeconds: 1,
      usage: [ITERATION],
    });
    expect('group' in (withoutGroup.of('model_cost_usd_total')[0]?.labels ?? {})).toBe(false);

    const withGroup = recordingMetrics();
    recordModelMetrics({ metrics: withGroup, prices: TABLE, group: 'grp_1' }, LABELS, {
      outcome: 'ok',
      durationSeconds: 1,
      usage: [ITERATION],
    });
    expect(withGroup.of('model_cost_usd_total')[0]?.labels['group']).toBe('grp_1');
  });

  it('labels a failure with the error kind', async () => {
    const metrics = recordingMetrics();
    await expect(
      withModelSpan({ tracer: recordingTracer(), metrics, prices: TABLE }, CONTEXT, () =>
        Promise.reject(new ModelCallError('timeout', 'anthropic', {})),
      ),
    ).rejects.toThrow(ModelCallError);
    expect(metrics.of('model_requests_total')[0]?.labels['outcome']).toBe('timeout');
    // No tokens for a call that never answered.
    expect(metrics.of('model_tokens_total').every((o) => o.value === 0)).toBe(true);
  });

  it('declares no label the catalog does not know', async () => {
    // `recordingMetrics` throws on an undeclared or missing label, which is a bug Prometheus would
    // not report — it serves two different series under one name instead.
    const metrics = recordingMetrics();
    await withModelSpan({ tracer: recordingTracer(), metrics, prices: TABLE }, CONTEXT, () =>
      Promise.resolve(RESULT),
    );
    expect(metrics.seriesCount()).toMatchObject({ comvivo_model_requests_total: 1 });
  });

  it('does nothing at all when the metrics endpoint is off', async () => {
    // Not merely harmless — skipped. Pricing a call nobody will read is wasted work on a turn's
    // critical path.
    const result = await withModelSpan(
      { tracer: recordingTracer(), metrics: noopMetrics() },
      CONTEXT,
      () => Promise.resolve(RESULT),
    );
    expect(result.text).toBe(RESULT.text);
  });
});

describe('costing never breaks a call', () => {
  const unpriced: UsageIteration = { ...ITERATION, model: 'a-model-nobody-priced' };

  it('omits the cost metric rather than throwing when a model cannot be priced', () => {
    // `costIteration` throws when the table has no row and no fallback either, which is right for
    // a budget guard and wrong here: a gap in a graph beats a dropped reply.
    const brokenTable = { version: 'broken', models: {}, batchMultipliers: {} } as never;
    expect(costUsd([unpriced], brokenTable)).toBeUndefined();

    const metrics = recordingMetrics();
    recordModelMetrics(
      { metrics, prices: brokenTable },
      { route: 'chat', provider: 'anthropic', model: 'x' },
      {
        outcome: 'ok',
        durationSeconds: 1,
        usage: [unpriced],
      },
    );
    expect(metrics.of('model_cost_usd_total')).toHaveLength(0);
    // The token series still landed: the call happened and was billed, whatever we can price it at.
    expect(metrics.of('model_tokens_total')).toHaveLength(4);
  });

  it('still returns the reply when the metrics backend throws', async () => {
    const exploding = {
      counter: () => ({
        inc: () => {
          throw new Error('duplicate metric registration');
        },
      }),
      gauge: () => ({ set: () => {}, inc: () => {}, dec: () => {} }),
      histogram: () => ({ observe: () => {} }),
    } as never;
    const result = await withModelSpan(
      { tracer: recordingTracer(), metrics: exploding, prices: TABLE },
      CONTEXT,
      () => Promise.resolve(RESULT),
    );
    expect(result.text).toBe(RESULT.text);
  });

  it('prices every iteration of a multi-iteration call', () => {
    const one = costUsd([ITERATION], TABLE);
    const two = costUsd([ITERATION, ITERATION], TABLE);
    expect(one).toBeDefined();
    expect(two).toBeCloseTo((one ?? 0) * 2, 12);
  });
});

describe('the request outcome', () => {
  function stopped(reason: string): { readonly stop: { readonly reason: string } } {
    return { stop: { reason } };
  }

  it('maps every stop reason to a bounded outcome', () => {
    const outcomes = new Map(
      (
        [
          'end_turn',
          'tool_use',
          'pause_turn',
          'other',
          'max_tokens',
          'context_overflow',
          'refusal',
        ] as const
      ).map((reason) => [reason, outcomeOf({ ...RESULT, ...stopped(reason) } as never)] as const),
    );
    expect(outcomes.get('end_turn')).toBe('ok');
    expect(outcomes.get('tool_use')).toBe('ok');
    expect(outcomes.get('pause_turn')).toBe('ok');
    expect(outcomes.get('other')).toBe('ok');
    expect(outcomes.get('max_tokens')).toBe('truncated');
    expect(outcomes.get('context_overflow')).toBe('context_overflow');
    // A refusal is its own outcome: it is the one a host asks about, and folding it into `ok`
    // would make a model that declines everything look perfectly healthy.
    expect(outcomes.get('refusal')).toBe('refused');
    // Bounded: seven stop reasons collapse to four outcomes, which is what keeps the series count
    // inside 11 §8's budget once multiplied by route and model.
    expect(new Set(outcomes.values()).size).toBe(4);
  });
});

describe('no content attribute, ever (01 §11.7)', () => {
  /** Every span this module can emit, from every path. */
  async function everySpan(): Promise<readonly RecordedSpan[]> {
    const tracer = recordingTracer();
    const deps = { tracer, metrics: noopMetrics(), prices: TABLE };

    await withModelSpan(deps, CONTEXT, () => Promise.resolve(RESULT));
    await withModelSpan(deps, CONTEXT, () =>
      Promise.resolve({
        ...RESULT,
        stop: {
          reason: 'refusal' as const,
          raw: 'refusal',
          category: 'general_harms',
          explanation: 'declined to discuss the recital',
          servedByFallback: true,
        },
      }),
    );
    await withModelSpan(deps, CONTEXT, () =>
      Promise.reject(new ModelCallError('bad_request', 'anthropic', { type: 'about Maria' })),
    ).catch(() => undefined);
    await withStructuredSpan(deps, CONTEXT, () =>
      Promise.resolve({
        kind: 'ok' as const,
        value: { who: 'Maria', what: 'the recital' },
        usage: [ITERATION],
        model: 'm',
      }),
    );
    await withStructuredSpan(deps, CONTEXT, () =>
      Promise.resolve({
        kind: 'invalid' as const,
        issues: 'who: expected string',
        usage: [],
        model: 'm',
      }),
    );
    await withEmbeddingsSpan(deps, { provider: 'fake', model: 'bge', count: 2 }, () =>
      Promise.resolve([new Float32Array(8), new Float32Array(8)]),
    );
    return tracer.spans;
  }

  it('emits spans from every path, so the scan below is not scanning nothing', async () => {
    const spans = await everySpan();
    expect(spans).toHaveLength(6);
    expect(spans.every((span) => Object.keys(span.attributes).length > 0)).toBe(true);
  });

  it('sets no attribute in an opt-in content family', async () => {
    const spans = await everySpan();
    const keys = spans.flatMap((span) => Object.keys(span.attributes));
    const offenders = keys.filter((key) => isForbiddenAttribute(key));
    expect(offenders).toEqual([]);
    // Stated the other way round too, against the registry snapshot by exact name, so a reader can
    // see the 15 names this is about.
    for (const name of GENAI_OPT_IN_CONTENT_ATTRIBUTES) {
      expect(keys).not.toContain(name);
    }
  });

  it('is checked by family, so a content attribute added to the registry tomorrow is caught', async () => {
    const spans = await everySpan();
    const keys = spans.flatMap((span) => Object.keys(span.attributes));
    for (const family of FORBIDDEN_ATTRIBUTE_FAMILIES) {
      expect(keys.filter((key) => key.toLowerCase().startsWith(family.toLowerCase()))).toEqual([]);
    }
  });

  it('carries no message text, member name or error detail in any attribute value', async () => {
    const spans = await everySpan();
    const dumped = JSON.stringify(spans.map((span) => span.attributes));
    for (const leak of ['Maria', 'Theo', 'recital', '18:30', 'expected string', 'declined']) {
      expect(dumped).not.toContain(leak);
    }
  });

  it('refuses a content attribute at the type level', () => {
    // The compile-time layer, asserted here so the three layers are visible in one place.
    // @ts-expect-error -- `gen_ai.input.messages` is an opt-in content attribute.
    const refused: Parameters<typeof mergeAttributes>[0] = { 'gen_ai.input.messages': 'hello' };
    expect(refused).toBeDefined();
  });

  it('still drops a forbidden key assembled from unknown data', () => {
    // The runtime layer. `mergeAttributes` re-sanitizes, and under COMVIVO_TEST_MODE a forbidden
    // key throws rather than being quietly dropped — which is what makes the cast inside it safe.
    expect(() =>
      mergeAttributes({ [GENAI.REQUEST_MODEL]: 'm' }, JSON.parse('{"gen_ai.input.messages":"x"}')),
    ).toThrow(/forbidden/i);
  });

  it('merges request and response halves with the later half winning', () => {
    const merged = mergeAttributes(requestAttributes(CONTEXT), resultAttributes(RESULT));
    expect(merged[GENAI.REQUEST_MODEL]).toBe('claude-opus-5-5');
    expect(merged[GENAI.USAGE_INPUT_TOKENS]).toBe(5_500);
  });
});
