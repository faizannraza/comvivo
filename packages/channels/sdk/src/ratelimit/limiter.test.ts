/**
 * The multi-key rate limiter (`06` §3.14; `M3-T7`).
 *
 * **Every test here runs in virtual time** and the suite asserts that: nothing resolves without an
 * `advance`, and `VirtualClock.pending` is checked so a leaked timer is a failure rather than a
 * slow test. That is `M3-T7`'s AC ("virtual-clock tests only") and it is what makes the interesting
 * cases reachable at all — a 3-second refill interval, a minute of a group's traffic, an hour of
 * contention between three chats.
 *
 * The assertions are grouped by the four things that can go wrong:
 *
 * 1. **A token is spent that cannot be used.** Taking from one bucket and finding the next empty
 *    leaves the accounting wrong in a way that only appears under load. Tested by proving, from
 *    outside, that nothing was taken from the bucket that *could* pay.
 * 2. **A queued waiter is jumped by a fresh arrival.** The classic unfairness of a lock with no
 *    queue, where one unlucky send is starved by a stream of lucky ones.
 * 3. **Interactive work is starved by low-priority work on a shared bucket.** Priority ordering
 *    alone does not prevent this, and the reservation is what does.
 * 4. **One chat's exhausted bucket blocks every other chat.** The thing round-robin exists to
 *    prevent, and the thing a naive reservation reintroduces.
 */
import {
  type MetricsBackend,
  type RecordingMetrics,
  recordingMetrics,
  setMetricsBackend,
} from '@comvivo/shared/observability';
import { VirtualClock } from '@comvivo/shared/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { type BucketSpec, bucketSpec } from './bucket.js';
import { type BucketKey, bucketKeys, CHAT_KEY_PREFIX, RateLimiter } from './limiter.js';

/** `06` §3.14's Telegram row, as specs. */
const GLOBAL = bucketSpec(25, 25);
const GROUP = bucketSpec(5, 1 / 3);

function limiter(specs: Readonly<Record<string, BucketSpec | null>>, clock: VirtualClock) {
  return new RateLimiter({
    channel: 'telegram',
    clock,
    timers: clock,
    specFor: (key: BucketKey) => {
      if (key in specs) return specs[key] ?? null;
      if (key.startsWith('chat:')) return specs['chat:*'] ?? null;
      if (key.startsWith('method:')) return specs['method:*'] ?? null;
      return null;
    },
  });
}

/**
 * Issues an acquire and records the order and virtual time of completion.
 *
 * `atMs` is **relative to when the tracker was made**, not an epoch. The first version recorded
 * `epochMilliseconds`, which is 1 767 225 630 000 and makes every timing assertion unreadable and
 * unwritable.
 */
function tracker(clock: VirtualClock) {
  const startedAt = clock.now().epochMilliseconds;
  const done: { label: string; atMs: number }[] = [];
  const failed: { label: string; name: string }[] = [];
  return {
    done,
    failed,
    labels: (): readonly string[] => done.map((entry) => entry.label),
    at: (label: string): number | undefined => done.find((entry) => entry.label === label)?.atMs,
    run(promise: Promise<void>, label: string): Promise<void> {
      return promise.then(
        () => {
          done.push({ label, atMs: clock.now().epochMilliseconds - startedAt });
        },
        (error: unknown) => {
          failed.push({ label, name: error instanceof Error ? error.name : String(error) });
        },
      );
    },
  };
}

function recording(): RecordingMetrics {
  const recorder = recordingMetrics();
  const backend: MetricsBackend = { ...recorder, shutdown: () => Promise.resolve() };
  setMetricsBackend(backend);
  return recorder;
}

afterEach(() => {
  setMetricsBackend(undefined);
});

describe('a key with no limit', () => {
  it('resolves without a bucket, a queue or a timer', () => {
    // `06` §3.14's last row: "Web / Simulator: none". `null` rather than a very large bucket,
    // because a huge bucket is still a bucket — it allocates, it is pruned, and it turns a test
    // about unlimited sends into a test about a number somebody chose.
    const clock = new VirtualClock();
    const limits = limiter({}, clock);
    const probe = tracker(clock);
    void probe.run(limits.acquire([bucketKeys.global, bucketKeys.chat('1')]), 'a');
    expect(limits.waiting).toBe(0);
    expect(clock.pending).toBe(0);
  });
});

