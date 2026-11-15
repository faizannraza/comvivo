/**
 * The worker loop (`02` §3.10.4; ADR-012).
 *
 * `02` §3.10.4 gives it as pseudocode and every line of it is here. Four decisions in that
 * pseudocode are worth stating, because each has a wrong form that works until it does not:
 *
 *  - **One loop per pool, claiming `pool.limit - inFlight`.** `01` §8's limits are a *global*
 *    budget per pool, not per kind: `model` is 4 because that is how many concurrent model calls
 *    the instance will make, however many kinds want one. A per-kind limit would let five kinds in
 *    the model pool make twenty calls.
 *  - **The payload is parsed on claim, and a parse failure is non-retryable.** A row can outlive
 *    the code that wrote it; `02` §3.10.1 says `JOB_PAYLOAD_INVALID ⇒ dead`. Retrying it would
 *    re-run the same failure every backoff until the attempts ran out, which is eight wasted
 *    wake-ups and an error log that hides the real cause.
 *  - **The heartbeat runs at a third of the lease.** Two misses still leave room for a third, so a
 *    single slow tick does not drop a lease out from under a working handler.
 *  - **The timeout aborts rather than kills.** `02` §3.10.1 caps `timeoutMs` at 80% of the lease,
 *    so the `AbortSignal` fires while the lease is still valid and the handler can still record
 *    its own failure. A timeout equal to the lease would race the recovery sweep.
 *
 * ## `lease_owner` is `${bootId}:${pool}:${slot}`
 *
 * `02` §3.10.3 specifies the shape, and the `bootId` prefix is what
 * `recoverExpiredLeases(bootId)` matches on: a restarted process recovers its predecessor's leases
 * immediately rather than waiting them out. The `pool` and `slot` make a log line say which worker
 * was holding a job without carrying the payload (`02` §3.10.4: "Logs carry job id, kind and
 * partition, never the payload").
 */
import type {
  ClaimedJob,
  ErrorInfo,
  JobKindDef,
  JobPool,
  JobQueue,
  JobQueueTx,
  LeaseResult,
  Store,
  TxToken,
} from '@comvivo/core';
import { JOB_PAYLOAD_INVALID, POOL_LIMITS } from '@comvivo/core';
import {
  err,
  type Logger,
  parse,
  type Result,
  type TimerHandle,
  type Timers,
  toLoggedError,
  ValidationError,
  type z,
} from '@comvivo/shared';
import { errorInfoOf } from './error-info.js';
import type { JobKindRegistry } from './kinds.js';
import { DEFAULT_CLAIM_LEASE_MS } from './queue.js';

/** What a handler is given (`02` §3.10.4). */
export interface JobContext<P> {
  readonly payload: P;
  readonly job: ClaimedJob;
  /** Fires at the kind's `timeoutMs`, while the lease is still valid. */
  readonly signal: AbortSignal;
  readonly store: Store;
  /**
   * Complete the job inside the handler's own transaction (`02` §3.10.2).
   *
   * A handler that mutates group state **must** use this rather than returning: its write and its
   * completion then commit together, and a `lease_lost` rolls both back. Returning instead would
   * let the work commit and the completion fail separately, after which the job runs again.
   */
  readonly completeIn: (uow: TxToken) => LeaseResult;
}

export type JobHandler<P> = (context: JobContext<P>) => Promise<void>;

export interface WorkerOptions {
  /**
   * Both halves of the queue.
   *
   * `JobQueue` for the loop's own writes — claim, heartbeat, fail — and `JobQueueTx` for the
   * `completeIn` it hands a handler. One object implements both (`SqliteJobQueue`), and asking for
   * both here is how the worker says it needs them rather than reaching into the store for one.
   */
  readonly queue: JobQueue & JobQueueTx;
  readonly registry: JobKindRegistry;
  readonly store: Store;
  readonly timers: Timers;
  readonly logger: Logger;
  readonly bootId: string;
  /** How a pool's kinds are handled. A kind with no handler is never claimed. */
  readonly handlers: ReadonlyMap<string, JobHandler<never>>;
  /** `02` §3.10.4's idle wait. Shorter in tests, where the clock is virtual. */
  readonly idleMs?: number | undefined;
}

/** `02` §3.10.4's idle wait: the loop wakes at least this often even with nothing happening. */
export const DEFAULT_IDLE_MS = 1_000;

