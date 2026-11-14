/**
 * The middleware chain (`05` §3.3.3, §3.5.1, §3.9.1; `M2-T9`).
 *
 * Three claims carry the weight, and each is a behaviour a member would feel:
 *
 *  - **The reservation holds.** Two slots belong to interactive routes, so a nightly consolidation
 *    cannot make somebody who typed a question wait.
 *  - **The breaker counts the right failures.** A 429 is back-pressure and must not open the
 *    circuit; a timeout is, and must. Getting this backwards turns a busy minute into an outage, or
 *    leaves a dead provider in rotation.
 *  - **Usage is written per iteration, immediately, and never throws.** A turn that failed after
 *    the model answered was still billed, and a usage write that propagated would turn a
 *    successful turn into a failed one.
 */
import {
  ModelCallError,
  type NewUsageRecord,
  type UsageIteration,
  type WriteResult,
} from '@comvivo/core';
import { recordingLogger, VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { PRICES, pickTable } from '../pricing/index.js';
import {
  BreakerRegistry,
  CircuitBreaker,
  CircuitOpenError,
  COUNTS_TOWARD_BREAKER,
} from './breaker.js';
import { INTERACTIVE_ROUTES, PriorityLimiter, priorityOf, ROUTE_PRIORITY } from './limiter.js';
import { traceOf, traceOfError, withTrace } from './trace-hook.js';
import { recordUsage, usageRecordFor } from './usage-hook.js';

const TABLE = pickTable([PRICES], '2026-11-13');

/** A deferred promise, so a test can hold a slot open and release it on purpose. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('the priority order (05 §3.3.3)', () => {
  it('ranks the six routes as the spec does', () => {
    expect([...ROUTE_PRIORITY]).toEqual([
      'chat',
      'guard',
      'declassify',
      'route',
      'extract',
      'consolidate',
    ]);
  });

  it('sorts an unknown route last, not first', () => {
    // A route added without touching the list should wait behind the ones a member is watching.
    expect(priorityOf('chat' as never)).toBeLessThan(priorityOf('unknown' as never));
  });

  it('reserves slots for the three routes a member is waiting on', () => {
    expect([...INTERACTIVE_ROUTES].toSorted()).toEqual(['chat', 'declassify', 'guard']);
    // `route` runs on the turn path and is deliberately **not** reserved: it is cheap, and
    // reserving for it would leave one slot for everything else.
    expect(INTERACTIVE_ROUTES.has('route')).toBe(false);
  });
});

describe('PriorityLimiter', () => {
  it('runs up to the limit concurrently', async () => {
    const limiter = new PriorityLimiter({ maxConcurrent: 2, reservedForInteractive: 0 });
    const first = deferred();
    const second = deferred();
    const running = [
      limiter.run('extract', () => first.promise),
      limiter.run('extract', () => second.promise),
    ];
    expect(limiter.inFlight).toBe(2);
    expect(limiter.queued).toBe(0);
    first.resolve();
    second.resolve();
    await Promise.all(running);
    expect(limiter.inFlight).toBe(0);
  });

  it('queues beyond the limit and serves the highest priority first', async () => {
    const limiter = new PriorityLimiter({ maxConcurrent: 1, reservedForInteractive: 0 });
    const held = deferred();
    const order: string[] = [];
    const occupying = limiter.run('extract', () => held.promise);

    // Queued in the *wrong* order on purpose: the queue, not arrival, decides.
    const consolidate = limiter.run('consolidate', () => {
      order.push('consolidate');
      return Promise.resolve();
    });
    const chat = limiter.run('chat', () => {
      order.push('chat');
      return Promise.resolve();
    });
    expect(limiter.queued).toBe(2);

    held.resolve();
    await Promise.all([occupying, consolidate, chat]);
    expect(order).toEqual(['chat', 'consolidate']);
  });

  it('is FIFO within one priority', async () => {
    const limiter = new PriorityLimiter({ maxConcurrent: 1, reservedForInteractive: 0 });
    const held = deferred();
    const order: number[] = [];
    const occupying = limiter.run('chat', () => held.promise);
    const queued = [1, 2, 3].map((n) =>
      limiter.run('chat', () => {
        order.push(n);
        return Promise.resolve();
      }),
    );
    held.resolve();
    await Promise.all([occupying, ...queued]);
    // Two members asking at the same moment are served in the order they asked.
    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps the reserved slots for interactive routes', async () => {
    const limiter = new PriorityLimiter({ maxConcurrent: 4, reservedForInteractive: 2 });
    const held = [deferred(), deferred()];
    const background = [
      limiter.run('consolidate', () => held[0]?.promise ?? Promise.resolve()),
      limiter.run('extract', () => held[1]?.promise ?? Promise.resolve()),
    ];
    // Two unreserved slots are now taken, so a third background route waits even though two slots
    // are free — which is the whole point of the reservation.
    const third = limiter.run('extract', () => Promise.resolve());
    expect(limiter.inFlight).toBe(2);
    expect(limiter.queued).toBe(1);

    // An interactive route goes straight through, into a reserved slot.
    let chatRan = false;
    const chat = limiter.run('chat', () => {
      chatRan = true;
      return Promise.resolve();
    });
    await chat;
    expect(chatRan).toBe(true);

    held[0]?.resolve();
    held[1]?.resolve();
    await Promise.all([...background, third]);
  });

  it('admits an interactive waiter ahead of a blocked background one', async () => {
    const limiter = new PriorityLimiter({ maxConcurrent: 2, reservedForInteractive: 1 });
    const held = deferred();
    const order: string[] = [];
    // One unreserved slot, taken.
    const occupying = limiter.run('extract', () => held.promise);
    // This background route cannot start even when a slot frees, because the free slot is reserved.
    const blocked = limiter.run('extract', () => {
      order.push('extract');
      return Promise.resolve();
    });
    const chat = limiter.run('chat', () => {
      order.push('chat');
      return Promise.resolve();
    });
    await chat;
    expect(order).toEqual(['chat']);
    held.resolve();
    await Promise.all([occupying, blocked]);
    expect(order).toEqual(['chat', 'extract']);
  });

  it('releases the slot when the call throws', async () => {
    const limiter = new PriorityLimiter({ maxConcurrent: 1, reservedForInteractive: 0 });
    await expect(limiter.run('chat', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    // A leaked slot would degrade the host permanently after a handful of provider errors.
    expect(limiter.inFlight).toBe(0);
    await expect(limiter.run('chat', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('refuses a configuration where every slot is reserved', () => {
    expect(() => new PriorityLimiter({ maxConcurrent: 2, reservedForInteractive: 3 })).toThrow(
      RangeError,
    );
  });
});

describe('the breaker’s failure classification (05 §3.5.3.10)', () => {
  it('counts only the failures where waiting helps', () => {
    const counting = Object.entries(COUNTS_TOWARD_BREAKER)
      .filter(([, counts]) => counts)
      .map(([kind]) => kind)
      .toSorted();
    expect(counting).toEqual(['network', 'overloaded', 'server', 'timeout', 'unknown']);
  });

  it('does not count back-pressure, an abort, or our own bugs', () => {
    for (const kind of [
      'rate_limited',
      'aborted',
      'bad_request',
      'auth',
      'permission',
      'billing',
      'model_not_found',
      'request_too_large',
    ] as const) {
      expect(COUNTS_TOWARD_BREAKER[kind], kind).toBe(false);
    }
  });
});

describe('CircuitBreaker', () => {
  function breaker(clock: VirtualClock): CircuitBreaker {
    return new CircuitBreaker({ clock, provider: 'anthropic' });
  }

  const fail = (kind: 'timeout' | 'rate_limited' | 'bad_request'): Promise<never> =>
    Promise.reject(new ModelCallError(kind, 'anthropic'));

  it('stays closed while calls succeed', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 10; i += 1) await circuit.run(() => Promise.resolve(i));
    expect(circuit.state).toBe('closed');
  });

  it('opens after five consecutive counting failures', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 4; i += 1) {
      await expect(circuit.run(() => fail('timeout'))).rejects.toBeInstanceOf(ModelCallError);
      expect(circuit.state).toBe('closed');
    }
    await expect(circuit.run(() => fail('timeout'))).rejects.toBeInstanceOf(ModelCallError);
    expect(circuit.state).toBe('open');
  });

  it('refuses a call while open, with how long is left', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 5; i += 1) {
      await circuit.run(() => fail('timeout')).catch(() => undefined);
    }
    const error = await circuit.run(() => Promise.resolve('never')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect((error as ModelCallError).detail.retryAfterMs).toBeGreaterThan(0);
  });

  it('does not open on rate limits, however many', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 20; i += 1) {
      await circuit.run(() => fail('rate_limited')).catch(() => undefined);
    }
    // A breaker that opened on 429s would turn a busy minute into a five-minute outage.
    expect(circuit.state).toBe('closed');
  });

  it('does not open on our own bugs, which a circuit would hide', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 20; i += 1) {
      await circuit.run(() => fail('bad_request')).catch(() => undefined);
    }
    expect(circuit.state).toBe('closed');
  });

  it('needs the failures inside the window', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 4; i += 1) {
      await circuit.run(() => fail('timeout')).catch(() => undefined);
    }
    await clock.advance('PT2M');
    // The four earlier failures have aged out: five spread over an hour of healthy traffic must
    // not open the circuit.
    await circuit.run(() => fail('timeout')).catch(() => undefined);
    expect(circuit.state).toBe('closed');
    expect(circuit.consecutiveFailures).toBe(1);
  });

  it('a success resets the streak', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 4; i += 1) {
      await circuit.run(() => fail('timeout')).catch(() => undefined);
    }
    await circuit.run(() => Promise.resolve('ok'));
    expect(circuit.consecutiveFailures).toBe(0);
    await circuit.run(() => fail('timeout')).catch(() => undefined);
    expect(circuit.state).toBe('closed');
  });

  it('a 429 between two timeouts does not reset the streak', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 4; i += 1) {
      await circuit.run(() => fail('timeout')).catch(() => undefined);
    }
    await circuit.run(() => fail('rate_limited')).catch(() => undefined);
    // A 429 does not make the provider healthy, and clearing the count there would stop the
    // breaker opening during exactly the degraded minute it exists for.
    expect(circuit.consecutiveFailures).toBe(4);
    await circuit.run(() => fail('timeout')).catch(() => undefined);
    expect(circuit.state).toBe('open');
  });

  it('goes half-open after the cooldown and closes on a successful trial', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 5; i += 1) {
      await circuit.run(() => fail('timeout')).catch(() => undefined);
    }
    expect(circuit.state).toBe('open');
    await clock.advance('PT31S');
    expect(circuit.state).toBe('half_open');
    await circuit.run(() => Promise.resolve('back'));
    expect(circuit.state).toBe('closed');
  });

  it('re-opens immediately when the trial fails', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 5; i += 1) {
      await circuit.run(() => fail('timeout')).catch(() => undefined);
    }
    await clock.advance('PT31S');
    await circuit.run(() => fail('timeout')).catch(() => undefined);
    // One failed trial is enough: a provider that is still down should not take five more.
    expect(circuit.state).toBe('open');
  });

  it('lets exactly one trial request through', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 5; i += 1) {
      await circuit.run(() => fail('timeout')).catch(() => undefined);
    }
    await clock.advance('PT31S');
    const held = deferred();
    const trial = circuit.run(() => held.promise);
    // A provider coming back from an outage should not be met with the whole backlog at once.
    await expect(circuit.run(() => Promise.resolve('second'))).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    held.resolve();
    await trial;
  });

  it('reports every state change, for the metric and the admin notice', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const changes: string[] = [];
    const circuit = new CircuitBreaker({
      clock,
      provider: 'anthropic',
      onStateChange: (from, to) => changes.push(`${from}->${to}`),
    });
    for (let i = 0; i < 5; i += 1) {
      await circuit.run(() => fail('timeout')).catch(() => undefined);
    }
    await clock.advance('PT31S');
    void circuit.state;
    await circuit.run(() => Promise.resolve('ok'));
    expect(changes).toEqual(['closed->open', 'open->half_open', 'half_open->closed']);
  });

  it('resets on request, for doctor --fix', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    for (let i = 0; i < 5; i += 1) {
      await circuit.run(() => fail('timeout')).catch(() => undefined);
    }
    circuit.reset();
    expect(circuit.state).toBe('closed');
    await expect(circuit.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('rethrows the original error unchanged, so a retry-after survives', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const circuit = breaker(clock);
    const original = new ModelCallError('rate_limited', 'anthropic', { retryAfterMs: 4000 });
    const thrown = await circuit.run(() => Promise.reject(original)).catch((e: unknown) => e);
    // The breaker observes; it does not rewrite.
    expect(thrown).toBe(original);
  });
});

describe('BreakerRegistry', () => {
  it('keeps one circuit per provider and reports every state', async () => {
    const clock = new VirtualClock('2026-11-13T12:00:00Z');
    const registry = new BreakerRegistry({ clock });
    expect(registry.for('anthropic')).toBe(registry.for('anthropic'));
    expect(registry.for('openai')).not.toBe(registry.for('anthropic'));

    for (let i = 0; i < 5; i += 1) {
      await registry
        .for('anthropic')
        .run(() => Promise.reject(new ModelCallError('server', 'anthropic')))
        .catch(() => undefined);
    }
    // One provider being down must not take the others with it.
    expect(registry.states()).toEqual({ anthropic: 'open', openai: 'closed' });
  });
});

const ITERATION: UsageIteration = {
  model: 'claude-opus-5-5',
  kind: 'message',
  input: 1000,
  cacheRead: 500,
  cacheWrite5m: 200,
  cacheWrite1h: 100,
  output: 50,
  batch: false,
};

const CONTEXT = {
  route: 'chat' as const,
  purpose: 'turn.reply',
  provider: 'anthropic' as const,
  requestedModel: 'claude-opus-5-5',
  effort: 'medium',
  dayLocal: '2026-11-13',
};

describe('usageRecordFor (05 §3.9.1)', () => {
  const clock = new VirtualClock('2026-11-13T12:00:00Z');
  const ids = { next: (prefix: string) => `${prefix}_0000000000000000000000000` as never };

  it('carries every field 05 §3.9.1 names', () => {
    const record = usageRecordFor({ ids, clock, prices: TABLE }, CONTEXT, ITERATION);
    expect(record).toMatchObject({
      route: 'chat',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      servedModel: 'claude-opus-5-5',
      purpose: 'turn.reply',
      effort: 'medium',
      kind: 'message',
      inputTokens: 1000,
      cachedReadTokens: 500,
      cacheWrite5mTokens: 200,
      cacheWrite1hTokens: 100,
      outputTokens: 50,
      batch: false,
      dayLocal: '2026-11-13',
    });
    expect(record.priceTableVersion).toBe(TABLE.version);
    expect(record.costMicros).toBeGreaterThan(0);
  });

  it('attributes a fallback iteration to the model that served it', () => {
    const record = usageRecordFor({ ids, clock, prices: TABLE }, CONTEXT, {
      ...ITERATION,
      kind: 'fallback_message',
      model: 'claude-sonnet-5-5',
    });
    // The requested model and the served one are both kept: one is what the route asked for, the
    // other is whose rates were charged.
    expect(record.model).toBe('claude-opus-5-5');
    expect(record.servedModel).toBe('claude-sonnet-5-5');
  });

  it('charges a model with no price row of its own against the registry’s `priceKey`', () => {
    // The whole point of `priceKey` (`05` §3.5.2), and until the M2 review nothing read it: a host
    // pins a dated snapshot, the registry answers through `openai/*`, the price table has only
    // exact ids — so without this the spend is estimated at the unknown-model fallback. Measured
    // against the real table: `gpt-6-astra` is 15 000 micro-USD on these tokens where the fallback
    // (Opus) is 6 000, so the difference is the assertion.
    const dated = {
      ...CONTEXT,
      provider: 'openai' as const,
      requestedModel: 'gpt-6-astra-2027-03-01',
      priceId: 'openai/gpt-6-astra',
    };
    const iteration = { ...ITERATION, model: 'gpt-6-astra-2027-03-01' };
    const withKey = usageRecordFor({ ids, clock, prices: TABLE }, dated, iteration);
    // The key is **omitted**, not set to `undefined`: `exactOptionalPropertyTypes` makes those
    // different, and the case being compared is a caller that never supplied a `priceId`.
    const { priceId: _omitted, ...noKey } = dated;
    const withoutKey = usageRecordFor({ ids, clock, prices: TABLE }, noKey, iteration);
    expect(withKey.costMicros).toBeGreaterThan(withoutKey.costMicros);
    // And the row still records what actually ran, not the row it was priced against.
    expect(withKey.servedModel).toBe('gpt-6-astra-2027-03-01');
  });

  it('ignores `priceKey` for an iteration a fallback served', () => {
    // A refusal fallback ran a different model, and that model's own rates are what were charged.
    // Redirecting it to the requested model's price row would bill the group for a call at rates
    // nobody paid.
    const dated = {
      ...CONTEXT,
      requestedModel: 'claude-opus-5-5',
      priceId: 'anthropic/claude-haiku-5-5',
    };
    const served = usageRecordFor({ ids, clock, prices: TABLE }, dated, {
      ...ITERATION,
      kind: 'fallback_message' as const,
      model: 'claude-sonnet-5-5',
    });
    const { priceId: _unused, ...noKey } = dated;
    const sonnetDirect = usageRecordFor({ ids, clock, prices: TABLE }, noKey, {
      ...ITERATION,
      kind: 'fallback_message' as const,
      model: 'claude-sonnet-5-5',
    });
    expect(served.costMicros).toBe(sonnetDirect.costMicros);
  });

  it('leaves `kind` unset for an iteration the column cannot name', () => {
    const record = usageRecordFor({ ids, clock, prices: TABLE }, CONTEXT, {
      ...ITERATION,
      kind: 'compaction',
    });
    // Its tokens and cost are still recorded, which is the part that must not be lost.
    expect('kind' in record).toBe(false);
    expect(record.costMicros).toBeGreaterThan(0);
  });

  it('carries the correlation a caller supplied, and omits what it did not', () => {
    const full = usageRecordFor(
      { ids, clock, prices: TABLE },
      {
        ...CONTEXT,
        groupId: 'grp_0000000000000000000000000' as never,
        turnId: 'trn_0000000000000000000000000' as never,
        jobId: 'job_0000000000000000000000000' as never,
        via: 'chat',
      },
      ITERATION,
    );
    expect(full).toMatchObject({
      groupId: 'grp_0000000000000000000000000',
      turnId: 'trn_0000000000000000000000000',
      jobId: 'job_0000000000000000000000000',
      via: 'chat',
    });

    const { effort: _effort, ...withoutEffort } = CONTEXT;
    const bare = usageRecordFor({ ids, clock, prices: TABLE }, withoutEffort, ITERATION);
    // Absent, not `undefined`: `exactOptionalPropertyTypes` makes those different, and a row with
    // a null group is a row the daily rollup cannot key.
    for (const key of ['groupId', 'turnId', 'jobId', 'via', 'effort']) {
      expect(key in bare, key).toBe(false);
    }
  });

  it('stores the cost rather than deriving it, so a price change cannot rewrite history', () => {
    const record = usageRecordFor({ ids, clock, prices: TABLE }, CONTEXT, ITERATION);
    expect(Number.isInteger(record.costMicros)).toBe(true);
    expect(record.priceTableVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('recordUsage', () => {
  function harness(options: { readonly failOn?: number } = {}) {
    const written: NewUsageRecord[] = [];
    let calls = 0;
    const recording = recordingLogger();
    const deps = {
      tx: (<T>(fn: (token: never) => T): T => {
        calls += 1;
        if (calls === options.failOn) throw new Error('disk full');
        return fn(undefined as never);
      }) as never,
      usage: {
        record: (_token: never, record: NewUsageRecord): WriteResult<never> => {
          written.push(record);
          return { kind: 'ok', value: undefined as never };
        },
      },
      ids: { next: (prefix: string) => `${prefix}_${String(written.length)}` as never },
      clock: new VirtualClock('2026-11-13T12:00:00Z'),
      logger: recording.logger,
      prices: TABLE,
    };
    return { deps, written, recording };
  }

  it('writes one record per iteration', () => {
    const { deps, written } = harness();
    recordUsage(deps as never, CONTEXT, [
      ITERATION,
      { ...ITERATION, kind: 'fallback_message', model: 'claude-sonnet-5-5' },
    ]);
    // A rescued turn produced two iterations at two prices; one record cannot carry that.
    expect(written).toHaveLength(2);
    expect(written.map((record) => record.servedModel)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
  });

  it('never throws, and logs the failure as the evidence the ledger is behind', () => {
    const { deps, written, recording } = harness({ failOn: 1 });
    expect(() => recordUsage(deps as never, CONTEXT, [ITERATION, ITERATION])).not.toThrow();
    // The second row still lands: one transaction per iteration, because the first was still
    // billed even if its write failed.
    expect(written).toHaveLength(1);
    const line = recording.lines().find((entry) => entry.event === 'usage.record_failed');
    expect(line?.level).toBe('error');
    // The error's name only — a storage message can carry a parameter (`01` §11.7).
    expect(JSON.stringify(line?.fields)).not.toContain('disk full');
  });
});

describe('the trace hook (11 §12-1)', () => {
  const context = {
    route: 'chat' as const,
    purpose: 'turn.reply',
    effort: 'medium',
    requestedModel: 'claude-opus-5-5',
    requestHash: 'abc123',
  };

  const result = {
    assistant: {
      role: 'assistant' as const,
      provider: 'fake' as const,
      servedModel: 'm',
      raw: [],
      view: [],
    },
    stop: { reason: 'end_turn' as const, raw: 'end_turn' },
    text: 'a secret reply about the recital',
    toolCalls: [],
    usage: [ITERATION, { ...ITERATION, kind: 'fallback_message' as const }],
    model: {
      provider: 'anthropic' as const,
      requested: 'claude-opus-5-5',
      served: 'claude-opus-4-8',
    },
    latency: { ttftMs: 120, totalMs: 900 },
    diagnostics: { inputTransformations: 1, betas: ['server-side-fallback-2026-07-01'] },
  };

  it('records the shape of the call and none of its content', () => {
    const trace = traceOf(context, result);
    expect(trace).toMatchObject({
      route: 'chat',
      requestHash: 'abc123',
      stopReason: 'end_turn',
      servedModel: 'claude-opus-4-8',
      iterations: 2,
      ttftMs: 120,
      totalMs: 900,
      inputTransformations: 1,
    });
    // A trace is read by anybody with `traces.read.group`; the prompt and the reply are not in it.
    expect(JSON.stringify(trace)).not.toContain('recital');
  });

  it('sums the tokens across iterations', () => {
    const trace = traceOf(context, result);
    expect(trace.inputTokens).toBe(2000);
    expect(trace.cachedReadTokens).toBe(1000);
    expect(trace.cacheWriteTokens).toBe(600);
    expect(trace.outputTokens).toBe(100);
  });

  it('records a failure by kind, never by message', () => {
    const error = new ModelCallError('overloaded', 'anthropic', { status: 529 });
    const trace = traceOfError(context, error, 42);
    expect(trace).toMatchObject({ stopReason: 'error', errorKind: 'overloaded', totalMs: 42 });
    expect(JSON.stringify(trace)).not.toContain('529 ');
  });

  it('emits a trace for a success and for a failure', async () => {
    const emitted: unknown[] = [];
    await withTrace({ emit: (trace) => emitted.push(trace) }, context, () =>
      Promise.resolve(result),
    );
    await withTrace({ emit: (trace) => emitted.push(trace) }, context, () =>
      Promise.reject(new ModelCallError('timeout', 'anthropic')),
    ).catch(() => undefined);
    // A turn that failed is the one somebody will ask about.
    expect(emitted).toHaveLength(2);
  });
});
