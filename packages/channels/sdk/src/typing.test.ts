/**
 * The typing indicator (`06` §3.11; `M3-T8`).
 *
 * Every test runs in virtual time, so the per-platform cadences are exercised at their real values
 * rather than at whatever a test could afford to wait for: Telegram's four seconds, Matrix's
 * twenty-five, and the sixty-second ceiling in full.
 *
 * The assertions are grouped by the ways three dots go wrong, and each one is something a member
 * would notice:
 *
 * 1. **They never stop.** A loop that outlives its turn is a bot that looks permanently busy, and
 *    the deadline is the only thing that bounds it when a turn hangs.
 * 2. **They stop late.** A `stop` that waits for a rate-limit token shows typing *after* the reply
 *    has arrived, which reads as a second message coming that never does.
 * 3. **They flicker.** A cadence longer than the platform's expiry, or a refresh refused by the
 *    limiter and treated as fatal.
 * 4. **They take the turn down with them.** A platform error on a cosmetic call must not reach the
 *    caller.
 */
import { recordingLogger, VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import type { ChannelCapabilities, PlatformChatRef } from './contract.js';
import { profiles } from './profiles.js';
import { TYPING_MAX_SECONDS, type TypingDeps, TypingManager } from './typing.js';

const CHAT: PlatformChatRef = { channel: 'telegram', platformChatId: '-100123' };
const THREAD: PlatformChatRef = { ...CHAT, platformThreadId: '77' };
const OTHER: PlatformChatRef = { channel: 'telegram', platformChatId: '-100999' };

interface Harness {
  readonly manager: TypingManager;
  readonly clock: VirtualClock;
  readonly calls: { chat: string; thread: string | null; on: boolean; atMs: number }[];
  /** `manager.start`, then settle, so the first call is recorded at the current instant. */
  start(chat: PlatformChatRef): Promise<void>;
  /** Make the next `n` calls throw. */
  failNext(count: number): void;
}

/**
 * Let the pending microtasks run.
 *
 * `start` is synchronous and fires the first `setTyping` through two `await`s — the rate-limit
 * acquire and the call itself — so without this the continuation sits in the queue until the next
 * `await`, which is inside `clock.advance`. `advanceTo` sets the virtual clock to its target before
 * flushing, so the first call would be recorded a second late and every cadence assertion would
 * read `[1000]` where it should read `[0, 4000]`. The same harness artefact the rate limiter's
 * property test hit, and it reads exactly like a bug in the code under test.
 */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

function harness(
  capabilities: ChannelCapabilities = profiles.telegram,
  options: { readonly omitSetTyping?: boolean; readonly maxSeconds?: number } = {},
): Harness {
  const clock = new VirtualClock();
  const startedAt = clock.now().epochMilliseconds;
  const calls: Harness['calls'] = [];
  let failures = 0;
  const setTyping = async (chat: PlatformChatRef, on: boolean): Promise<void> => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('missing permission');
    }
    calls.push({
      chat: chat.platformChatId,
      thread: chat.platformThreadId ?? null,
      on,
      atMs: clock.now().epochMilliseconds - startedAt,
    });
    return Promise.resolve();
  };
  const deps: TypingDeps = {
    channel: 'telegram',
    capabilities,
    clock,
    timers: clock,
    ...(options.omitSetTyping === true ? {} : { setTyping }),
    ...(options.maxSeconds === undefined ? {} : { maxSeconds: options.maxSeconds }),
    logger: recordingLogger().logger,
  };
  const manager = new TypingManager(deps);
  return {
    manager,
    clock,
    calls,
    start: async (chat: PlatformChatRef) => {
      manager.start(chat);
      await settle();
    },
    failNext: (count: number) => {
      failures = count;
    },
  };
}

/** A capability set with typing on and a chosen cadence. */
const withCadence = (seconds: number | null): ChannelCapabilities => ({
  ...profiles.telegram,
  typingIndicator: seconds !== null,
  typingRefreshSec: seconds,
});