/**
 * One pool's worker loop.
 *
 * Driven rather than self-starting: `tick()` is one pass, and `run()` loops until `stop()`. That
 * split is what makes the loop testable — a test calls `tick()` and asserts, where a loop that
 * owned its own `setInterval` could only be observed through sleeps.
 */
export class PoolWorker {
  readonly #options: WorkerOptions;
  readonly #pool: JobPool;
  readonly #limit: number;
  #inFlight = 0;
  #running = false;
  #wake: (() => void) | undefined;
  #idleTimer: TimerHandle | undefined;

  constructor(pool: JobPool, options: WorkerOptions) {
    this.#pool = pool;
    this.#options = options;
    this.#limit = POOL_LIMITS[pool];
  }

  /** How many of this pool's slots are busy, for `jobs_leased{pool}` (`02` §3.10.4). */
  get inFlight(): number {
    return this.#inFlight;
  }

  /**
   * `02` §3.10.4's `wakeEvent`: called from the `afterCommit` hook of any enqueue.
   *
   * Through `afterCommit` rather than from inside the transaction, because a wake that fired before
   * the commit would send the worker looking for a row it cannot see yet — and it would then wait
   * out the full idle interval before trying again.
   */
  wake(): void {
    this.#wake?.();
  }

  /**
   * One pass: claim what the pool has room for and start it.
   *
   * Returns the jobs started, so a test can assert on a round rather than on a sleep. The handlers
   * run detached — `02` §3.10.4's `run(job).finally(…)` — because a pass that awaited them would
   * make the pool's concurrency one.
   */
  tick(): readonly ClaimedJob[] {
    const free = this.#limit - this.#inFlight;
    if (free <= 0) return [];
    const kinds = this.#claimableKinds();
    if (kinds.length === 0) return [];
    const claimed = this.#options.queue.claim(this.#owner(), {
      kinds,
      max: free,
      leaseMs: this.#leaseFor(kinds),
      // `02` §3.10.3's extra exclusion, for the kinds whose definition asks for it. The worker is
      // where this can be known at all: the queue has no registry, because a kind's definition
      // lives with its owner.
      singleFlightKinds: kinds.filter(
        (kind) => this.#options.registry.def(kind)?.singleFlightByKey === true,
      ),
    });
    for (const job of claimed) {
      this.#inFlight += 1;
      void this.#run(job)
        // The last-resort handler, and the reason it exists is measured: `#run`'s own `try` starts
        // at the handler call, so anything before it — a `payload` column that is not JSON, or the
        // database refusing the write that records a failure (`SQLITE_BUSY`, `SQLITE_FULL`) —
        // became an **unhandled rejection**, and Node 26 ends the process on one. The lease then
        // expired, the job was re-claimed on the next boot, and it ended the process again: a
        // crash loop whose only visible cause was a stack trace. Now it is a line in the log and
        // one expired lease. Found by the M1 exit gate's reviewer.
        .catch((error: unknown) => {
          this.#options.logger.error('job.crashed', {
            jobId: job.id,
            jobKind: job.kind,
            partitionKey: job.partitionKey,
            attempt: job.attempts,
            err: toLoggedError(error),
          });
        })
        .finally(() => {
          this.#inFlight -= 1;
          this.wake();
        });
    }
    return claimed;
  }

  /**
   * Loop until `stop()`. Waits on a wake event, or the idle interval, between passes.
   *
   * The flag is read through a **method** rather than directly, and that is not style: TypeScript's
   * control-flow analysis narrows `this.#running` to `true` inside the loop, because it cannot see
   * that `stop()` mutates it from outside — so a direct read makes `no-unnecessary-condition`
   * correctly complain about a condition that is, as far as the types know, always true. The call
   * is the honest way to say "this value changes behind my back".
   */
  async run(): Promise<void> {
    this.#running = true;
    while (this.#isRunning()) {
      this.tick();
      if (!this.#isRunning()) break;
      await this.#waitForWork();
    }
  }

  #isRunning(): boolean {
    return this.#running;
  }

  stop(): void {
    this.#running = false;
    if (this.#idleTimer !== undefined) this.#options.timers.clearTimeout(this.#idleTimer);
    this.#wake?.();
  }

  /* ───────────────────────────── Internals ───────────────────────────── */

  /**
   * `02` §3.10.3's `lease_owner`: `${bootId}:${pool}:${slot}`.
   *
   * The slot is the count already in flight, which makes the owner distinct per concurrent claim
   * within a pool — enough for a log line to say which worker held a job. It is **not** a lock: the
   * fence is `attempts`, and two slots with the same name would still be unable to complete each
   * other's work.
   */
  #owner(): string {
    return `${this.#options.bootId}:${this.#pool}:${String(this.#inFlight)}`;
  }

  /** Only kinds with a registered definition **and** a handler: anything else is unrunnable. */
  #claimableKinds(): readonly string[] {
    return this.#options.registry
      .kindsInPool(this.#pool)
      .filter((kind) => this.#options.handlers.has(kind));
  }

  /**
   * The pool's lease: the **longest** among the kinds being claimed.
   *
   * `02` §3.10.3 binds one `leaseMs` per claim call, and the kinds in a pool can want different
   * ones — `backup.offsite` has a 900 s timeout. Taking the longest means a short-lease kind holds
   * its row a little longer than it needs; taking the shortest would expire a long handler's lease
   * while it was still inside its own budget, which is the failure that matters.
   */
  #leaseFor(kinds: readonly string[]): number {
    let longest = DEFAULT_CLAIM_LEASE_MS;
    for (const kind of kinds) {
      const def = this.#options.registry.def(kind);
      if (def !== undefined && def.leaseMs > longest) longest = def.leaseMs;
    }
    return longest;
  }

  async #run(job: ClaimedJob): Promise<void> {
    const def = this.#options.registry.def(job.kind);
    const handler = this.#options.handlers.get(job.kind);
    if (def === undefined || handler === undefined) {
      // Claimed and unrunnable. Only reachable if a handler was removed between the claim and
      // here, which a deploy can do — so it is a dead letter rather than a crash.
      this.#options.queue.fail(job, unrunnable(job.kind), { retryable: false });
      return;
    }

    // `JSON.parse` inside the guard, not above it: a `payload` column that is not JSON is the
    // same failure as one that does not match the schema — `02` §3.10.1's `JOB_PAYLOAD_INVALID ⇒
    // dead` — and it used to throw past every handler instead.
    const parsed = parsePayload(def, job.payload);
    if (!parsed.ok) {
      // `02` §3.10.1: `JOB_PAYLOAD_INVALID ⇒ dead`. Non-retryable, because the payload will not
      // start parsing on the next attempt and eight retries would hide the real cause.
      this.#options.logger.warn('job.payload_invalid', {
        jobId: job.id,
        jobKind: job.kind,
        partitionKey: job.partitionKey,
      });
      this.#options.queue.fail(job, payloadInvalid(job.kind), {
        retryable: false,
      });
      return;
    }

    const controller = new AbortController();
    const timeout = this.#options.timers.setTimeout(() => {
      controller.abort(new Error(`${job.kind} timed out`));
    }, def.timeoutMs);
    const heartbeat = this.#startHeartbeat(job, def);
    let completed = false;
    // Read through a function for the same reason as `#isRunning`: the flag is set inside the
    // handler's `completeIn`, across an `await`, and a direct read afterwards is narrowed to
    // `false` by control-flow analysis.
    const didComplete = (): boolean => completed;
    try {
      await handler({
        payload: parsed.value as never,
        job,
        signal: controller.signal,
        store: this.#options.store,
        completeIn: (uow: TxToken) => {
          completed = true;
          return this.#options.queue.completeIn(uow, job);
        },
      });
      // `02` §3.10.4: "if (!job.completed) queue.complete(job)". A handler that completed inside
      // its own transaction must not be completed again — the second call would find the fence
      // already satisfied by nothing and report `lease_lost`, which reads like a bug.
      if (!didComplete()) this.#options.queue.complete(job);
    } catch (error) {
      const info = errorInfoOf(error);
      this.#options.logger.warn('job.failed', {
        jobId: job.id,
        jobKind: job.kind,
        partitionKey: job.partitionKey,
        attempt: job.attempts,
        outcome: info.code,
      });
      this.#options.queue.fail(job, info, {
        retryable: info.retryable,
        ...(retryAfterOf(error) === undefined ? {} : { retryAfterMs: retryAfterOf(error) }),
      });
    } finally {
      this.#options.timers.clearTimeout(timeout);
      heartbeat();
    }
  }

  /**
   * Heartbeat at a third of the lease, returning the canceller.
   *
   * A third rather than a half: two missed ticks still leave room for a third, so one slow event
   * loop does not drop a lease out from under a handler that is working fine. Re-armed each time
   * rather than an interval, because `Timers` has no `setInterval` — and a chain of timeouts is
   * also what stops a backlog of ticks building up behind a blocked loop.
   */
  #startHeartbeat(job: ClaimedJob, def: JobKindDef<unknown>): () => void {
    let handle: TimerHandle | undefined;
    let stopped = false;
    const every = Math.max(1, Math.floor(def.leaseMs / 3));
    const beat = (): void => {
      if (stopped) return;
      // A lost lease stops the heartbeat rather than keeping it alive: somebody else owns the
      // attempt now, and extending a lease we do not hold would be extending theirs.
      if (this.#options.queue.heartbeat(job, def.leaseMs) === 'lease_lost') return;
      handle = this.#options.timers.setTimeout(beat, every);
    };
    handle = this.#options.timers.setTimeout(beat, every);
    return () => {
      stopped = true;
      if (handle !== undefined) this.#options.timers.clearTimeout(handle);
    };
  }

  /** `02` §3.10.4: "wait until (wakeEvent | nextDueAt | 1000 ms)". */
  async #waitForWork(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.#wake = undefined;
        resolve();
      };
      this.#wake = finish;
      this.#idleTimer = this.#options.timers.setTimeout(
        finish,
        this.#options.idleMs ?? DEFAULT_IDLE_MS,
      );
    });
  }
}