describe('the uncontended path', () => {
  it('takes from every bucket and sets no timer', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: GLOBAL, 'chat:*': GROUP }, clock);
    await limits.acquire([bucketKeys.global, bucketKeys.chat('1')]);
    expect(limits.waiting).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('drains the burst and then waits for the refill', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: GLOBAL, 'chat:*': GROUP }, clock);
    const keys = [bucketKeys.global, bucketKeys.chat('1')];
    // `06` §3.14: Telegram groups are capacity 5, refill 1 per 3 s.
    for (let send = 0; send < 5; send += 1) await limits.acquire(keys);
    const probe = tracker(clock);
    void probe.run(limits.acquire(keys), 'sixth');
    expect(probe.labels()).toEqual([]);
    expect(limits.waiting).toBe(1);

    await clock.advance('PT2S');
    expect(probe.labels()).toEqual([]);
    await clock.advance('PT1S');
    expect(probe.labels()).toEqual(['sixth']);
    expect(clock.pending).toBe(0);
  });
});

describe('the acquire is atomic across keys', () => {
  it('takes nothing when one bucket in the set cannot pay', async () => {
    // Observed from outside, which is the only honest way: the chat bucket is empty, so the sixth
    // send waits — and if the implementation had already taken its global token, a later acquire
    // for the whole of the remaining global capacity would have to wait too.
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(10, 10), 'chat:*': bucketSpec(1, 1) }, clock);
    const both = [bucketKeys.global, bucketKeys.chat('1')];
    await limits.acquire(both);
    const probe = tracker(clock);
    void probe.run(limits.acquire(both), 'blocked');
    expect(limits.waiting).toBe(1);

    // Global had 10, one send took 1, so 9 remain — and will not resolve if the blocked waiter
    // helped itself to a tenth.
    void probe.run(limits.acquire([bucketKeys.global], 9), 'rest-of-global');
    await clock.advance('PT0S');
    expect(probe.labels()).toEqual(['rest-of-global']);
  });

  it('waits on the slowest key in the set, not the first', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(1, 1), 'chat:*': bucketSpec(1, 1 / 10) }, clock);
    const both = [bucketKeys.global, bucketKeys.chat('1')];
    await limits.acquire(both);
    const probe = tracker(clock);
    void probe.run(limits.acquire(both), 'second');
    // Global refills in 1 s, the chat in 10. The wait is the chat's.
    await clock.advance('PT5S');
    expect(probe.labels()).toEqual([]);
    await clock.advance('PT5S');
    expect(probe.labels()).toEqual(['second']);
  });

  it('counts a repeated key once', async () => {
    // `['global', 'global']` means one bucket, not a double charge. A caller building a key list
    // from overlapping sources should not pay twice for the same limit.
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(2, 1) }, clock);
    await limits.acquire([bucketKeys.global, bucketKeys.global]);
    await limits.acquire([bucketKeys.global]);
    expect(limits.waiting).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('refuses a cost above a capacity rather than queueing it for ever', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(5, 1) }, clock);
    await expect(limits.acquire([bucketKeys.global], 6)).rejects.toThrow(/can never be paid/);
    expect(limits.waiting).toBe(0);
  });
});

describe('fairness at the front door', () => {
  it('does not let a fresh arrival jump a queued waiter', async () => {
    // Without the `queue.size === 0` guard on the fast path, `late` takes the token `early` has
    // been waiting for, and under sustained load the queue never drains.
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(1, 1) }, clock);
    await limits.acquire([bucketKeys.global]);
    const probe = tracker(clock);
    void probe.run(limits.acquire([bucketKeys.global]), 'early');
    await clock.advance('PT0.5S');
    void probe.run(limits.acquire([bucketKeys.global]), 'late');
    await clock.advance('PT2S');
    expect(probe.labels()).toEqual(['early', 'late']);
  });
});

