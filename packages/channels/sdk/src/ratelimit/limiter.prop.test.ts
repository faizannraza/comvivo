/**
 * `M3-T7`'s properties: "the rate is never exceeded and interactive work is never starved".
 *
 * Both are stated over data the test can see from outside, which is what makes them properties of
 * the limiter rather than of its internals. **A resolved acquire is a take**: it resolved because
 * every bucket in its set could pay, and it took `cost` from each of them at that instant. So the
 * resolution times are the complete ledger, and the token-bucket contract can be checked against
 * it directly:
 *
 *   for every key, and every window `[t1, t2]`, the tokens taken in that window are at most
 *   `capacity + rate × (t2 − t1)`.
 *
 * That is the definition of a token bucket, checked over every window rather than at the end —
 * which matters, because a limiter that handed out the whole day's allowance in one second and then
 * nothing would satisfy any average-rate check.
 *
 * The starvation half is stated as an ordering: between two acquires that ask for **the same thing**
 * — same keys, same cost — the one with the higher priority, or the earlier arrival at equal
 * priority in the same chat, is never served later. Restricting it to identical requests is what
 * makes it exact: two acquires asking for different amounts of a shared bucket can legitimately
 * complete in either order, because the smaller one may fit when the larger one does not.
 */
import { fcConfig, VirtualClock } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Priority } from '../contract.js';
import { bucketSpec } from './bucket.js';
import { type BucketKey, bucketKeys, RateLimiter } from './limiter.js';
import { priorityRank } from './scheduler.js';

interface Request {
  readonly gapMs: number;
  readonly chat: number;
  readonly priority: Priority;
  readonly cost: number;
}

interface Resolved extends Request {
  readonly index: number;
  readonly keys: readonly BucketKey[];
  readonly atMs: number;
}

const priority = fc.constantFrom<Priority>('interactive', 'scheduled', 'background');

/** A workload plus the bucket shapes it runs against. */
const workload = fc
  .record({
    globalCapacity: fc.integer({ min: 1, max: 4 }),
    globalPerSecond: fc.integer({ min: 1, max: 8 }),
    chatCapacity: fc.integer({ min: 1, max: 3 }),
    chatPerSecond: fc.integer({ min: 1, max: 4 }),
    chats: fc.integer({ min: 1, max: 3 }),
    requests: fc.array(
      fc.record({
        gapMs: fc.integer({ min: 0, max: 1_500 }),
        chat: fc.nat({ max: 2 }),
        priority,
        cost: fc.integer({ min: 1, max: 3 }),
      }),
      { minLength: 1, maxLength: 12 },
    ),
  })
  .map((shape) => ({
    ...shape,
    // A cost above a capacity can never be paid, and `acquire` rejects it. Clamped rather than
    // filtered so the generator does not throw away most of its draws.
    requests: shape.requests.map((request) => ({
      ...request,
      chat: request.chat % shape.chats,
      cost: Math.min(request.cost, shape.globalCapacity, shape.chatCapacity),
    })),
  }));

type Workload = typeof workload extends fc.Arbitrary<infer T> ? T : never;

/** Run a workload in virtual time and return every acquire that resolved, with when. */
async function run(shape: Workload): Promise<{ resolved: readonly Resolved[]; pending: number }> {
  const clock = new VirtualClock();
  const startedAt = clock.now().epochMilliseconds;
  const global = bucketSpec(shape.globalCapacity, shape.globalPerSecond);
  const chat = bucketSpec(shape.chatCapacity, shape.chatPerSecond);
  const limits = new RateLimiter({
    channel: 'simulator',
    clock,
    timers: clock,
    specFor: (key) => (key === bucketKeys.global ? global : chat),
  });

  const resolved: Resolved[] = [];
  const settled: Promise<unknown>[] = [];
  for (const [index, request] of shape.requests.entries()) {
    if (request.gapMs > 0) await clock.advance({ milliseconds: request.gapMs });
    const keys = [bucketKeys.global, bucketKeys.chat(String(request.chat))];
    settled.push(
      limits.acquire(keys, request.cost, request.priority).then(() => {
        resolved.push({
          ...request,
          index,
          keys,
          atMs: clock.now().epochMilliseconds - startedAt,
        });
      }),
    );
    // Flush, so an acquire that resolved on the fast path records *this* instant.
    //
    // Without it the continuation sits in the microtask queue until the next `await`, which is
    // inside `advance` — and `advanceTo` sets the virtual clock to a timer's due instant *before*
    // firing it, so an acquire that completed at t=0 was recorded at t=1 000. That turned two takes
    // a second apart into two takes at the same instant and the envelope check reported a
    // violation the limiter had not committed. A harness artefact that reads exactly like a bug,
    // which is the kind worth a comment.
    await Promise.resolve();
    await Promise.resolve();
  }
  // Long enough for every bucket in the generated space to refill many times over.
  await clock.advance({ minutes: 10 });
  await Promise.all(settled);
  const pending = limits.waiting;
  limits.close();
  return { resolved, pending };
}