describe('platforms without a typing indicator', () => {
  it('do nothing at all, rather than erroring', async () => {
    // Slack's plain bots have no typing API. The engine calls `start` unconditionally, so this is
    // where the per-platform branch lives — once, instead of at every call site.
    expect(profiles.slack.typingIndicator).toBe(false);
    expect(profiles.slack.typingRefreshSec).toBeNull();
    const kit = harness(profiles.slack);
    expect(kit.manager.enabled).toBe(false);
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 120 });
    expect(kit.calls).toEqual([]);
    expect(kit.manager.active).toBe(0);
    await kit.manager.stop(CHAT);
    expect(kit.calls).toEqual([]);
  });

  it('let the flag win over a cadence that contradicts it', async () => {
    // Found by a break drill: removing the `typingIndicator` check left every test green, because
    // `ChannelCapabilitiesSchema` refines the two to agree and Slack is the only profile with the
    // flag off. But `ChannelCapabilities` is a plain interface — the simulator, a test and a plugin
    // channel (`10` §3) can all build one without going through the schema — so the check is the
    // one thing standing between a hand-written capability set and a typing loop on a platform
    // that has no typing API. The flag wins, because "do not show it" is the safe direction.
    const kit = harness({ ...profiles.telegram, typingIndicator: false, typingRefreshSec: 4 });
    expect(kit.manager.enabled).toBe(false);
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 30 });
    expect(kit.calls).toEqual([]);
  });

  it('treat a missing `setTyping` the same way', async () => {
    // `06` C23 requires an optional method's presence to match its capabilities, so this should
    // never happen — and if it does, the safe reading is "no typing" rather than a crash mid-turn.
    const kit = harness(profiles.telegram, { omitSetTyping: true });
    expect(kit.manager.enabled).toBe(false);
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 10 });
    expect(kit.manager.active).toBe(0);
  });
});

describe('the cadence comes from the profile', () => {
  it('refreshes at each platform’s own interval', async () => {
    // One number for all of them would either flicker on Telegram (whose action lasts 5 s) or
    // spend four times the calls it needs on Matrix (whose timeout is 30 s).
    for (const [name, seconds] of [
      ['telegram', 4],
      ['discord', 8],
      ['signal', 12],
      ['web', 15],
      ['matrix', 25],
      ['ideal', 30],
    ] as const) {
      const kit = harness(profiles[name]);
      expect(profiles[name].typingRefreshSec, name).toBe(seconds);
      await kit.start(CHAT);
      await kit.clock.advance({ seconds: 1 });
      // The first call is immediate; the second lands exactly one interval later.
      await kit.clock.advance({ seconds: seconds - 1 });
      const ons = kit.calls.filter((call) => call.on);
      expect(
        ons.map((call) => call.atMs),
        name,
      ).toEqual([0, seconds * 1_000]);
    }
  });

  it('keeps refreshing for the whole of maxSeconds and then stops', async () => {
    // Telegram at 4 s over 60 s: calls at 0, 4, …, 56, and the 60-second mark is the deadline
    // rather than another refresh.
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: TYPING_MAX_SECONDS + 30 });
    const ons = kit.calls.filter((call) => call.on).map((call) => call.atMs);
    expect(ons).toEqual([
      0, 4_000, 8_000, 12_000, 16_000, 20_000, 24_000, 28_000, 32_000, 36_000, 40_000, 44_000,
      48_000, 52_000, 56_000,
    ]);
    expect(kit.manager.active).toBe(0);
    // And it told the platform to stop.
    expect(kit.calls.at(-1)).toMatchObject({ on: false, atMs: 60_000 });
  });

  it('never leaves a timer behind, so a hung turn cannot hold the process open', async () => {
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    expect(kit.clock.pending).toBeGreaterThan(0);
    await kit.clock.advance({ seconds: TYPING_MAX_SECONDS + 1 });
    expect(kit.clock.pending).toBe(0);
  });

  it('shortens the last interval rather than overshooting the deadline', async () => {
    // A 10-second ceiling with a 4-second cadence: 0, 4, 8, then 2 seconds to the deadline.
    const kit = harness(profiles.telegram, { maxSeconds: 10 });
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 30 });
    expect(kit.calls.filter((call) => call.on).map((call) => call.atMs)).toEqual([0, 4_000, 8_000]);
    expect(kit.calls.at(-1)).toMatchObject({ on: false, atMs: 10_000 });
  });
});