describe('priority', () => {
  it('serves interactive work first on a contended bucket', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(1, 1) }, clock);
    await limits.acquire([bucketKeys.global]);
    const probe = tracker(clock);
    const keys = [bucketKeys.global];
    void probe.run(limits.acquire(keys, 1, 'background'), 'bg');
    void probe.run(limits.acquire(keys, 1, 'scheduled'), 'sched');
    void probe.run(limits.acquire(keys, 1, 'interactive'), 'inter');
    await clock.advance('PT5S');
    expect(probe.labels()).toEqual(['inter', 'sched', 'bg']);
  });
});

describe('round-robin across chats', () => {
  it('alternates chats competing for the global bucket', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(1, 1), 'chat:*': bucketSpec(10, 10) }, clock);
    await limits.acquire([bucketKeys.global, bucketKeys.chat('a')]);
    const probe = tracker(clock);
    for (const [label, chat] of [
      ['a1', 'a'],
      ['a2', 'a'],
      ['a3', 'a'],
      ['b1', 'b'],
    ] as const) {
      void probe.run(limits.acquire([bucketKeys.global, bucketKeys.chat(chat)]), label);
    }
    await clock.advance('PT10S');
    // `b`'s single message is not stuck behind all three of `a`'s.
    expect(probe.labels()).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  it('does not let one chat’s exhausted bucket block another chat', async () => {
    // The failure round-robin exists to prevent, and the one a naive reservation reintroduces: `a`
    // is blocked on its own bucket, and reserving every key it holds would reserve `global` too.
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(10, 10), 'chat:*': bucketSpec(1, 1 / 10) }, clock);
    await limits.acquire([bucketKeys.global, bucketKeys.chat('a')]);
    const probe = tracker(clock);
    void probe.run(limits.acquire([bucketKeys.global, bucketKeys.chat('a')]), 'a-blocked');
    void probe.run(limits.acquire([bucketKeys.global, bucketKeys.chat('b')]), 'b-free');
    await clock.advance('PT0S');
    expect(probe.labels()).toEqual(['b-free']);
    await clock.advance('PT10S');
    expect(probe.labels()).toEqual(['b-free', 'a-blocked']);
  });
});