/** The arrival time of each request, from the gaps. */
function arrivals(shape: Workload): readonly number[] {
  let at = 0;
  return shape.requests.map((request) => {
    at += request.gapMs;
    return at;
  });
}

/** The widest violation of the bucket envelope for one key, or `null`. */
function envelopeViolation(
  takes: readonly { atMs: number; cost: number }[],
  capacity: number,
  perSecond: number,
): string | null {
  const ordered = [...takes].toSorted((a, b) => a.atMs - b.atMs);
  for (let from = 0; from < ordered.length; from += 1) {
    let taken = 0;
    const start = ordered[from]?.atMs ?? 0;
    for (let to = from; to < ordered.length; to += 1) {
      const entry = ordered[to];
      if (entry === undefined) continue;
      taken += entry.cost;
      const windowSeconds = (entry.atMs - start) / 1_000;
      const allowed = capacity + perSecond * windowSeconds;
      // A millisecond of slack for the one-sided rounding in `waitMs` (see `bucket.test.ts`):
      // a wait is never short, so a take can only ever land late, which cannot break the envelope
      // — but the comparison is against an exact real number and the take time is an integer.
      if (taken > allowed + perSecond / 1_000 + 1e-9) {
        return `key window [${String(start)}, ${String(entry.atMs)}] took ${String(taken)} against ${allowed.toFixed(4)}`;
      }
    }
  }
  return null;
}

describe('the rate is never exceeded', () => {
  it('holds the bucket envelope over every window, for every key', async () => {
    await fc.assert(
      fc.asyncProperty(workload, async (shape) => {
        const { resolved, pending } = await run(shape);
        expect(pending).toBe(0);
        expect(resolved).toHaveLength(shape.requests.length);

        const perKey = new Map<BucketKey, { atMs: number; cost: number }[]>();
        for (const entry of resolved) {
          for (const key of entry.keys) {
            const takes = perKey.get(key) ?? [];
            takes.push({ atMs: entry.atMs, cost: entry.cost });
            perKey.set(key, takes);
          }
        }
        for (const [key, takes] of perKey) {
          const isGlobal = key === bucketKeys.global;
          const violation = envelopeViolation(
            takes,
            isGlobal ? shape.globalCapacity : shape.chatCapacity,
            isGlobal ? shape.globalPerSecond : shape.chatPerSecond,
          );
          expect(violation, `${key}: ${violation ?? ''}`).toBeNull();
        }
      }),
      fcConfig({ numRuns: 1_000 }),
    );
  });
});

/**
 * The first pair where a request that should have been served no later was served later.
 *
 * Restricted to pairs asking for **the same thing** — same chat, same cost — which is what makes
 * the claim exact. Two acquires of different sizes against a shared bucket can legitimately finish
 * in either order, because the smaller one fits when the larger one does not; that is the case
 * `limiter.test.ts` covers separately, where the guarantee is "not starved" rather than "first".
 */
function orderingViolation(resolved: readonly Resolved[], at: readonly number[]): string | null {
  for (const a of resolved) {
    for (const b of resolved) {
      if (a === b || a.cost !== b.cost || a.chat !== b.chat) continue;
      // `a` can only be said to come before `b` if `b` was **still waiting** when `a` arrived.
      // Nothing is preempted retroactively: an interactive send that arrives after a scheduled one
      // has already gone is not evidence of starvation, and the first version of this property said
      // it was. At the same virtual instant the issue order decides, which is why `index` breaks
      // the tie — two acquires in the same millisecond still happen in a program order.
      const arrived = at[a.index] ?? 0;
      const stillWaiting = b.atMs > arrived || (b.atMs === arrived && a.index < b.index);
      if (!stillWaiting) continue;
      const shouldPrecede =
        priorityRank(a.priority) < priorityRank(b.priority) ||
        (a.priority === b.priority && a.index < b.index);
      if (shouldPrecede && a.atMs > b.atMs) {
        return (
          `#${String(a.index)} (${a.priority}, ${String(a.atMs)} ms) was served after ` +
          `#${String(b.index)} (${b.priority}, ${String(b.atMs)} ms)`
        );
      }
    }
  }
  return null;
}

describe('interactive work is never starved', () => {
  it('never serves an identical lower-priority or later request first', async () => {
    await fc.assert(
      fc.asyncProperty(workload, async (shape) => {
        const { resolved } = await run(shape);
        const violation = orderingViolation(resolved, arrivals(shape));
        expect(violation, violation ?? '').toBeNull();
      }),
      fcConfig({ numRuns: 1_000 }),
    );
  });

  it('resolves every acquire, whatever the workload', async () => {
    // A deadlock in the reservation would show up here and nowhere else: a waiter holding a key
    // reserved against a waiter that holds the key it needs.
    await fc.assert(
      fc.asyncProperty(workload, async (shape) => {
        const { resolved, pending } = await run(shape);
        expect(pending).toBe(0);
        expect(resolved).toHaveLength(shape.requests.length);
      }),
      fcConfig({ numRuns: 1_000 }),
    );
  });
});