describe('stop', () => {
  it('ends the loop and tells the platform', async () => {
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 9 });
    await kit.manager.stop(CHAT);
    expect(kit.manager.active).toBe(0);
    expect(kit.calls.at(-1)).toMatchObject({ on: false, atMs: 9_000 });
    const before = kit.calls.length;
    await kit.clock.advance({ seconds: 60 });
    expect(kit.calls).toHaveLength(before);
  });

  it('does not wait for a rate-limit token', async () => {
    // The point of leaving `off` unmetered. Telegram's cadence is exactly the limit (1 per 4 s), so
    // a `stop` immediately after a refresh would sit behind a token for most of four seconds — and
    // three dots that arrive with the answer read as a second message coming that never does.
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    await kit.clock.advance({ milliseconds: 1 });
    await kit.manager.stop(CHAT);
    expect(kit.calls.at(-1)).toMatchObject({ on: false, atMs: 1 });
  });

  it('is safe on a chat that was never started', async () => {
    // The failure path calls `stop` on everything it might have started.
    const kit = harness(profiles.telegram);
    await expect(kit.manager.stop(CHAT)).resolves.toBeUndefined();
    expect(kit.calls).toEqual([]);
  });

  it('is idempotent', async () => {
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    await kit.manager.stop(CHAT);
    await kit.manager.stop(CHAT);
    expect(kit.calls.filter((call) => !call.on)).toHaveLength(1);
  });

  it('stops every chat at once, and closes the limiter', async () => {
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    await kit.start(OTHER);
    await kit.clock.advance({ seconds: 1 });
    expect(kit.manager.active).toBe(2);
    await kit.manager.stopAll();
    expect(kit.manager.active).toBe(0);
    expect(kit.clock.pending).toBe(0);
    expect(
      kit.calls
        .filter((call) => !call.on)
        .map((call) => call.chat)
        .toSorted(),
    ).toEqual(['-100123', '-100999']);
  });
});

describe('a stop that lands mid-refresh', () => {
  /** A manager whose `on` calls hang until released, so `stop` can be raced against one. */
  function racing(): {
    manager: TypingManager;
    clock: VirtualClock;
    calls: { on: boolean; atMs: number }[];
    release(): void;
  } {
    const clock = new VirtualClock();
    const startedAt = clock.now().epochMilliseconds;
    const calls: { on: boolean; atMs: number }[] = [];
    let pending: (() => void) | undefined;
    const manager = new TypingManager({
      channel: 'telegram',
      capabilities: profiles.telegram,
      clock,
      timers: clock,
      setTyping: (_chat, on) => {
        calls.push({ on, atMs: clock.now().epochMilliseconds - startedAt });
        if (!on) return Promise.resolve();
        return new Promise<void>((resolve) => {
          pending = resolve;
        });
      },
    });
    return {
      manager,
      clock,
      calls,
      release: () => {
        pending?.();
        pending = undefined;
      },
    };
  }

  it('does not leave an orphaned refresh loop behind', async () => {
    // The race the post-await liveness check exists for, and a break drill showed nothing else
    // covered it: `#tick` is awaiting the platform when `stop` runs, so the session is already gone
    // by the time the call returns. Without the check the continuation schedules the next refresh
    // against a session nothing can stop — sixty seconds of three dots after the member has their
    // reply, and a timer holding the process open.
    const kit = racing();
    kit.manager.start(CHAT);
    await settle();
    expect(kit.calls).toEqual([{ on: true, atMs: 0 }]);

    await kit.manager.stop(CHAT);
    expect(kit.manager.active).toBe(0);
    expect(kit.calls.at(-1)).toMatchObject({ on: false });

    // The platform's reply to the refresh arrives after the stop.
    kit.release();
    await settle();
    await kit.clock.advance({ seconds: 120 });
    expect(kit.calls.filter((call) => call.on)).toHaveLength(1);
    expect(kit.clock.pending).toBe(0);
    expect(kit.manager.active).toBe(0);
  });

  it('does not let a restarted chat be stopped by the previous loop', async () => {
    // The case a boolean flag would get wrong and session identity gets right: the key is live
    // again, holding a *different* session, and the old continuation must not touch it.
    const kit = racing();
    kit.manager.start(CHAT);
    await settle();
    await kit.manager.stop(CHAT);
    kit.manager.start(CHAT);
    await settle();
    expect(kit.manager.active).toBe(1);
    kit.release();
    await settle();
    expect(kit.manager.active).toBe(1);
  });
});