describe('interactive work is never starved', () => {
  it('serves a reply at its own bucket’s pace, however much background work arrives', async () => {
    // A reply blocked on its own chat's bucket, with a stream of background digests to *other*
    // chats arriving while it waits. Each digest spends a global token, so the question is whether
    // the reply is pushed back by them.
    //
    // It is not, and the first version of this test asserted the wrong thing about why: it expected
    // the reply to complete **first**, and `bg0` legitimately goes ahead of it at t=1 s — the reply
    // cannot use the global token it takes, because its own chat is still empty. What has to hold
    // is the *time*: the reply goes at 2 s, which is when its chat refills, exactly as it would
    // with no background traffic at all. That is the bound, and the control run below is what makes
    // it a claim about the limiter rather than about the numbers.
    const run = async (backgroundSends: number): Promise<number | undefined> => {
      const clock = new VirtualClock();
      const limits = limiter({ global: bucketSpec(1, 1), 'chat:*': bucketSpec(1, 1 / 2) }, clock);
      await limits.acquire([bucketKeys.global, bucketKeys.chat('a')]);
      const probe = tracker(clock);
      void probe.run(
        limits.acquire([bucketKeys.global, bucketKeys.chat('a')], 1, 'interactive'),
        'reply',
      );
      for (let n = 0; n < backgroundSends; n += 1) {
        void probe.run(
          limits.acquire([bucketKeys.global, bucketKeys.chat(`b${String(n)}`)], 1, 'background'),
          `bg${String(n)}`,
        );
        await clock.advance('PT0.25S');
      }
      await clock.advance('PT30S');
      return probe.at('reply');
    };
    expect(await run(0)).toBe(2_000);
    expect(await run(6)).toBe(2_000);
    expect(await run(40)).toBe(2_000);
  });

  it('serves background work that the reply could not have used anyway', async () => {
    // The other side of the same rule: reserving a key a waiter is **not** blocked on would be
    // head-of-line blocking dressed as fairness. Here the reply is blocked on its chat, global has
    // room, and the digest to another chat should go.
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(10, 10), 'chat:*': bucketSpec(1, 1 / 10) }, clock);
    await limits.acquire([bucketKeys.global, bucketKeys.chat('a')]);
    const probe = tracker(clock);
    void probe.run(
      limits.acquire([bucketKeys.global, bucketKeys.chat('a')], 1, 'interactive'),
      'reply',
    );
    void probe.run(
      limits.acquire([bucketKeys.global, bucketKeys.chat('b')], 1, 'background'),
      'digest',
    );
    await clock.advance('PT0S');
    expect(probe.labels()).toEqual(['digest']);
  });

  it('does not let a stream of small acquires starve a large one', async () => {
    // The case the scan order alone does **not** cover, and the one the reservation is for. A
    // waiter asking for 3 tokens of a bucket holding 1 is blocked while a waiter asking for 1 is
    // not, so without the reservation a stream of single-token sends starves the three-token one
    // for ever — at any priority, which makes it the sharper of the two failures.
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(3, 1) }, clock);
    await limits.acquire([bucketKeys.global], 3);
    const probe = tracker(clock);
    void probe.run(limits.acquire([bucketKeys.global], 3), 'large');
    for (let n = 0; n < 10; n += 1) {
      void probe.run(limits.acquire([bucketKeys.global], 1), `small${String(n)}`);
      await clock.advance('PT0.5S');
    }
    // Three tokens at one per second: the large acquire goes at 3 s and nothing precedes it. The
    // small ones follow — the loop runs for 5 s of virtual time, so some of them get their turn
    // after the large one has had its; what matters is that none of them got it first.
    expect(probe.labels()[0]).toBe('large');
    expect(probe.at('large')).toBe(3_000);
  });
});

describe('abort', () => {
  it('throws before queueing when the signal is already aborted', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(1, 1) }, clock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      limits.acquire([bucketKeys.global], 1, 'scheduled', controller.signal),
    ).rejects.toThrow();
    expect(limits.waiting).toBe(0);
  });

  it('rejects a queued waiter, takes nothing, and lets the next one through', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(1, 1) }, clock);
    await limits.acquire([bucketKeys.global]);
    const probe = tracker(clock);
    const controller = new AbortController();
    void probe.run(
      limits.acquire([bucketKeys.global], 1, 'scheduled', controller.signal),
      'cancelled',
    );
    void probe.run(limits.acquire([bucketKeys.global]), 'next');
    expect(limits.waiting).toBe(2);
    controller.abort();
    await clock.advance('PT0S');
    expect(limits.waiting).toBe(1);
    expect(probe.failed.map((entry) => entry.label)).toEqual(['cancelled']);
    await clock.advance('PT1S');
    expect(probe.labels()).toEqual(['next']);
  });

  it('re-pumps on abort, so a waiter behind a cancelled one is not left asleep', async () => {
    // The cancelled waiter's reservation goes with it. Without the `#pump()` in the abort handler,
    // the next waiter stays queued until some other event happens to wake the limiter.
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(2, 1 / 100) }, clock);
    await limits.acquire([bucketKeys.global], 2);
    const probe = tracker(clock);
    const controller = new AbortController();
    void probe.run(limits.acquire([bucketKeys.global], 2, 'interactive', controller.signal), 'big');
    await clock.advance('PT100S');
    expect(probe.labels()).toEqual([]);
    // One token exists now, which the cost-2 waiter cannot use but a cost-1 waiter could.
    void probe.run(limits.acquire([bucketKeys.global], 1, 'background'), 'small');
    await clock.advance('PT0S');
    expect(probe.labels()).toEqual([]);
    controller.abort();
    await clock.advance('PT0S');
    expect(probe.labels()).toEqual(['small']);
  });
});

