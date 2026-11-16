/**
 * The multi-key rate limiter (`06` §3.14; `M3-T7`).
 *
 * `06` §3.14: "`RateLimiter.acquire(keys, cost, priority, signal)` waits on **all** buckets
 * atomically." Atomically is the whole problem. A send to a Telegram group is limited three ways at
 * once — 25 a second overall, 20 a minute to that group, and whatever the method's own bucket says
 * — and taking them one at a time is wrong in a way that only shows up under load: a waiter that
 * takes the global token, then finds the per-chat bucket empty, has spent a token it cannot use and
 * has to either hold it (starving everyone else) or return it (and the accounting drifts). So a
 * token is taken from **every** bucket in the set or from none, in one synchronous step.
 *
 * ## No starvation, and where it actually comes from
 *
 * `M3-T7`'s AC asks for a property: "the rate is never exceeded **and interactive work is never
 * starved**". The first half is the atomic take. The second half has two parts, and working out
 * which did the work took a test that failed.
 *
 * **For acquires of equal cost, the scan order is the whole guarantee.** `#pump` walks
 * `scheduler.ts`'s order — priority, then round-robin across chats, then FIFO — and serves the
 * first waiter that can pay. Two waiters sharing a key and asking for the same cost either can both
 * pay it or neither can, so a lower-priority waiter can only ever be served ahead of a blocked
 * higher-priority one on a key they do **not** share: the reply blocked on its own chat's bucket
 * while a digest goes to a different chat. That is correct, and when the reply's own bucket refills
 * it is examined first and takes what it needs. Its wait is bounded by its own binding bucket.
 *
 * **For acquires of unequal cost, the scan order is not enough**, and this is what the reservation
 * is for. A waiter asking for 3 tokens of a bucket holding 1 is blocked while a waiter asking for 1
 * is not, so a stream of small acquires starves a large one indefinitely — at any priority, which
 * makes it the sharper failure of the two. So a blocked waiter **reserves the keys that are
 * blocking it** against everything later in the order, and the large acquire is served as soon as
 * its bucket reaches the level it asked for.
 *
 * Reserving only the **binding** keys is what keeps this from becoming head-of-line blocking. An
 * earlier version reserved every key a blocked waiter held, which meant one chat's exhausted bucket
 * stopped every other chat through the shared `global` key — the exact failure the round-robin in
 * `scheduler.ts` exists to prevent, reintroduced one layer up.
 *
 * ## Why there are no real timers in here
 *
 * `Timers` is injected (`shared/ports/clock.ts`) and `channel-sdk-purity` bans `setTimeout` in this
 * package outright. `VirtualClock` implements `Clock` and `Timers` together, so the whole of
 * `M3-T7`'s test suite runs in virtual time: a 3-second refill interval, a 60-second retry cap and
 * an hour of a group's traffic all cost microseconds and are exactly reproducible. A limiter tested
 * against the wall clock is tested at one point per second of test runtime, which is to say barely.
 */
import type { Clock, TimerHandle, Timers } from '@comvivo/shared';
import { getMetrics } from '@comvivo/shared/observability';
import type { Temporal } from 'temporal-polyfill';
import type { ChannelId, Priority } from '../contract.js';
import { type BucketSpec, TokenBucket } from './bucket.js';
import { FairQueue, type Waiter } from './scheduler.js';

/** A bucket's name. Built with {@link bucketKeys} so the lane convention is not a spelling. */
export type BucketKey = string;

/** The prefix that makes a key a chat's, which is what `06` §3.14 round-robins across. */
export const CHAT_KEY_PREFIX = 'chat:';

/**
 * The key vocabulary of `06` §3.14's table.
 *
 * A builder rather than a convention in prose, because two things depend on the spelling and
 * neither fails loudly if an adapter gets it wrong: the round-robin lane is the `chat:` key, and
 * the `scope` label on the wait histogram is the key's prefix. An adapter that wrote `chat-42`
 * would silently lose fairness between chats and report every wait as `other`.
 */