/** Every pool's worker, which is what `apps/server` starts (`02` §3.10.4). */
export function makeWorkers(options: WorkerOptions): readonly PoolWorker[] {
  return (Object.keys(POOL_LIMITS) as JobPool[]).map((pool) => new PoolWorker(pool, options));
}

/**
 * A job's payload, parsed from the column and checked against its kind's schema.
 *
 * Both failures are the same failure. `02` §3.10.1 maps `JOB_PAYLOAD_INVALID` to *dead*, and a
 * `payload` column that is not JSON at all is no more retryable than one that parses into the
 * wrong shape — but `JSON.parse` threw past the caller instead of landing here, which the M1 exit
 * gate's reviewer traced to a crash loop. A row can outlive the code that wrote it, so this is
 * reachable by an upgrade and not only by a bug.
 */
function parsePayload(
  def: { readonly payload: z.ZodType },
  payload: string,
): Result<unknown, ValidationError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload) as unknown;
  } catch (cause) {
    return err(
      new ValidationError('a job payload is not JSON', [
        { path: 'payload', message: (cause as Error).message.slice(0, 200) },
      ]),
    );
  }
  return parse(def.payload, decoded);
}

function payloadInvalid(kind: string): ErrorInfo {
  return {
    code: JOB_PAYLOAD_INVALID,
    // Bounded and content-free: `02` §3.3.9 forbids content in `last_error`, and a payload's own
    // values are exactly what a validation message tends to quote.
    message: `${kind} payload did not match its schema`,
    retryable: false,
    at: new Date().toISOString(),
  };
}

