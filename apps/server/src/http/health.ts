/**
 * What `/healthz` and `/readyz` answer from (`09` §3.8; `12` §4.3; `01` §14 **A15**; `M3-T14`).
 *
 * ## The one rule that shapes this module
 *
 * **`/healthz` touches no database.** `09` §3.8 says so twice — "No DB access per request (cached
 * state)" and "served before migrations finish" — and the reason is what liveness is *for*: a
 * watchdog asks "is this process worth keeping?", and a probe that queried a locked database would
 * answer "no" during the migration it is meant to protect, and the watchdog would kill the
 * migration. So liveness reads a **cached** `HealthState` that the boot sequence and the shutdown
 * path write, plus one in-process measurement (the event-loop delay).
 *
 * `/readyz` is the opposite and may block: it is "can this serve traffic?", asked by a wait loop
 * and a reverse proxy, and its whole value is that it actually checks. It runs the probes `09`
 * §3.8 lists.
 *
 * ## Why liveness stays 200 in recovery mode
 *
 * `09` §3.8 and `12` §4.3 both say recovery mode is `degraded` with `phase: 'recovery'` — a **200**
 * — while `/readyz` is 503. That looks inconsistent and is the most carefully chosen pair of
 * statuses here: restarting a process that has entered recovery mode would not help, because the
 * database is still damaged, so a 503 on liveness would produce an endless restart loop that never
 * reaches the host's attention. Readiness says "do not send traffic", which is the true statement.
 *
 * ## Channels never fail readiness
 *
 * `01` §14 A15 and `09` §3.8: a Telegram outage is not this instance being unready. It is listed in
 * `degraded[]` and that is all. A readiness probe that failed on it would take the whole instance
 * out of a reverse proxy because somebody else's API was down.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** `09` §3.8's five liveness statuses. */
export const HEALTH_STATUSES = ['ok', 'starting', 'degraded', 'draining', 'fail'] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** `12` §3.8.1's boot steps 6–9, plus recovery mode, as a phase a watchdog can read. */
export const HEALTH_PHASES = ['migrating', 'backing-up', 'recovering', 'recovery'] as const;

export type HealthPhase = (typeof HEALTH_PHASES)[number];

/** Which statuses are 200 (`09` §3.8; `12` §4.3). A total mapping, not a comparison. */
const IS_LIVE: Readonly<Record<HealthStatus, boolean>> = {
  ok: true,
  starting: true,
  // Recovery mode included: a restart would not fix a damaged database, so liveness stays 200 and
  // `/readyz` is what says "no traffic". See the module header.
  degraded: true,
  draining: false,
  fail: false,
};

export function isLive(status: HealthStatus): boolean {
  return IS_LIVE[status];
}

/** A channel's connection state (`12` §4.3's `channels` map). */
export const CHANNEL_STATES = ['connected', 'connecting', 'auth_failed', 'disabled'] as const;

export type ChannelState = (typeof CHANNEL_STATES)[number];

/**
 * The cached state `/healthz` reads.
 *
 * Every field is set by the process itself — boot, shutdown, the adapter host, the backup job — and
 * none is derived from a query. `02`'s database is deliberately absent from this type: a field that
 * needed a read would make the no-DB rule a convention rather than a property.
 */
export interface HealthSnapshot {
  readonly status: HealthStatus;
  readonly phase: HealthPhase | undefined;
  readonly version: string;
  readonly startedAt: number;
  /** `12` §4.3's `channels`. A map rather than a list, so a probe can name the one that is down. */
  readonly channels: Readonly<Record<string, ChannelState>>;
  /** When a backup last succeeded and was last verified, in epoch ms. */
  readonly backups: { readonly lastSuccessAt?: number; readonly lastVerifyAt?: number };
}

/** `09` §3.8: a backup older than this makes the instance `degraded`. */
export const STALE_BACKUP_MS = 36 * 60 * 60 * 1000;

/**
 * `09` §3.8's event-loop rule: p99 delay over 5 s in the last 30 s means `fail`.
 *
 * A stalled loop is the one condition a restart genuinely fixes, which is why it is the only
 * measurement liveness takes — and why it is a measurement rather than a flag. A process wedged in
 * a synchronous loop cannot set a flag saying so.
 */
export const EVENT_LOOP_FAIL_MS = 5_000;

/**
 * The event-loop monitor, resettable so the window means what `09` §3.8 says.
 *
 * `monitorEventLoopDelay`'s histogram is cumulative, so without a reset a single 6 s stall at boot
 * would hold the p99 over the threshold for the life of the process — and liveness would report
 * `fail` forever for something that has passed. `reset()` on each read gives a window since the
 * previous probe, which is the closest honest reading of "the last 30 s" without a second timer,
 * and a watchdog polls far more often than every 30 s.
 */
export interface EventLoopProbe {
  /** The p99 delay in milliseconds since the last call, or `0` before the first. */
  p99Ms(): number;
}

export function nodeEventLoopProbe(): EventLoopProbe {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return {
    p99Ms(): number {
      // Nanoseconds in the histogram, milliseconds in the contract.
      const p99 = histogram.percentile(99) / 1e6;
      histogram.reset();
      return Number.isFinite(p99) ? p99 : 0;
    },
  };
}

/**
 * The mutable holder the process writes and `/healthz` reads.
 *
 * A class with one method per transition rather than a settable object, because the transitions are
 * the contract: `draining()` is one-way (a process that un-drained would be lying to the load
 * balancer that already stopped sending it traffic) and `fail()` is one-way for the same reason.
 */