export const bucketKeys = {
  /** The platform-wide bucket: Telegram's 25/s, Slack's 3/s workspace cap. */
  global: 'global' as BucketKey,
  chat: (platformChatId: string): BucketKey => `${CHAT_KEY_PREFIX}${platformChatId}`,
  method: (name: string): BucketKey => `method:${name}`,
  route: (name: string): BucketKey => `route:${name}`,
} as const;

/** The label on the wait histogram: which kind of limit was binding. */
function scopeOf(key: BucketKey): string {
  if (key === bucketKeys.global) return 'global';
  const prefix = key.indexOf(':');
  return prefix === -1 ? 'other' : key.slice(0, prefix);
}

export interface RateLimiterDeps {
  readonly channel: ChannelId;
  readonly clock: Clock;
  readonly timers: Timers;
  /**
   * The spec for a key, or `null` for a key with no limit.
   *
   * `null` rather than a huge capacity, because `06` §3.14's last row is "Web / Simulator: none" and
   * a very large bucket is still a bucket: it allocates, it is pruned, and it turns a test about
   * unlimited sends into a test about a number somebody chose.
   */
  specFor(key: BucketKey): BucketSpec | null;
}

interface Pending extends Waiter {
  readonly keys: readonly BucketKey[];
  readonly cost: number;
  readonly queuedAt: number;
  resolve(): void;
  reject(reason: Error): void;
  /** Detaches the abort listener. Called exactly once, when the waiter leaves the queue. */
  release(): void;
}

/**
 * Whatever was thrown, as an `Error`.
 *
 * Everything this module throws already is one — a `RangeError` for a cost above a capacity, the
 * close reason, the signal's own `AbortError` — so this is the belt for a host that aborted with
 * something else, and it is what lets every rejection path be typed `Error` rather than `unknown`.
 */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Buckets held before a prune is considered.
 *
 * A bucket is three numbers, so this is not about memory — it is that `chat:` keys come from the
 * platform, so the map is keyed by input we do not control. A bot in a large Slack workspace sees
 * every channel it is invited to.
 */
const PRUNE_ABOVE = 256;

export class RateLimiter {
  readonly #deps: RateLimiterDeps;
  readonly #buckets = new Map<BucketKey, TokenBucket>();
  readonly #queue = new FairQueue<Pending>();
  #timer: TimerHandle | null = null;
  #timerDueAt: number | null = null;
  #closed: Error | null = null;

  constructor(deps: RateLimiterDeps) {
    this.#deps = deps;
  }

  /** How many waiters are queued. For a test, and for `09`'s diagnostics. */
  get waiting(): number {
    return this.#queue.size;
  }

  /**
   * Wait until every key can pay `cost`, then take it from all of them.
   *
   * Resolves immediately when nothing is limited or everything can pay **and nobody is queued**.
   * That last clause is the whole of the fairness guarantee at the front door: without it a fresh
   * arrival takes the token a queued waiter has been waiting for, and under sustained load the
   * queue never drains — the classic unfairness of a lock with no queue, where the unlucky waiter
   * is starved by a stream of lucky ones.
   */
  acquire(
    keys: readonly BucketKey[],
    cost = 1,
    priority: Priority = 'scheduled',
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      if (this.#closed !== null) throw this.#closed;
      signal?.throwIfAborted();
      const limited = this.#limited(keys);
      if (limited.length === 0) return Promise.resolve();

      const now = this.#deps.clock.now();
      // Validated before anything is queued: a cost above a bucket's capacity can never be paid,
      // so queueing it would hold that key reserved against every later waiter and read as a hang.
      const wait = this.#waitMs(limited, cost, now);
      if (this.#queue.size === 0 && wait === 0) {
        this.#take(limited, cost, now);
        this.#observe(limited, 0, now);
        return Promise.resolve();
      }
      return this.#enqueue(limited, cost, priority, now, signal);
    } catch (error) {
      // `acquire` hands back a promise, so every failure has to arrive *through* it: a synchronous
      // throw would escape a caller who only wrote `.catch()`, on the paths most likely to be
      // mishandled — a cost above a capacity, and an already-aborted signal.
      return Promise.reject(asError(error));
    }
  }

