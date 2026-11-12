/**
 * `queue.model-based` (`M1-T23`; `02` §3.10, §9.2, `11` §3.1.6).
 *
 * The acceptance criterion: a model-based `fc.commands` suite over **enqueue, lease, complete,
 * fail, expire and recover**, asserting *no double-run*, *idempotency respected* and *bounded
 * backoff*.
 *
 * ## Why a model rather than a list of cases
 *
 * Every individual transition is easy to test and all of them are already covered in
 * `queue.contract.test.ts`. What a queue gets wrong is the *interleaving*: a lease that expires
 * while its handler is finishing, a retry that lands after a recovery, a dead letter re-queued
 * while a stale worker still holds a reference. Those sequences are not something anybody writes
 * down — which is precisely `11` §3.1.6's reason for making the queue one of the mandatory
 * model-based suites.
 *
 * ## The model
 *
 * A dictionary from job id to `{ status, attempts, runs }`, where `runs` counts **completions**.
 * The three invariants are checked after every command, against the database:
 *
 *  - **No double-run.** `runs ≤ 1` for every job. A job completed twice has run twice, and in
 *    production that is a reminder sent twice or a consolidation that merged the same messages
 *    into two memory sets.
 *  - **Idempotency respected.** One row per idempotency key, always.
 *  - **Bounded backoff.** A requeued job's `run_at` is inside `[now + base/2, now + cap]`, so no
 *    sequence of failures can produce either a hot loop or a job scheduled past the heat death.
 */
import type { ClaimedJob, JobKindDef } from '@comvivo/core';
import { JOB_BACKOFF } from '@comvivo/core';
import { z } from '@comvivo/shared';
import { fcConfig, fcTimeoutMs } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { JobKindRegistry } from '../queue/kinds.js';
import { withRepos } from '../repos/testing/harness.js';

const PayloadSchema = z.object({ n: z.int().min(0) });
type Payload = z.infer<typeof PayloadSchema>;
const KIND = 'embed.items';
const LEASE_MS = 5_000;

/** What the model believes about one job. */
interface ModelJob {
  status: 'queued' | 'leased' | 'succeeded' | 'dead';
  attempts: number;
  /** Completions. The invariant is that this never exceeds one. */
  runs: number;
}

interface Model {
  readonly jobs: Map<string, ModelJob>;
  /** Idempotency key → job id, which the model uses to predict `duplicate`. */
  readonly byKey: Map<string, string>;
  /** Claimed jobs this worker still holds a reference to, including stale ones. */
  readonly held: ClaimedJob[];
  next: number;
}

type World = Parameters<Parameters<typeof withRepos>[0]>[0];

interface System {
  readonly world: World;
  readonly def: JobKindDef<Payload>;
}

/* ──────────────────────────────── Commands ──────────────────────────────── */

class Enqueue implements fc.Command<Model, System> {
  constructor(
    private readonly key: string | undefined,
    private readonly partition: 0 | 1,
  ) {}

  check(): boolean {
    return true;
  }

  run(model: Model, system: System): void {
    const partitionKey = this.partition === 0 ? system.world.groupId : system.world.otherGroupId;
    const result = system.world.store.write((uow) =>
      system.world.repos.jobs.enqueue(uow, system.def, {
        partitionKey,
        payload: { n: model.next },
        ...(this.key === undefined ? {} : { idempotencyKey: this.key }),
      }),
    );
    model.next += 1;
    if (this.key !== undefined && model.byKey.has(this.key)) {
      // Idempotency respected: the same key must answer `duplicate` with the same id, forever —
      // keys stay unique until the row is swept (`02` §3.10.2: seven days for succeeded rows), so
      // a dead or completed job does **not** free its key.
      expect(result.kind).toBe('duplicate');
      expect(result.id).toBe(model.byKey.get(this.key));
      return;
    }
    expect(result.kind).toBe('enqueued');
    model.jobs.set(result.id, { status: 'queued', attempts: 0, runs: 0 });
    if (this.key !== undefined) model.byKey.set(this.key, result.id);
  }

  toString(): string {
    return `enqueue(${this.key ?? '-'}, p${String(this.partition)})`;
  }
}

class Claim implements fc.Command<Model, System> {
  constructor(private readonly max: number) {}

  check(): boolean {
    return true;
  }

