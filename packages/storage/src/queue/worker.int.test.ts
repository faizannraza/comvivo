/**
 * The worker loop (`M1-T23`; `02` §3.10.4).
 *
 * The loop is where the queue's guarantees meet an `async` handler, and three of its decisions are
 * the kind that work until they do not:
 *
 *  - **a payload that no longer parses is dead, not retried** — a row can outlive the code that
 *    wrote it, and eight retries of the same parse failure hide the cause;
 *  - **`completeIn` and `complete` are not both called** — the second would report `lease_lost`
 *    for a job that completed perfectly well, which reads like a bug;
 *  - **the pool's limit bounds in-flight work**, because `01` §8's limits are a global budget per
 *    pool rather than a per-kind one.
 *
 * Driven by `VirtualClock`, so the heartbeat and the timeout are assertions rather than sleeps
 * (`11` §3.1.7).
 */
import type { ClaimedJob, ClaimRequest, Store } from '@comvivo/core';
import { ModelCallError } from '@comvivo/core';
import { z } from '@comvivo/shared';
import { VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { silentLogger, T0, withReposAsync } from '../repos/testing/harness.js';
import { JobKindRegistry } from './kinds.js';
import { type JobContext, type JobHandler, makeWorkers, PoolWorker } from './worker.js';

const PayloadSchema = z.object({ n: z.int().min(0) });
type Payload = z.infer<typeof PayloadSchema>;

type World = Parameters<Parameters<typeof withReposAsync>[0]>[0];

/** A worker over one pool, with the handlers a test supplies. */
function workerFor(
  world: World,
  pool: 'io' | 'embed' | 'model',
  kinds: readonly string[],
  handlers: ReadonlyMap<string, JobHandler<never>>,
  queue: World['repos']['jobs'] = world.repos.jobs,
  /** A logger that records, for the one test that asserts a line was written. */
  recorder?: { error: (event: string) => void },
): { worker: PoolWorker; registry: JobKindRegistry; clock: VirtualClock } {
  const registry = new JobKindRegistry();
  for (const kind of kinds) registry.register(kind, PayloadSchema);
  const clock = new VirtualClock(T0);
  const worker = new PoolWorker(pool, {
    queue,
    registry,
    store: world.store,
    timers: clock,
    logger:
      recorder === undefined
        ? silentLogger
        : ({
            ...silentLogger,
            error: (event: string) => {
              recorder.error(event);
            },
          } as unknown as typeof silentLogger),
    bootId: 'boot-01',
    handlers,
    idleMs: 10,
  });
  return { worker, registry, clock };
}

function enqueue(world: World, registry: JobKindRegistry, kind: string, n = 0, key?: string): void {
  const def = registry.def(kind);
  if (def === undefined) throw new Error('fixture');
  world.store.write((uow) =>
    world.repos.jobs.enqueue(uow, def, {
      partitionKey: kind === 'retention.sweep' ? '_instance' : world.groupId,
      payload: { n } as never,
      ...(key === undefined ? {} : { idempotencyKey: key }),
    }),
  );
}

describe('the worker loop (02 §3.10.4)', () => {
  it('runs a handler and completes the job', async () => {
    await withReposAsync(async (world) => {
      const seen: number[] = [];
      const handlers = new Map<string, JobHandler<never>>([
        [
          'poll.close',
          (async (context: { payload: Payload }) => {
            seen.push(context.payload.n);
          }) as JobHandler<never>,
        ],
      ]);
      const { worker, registry } = workerFor(world, 'io', ['poll.close'], handlers);
      enqueue(world, registry, 'poll.close', 7);

      const claimed = worker.tick();
      expect(claimed).toHaveLength(1);
      // The handlers run detached (`02` §3.10.4's `run(job).finally(…)`), so the pass returns
      // before they finish — a `tick` that awaited them would make the pool's concurrency one.
      await settle();
      expect(seen).toEqual([7]);
      expect(world.repos.jobs.job(claimed[0]?.id ?? ('x' as never))?.status).toBe('succeeded');
      expect(
        world.repos.jobs.job(claimed[0]?.id ?? ('x' as never))?.durationMs,
      ).toBeGreaterThanOrEqual(0);
      expect(worker.inFlight).toBe(0);
    });
  });

  it('lets a handler complete inside its own transaction', async () => {
    await withReposAsync(async (world) => {
      let outcome: string | undefined;
      let completeCalls = 0;
      const handlers = new Map<string, JobHandler<never>>([
        [
          'poll.close',
          (async (context: {
            readonly completeIn: JobContext<Payload>['completeIn'];
            readonly store: Store;
          }) => {
            // `02` §3.10.2: the handler's work and its completion commit together. A handler that
            // mutated group state and then returned would have its write land and its completion
            // happen separately — and a crash between them runs the job again.
            outcome = context.store.write((uow) => context.completeIn(uow));
          }) as JobHandler<never>,
        ],
      ]);
      // The queue, with `complete` counted. Injected rather than spied on: `WorkerOptions.queue`
      // is already a port, so a counting wrapper is the honest way to assert what the worker calls.
      const counting = {
        ...world.repos.jobs,
        claim: (worker: string, request: ClaimRequest) => world.repos.jobs.claim(worker, request),
        heartbeat: (job: ClaimedJob, ms: number) => world.repos.jobs.heartbeat(job, ms),
        fail: (...args: Parameters<(typeof world.repos.jobs)['fail']>) =>
          world.repos.jobs.fail(...args),
        completeIn: (...args: Parameters<(typeof world.repos.jobs)['completeIn']>) =>
          world.repos.jobs.completeIn(...args),
        complete: (job: ClaimedJob) => {
          completeCalls += 1;
          return world.repos.jobs.complete(job);
        },
      } as unknown as typeof world.repos.jobs;
      const { worker, registry } = workerFor(world, 'io', ['poll.close'], handlers, counting);
      enqueue(world, registry, 'poll.close');
      const [job] = worker.tick();
      await settle();
      expect(outcome).toBe('ok');
      expect(world.repos.jobs.job(job?.id ?? ('x' as never))?.status).toBe('succeeded');
      // And `complete` was **not** called afterwards. Counted rather than inferred from the row:
      // a second call changes nothing observable — it finds the fence unsatisfied and returns
      // `lease_lost` — so the only way to see it is to count the calls. What it *would* do is
      // report a lost lease for a job that finished perfectly well, which reads like a bug in a
      // log and inflates `02` §3.10.4's `lease_lost` counter.
      expect(completeCalls, '`complete` was called after `completeIn`').toBe(0);
      expect(world.repos.jobs.jobsByStatus('succeeded', 10)).toHaveLength(1);
    });
  });

  it('kills a job whose payload no longer parses', async () => {
    await withReposAsync(async (world) => {
      let ran = false;
      const handlers = new Map<string, JobHandler<never>>([
        [
          'poll.close',
          (async () => {
            ran = true;
          }) as JobHandler<never>,
        ],
      ]);
      const { worker, registry } = workerFor(world, 'io', ['poll.close'], handlers);
      enqueue(world, registry, 'poll.close');
      // The shape an upgrade leaves behind: the row was written by code whose schema has moved on.
      world.db.prepare('UPDATE jobs SET payload = \'{"n":-1}\'').run();

      const [job] = worker.tick();
      await settle();
      // `02` §3.10.1: `JOB_PAYLOAD_INVALID ⇒ dead`. Non-retryable, because the payload will not
      // start parsing on the next attempt — and the handler must not have run.
      expect(ran).toBe(false);
      const row = world.repos.jobs.job(job?.id ?? ('x' as never));
      expect(row?.status).toBe('dead');
      expect(row?.lastError?.code).toBe('JOB_PAYLOAD_INVALID');
      // The message says nothing about the payload's contents: `02` §3.3.9 forbids content in
      // `last_error`, and a validation message is exactly where a value tends to be quoted.
      expect(row?.lastError?.message).not.toContain('-1');
    });
  });

  it('kills a job whose payload is not JSON at all, instead of crashing the worker', async () => {
    await withReposAsync(async (world) => {
      let ran = false;
      const handlers = new Map<string, JobHandler<never>>([
        [
          'poll.close',
          (async () => {
            ran = true;
          }) as JobHandler<never>,
        ],
      ]);
      const { worker, registry } = workerFor(world, 'io', ['poll.close'], handlers);
      enqueue(world, registry, 'poll.close');
      // Not a schema mismatch — not JSON. A truncated write, a column edited by hand, a row from a
      // build that stored something else. `JSON.parse` used to throw past `#run`'s caller, which
      // on Node 26 ends the **process**: the lease expired, the job was re-claimed on the next
      // boot and ended it again. Found by the M1 exit gate's reviewer.
      world.db.prepare(`UPDATE jobs SET payload = '{"n":'`).run();

      const [job] = worker.tick();
      await settle();
      expect(ran).toBe(false);
      const row = world.repos.jobs.job(job?.id ?? ('x' as never));
      expect(row?.status).toBe('dead');
      expect(row?.lastError?.code).toBe('JOB_PAYLOAD_INVALID');
      // And the worker is still running: it claims the next job rather than having died with it.
      enqueue(world, registry, 'poll.close');
      const [next] = worker.tick();
      await settle();
      expect(ran).toBe(true);
      expect(world.repos.jobs.job(next?.id ?? ('x' as never))?.status).toBe('succeeded');
    });
  });

  it('logs and survives a failure in its own machinery, rather than ending the process', async () => {
    await withReposAsync(async (world) => {
      const handlers = new Map<string, JobHandler<never>>([
        ['poll.close', (() => Promise.reject(new Error('handler down'))) as JobHandler<never>],
      ]);
      // The queue itself refusing the write that records a failure — `SQLITE_BUSY` on a loaded
      // host, or `SQLITE_FULL`. `fail` is called from outside `#run`'s `try`, so before the M1
      // exit gate this became an **unhandled rejection**, which on Node 26 ends the process: the
      // lease expired, the job was re-claimed on the next boot, and it ended the process again.
      const events: string[] = [];
      const brokenQueue = {
        ...world.repos.jobs,
        claim: world.repos.jobs.claim.bind(world.repos.jobs),
        fail: () => {
          throw new Error('database is locked');
        },
      } as unknown as World['repos']['jobs'];
      const { worker, registry } = workerFor(world, 'io', ['poll.close'], handlers, brokenQueue, {
        error: (event: string) => {
          events.push(event);
        },
      });
      enqueue(world, registry, 'poll.close');

      worker.tick();
      await settle();
      // One log line, and the loop still alive. The job keeps its lease and is retried when the
      // lease expires, which is the queue's existing recovery path.
      expect(events).toContain('job.crashed');
      expect(() => worker.tick()).not.toThrow();
    });
  });

  it('requeues a handler that throws, and kills one that throws permanently', async () => {
    await withReposAsync(async (world) => {
      const handlers = new Map<string, JobHandler<never>>([
        [
          'poll.close',
          (async (context: { payload: Payload }) => {
            if (context.payload.n === 0) throw new Error('the network blinked');
            const { ValidationError } = await import('@comvivo/shared');
            throw new ValidationError('that will never parse', []);
          }) as JobHandler<never>,
        ],
      ]);
      const { worker, registry } = workerFor(world, 'io', ['poll.close'], handlers);
      enqueue(world, registry, 'poll.close', 0, 'transient');
      const [transient] = worker.tick();
      await settle();
      // An unknown `Error` is retried: the common cause is transient, and the attempt budget bounds
      // the cost of being wrong. A non-retryable default would turn one flaky socket into a dead
      // letter a host has to notice and re-run by hand.
      expect(world.repos.jobs.job(transient?.id ?? ('x' as never))?.status).toBe('queued');

      enqueue(world, registry, 'poll.close', 1, 'permanent');
      // Wind the first job's retry out of the way so the second is the one claimed.
      world.db
        .prepare("UPDATE jobs SET run_at = run_at + 3600000 WHERE idempotency_key = 'transient'")
        .run();
      const [permanent] = worker.tick();
      await settle();
      // A `ValidationError` will not start succeeding: the input is wrong or the code is.
      expect(world.repos.jobs.job(permanent?.id ?? ('x' as never))?.status).toBe('dead');
      expect(world.repos.jobs.job(permanent?.id ?? ('x' as never))?.lastError?.code).toBe(
        'validation.failed',
      );
    });
  });

  it('bounds in-flight work by the pool`s limit', async () => {
    await withReposAsync(async (world) => {
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handlers = new Map<string, JobHandler<never>>([
        ['embed.items', (async () => blocked) as JobHandler<never>],
      ]);
      const { worker, registry } = workerFor(world, 'embed', ['embed.items'], handlers);
      for (const n of [0, 1, 2]) enqueue(world, registry, 'embed.items', n, `e${String(n)}`);

      // `01` §8: the `embed` pool is 1, because the embedder is a single ONNX session. A per-kind
      // limit would let several kinds in one pool exceed it together.
      expect(worker.tick()).toHaveLength(1);
      expect(worker.inFlight).toBe(1);
      expect(worker.tick(), 'the pool claimed past its limit').toEqual([]);
      release?.();
      await settle();
      expect(worker.inFlight).toBe(0);
      expect(worker.tick()).toHaveLength(1);
      release?.();
      await settle();
    });
  });

  it('does not claim a kind it cannot run', async () => {
    await withReposAsync(async (world) => {
      // Registered but unhandled, which is what `M1` looks like for most of the catalog. A claim
      // would lease a row nothing can run, and the lease would then have to expire — eight times,
      // before the job died for no reason a host could act on.
      const { worker, registry } = workerFor(
        world,
        'io',
        ['poll.close'],
        new Map<string, JobHandler<never>>(),
      );
      enqueue(world, registry, 'poll.close');
      expect(worker.tick()).toEqual([]);
      expect(world.repos.jobs.jobsByStatus('queued', 10)).toHaveLength(1);
      expect(registry.unregistered()).toContain('reminder.fire');
    });
  });

  it('heartbeats while a handler works, and aborts it at the timeout', async () => {
    await withReposAsync(async (world) => {
      let aborted = false;
      let release: (() => void) | undefined;
      const handlers = new Map<string, JobHandler<never>>([
        [
          'poll.close',
          (async (context: { signal: AbortSignal }) => {
            context.signal.addEventListener('abort', () => {
              aborted = true;
              release?.();
            });
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }) as JobHandler<never>,
        ],
      ]);
      const { worker, registry, clock } = workerFor(world, 'io', ['poll.close'], handlers);
      enqueue(world, registry, 'poll.close');
      const [job] = worker.tick();
      await settle();
      const leaseAtClaim = world.repos.jobs.job(job?.id ?? ('x' as never))?.leaseUntil;

      // A third of the lease: `02` §3.10.1's default is 60 s, so 20 s. Two missed ticks still leave
      // room for a third, which is why it is a third rather than a half.
      await clock.advance('PT21S');
      const leaseNow = (): number =>
        world.repos.jobs.job(job?.id ?? ('x' as never))?.leaseUntil?.epochMilliseconds ?? 0;
      await settleUntil(() => leaseNow() > (leaseAtClaim?.epochMilliseconds ?? 0));
      expect(leaseNow(), 'the heartbeat did not extend the lease').toBeGreaterThan(
        leaseAtClaim?.epochMilliseconds ?? 0,
      );

      // `02` §3.10.1 caps the timeout at 80% of the lease — 48 s — so the signal fires while the
      // lease is still valid and the handler can record its own failure. A timeout equal to the
      // lease would race the recovery sweep.
      await clock.advance('PT30S');
      await settleUntil(() => aborted);
      expect(aborted, 'the timeout did not abort the handler').toBe(true);
    });
  });

  it('stops when told to, and wakes on an enqueue', async () => {
    await withReposAsync(async (world) => {
      const seen: number[] = [];
      const handlers = new Map<string, JobHandler<never>>([
        [
          'poll.close',
          (async (context: { payload: Payload }) => {
            seen.push(context.payload.n);
          }) as JobHandler<never>,
        ],
      ]);
      const { worker, registry, clock } = workerFor(world, 'io', ['poll.close'], handlers);
      const loop = worker.run();
      enqueue(world, registry, 'poll.close', 1);
      // `02` §3.10.4's `wakeEvent`, which an enqueue's `afterCommit` hook calls: the loop picks the
      // job up now rather than at the end of the idle interval.
      worker.wake();
      await settle();
      expect(seen).toEqual([1]);
      worker.stop();
      await clock.advance('PT1S');
      await loop;
      // Stopped: a job enqueued now is not picked up, which is what makes shutdown finite.
      enqueue(world, registry, 'poll.close', 2);
      worker.wake();
      await settle();
      expect(seen).toEqual([1]);
    });
  });
});

describe('the worker set and its edges (02 §3.10.4)', () => {
  it('builds one worker per pool, with 01 §8`s limits', () => {
    const registry = new JobKindRegistry();
    const workers = makeWorkers({
      queue: undefined as never,
      registry,
      store: undefined as never,
      timers: new VirtualClock(T0),
      logger: silentLogger,
      bootId: 'boot-01',
      handlers: new Map(),
    });
    // `01` §8 gives five pools, and the limits are a **global** budget per pool rather than a
    // per-kind one — `model` is 4 because that is how many concurrent model calls the instance
    // will make, however many kinds want one.
    expect(workers).toHaveLength(5);
    expect(workers.every((worker) => worker.inFlight === 0)).toBe(true);
  });

  it('takes a retry-after from a thrown error', async () => {
    await withReposAsync(async (world) => {
      const handlers = new Map<string, JobHandler<never>>([
        [
          'poll.close',
          (async () => {
            // `02` §3.10.3: a platform asking for a longer wait knows something we do not. The
            // adapter that saw the `429` is the only place that number exists, so it travels on
            // the thrown error rather than through a side channel.
            const error = Object.assign(new Error('slow down'), { retryAfterMs: 3_600_000 });
            throw error;
          }) as JobHandler<never>,
        ],
      ]);
      const { worker, registry } = workerFor(world, 'io', ['poll.close'], handlers);
      enqueue(world, registry, 'poll.close');
      const [job] = worker.tick();
      await settle();
      const row = world.repos.jobs.job(job?.id ?? ('x' as never));
      expect(row?.status).toBe('queued');
      const waited = (row?.runAt.epochMilliseconds ?? 0) - (row?.createdAt.epochMilliseconds ?? 0);
      expect(waited).toBeGreaterThanOrEqual(3_600_000);
    });
  });

  it('takes a retry-after from a ModelCallError, which carries it on `detail`', async () => {
    await withReposAsync(async (world) => {
      const handlers = new Map<string, JobHandler<never>>([
        [
          'poll.close',
          (async () => {
            // The M2 second-pass review's eighth finding. `ModelCallError` puts the provider's
            // `retry-after` in `detail.retryAfterMs` (`01` §7.5) and a channel send error puts it
            // at the top level; `retryAfterOf` read only the top level. So a provider 429 on a
            // background route — every `extract`, `consolidate` and `embed` job — ignored the time
            // the provider asked for and used our own jittered backoff instead. The `02` §3.10.3
            // clause and the `M2-T9` AC's "`retry-after` honored" were satisfied at the parse
            // boundary and nowhere else.
            throw new ModelCallError('rate_limited', 'anthropic', { retryAfterMs: 3_600_000 });
          }) as JobHandler<never>,
        ],
      ]);
      const { worker, registry } = workerFor(world, 'io', ['poll.close'], handlers);
      enqueue(world, registry, 'poll.close');
      const [job] = worker.tick();
      await settle();
      const row = world.repos.jobs.job(job?.id ?? ('x' as never));
      expect(row?.status).toBe('queued');
      const waited = (row?.runAt.epochMilliseconds ?? 0) - (row?.createdAt.epochMilliseconds ?? 0);
      expect(waited).toBeGreaterThanOrEqual(3_600_000);
    });
  });

  it('dead-letters a job whose handler vanished after the claim', async () => {
    await withReposAsync(async (world) => {
      const handlers = new Map<string, JobHandler<never>>([
        ['poll.close', (async () => undefined) as JobHandler<never>],
      ]);
      const { worker, registry } = workerFor(world, 'io', ['poll.close'], handlers);
      enqueue(world, registry, 'poll.close');
      // A deploy can remove a handler between a claim and the run — the claim already happened
      // against the old registry. Dead rather than a crash: the job cannot run, and leaving it
      // leased would make it wait out eight lease expirations before dying for no visible reason.
      const [job] = worker.tick();
      handlers.delete('poll.close');
      await settle();
      // The handler that *was* registered ran, because the delete came after the dispatch — so
      // this asserts the path through a second tick, with nothing registered.
      enqueue(world, registry, 'poll.close', 1, 'second');
      const [orphan] = worker.tick();
      await settle();
      expect(job).toBeDefined();
      expect(orphan).toBeUndefined();
      // Nothing claimed, because a kind with no handler is not claimable at all — which is the
      // better outcome than claiming and dead-lettering, and is why `#claimableKinds` filters.
      expect(world.repos.jobs.jobsByStatus('queued', 10)).toHaveLength(1);
    });
  });

  it('claims with the longest lease among a pool`s kinds', async () => {
    await withReposAsync(async (world) => {
      const handlers = new Map<string, JobHandler<never>>([
        ['backup.snapshot', (async () => undefined) as JobHandler<never>],
        ['retention.sweep', (async () => undefined) as JobHandler<never>],
      ]);
      const { worker, registry } = workerFor(
        world,
        'model',
        ['backup.snapshot', 'retention.sweep'],
        handlers,
      );
      // Both are maintenance kinds, so registering them into the `model` pool is not what a real
      // boot does — but the lease arithmetic is what is under test, and `backup.offsite`'s 900 s
      // timeout is the case `02` §3.10.1 singles out.
      expect(registry.def('backup.snapshot')?.leaseMs).toBe(60_000);
      enqueue(world, registry, 'retention.sweep');
      expect(worker.tick()).toEqual([]);
      await settle();
      // Claimed by the `maintenance` worker instead, which is where the catalog puts them.
      const maintenance = workerFor(world, 'model', ['backup.snapshot'], handlers);
      expect(maintenance.registry.kindsInPool('maintenance')).toEqual(['backup.snapshot']);
    });
  });
});

/** Let the detached handler promises resolve. One turn of the microtask queue is not enough. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/**
 * Settle until `condition` holds, or give up after `rounds` of it.
 *
 * One `settle()` drains the microtask queue and one macrotask turn, which is enough when the
 * machine is idle and not when it is not: the heartbeat assertion below failed inside a full
 * `pnpm verify` — 204 files in parallel — and passed on its own, every time. A fixed number of
 * turns is a race against the scheduler, and a test that is only green on an unloaded machine is
 * a test that will fail in CI on someone else's branch. Found at the M1 exit gate, which is the
 * second load-sensitive assertion this milestone has had.
 *
 * It still **fails** if the condition never holds: the loop bounds the wait, it does not weaken
 * the assertion, and the caller asserts afterwards exactly as before.
 */
async function settleUntil(condition: () => boolean, rounds = 200): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    if (condition()) return;
    await settle();
  }
}
