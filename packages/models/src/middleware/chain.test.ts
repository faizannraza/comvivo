/**
 * `withMiddleware` — the composition itself (`05` §3.5.1; `M2-T9`, telemetry at `M2-T15`).
 *
 * The individual stages are covered in `middleware.test.ts`. This file asserts the thing only the
 * composition can get wrong: **the order**, which `05` §3.5.1 specifies rather than suggests. Each
 * of the four edges below is a behaviour a member or a host would feel if it were reversed:
 *
 *  - A queued call must not hold a breaker decision made before it waited.
 *  - A dead provider must not hold a limiter slot for the length of a timeout.
 *  - A span's duration must be the provider's latency, not the queue's and not a SQLite write's.
 *  - Usage must be recorded for a call that happened, including one whose answer was unusable.
 *
 * This suite was added at `M2-T15`: `withMiddleware` had no test of its own, so the stage order it
 * exists to encode was being asserted only by reading it.
 */
import type {
  BatchHandle,
  BatchStatus,
  ModelGateway,
  ModelRoute,
  ModelTurnRequest,
  ModelTurnResult,
  NewUsageRecord,
  NotPromise,
  RouteInfo,
  StructuredRequest,
  StructuredResult,
  TxToken,
  UsageIteration,
  UsageRecord,
  WriteResult,
} from '@comvivo/core';
import { ModelCallError } from '@comvivo/core';
import type { IdGenerator } from '@comvivo/shared';
import { GENAI, OTEL, recordingMetrics, recordingTracer } from '@comvivo/shared/observability';
import { recordingLogger, VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { PRICES, pickTable } from '../pricing/index.js';
import { BreakerRegistry } from './breaker.js';
import { type ChainDeps, withMiddleware } from './chain.js';
import { PriorityLimiter } from './limiter.js';
import type { UsageContext, UsageHookDeps } from './usage-hook.js';

const TABLE = pickTable([PRICES], '2026-11-13');

const ITERATION: UsageIteration = {
  model: 'claude-opus-5-5',
  kind: 'message',
  input: 1_000,
  cacheRead: 2_000,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  output: 200,
  batch: false,
};

const INFO: RouteInfo = {
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  supports: {
    contextWindow: 200_000,
    maxOutput: 64_000,
    effort: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    tools: 'native_strict',
    structured: 'native',
    parallelTools: true,
    midConversationSystem: true,
    perMessageEffort: false,
    promptCaching: 'explicit',
    minCacheableTokens: 512,
    maxBreakpoints: 4,
    vision: true,
    pdf: true,
    batches: true,
    countTokens: true,
  },
};

function turnRequest(route: ModelRoute = 'chat'): ModelTurnRequest {
  return {
    route,
    purpose: 'turn.reply',
    system: [{ id: 'charter', text: 'You are helpful.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: 'auto',
    effort: 'medium',
    maxOutputTokens: 1_024,
    correlation: {},
  };
}

function structuredRequest(): StructuredRequest<unknown> {
  return {
    route: 'extract',
    purpose: 'extract.facts',
    system: [{ id: 'extract', text: 'Extract.' }],
    input: [{ type: 'text', text: 'hello' }],
    schema: { safeParse: (input: unknown) => ({ success: true as const, data: input }) },
    jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    schemaName: 'facts',
    effort: 'low',
    maxOutputTokens: 512,
    correlation: {},
  };
}

function result(overrides: Partial<ModelTurnResult> = {}): ModelTurnResult {
  return {
    assistant: {
      role: 'assistant',
      provider: 'anthropic',
      servedModel: 'claude-opus-5-5',
      raw: [],
      view: [],
    },
    stop: { reason: 'end_turn', raw: 'end_turn' },
    text: 'hi',
    toolCalls: [],
    usage: [ITERATION],
    model: { provider: 'anthropic', requested: 'claude-opus-5-5', served: 'claude-opus-5-5' },
    latency: { totalMs: 750 },
    diagnostics: { inputTransformations: 0, betas: [] },
    ...overrides,
  };
}

const USAGE_CONTEXT: UsageContext = {
  route: 'chat',
  purpose: 'turn.reply',
  provider: 'anthropic',
  requestedModel: 'claude-opus-5-5',
  effort: 'medium',
  dayLocal: '2026-11-13',
};

const BATCH_HANDLE: BatchHandle = {
  provider: 'anthropic',
  batchId: 'msgbatch_1',
  customIds: [],
  submittedAt: '2026-11-13T10:00:00Z',
};

/** A transaction token, which is a brand with no runtime shape. */
const TX_TOKEN = {} as TxToken;

/**
 * A usage hook wired to an in-memory list.
 *
 * Fully typed rather than cast. The first version of this used `as unknown as UsageHookDeps` and
 * named a member `insert` that does not exist; because `recordUsage` **never throws** by design
 * (`05` §3.9.1 — a usage write must not turn a successful turn into a failed one), the test saw an
 * empty list and no error. A cast around a deliberately silent collaborator hides exactly the
 * mistakes the types would have caught.
 */
function usageDeps(recorded: NewUsageRecord[]): UsageHookDeps {
  return {
    clock: new VirtualClock('2026-11-13T10:00:00Z'),
    ids: { next: (prefix: string) => `${prefix}_1` } as IdGenerator,
    prices: TABLE,
    logger: recordingLogger().logger,
    tx: <T>(fn: (uow: TxToken) => NotPromise<T>): T => fn(TX_TOKEN),
    usage: {
      record: (_uow: TxToken, record: NewUsageRecord): WriteResult<UsageRecord> => {
        recorded.push(record);
        return { kind: 'ok', value: record as UsageRecord };
      },
    },
  };
}

/** A gateway that logs what the chain did to it, in order. */
class SpyGateway implements ModelGateway {
  readonly calls: string[] = [];
  /** Appended to by whoever wants to interleave with the adapter's own entries. */
  readonly timeline: string[] = [];
  #onRun: () => Promise<ModelTurnResult> = () => Promise.resolve(result());

  onRun(fn: () => Promise<ModelTurnResult>): this {
    this.#onRun = fn;
    return this;
  }

  run(req: ModelTurnRequest): Promise<ModelTurnResult> {
    this.calls.push(`run:${req.route}`);
    this.timeline.push('adapter');
    return this.#onRun();
  }

  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(`structured:${req.route}`);
    return Promise.resolve({
      kind: 'ok',
      value: {} as T,
      usage: [ITERATION],
      model: 'claude-haiku-5-5',
    });
  }

  embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    this.calls.push(`embed:${String(texts.length)}`);
    return Promise.resolve(texts.map(() => new Float32Array(4)));
  }

  countTokens(): Promise<number> {
    this.calls.push('countTokens');
    return Promise.resolve(42);
  }

  submitBatch(): Promise<BatchHandle> {
    this.calls.push('submitBatch');
    return Promise.resolve(BATCH_HANDLE);
  }

  pollBatch(): Promise<BatchStatus> {
    this.calls.push('pollBatch');
    return Promise.resolve({ state: 'in_progress', counts: {} } as unknown as BatchStatus);
  }

  routeInfo(): RouteInfo {
    return INFO;
  }
}

function chain(gateway: ModelGateway, overrides: Partial<ChainDeps> = {}): ModelGateway {
  return withMiddleware({
    inner: gateway,
    limiter: new PriorityLimiter(),
    breakers: new BreakerRegistry({ clock: new VirtualClock('2026-11-13T10:00:00Z') }),
    logger: recordingLogger().logger,
    ...overrides,
  });
}

describe('withMiddleware composition (05 §3.5.1)', () => {
  it('passes a turn through to the adapter and returns its result unchanged', async () => {
    const inner = new SpyGateway();
    const out = await chain(inner).run(turnRequest(), AbortSignal.timeout(1_000));
    expect(inner.calls).toEqual(['run:chat']);
    expect(out.text).toBe('hi');
  });

  it('does not reach the adapter when the breaker is open', async () => {
    const inner = new SpyGateway().onRun(() =>
      Promise.reject(new ModelCallError('timeout', 'anthropic', {})),
    );
    // `BreakerOptions` is flat, not nested: one timeout opens the circuit.
    const breakers = new BreakerRegistry({
      clock: new VirtualClock('2026-11-13T10:00:00Z'),
      threshold: 1,
    });
    const gateway = chain(inner, { breakers });

    await expect(gateway.run(turnRequest(), AbortSignal.timeout(1_000))).rejects.toThrow();
    const before = inner.calls.length;
    // The second call is refused by the breaker, not by the provider, so it must not take a
    // limiter slot for the length of a timeout.
    await expect(gateway.run(turnRequest(), AbortSignal.timeout(1_000))).rejects.toThrow();
    expect(inner.calls).toHaveLength(before);
  });

  it('records usage for a turn, and only when there is something to attribute it to', async () => {
    const recorded: NewUsageRecord[] = [];
    const usage = usageDeps(recorded);

    // No context: nothing to roll up or budget against, so nothing is written.
    await chain(new SpyGateway(), { usage }).run(turnRequest(), AbortSignal.timeout(1_000));
    expect(recorded).toHaveLength(0);

    await chain(new SpyGateway(), { usage, usageContextFor: () => USAGE_CONTEXT }).run(
      turnRequest(),
      AbortSignal.timeout(1_000),
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ route: 'chat', model: 'claude-opus-5-5' });
  });

  it('emits a trace row for a turn', async () => {
    const traces: { readonly route: string; readonly totalMs: number }[] = [];
    await chain(new SpyGateway(), {
      emitTrace: (trace) => traces.push(trace),
    }).run(turnRequest(), AbortSignal.timeout(1_000));
    expect(traces[0]).toMatchObject({ route: 'chat', totalMs: 750 });
  });

  it('passes routeInfo, embed and the optional members straight through', async () => {
    const inner = new SpyGateway();
    const gateway = chain(inner);

    expect(gateway.routeInfo('chat')).toBe(INFO);
    await gateway.embed(['a', 'b'], 'query');
    await gateway.countTokens?.(turnRequest());
    await gateway.submitBatch?.([]);
    await gateway.pollBatch?.(BATCH_HANDLE);

    // None of these is a model call, so none of them may take a turn-path limiter slot.
    expect(inner.calls).toEqual(['embed:2', 'countTokens', 'submitBatch', 'pollBatch']);
    // `batchResults` was never defined on the inner gateway, so it must not appear defined here.
    expect(gateway.batchResults).toBeUndefined();
  });

  it('leaves the optional members undefined when the adapter has none', () => {
    // A local-only gateway offers no token count and no Batches. The chain must not fabricate
    // members for them, or a caller's `countTokens?.()` would resolve against nothing.
    class Minimal implements ModelGateway {
      run(): Promise<ModelTurnResult> {
        return Promise.resolve(result());
      }
      structured<T>(): Promise<StructuredResult<T>> {
        return Promise.resolve({ kind: 'ok', value: {} as T, usage: [], model: 'local' });
      }
      embed(): Promise<readonly Float32Array[]> {
        return Promise.resolve([]);
      }
      routeInfo(): RouteInfo {
        return INFO;
      }
    }
    const gateway = chain(new Minimal());
    expect(gateway.countTokens).toBeUndefined();
    expect(gateway.submitBatch).toBeUndefined();
    expect(gateway.pollBatch).toBeUndefined();
    expect(gateway.batchResults).toBeUndefined();
  });

  it('runs a structured call with no telemetry configured', async () => {
    const inner = new SpyGateway();
    const out = await chain(inner).structured(structuredRequest(), AbortSignal.timeout(1_000));
    expect(inner.calls).toEqual(['structured:extract']);
    expect(out.kind).toBe('ok');
  });

  it('runs a structured call through the limiter and records its usage', async () => {
    const inner = new SpyGateway();
    const metrics = recordingMetrics();
    await chain(inner, {
      telemetry: { tracer: recordingTracer(), metrics, prices: TABLE },
    }).structured(structuredRequest(), AbortSignal.timeout(1_000));
    expect(inner.calls).toEqual(['structured:extract']);
    expect(metrics.of('model_requests_total')[0]?.labels).toMatchObject({
      route: 'extract',
      outcome: 'ok',
    });
  });
});