  run(model: Model, system: System): void {
    const claimed = system.world.repos.jobs.claim('boot-01:embed:0', {
      kinds: [KIND],
      max: this.max,
      leaseMs: LEASE_MS,
    });
    for (const job of claimed) {
      const tracked = model.jobs.get(job.id);
      expect(tracked, 'the queue returned a job the model never enqueued').toBeDefined();
      if (tracked === undefined) continue;
      // The claim is the only thing that moves `attempts`, which is what makes it the fencing
      // token: it changes exactly when ownership does.
      expect(job.attempts).toBe(tracked.attempts + 1);
      tracked.attempts = job.attempts;
      tracked.status = 'leased';
      model.held.push(job);
    }
    // At most one per partition per round (`rn = 1`), whatever `max` asked for.
    expect(new Set(claimed.map((job) => job.partitionKey)).size).toBe(claimed.length);
  }

  toString(): string {
    return `claim(${String(this.max)})`;
  }
}

class Complete implements fc.Command<Model, System> {
  constructor(private readonly which: number) {}

  check(model: Model): boolean {
    return model.held.length > 0;
  }

  run(model: Model, system: System): void {
    const job = pick(model.held, this.which);
    const tracked = model.jobs.get(job.id);
    const outcome = system.world.repos.jobs.complete(job);
    // The fence decides: a worker whose reference is stale — the lease expired and the job was
    // re-claimed — gets `lease_lost` and changes nothing. Predicting it from the model is the
    // whole test: the model knows the current attempt, so it knows whose reference is live.
    const live =
      tracked !== undefined && tracked.status === 'leased' && tracked.attempts === job.attempts;
    expect(outcome).toBe(live ? 'ok' : 'lease_lost');
    if (live && tracked !== undefined) {
      tracked.status = 'succeeded';
      tracked.runs += 1;
    }
  }

  toString(): string {
    return `complete(${String(this.which)})`;
  }
}

class Fail implements fc.Command<Model, System> {
  constructor(
    private readonly which: number,
    private readonly retryable: boolean,
  ) {}

  check(model: Model): boolean {
    return model.held.length > 0;
  }

  run(model: Model, system: System): void {
    const job = pick(model.held, this.which);
    const tracked = model.jobs.get(job.id);
    const before = system.world.repos.jobs.job(job.id);
    const outcome = system.world.repos.jobs.fail(
      job,
      { code: 'X', message: 'generated', retryable: this.retryable, at: new Date().toISOString() },
      { retryable: this.retryable },
    );
    const live =
      tracked !== undefined && tracked.status === 'leased' && tracked.attempts === job.attempts;
    if (!live) {
      expect(outcome).toBe('lease_lost');
      return;
    }
    if (tracked === undefined) return;
    const spent = job.attempts >= job.maxAttempts;
    const dead = !this.retryable || spent;
    expect(outcome).toBe(dead ? 'dead' : 'requeued');
    tracked.status = dead ? 'dead' : 'queued';
    if (dead) return;

    // **Bounded backoff.** Equal jitter, so the delay is in `[d/2, d]` where `d = min(cap,
    // base · 2^(attempts−1))`. Checked against the row rather than recomputed, because recomputing
    // it with the same formula would prove only that the formula equals itself.
    const after = system.world.repos.jobs.job(job.id);
    const waited =
      (after?.runAt.epochMilliseconds ?? 0) -
      (before?.leaseUntil?.epochMilliseconds ?? 0) +
      LEASE_MS;
    expect(
      waited,
      `attempt ${String(job.attempts)} backed off out of range`,
    ).toBeGreaterThanOrEqual(Math.floor(ceiling(job.attempts) / 2) - 1);
    expect(waited).toBeLessThanOrEqual(ceiling(job.attempts) + 1_000);
  }

  toString(): string {
    return `fail(${String(this.which)}, ${this.retryable ? 'retryable' : 'permanent'})`;
  }
}

/** `02` §3.10.3's lease recovery: a handler that hung, or a process that went away. */
class Recover implements fc.Command<Model, System> {
  constructor(private readonly bootId: string) {}

  check(model: Model): boolean {
    return [...model.jobs.values()].some((job) => job.status === 'leased');
  }

  run(model: Model, system: System): void {
    const recovered = system.world.repos.jobs.recoverExpiredLeases(this.bootId);
    const leased = [...model.jobs.values()].filter((job) => job.status === 'leased');
    if (this.bootId === 'boot-01') {
      // This incarnation's own leases are not recovered while they are still valid. `LEASE_MS` is
      // 5 s and the suite runs in milliseconds, so none of them has expired.
      expect(recovered).toBe(0);
      return;
    }
    // A different incarnation: every lease belongs to a process that is gone, so all of them come
    // back at once — `02` §3.10.3's `lease_owner NOT LIKE :bootId || ':%'`.
    expect(recovered).toBe(leased.length);
    for (const job of leased) job.status = 'queued';
  }

  toString(): string {
    return `recover(${this.bootId})`;
  }
}