describe('close', () => {
  it('rejects every waiter and leaves no timer behind', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(1, 1 / 60) }, clock);
    await limits.acquire([bucketKeys.global]);
    const probe = tracker(clock);
    void probe.run(limits.acquire([bucketKeys.global]), 'a');
    void probe.run(limits.acquire([bucketKeys.global]), 'b');
    expect(clock.pending).toBe(1);
    limits.close();
    await clock.advance('PT0S');
    expect(probe.failed.map((entry) => entry.label).toSorted()).toEqual(['a', 'b']);
    expect(limits.waiting).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('refuses a later acquire', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(1, 1) }, clock);
    limits.close();
    await expect(limits.acquire([bucketKeys.global])).rejects.toThrow(/closed/);
  });
});

describe('prune', () => {
  it('drops only full buckets, which makes it unobservable', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ 'chat:*': bucketSpec(1, 1) }, clock);
    await limits.acquire([bucketKeys.chat('a')]);
    // `a` refills while nothing happens, then `b` is drained — so at the prune, `a` is full and `b`
    // is empty. The first version drained both at once and then advanced, which refilled both: two
    // buckets dropped, and the assertion that a *partly drained* bucket survives was testing
    // nothing.
    await clock.advance('PT1S');
    await limits.acquire([bucketKeys.chat('b')]);
    expect(limits.prune()).toBe(1);
    // `b` is still empty, so it still waits — pruning did not hand back a burst.
    const probe = tracker(clock);
    void probe.run(limits.acquire([bucketKeys.chat('b')]), 'b2');
    expect(probe.labels()).toEqual([]);
    await clock.advance('PT1S');
    expect(probe.labels()).toEqual(['b2']);
  });
});

describe('the wait metric (11 §3.10.3)', () => {
  it('observes every acquire, with `none` when nothing waited', async () => {
    const recorder = recording();
    const clock = new VirtualClock();
    const limits = limiter({ global: GLOBAL, 'chat:*': GROUP }, clock);
    await limits.acquire([bucketKeys.global, bucketKeys.chat('1')]);
    const observed = recorder.of('channel_ratelimit_wait_seconds');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.labels).toEqual({ channel: 'telegram', scope: 'none' });
    expect(observed[0]?.value).toBe(0);
  });

  it('labels the scope of the limit that was binding', async () => {
    // The question a host actually asks is "is the bot slow because of us or because of the
    // platform", and the follow-up is which limit — a busy group and a busy host have different
    // fixes.
    const recorder = recording();
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(10, 10), 'chat:*': bucketSpec(1, 1 / 2) }, clock);
    const keys = [bucketKeys.global, bucketKeys.chat('1')];
    await limits.acquire(keys);
    const probe = tracker(clock);
    void probe.run(limits.acquire(keys), 'second');
    await clock.advance('PT2S');
    expect(probe.labels()).toEqual(['second']);
    const waited = recorder.of('channel_ratelimit_wait_seconds').filter((entry) => entry.value > 0);
    expect(waited).toHaveLength(1);
    expect(waited[0]?.labels).toEqual({ channel: 'telegram', scope: 'chat' });
    expect(waited[0]?.value).toBeCloseTo(2, 3);
  });
});