  /**
   * Reject every waiter and stop the timer.
   *
   * An adapter's `stop()` aborts `ctx.signal`, which every caller passes, so in production this is
   * belt and braces. It matters in a test: a pending virtual timer is a leak `VirtualClock.pending`
   * reports, and a limiter nobody closed keeps one for ever.
   */
  close(reason: Error = new Error('the rate limiter is closed')): void {
    this.#closed = reason;
    this.#clearTimer();
    for (const waiter of this.#queue.order()) {
      this.#queue.remove(waiter);
      waiter.release();
      waiter.reject(reason);
    }
  }

  /**
   * Drop full buckets that nobody is waiting on.
   *
   * Safe by construction rather than by care: a full bucket holds no information a fresh one does
   * not, because a new `TokenBucket` starts at capacity. So dropping one is **unobservable**, which
   * is the only kind of cache eviction worth having in a rate limiter — evicting a partly-drained
   * bucket would hand back a burst the platform never granted.
   */
  prune(): number {
    const now = this.#deps.clock.now();
    let dropped = 0;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.isFull(now)) {
        this.#buckets.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** The keys that have a limit, deduplicated. */
  #limited(keys: readonly BucketKey[]): readonly BucketKey[] {
    const out: BucketKey[] = [];
    for (const key of new Set(keys)) {
      if (this.#deps.specFor(key) !== null) out.push(key);
    }
    return out;
  }

  #bucket(key: BucketKey): TokenBucket {
    const held = this.#buckets.get(key);
    if (held !== undefined) return held;
    const spec = this.#deps.specFor(key);
    if (spec === null) throw new Error(`no bucket spec for "${key}"`);
    if (this.#buckets.size >= PRUNE_ABOVE) this.prune();
    const fresh = new TokenBucket(spec, this.#deps.clock.now());
    this.#buckets.set(key, fresh);
    return fresh;
  }

  /** The longest wait across the set: when **all** of them can pay. */
  #waitMs(keys: readonly BucketKey[], cost: number, now: Temporal.Instant): number {
    let longest = 0;
    for (const key of keys) longest = Math.max(longest, this.#bucket(key).waitMs(cost, now));
    return longest;
  }

  /** The keys that are actually blocking, which are the only ones worth reserving. */
  #binding(keys: readonly BucketKey[], cost: number, now: Temporal.Instant): readonly BucketKey[] {
    return keys.filter((key) => this.#bucket(key).waitMs(cost, now) > 0);
  }

  #take(keys: readonly BucketKey[], cost: number, now: Temporal.Instant): void {
    for (const key of keys) this.#bucket(key).take(cost, now);
  }

  /**
   * Queue a waiter and return the promise it resolves.
   *
   * Neither this nor `acquire` is `async`, and that is not a style choice. Each `async`/`await`
   * layer puts another microtask between `resolve()` and the caller's continuation, and
   * `VirtualClock.advanceTo` flushes a fixed two ticks between timers — so with `acquire` awaiting
   * an awaiting `#enqueue`, the continuation ran *after* the advance had finished and every timing
   * assertion read the end of the window instead of the instant the timer fired. Invisible in
   * production and fatal to a virtual-clock test, which is the whole test strategy for this module.
   */
  #enqueue(
    keys: readonly BucketKey[],
    cost: number,
    priority: Priority,
    now: Temporal.Instant,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const lane = keys.find((key) => key.startsWith(CHAT_KEY_PREFIX)) ?? keys[0] ?? '';
    return new Promise<void>((resolve, reject) => {
      // `detach` is reassigned below rather than the listener being declared first, because the
      // two refer to each other: the listener needs the waiter to remove it from the queue, and
      // the waiter needs a way to remove the listener.
      let detach = (): void => {};
      const waiter: Pending = {
        priority,
        lane,
        seq: this.#queue.nextSeq(),
        keys,
        cost,
        queuedAt: now.epochMilliseconds,
        resolve,
        reject,
        release: () => {
          detach();
        },
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          // The reservation this waiter held is gone, so somebody behind it may now be serveable.
          if (!this.#queue.remove(waiter)) return;
          waiter.release();
          reject(asError(signal.reason));
          this.#pump();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        detach = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }
      this.#queue.push(waiter);
      this.#pump();
    });
  }

  /**
   * Serve everything that can be served, then schedule the next wake.
   *
   * One forward pass over the fair order is enough, and that is a property rather than an
   * optimisation: taking tokens only ever **lowers** a level, so a waiter skipped earlier in the
   * pass could not have become serveable by a later serve. Reservations are unaffected too — only
   * *blocked* waiters reserve, and a served waiter was not blocked.
   */
  #pump(): void {
    const now = this.#deps.clock.now();
    const reserved = new Set<BucketKey>();
    let soonest: number | null = null;
    for (const waiter of this.#queue.order()) {
      if (waiter.keys.some((key) => reserved.has(key))) continue;
      const wait = this.#waitMs(waiter.keys, waiter.cost, now);
      if (wait === 0) {
        this.#queue.remove(waiter);
        this.#queue.served(waiter);
        this.#take(waiter.keys, waiter.cost, now);
        this.#observe(waiter.keys, now.epochMilliseconds - waiter.queuedAt, now);
        waiter.release();
        waiter.resolve();
        continue;
      }
      for (const key of this.#binding(waiter.keys, waiter.cost, now)) reserved.add(key);
      soonest = soonest === null ? wait : Math.min(soonest, wait);
    }
    this.#schedule(soonest, now.epochMilliseconds);
  }

  /**
   * Keep at most one timer, due at the soonest moment anything could change.
   *
   * An existing earlier timer is left alone: it wakes, finds nothing serveable and reschedules,
   * which costs one no-op pump and is simpler than tracking per-waiter timers. A later one is
   * replaced, because leaving it would make the queue wait past the moment it could have gone.
   */
  #schedule(waitMs: number | null, nowMs: number): void {
    if (waitMs === null) {
      this.#clearTimer();
      return;
    }
    const dueAt = nowMs + waitMs;
    if (this.#timer !== null && this.#timerDueAt !== null && this.#timerDueAt <= dueAt) return;
    this.#clearTimer();
    this.#timerDueAt = dueAt;
    this.#timer = this.#deps.timers.setTimeout(() => {
      this.#timer = null;
      this.#timerDueAt = null;
      this.#pump();
    }, waitMs);
  }