/** `02` §3.10.3's `retryDead`, from the CLI. The one command that resets the attempt budget. */
class RetryDead implements fc.Command<Model, System> {
  constructor(private readonly which: number) {}

  check(model: Model): boolean {
    return [...model.jobs.values()].some((job) => job.status === 'dead');
  }

  run(model: Model, system: System): void {
    const dead = [...model.jobs.entries()].filter(([, job]) => job.status === 'dead');
    const entry = pick(dead, this.which);
    const [id, tracked] = entry;
    expect(system.world.repos.jobs.retryDead(id as never)).toBe('requeued');
    tracked.status = 'queued';
    tracked.attempts = 0;
    // The run count is **not** reset: a job that already completed cannot be dead, so a retried
    // dead job has never run — and if this ever reset a non-zero count it would hide a double-run.
    expect(tracked.runs).toBe(0);
  }

  toString(): string {
    return `retryDead(${String(this.which)})`;
  }
}

/* ──────────────────────────────── The property ──────────────────────────────── */

const commands = [
  fc
    .tuple(fc.option(fc.constantFrom('k1', 'k2', 'k3'), { nil: undefined }), fc.constantFrom(0, 1))
    .map(([key, partition]) => new Enqueue(key, partition as 0 | 1)),
  fc.integer({ min: 1, max: 3 }).map((max) => new Claim(max)),
  fc.nat(5).map((which) => new Complete(which)),
  fc.tuple(fc.nat(5), fc.boolean()).map(([which, retryable]) => new Fail(which, retryable)),
  fc.constantFrom('boot-01', 'boot-02').map((bootId) => new Recover(bootId)),
  fc.nat(5).map((which) => new RetryDead(which)),
];

describe('queue.model-based (02 §9.2, 11 §3.1.6)', { tags: ['prop', 'db'] }, () => {
  // The timeout scales with the run count, because the M1 exit gate runs this suite at
  // `FC_NUM_RUNS=20000` by name and a fixed limit cannot survive that: measured at **11 ms per
  // run** (500 runs in 5.5 s, each a model-based run against a real database), 20,000 runs take
  // about four minutes. Before this, the gate's own command failed on a 30-second timeout while
  // the property itself passed — `fc.assert` is synchronous, so Vitest could only report the
  // overrun after the fact. 25 ms per run is the measured cost with margin for a slower runner.
  it('never double-runs, respects idempotency, and bounds every backoff', {
    timeout: fcTimeoutMs(25),
  }, () => {
    fc.assert(
      fc.property(fc.commands(commands, { maxCommands: 40 }), (run) => {
        withRepos((world) => {
          const registry = new JobKindRegistry();
          const def = registry.register(KIND, PayloadSchema);
          const model: Model = { jobs: new Map(), byKey: new Map(), held: [], next: 0 };
          fc.modelRun(() => ({ model, real: { world, def } }), run);

          // ── The invariants, checked once over the final state as well as inside each command.
          for (const [id, tracked] of model.jobs) {
            // **No double-run.** The one that matters: a job completed twice has run twice, which
            // in production is a reminder sent twice or a consolidation merging the same messages
            // into two memory sets.
            expect(tracked.runs, `${id} ran more than once`).toBeLessThanOrEqual(1);
            const row = world.repos.jobs.job(id as never);
            expect(row?.status, `${id} drifted from the model`).toBe(tracked.status);
            expect(row?.attempts).toBe(tracked.attempts);
            // No job exceeds its budget: the dead letter is what bounds the work, and an
            // off-by-one would be a job retried forever.
            expect(row?.attempts ?? 0).toBeLessThanOrEqual(def.maxAttempts);
          }
          // **Idempotency respected**, as a property of the table rather than of the model: one row
          // per key, whatever sequence produced it.
          const keyed = world.db
            .prepare(
              'SELECT idempotency_key, count(*) AS n FROM jobs WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key',
            )
            .all() as { idempotency_key: string; n: number }[];
          for (const row of keyed) {
            expect(row.n, `${row.idempotency_key} has ${String(row.n)} rows`).toBe(1);
          }
        });
      }),
      fcConfig(),
    );
  });
});

/** `d = min(cap, base · 2^(attempts−1))` — the ceiling the equal jitter halves. */
function ceiling(attempts: number): number {
  return Math.min(JOB_BACKOFF.capMs, JOB_BACKOFF.baseMs * 2 ** Math.max(0, attempts - 1));
}

/** A deterministic pick from a non-empty list, so a shrunk counterexample replays. */
function pick<T>(items: readonly T[], which: number): T {
  const item = items[which % items.length];
  if (item === undefined) throw new Error('pick on an empty list');
  return item;
}