describe('bucketKeys and the scope label', () => {
  it('builds 06 §3.14’s four key kinds', () => {
    // The key is the thing that cannot be a metric label: a `chat:` key is a platform chat id, so
    // it has no maximum and `11` §8's series budget would be fiction. The prefix is a closed set.
    expect(bucketKeys.chat('x').startsWith(CHAT_KEY_PREFIX)).toBe(true);
    expect(bucketKeys.global).toBe('global');
    expect(bucketKeys.chat('-1001234')).toBe('chat:-1001234');
    expect(bucketKeys.method('chat.postMessage')).toBe('method:chat.postMessage');
    expect(bucketKeys.route('POST /channels/:id/messages')).toBe(
      'route:POST /channels/:id/messages',
    );
  });

  /** Drain a one-token bucket, queue a second acquire, and report the scope it was labelled with. */
  async function scopeOfWait(
    keys: readonly BucketKey[],
    specs: Readonly<Record<string, BucketSpec | null>>,
  ): Promise<string | undefined> {
    const recorder = recording();
    const clock = new VirtualClock();
    const limits = limiter(specs, clock);
    await limits.acquire(keys);
    const probe = tracker(clock);
    void probe.run(limits.acquire(keys), 'second');
    await clock.advance('PT5S');
    expect(probe.labels()).toEqual(['second']);
    const waited = recorder.of('channel_ratelimit_wait_seconds').find((entry) => entry.value > 0);
    return waited?.labels['scope'];
  }

  it('labels a global wait `global`', async () => {
    expect(await scopeOfWait([bucketKeys.global], { global: bucketSpec(1, 1) })).toBe('global');
  });

  it('labels a per-method wait `method` (Slack’s tiers, 06 §3.14)', async () => {
    expect(
      await scopeOfWait([bucketKeys.global, bucketKeys.method('chat.postMessage')], {
        global: bucketSpec(10, 10),
        'method:*': bucketSpec(1, 1),
      }),
    ).toBe('method');
  });

  it('labels a per-route wait `route` (Discord’s buckets, 06 §3.14)', async () => {
    expect(
      await scopeOfWait([bucketKeys.route('POST /channels/1/messages')], {
        'route:POST /channels/1/messages': bucketSpec(1, 1),
      }),
    ).toBe('route');
  });

  it('labels an unprefixed key `other` rather than leaking it', async () => {
    expect(await scopeOfWait(['workspace'], { workspace: bucketSpec(1, 1) })).toBe('other');
  });

  it('is not confused by a Matrix room id, which contains a colon', async () => {
    // `!abc:server.tld`. The scope is taken from the **first** colon, so the prefix is `chat` and
    // the room id stays out of the label — a `split(':')` reaching for the wrong element would put
    // a server name in a scrape.
    expect(
      await scopeOfWait([bucketKeys.chat('!abc:server.tld')], { 'chat:*': bucketSpec(1, 1) }),
    ).toBe('chat');
  });
});

describe('timers', () => {
  it('keeps at most one, and clears it when the queue empties', async () => {
    const clock = new VirtualClock();
    const limits = limiter({ global: bucketSpec(1, 1), 'chat:*': bucketSpec(1, 1 / 4) }, clock);
    await limits.acquire([bucketKeys.global, bucketKeys.chat('a')]);
    await limits.acquire([bucketKeys.chat('b')]);
    const probe = tracker(clock);
    void probe.run(limits.acquire([bucketKeys.global, bucketKeys.chat('a')]), 'a');
    void probe.run(limits.acquire([bucketKeys.chat('b')]), 'b');
    expect(clock.pending).toBe(1);
    await clock.advance('PT4S');
    expect(probe.labels().toSorted()).toEqual(['a', 'b']);
    expect(clock.pending).toBe(0);
  });

  it('brings its timer forward when a sooner waiter arrives', async () => {
    // **One** limiter, two lanes with different refill rates. The first version of this test used
    // two limiters, so each had a timer of its own and the drill — "never replace an existing
    // timer" — passed: there was nothing to replace. With both lanes on one limiter, the 10-second
    // timer set for `slow` has to be pulled forward to 1 second when `fast` queues behind it, or
    // the fast lane waits for the slow one's refill.
    const clock = new VirtualClock();
    const limits = limiter(
      { 'chat:slow': bucketSpec(1, 1 / 10), 'chat:fast': bucketSpec(1, 1) },
      clock,
    );
    await limits.acquire([bucketKeys.chat('slow')]);
    await limits.acquire([bucketKeys.chat('fast')]);
    const probe = tracker(clock);
    void probe.run(limits.acquire([bucketKeys.chat('slow')]), 'slow');
    void probe.run(limits.acquire([bucketKeys.chat('fast')]), 'fast');
    await clock.advance('PT10S');
    expect(probe.labels()).toEqual(['fast', 'slow']);
    expect(probe.at('fast')).toBe(1_000);
    expect(probe.at('slow')).toBe(10_000);
  });
});