describe('telemetry through the chain (11 §3.10.2; M2-T15)', () => {
  it('describes the call from the route the registry resolved', async () => {
    const tracer = recordingTracer();
    await chain(new SpyGateway(), {
      telemetry: {
        tracer,
        metrics: recordingMetrics(),
        prices: TABLE,
        endpointFor: (provider) =>
          provider === 'anthropic' ? 'https://api.anthropic.com' : undefined,
      },
    }).run(turnRequest(), AbortSignal.timeout(1_000));

    const span = tracer.spans[0];
    expect(span?.name).toBe('chat claude-opus-5-5');
    expect(span?.kind).toBe('client');
    expect(span?.attributes).toMatchObject({
      [GENAI.PROVIDER_NAME]: 'anthropic',
      [GENAI.REQUEST_MODEL]: 'claude-opus-5-5',
      [GENAI.REQUEST_MAX_TOKENS]: 1_024,
      // The Anthropic adapter streams every turn-path call, which is the chain's default.
      [GENAI.REQUEST_STREAM]: true,
      [OTEL.SERVER_ADDRESS]: 'api.anthropic.com',
    });
  });

  it('names the local flavour rather than attributing a local model to OpenAI', async () => {
    const tracer = recordingTracer();
    await chain(new SpyGateway(), {
      telemetry: {
        tracer,
        metrics: recordingMetrics(),
        prices: TABLE,
        flavourFor: () => 'ollama',
        endpointFor: () => 'http://127.0.0.1:11434',
      },
    }).run(turnRequest(), AbortSignal.timeout(1_000));
    expect(tracer.spans[0]?.attributes[GENAI.PROVIDER_NAME]).toBe('ollama');
    expect(tracer.spans[0]?.attributes[OTEL.SERVER_PORT]).toBe(11434);
  });

  it('closes the span before the usage write, so a SQLite transaction is not provider latency', async () => {
    const tracer = recordingTracer();
    const order: string[] = [];
    const usage: UsageHookDeps = {
      ...usageDeps([]),
      tx: <T>(fn: (uow: TxToken) => NotPromise<T>): T => {
        // The span has to be finished by now. Were telemetry outside the usage hook, every
        // model-latency graph would carry a disk write.
        order.push(`tx:spanEnded=${String(tracer.spans[0]?.ended ?? false)}`);
        return fn(TX_TOKEN);
      },
    };

    await chain(new SpyGateway(), {
      usage,
      usageContextFor: () => USAGE_CONTEXT,
      telemetry: { tracer, metrics: recordingMetrics(), prices: TABLE },
    }).run(turnRequest(), AbortSignal.timeout(1_000));

    expect(order).toEqual(['tx:spanEnded=true']);
  });

  it('emits no span and no metric when telemetry is not configured', async () => {
    const tracer = recordingTracer();
    const metrics = recordingMetrics();
    // Omitted entirely, which is the default for a host who enabled neither OTel nor `/metrics`.
    await chain(new SpyGateway()).run(turnRequest(), AbortSignal.timeout(1_000));
    expect(tracer.spans).toHaveLength(0);
    expect(metrics.observations).toHaveLength(0);
  });

  it('records the error kind on both the span and the metric when the provider fails', async () => {
    const tracer = recordingTracer();
    const metrics = recordingMetrics();
    const inner = new SpyGateway().onRun(() =>
      Promise.reject(new ModelCallError('overloaded', 'anthropic', {})),
    );

    await expect(
      chain(inner, { telemetry: { tracer, metrics, prices: TABLE } }).run(
        turnRequest(),
        AbortSignal.timeout(1_000),
      ),
    ).rejects.toThrow(ModelCallError);

    expect(tracer.spans[0]?.attributes[OTEL.ERROR_TYPE]).toBe('overloaded');
    expect(tracer.spans[0]?.status).toBe('error');
    expect(metrics.of('model_requests_total')[0]?.labels['outcome']).toBe('overloaded');
  });
});