describe('start is idempotent per chat', () => {
  it('ignores a second start rather than resetting the deadline', async () => {
    // `M3-T25`'s coalescing folds a later message into a turn already under way. Resetting the
    // clock there would let a chat accumulate indefinite typing out of a stream of messages.
    const kit = harness(profiles.telegram, { maxSeconds: 10 });
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 8 });
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 30 });
    expect(kit.calls.at(-1)).toMatchObject({ on: false, atMs: 10_000 });
    expect(kit.manager.active).toBe(0);
  });

  it('treats a thread as its own chat', async () => {
    // Telegram's `sendChatAction` takes a `message_thread_id`, and a topic in a forum group is a
    // different place to be typing.
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    await kit.start(THREAD);
    await kit.clock.advance({ seconds: 1 });
    expect(kit.manager.active).toBe(2);
    expect(kit.calls.filter((call) => call.on).map((call) => call.thread)).toEqual([null, '77']);
    await kit.manager.stop(THREAD);
    expect(kit.manager.active).toBe(1);
  });
});

describe('the per-chat limit (06 §3.11: 1 call per 4 s)', () => {
  it('is per chat, so a second conversation does not wait for the first', async () => {
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    await kit.start(OTHER);
    await kit.clock.advance({ milliseconds: 1 });
    expect(kit.calls.filter((call) => call.on).map((call) => call.atMs)).toEqual([0, 0]);
  });

  it('paces a cadence tighter than the limit instead of dropping the refresh', async () => {
    // A hypothetical profile refreshing every second against a 4-second limit. The refreshes land
    // at the limit's pace, which is the right degradation: slower dots, never no dots.
    const kit = harness(withCadence(1));
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 13 });
    const ons = kit.calls.filter((call) => call.on).map((call) => call.atMs);
    expect(ons[0]).toBe(0);
    for (const [index, atMs] of ons.entries()) {
      if (index === 0) continue;
      const previous = ons[index - 1] ?? 0;
      expect(atMs - previous, `gap ${String(index)}`).toBeGreaterThanOrEqual(4_000);
    }
  });
});

describe('the deadline can pass while a refresh waits for a token', () => {
  it('stops instead of scheduling a timer with no time left', async () => {
    // A cadence tighter than the limit, with a ceiling that lands exactly where the token does:
    // the refresh is released at 4 s and the loop had 4 s. The post-call deadline check is what
    // turns that into a stop rather than a `setTimeout` for zero milliseconds, which would spin.
    const kit = harness(withCadence(1), { maxSeconds: 4 });
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 20 });
    expect(kit.calls.filter((call) => call.on).map((call) => call.atMs)).toEqual([0, 4_000]);
    expect(kit.calls.at(-1)).toMatchObject({ on: false, atMs: 4_000 });
    expect(kit.manager.active).toBe(0);
    expect(kit.clock.pending).toBe(0);
  });
});

