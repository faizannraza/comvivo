/**
 * The typing indicator (`06` §3.11; `M3-T8`).
 *
 * Three dots while Village thinks. The reason it needs a module rather than two calls is that every
 * platform expires the state on its own schedule — Telegram's action lasts 5 seconds, Discord's 10,
 * Signal's 15, Matrix's 30 — so "show typing for this turn" is a refresh loop, and a refresh loop
 * that outlives its turn is a bot that looks permanently busy.
 *
 * ## What it is for, and what it costs
 *
 * `01` §11.10 budgets a reply at 4 s p50 and 10 s p95, and a turn that runs a tool can be slower
 * than that. Without an indicator the member sees nothing and sends the message again — which,
 * because ingestion coalesces (`M3-T25`), is work Village does twice for one question. So this is
 * latency-hiding, and the thing it must never do is lie: it stops on the first part, on failure,
 * and at `maxSeconds` whatever happens, because three dots that never resolve are worse than
 * silence.
 *
 * ## The four rules that are not about cadence
 *
 * - **`typingIndicator: false` is a no-op, not an error.** Slack's plain bots have no typing API at
 *   all. The engine calls `start` unconditionally and this decides, so no caller carries a
 *   per-platform branch.
 * - **`stop` never waits for a rate-limit token.** A delayed stop shows three dots *after* the
 *   reply has arrived, which reads as a second message coming that never does. Only `on` is
 *   metered.
 * - **A failed call ends the loop for that chat.** A missing permission fails identically every
 *   4 seconds for the whole 60, so retrying it is fifteen calls to learn one thing. Typing is
 *   cosmetic; a turn must never fail because of it, and `06` §3.11's "never shown in chats where a
 *   send would fail" is the engine's decision rather than something this can know in advance.
 * - **The per-chat limit is its own.** `06` §3.11: "It has its own per-chat limit of 1 call per 4 s,
 *   which does not consume message tokens." Constructed here rather than injected, so "separate" is
 *   a property of the design and not of whoever wired it: a typing refresh that spent a message
 *   token would make the indicator compete with the reply it is covering.
 */
import type { Clock, Logger, TimerHandle, Timers } from '@comvivo/shared';
import type { ChannelCapabilities, ChannelId, PlatformChatRef } from './contract.js';
import { bucketKeys, bucketSpec, RateLimiter } from './ratelimit/index.js';

/** `06` §3.11: "or after `typing.maxSeconds` (60)". */
export const TYPING_MAX_SECONDS = 60;

/** `06` §3.11: "its own per-chat limit of 1 call per 4 s". */
export const TYPING_BUCKET = bucketSpec(1, 1 / 4);

export interface TypingDeps {
  /** For the limiter's metric label; `ChannelCapabilities` deliberately does not carry it. */
  readonly channel: ChannelId;
  readonly capabilities: ChannelCapabilities;
  readonly clock: Clock;
  readonly timers: Timers;
  /**
   * The adapter's `setTyping`, bound.
   *
   * Optional, and absent means the same as `typingIndicator: false`. `06` C23 requires an optional
   * method's presence to match its capabilities, so the two should never disagree — and if they do,
   * the safe reading is "no typing" rather than a crash in the middle of a turn.
   */
  readonly setTyping?: (chat: PlatformChatRef, on: boolean) => Promise<void>;
  readonly logger?: Logger;
  /** Defaults to `06` §3.11's 60 seconds. */
  readonly maxSeconds?: number;
}

/**
 * One chat's loop.
 *
 * There is no `stopped` flag. Membership in `#sessions` **under this exact object** is the liveness
 * test: `#end` deletes the entry, so a refresh already in flight resumes, finds the map no longer
 * pointing at it, and returns — which also covers the case a flag would get wrong, where `start`
 * ran again and the key now holds a *different* session. A boolean alongside that would be a second
 * source of truth, and `@typescript-eslint/no-unnecessary-condition` was right to call it dead:
 * TypeScript keeps property narrowing across an `await`, so a check that mattered at runtime looked
 * redundant to the compiler. Removing the state was the fix, not suppressing the rule.
 */
interface Session {
  readonly chat: PlatformChatRef;
  /** The instant the loop must stop at, whatever else happens. */
  readonly deadlineMs: number;
  timer: TimerHandle | null;
}

/**
 * A chat's identity for the session map.
 *
 * The thread is part of it, because Telegram's `sendChatAction` takes a `message_thread_id` and a
 * topic in a forum group is a different place to be typing. Two turns in two topics of one group
 * are two indicators.
 *
 * `JSON.stringify` of the three parts rather than a joined string: a platform chat id is opaque and
 * may contain any character, including whatever separator looked safe.
 */
function chatKey(chat: PlatformChatRef): string {
  return JSON.stringify([chat.channel, chat.platformChatId, chat.platformThreadId ?? null]);
}

export class TypingManager {
  readonly #deps: TypingDeps;
  readonly #sessions = new Map<string, Session>();
  readonly #limiter: RateLimiter;
  readonly #refreshMs: number | null;
  readonly #maxMs: number;