  #clearTimer(): void {
    if (this.#timer !== null) this.#deps.timers.clearTimeout(this.#timer);
    this.#timer = null;
    this.#timerDueAt = null;
  }

  /**
   * Record the wait, labelled by which **kind** of limit was binding (`11` §3.10.3).
   *
   * Every acquire is observed, including the ones that waited nothing, so the histogram's count is
   * the send rate and its quantiles answer the question a host actually asks: "is the bot slow
   * because of us, or because of the platform?" The `scope` label answers the follow-up — a
   * per-chat limit is a busy group and a global one is a busy host, and the fixes are different.
   */
  #observe(keys: readonly BucketKey[], waitedMs: number, now: Temporal.Instant): void {
    const binding = waitedMs === 0 ? undefined : this.#slowest(keys, now);
    getMetrics()
      .histogram('channel_ratelimit_wait_seconds')
      .observe({ channel: this.#deps.channel, scope: binding ?? 'none' }, waitedMs / 1_000);
  }

  /** The key with the least headroom, which is the one that made the caller wait. */
  #slowest(keys: readonly BucketKey[], now: Temporal.Instant): string | undefined {
    let lowest: { key: BucketKey; level: number } | undefined;
    for (const key of keys) {
      const level = this.#bucket(key).level(now);
      if (lowest === undefined || level < lowest.level) lowest = { key, level };
    }
    return lowest === undefined ? undefined : scopeOf(lowest.key);
  }
}