describe('after shutdown', () => {
  it('a late start shows nothing and raises nothing', async () => {
    // `stopAll` closes the limiter, so the acquire inside the next refresh rejects. A turn arriving
    // during shutdown is a real ordering, and the answer is no typing rather than an exception on
    // a path the caller never awaits.
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    await kit.manager.stopAll();
    const before = kit.calls.length;
    expect(() => {
      kit.manager.start(OTHER);
    }).not.toThrow();
    await settle();
    await kit.clock.advance({ seconds: 30 });
    expect(kit.calls).toHaveLength(before);
    expect(kit.manager.active).toBe(0);
    expect(kit.clock.pending).toBe(0);
  });
});

describe('a failed call', () => {
  it('never reaches the caller', async () => {
    const kit = harness(profiles.telegram);
    kit.failNext(1);
    expect(() => {
      kit.manager.start(CHAT);
    }).not.toThrow();
    await kit.clock.advance({ seconds: 1 });
    expect(kit.calls).toEqual([]);
  });

  it('ends the loop instead of retrying it fifteen times', async () => {
    // A missing permission fails identically every four seconds for the whole sixty. Typing is
    // cosmetic, and `06` §3.20.3's diagnostic reports the real problem once.
    const kit = harness(profiles.telegram);
    kit.failNext(1);
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 120 });
    expect(kit.calls).toEqual([]);
    expect(kit.manager.active).toBe(0);
    expect(kit.clock.pending).toBe(0);
  });

  it('ends the loop when a refresh fails mid-turn', async () => {
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    await kit.clock.advance({ seconds: 1 });
    kit.failNext(1);
    await kit.clock.advance({ seconds: 10 });
    expect(kit.calls.filter((call) => call.on).map((call) => call.atMs)).toEqual([0]);
    expect(kit.manager.active).toBe(0);
  });

  it('does not stop a healthy chat when another one fails', async () => {
    const kit = harness(profiles.telegram);
    await kit.start(CHAT);
    await kit.clock.advance({ milliseconds: 1 });
    kit.failNext(1);
    await kit.start(OTHER);
    await kit.clock.advance({ seconds: 5 });
    expect(kit.manager.active).toBe(1);
    expect(kit.calls.filter((call) => call.on).map((call) => call.chat)).toEqual([
      '-100123',
      '-100123',
    ]);
  });

  it('logs at debug, with the error’s class and never its message', async () => {
    const clock = new VirtualClock();
    const recorder = recordingLogger();
    const manager = new TypingManager({
      channel: 'telegram',
      capabilities: profiles.telegram,
      clock,
      timers: clock,
      setTyping: () => Promise.reject(new TypeError('cannot send to -100123: not an admin')),
      logger: recorder.logger,
    });
    manager.start(CHAT);
    await clock.advance({ seconds: 1 });
    const lines = recorder.lines().filter((entry) => entry.event === 'channel.typing_failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('debug');
    expect(JSON.stringify(lines[0])).toContain('TypeError');
    expect(JSON.stringify(lines[0])).not.toContain('not an admin');
  });
});

describe('the profiles agree with 06 §3.11’s table', () => {
  it('pairs the flag with the cadence on every profile', () => {
    for (const [name, caps] of Object.entries(profiles)) {
      expect(caps.typingIndicator, name).toBe(caps.typingRefreshSec !== null);
    }
  });

  it('keeps every cadence under the platform’s own expiry', () => {
    // The numbers that make the refresh a refresh rather than a flicker, from §3.11's Notes column.
    const expiry: Record<string, number> = {
      telegram: 5,
      discord: 10,
      signal: 15,
      web: 20,
      matrix: 30,
    };
    for (const [name, limit] of Object.entries(expiry)) {
      const cadence = profiles[name as keyof typeof profiles].typingRefreshSec;
      expect(cadence, name).not.toBeNull();
      expect(cadence ?? 0, name).toBeLessThan(limit);
    }
  });
});