  constructor(deps: TypingDeps) {
    this.#deps = deps;
    const refresh = deps.capabilities.typingRefreshSec;
    const usable = deps.capabilities.typingIndicator && deps.setTyping !== undefined;
    this.#refreshMs = usable && refresh !== null ? refresh * 1_000 : null;
    this.#maxMs = (deps.maxSeconds ?? TYPING_MAX_SECONDS) * 1_000;
    this.#limiter = new RateLimiter({
      channel: deps.channel,
      clock: deps.clock,
      timers: deps.timers,
      // Per chat only. There is no global typing bucket: `06` §3.11 says the limit is per chat, and
      // a global one would make a busy household's second conversation wait for its first.
      specFor: (key) => (key === bucketKeys.global ? null : TYPING_BUCKET),
    });
  }

  /** Whether this platform can show a typing indicator at all. */
  get enabled(): boolean {
    return this.#refreshMs !== null;
  }

  /** How many chats are showing one. For a test, and for `09`'s diagnostics. */
  get active(): number {
    return this.#sessions.size;
  }

  /**
   * Start, or extend nothing.
   *
   * Idempotent per chat: a second `start` while one is running is ignored rather than resetting the
   * deadline. `06` §3.11 ties the 60 seconds to the *turn*, and the engine calls `start` once when
   * the router decides `respond` — but `M3-T25`'s coalescing can fold a second message into a turn
   * already under way, and resetting the clock there would let a chat accumulate indefinite typing
   * out of a stream of messages.
   */
  start(chat: PlatformChatRef): void {
    if (this.#refreshMs === null) return;
    const key = chatKey(chat);
    if (this.#sessions.has(key)) return;
    const session: Session = {
      chat,
      deadlineMs: this.#deps.clock.now().epochMilliseconds + this.#maxMs,
      timer: null,
    };
    this.#sessions.set(key, session);
    void this.#tick(key, session);
  }

  /**
   * Stop, and tell the platform if it needs telling.
   *
   * Returns a promise so a caller that wants the indicator gone *before* the message lands can
   * await it, and is safe to call on a chat that was never started — which is the common case on
   * the failure path, where the engine stops everything it might have started.
   */
  async stop(chat: PlatformChatRef): Promise<void> {
    await this.#end(chatKey(chat));
  }

  /** Stop every chat and close the limiter. The composition root calls this on shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((key) => this.#end(key)));
    this.#limiter.close();
  }

  async #end(key: string): Promise<void> {
    const session = this.#sessions.get(key);
    if (session === undefined) return;
    if (session.timer !== null) this.#deps.timers.clearTimeout(session.timer);
    this.#sessions.delete(key);
    // Unmetered, deliberately: see the module header. An adapter whose platform clears the state
    // when the bot sends (Telegram) implements this as a no-op.
    await this.#call(session.chat, false);
  }

  /**
   * One refresh, then schedule the next.
   *
   * The deadline is checked **before** the call as well as after, because a refresh can sit behind
   * a rate-limit token for longer than the loop had left — and a `sendChatAction` that lands after
   * the reply is three dots the member sees with their answer already on screen.
   */
  async #tick(key: string, session: Session): Promise<void> {
    // The narrowing `Math.min(this.#refreshMs, …)` needs below, and nothing more: `#tick` is only
    // entered from `start`, which has just inserted this session, or from a timer that `#end`
    // clears before it can fire. A session check *here* would be unreachable, which a break drill
    // showed by deleting it and watching every test stay green.
    if (this.#refreshMs === null) return;
    if (this.#deps.clock.now().epochMilliseconds >= session.deadlineMs) {
      await this.#end(key);
      return;
    }
    const sent = await this.#meteredCall(session.chat);
    if (!sent) {
      this.#sessions.delete(key);
      return;
    }
    // Re-checked after the await: `stop` may have run while the call was in flight, and restarting
    // the timer then would leave an orphaned loop with no session able to stop it.
    if (this.#sessions.get(key) !== session) return;
    const remaining = session.deadlineMs - this.#deps.clock.now().epochMilliseconds;
    if (remaining <= 0) {
      await this.#end(key);
      return;
    }
    session.timer = this.#deps.timers.setTimeout(
      () => {
        session.timer = null;
        void this.#tick(key, session);
      },
      Math.min(this.#refreshMs, remaining),
    );
  }

  /**
   * A metered `on` call. `false` when it was refused or failed.
   *
   * The bucket key is the **session** key, so a forum topic has its own throttle. `06` §3.11 says
   * "per-chat" and Telegram's `sendChatAction` does take a `message_thread_id`, so a shared bucket
   * is defensible — and wrong in practice: with the cadence (4 s) equal to the limit (1 per 4 s),
   * two concurrent turns in two topics of one group would leave the second showing nothing at all
   * for four seconds, which is most of the latency the indicator exists to cover. Amended in `06`
   * §3.11 at `M3-T8`.
   */
  async #meteredCall(chat: PlatformChatRef): Promise<boolean> {
    try {
      await this.#limiter.acquire([bucketKeys.chat(chatKey(chat))], 1, 'interactive');
    } catch (error) {
      this.#log(chat, error);
      return false;
    }
    return this.#call(chat, true);
  }

  /** `false` when the adapter threw. Never rethrows: a turn must not fail over three dots. */
  async #call(chat: PlatformChatRef, on: boolean): Promise<boolean> {
    const setTyping = this.#deps.setTyping;
    if (setTyping === undefined) return false;
    try {
      await setTyping(chat, on);
      return true;
    } catch (error) {
      this.#log(chat, error);
      return false;
    }
  }

  /**
   * One line, at `debug`.
   *
   * `CLAUDE.md` §2 keeps content out of logs above `debug`, and a chat id is not content — but a
   * failed typing call is also not news. A missing permission would otherwise produce a warn line
   * every four seconds for a minute, in a chat where the real failure (`06` §3.20.3's diagnostic)
   * is already being reported once.
   */
  #log(chat: PlatformChatRef, error: unknown): void {
    this.#deps.logger?.debug('channel.typing_failed', {
      detail: { chat: chat.platformChatId, error: error instanceof Error ? error.name : 'unknown' },
    });
  }
}