export class HealthState {
  #status: HealthStatus = 'starting';
  #phase: HealthPhase | undefined;
  readonly #version: string;
  readonly #startedAt: number;
  #channels: Record<string, ChannelState> = {};
  #backups: { lastSuccessAt?: number; lastVerifyAt?: number } = {};
  readonly #now: () => number;

  constructor(options: { readonly version: string; readonly now?: () => number }) {
    this.#version = options.version;
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
  }

  /** `12` §3.8.1 steps 6–9: still booting, with the step a watchdog should wait through. */
  starting(phase: HealthPhase): void {
    if (this.#terminal()) return;
    this.#status = 'starting';
    this.#phase = phase;
  }

  /** Boot step 9 finished. */
  ready(): void {
    if (this.#terminal()) return;
    this.#status = 'ok';
    this.#phase = undefined;
  }

  /**
   * `09` §3.8's recovery mode: `degraded`, phase `recovery`, and liveness stays 200.
   *
   * Its own method rather than `starting('recovery')`, because the status differs: a host in
   * recovery mode is not booting towards `ok`, and a watchdog that treated it as `starting` would
   * eventually time out and restart a process whose database is damaged.
   */
  recovery(): void {
    if (this.#terminal()) return;
    this.#status = 'degraded';
    this.#phase = 'recovery';
  }

  /** Shutdown has begun. One-way: `09` §3.8's `draining` is 503 and does not come back. */
  draining(): void {
    if (this.#status === 'fail') return;
    this.#status = 'draining';
    this.#phase = undefined;
  }

  /** An unrecoverable database error. One-way, and 503. */
  fail(): void {
    this.#status = 'fail';
    this.#phase = undefined;
  }

  /** The adapter host's report. `auth_failed` makes the instance `degraded` (`01` §14 A15). */
  channel(id: string, state: ChannelState): void {
    this.#channels = { ...this.#channels, [id]: state };
  }

  backupSucceeded(at: number): void {
    this.#backups = { ...this.#backups, lastSuccessAt: at };
  }

  backupVerified(at: number): void {
    this.#backups = { ...this.#backups, lastVerifyAt: at };
  }

  /**
   * The snapshot, with the derived degradations applied.
   *
   * `09` §3.8 lists three things that make an otherwise-`ok` instance `degraded`: a channel in
   * `auth_failed`, a backup older than 36 hours, and recovery mode. The first two are derived here
   * rather than set by whoever noticed, so they cannot be set and then forgotten — a channel that
   * reconnects clears its own degradation by changing its state.
   */
  snapshot(): HealthSnapshot {
    const degraded =
      this.#status === 'ok' && (this.#hasChannelAuthFailure() || this.#backupIsStale());
    return {
      status: degraded ? 'degraded' : this.#status,
      phase: this.#phase,
      version: this.#version,
      startedAt: this.#startedAt,
      channels: { ...this.#channels },
      backups: { ...this.#backups },
    };
  }

  /** `draining` and `fail` are one-way, so every other transition checks them together. */
  #terminal(): boolean {
    return this.#status === 'draining' || this.#status === 'fail';
  }

  #hasChannelAuthFailure(): boolean {
    return Object.values(this.#channels).includes('auth_failed');
  }

  #backupIsStale(): boolean {
    const last = this.#backups.lastSuccessAt;
    // **Never backed up is not stale.** A fresh install has no backup and is not degraded for it;
    // `doctor` is what nags about setting one up. Treating absence as stale would make every new
    // instance report `degraded` for its first 36 hours, which is how a status gets ignored.
    if (last === undefined) return false;
    return this.#now() - last > STALE_BACKUP_MS;
  }
}

/** One `/readyz` check (`09` §3.8). `id` is what a 503 body lists. */
export interface ReadinessCheck {
  readonly id: string;
  /**
   * Whether a failure is fatal to readiness.
   *
   * `09` §3.8 makes "dashboard assets are present" a **warning only**, and channels are listed in
   * `degraded[]` and never fail readiness (`01` §14 A15). So this is a property of the check and
   * not a decision at the call site, which is what stops a future check from quietly becoming
   * fatal.
   */
  readonly fatal: boolean;
  run(): Promise<boolean> | boolean;
}

export interface ReadinessResult {
  readonly ready: boolean;
  /** Failing fatal checks, by id. `09` §3.8: "a problem with failing check IDs only". */
  readonly failing: readonly string[];
  /** Failing non-fatal checks, and every channel that is not connected. */
  readonly degraded: readonly string[];
}

/**
 * Run the readiness checks (`09` §3.8).
 *
 * Every check runs, even after one has failed. A probe that stopped at the first failure would
 * report one id per attempt, and a host restarting between attempts would chase them one at a time
 * — `09` §3.8's body is a *list* for that reason.
 */
export async function runReadiness(
  checks: readonly ReadinessCheck[],
  snapshot: HealthSnapshot,
): Promise<ReadinessResult> {
  const failing: string[] = [];
  const degraded: string[] = [];
  for (const check of checks) {
    let passed = false;
    try {
      passed = await check.run();
    } catch {
      // A throwing check is a failing check. Swallowed rather than propagated because `/readyz`'s
      // job is to answer: a 500 from the readiness probe tells a wait loop nothing it can act on,
      // where a 503 naming the check tells it everything.
      passed = false;
    }
    if (passed) continue;
    (check.fatal ? failing : degraded).push(check.id);
  }
  // Channels, which `01` §14 A15 keeps out of readiness entirely. Listed so the dashboard and the
  // CLI can show them from the same place the probe read.
  for (const [id, state] of Object.entries(snapshot.channels)) {
    if (state !== 'connected') degraded.push(`channel:${id}`);
  }
  return { ready: failing.length === 0, failing, degraded };
}