function unrunnable(kind: string): ErrorInfo {
  return {
    code: 'JOB_HANDLER_MISSING',
    message: `no handler is registered for ${kind}`,
    retryable: false,
    at: new Date().toISOString(),
  };
}

/**
 * A platform's `Retry-After`, when the thrown error carries one (`02` §3.10.3).
 *
 * **Both shapes**, because the two error types that carry one disagree about where it lives.
 * `ModelCallError` puts it in `detail.retryAfterMs` (`01` §7.5) and a channel's send error puts it
 * at the top level. This read only the top level, so a provider 429 on a background route — every
 * `extract`, `consolidate` and `embed` job — got the queue's own jittered backoff instead of the
 * time the provider asked for. Found at the M2 second-pass review, which measured
 * `new ModelCallError('rate_limited', 'anthropic', { retryAfterMs: 4000 }).retryAfterMs` as
 * `undefined` while `.detail.retryAfterMs` was 4000.
 *
 * `computeBackoff` takes the larger of the two, so honouring it can only ever delay a retry, never
 * hurry one — which is the safe direction when a provider has told us it is overloaded.
 */
function retryAfterOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const shaped = error as { retryAfterMs?: unknown; detail?: { retryAfterMs?: unknown } };
  return positiveMs(shaped.retryAfterMs) ?? positiveMs(shaped.detail?.retryAfterMs);
}

function positiveMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
