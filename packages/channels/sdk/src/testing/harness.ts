/**
 * The conformance harness (`06` §3.25; `M3-T9`).
 *
 * An adapter is the one part of this product whose correctness cannot be argued from the source. It
 * is a translation between a platform nobody controls and an envelope this repository defines, and
 * the failure modes are all at the seam: a payload shape the specification does not describe, a
 * limit that changed last Tuesday, a callback acked twice. `06` §3.25's answer is a kit — 24 cases
 * every adapter runs, against a fake platform it can drive.
 *
 * ## What a harness supplies, and why that is the whole interface
 *
 * Three things: a **fake platform** the case can push payloads into and read calls out of, an
 * **adapter** pointed at it, and a **fixture directory**. Nothing else, and in particular no hooks
 * for a case to reach inside the adapter — because a kit that could would test the adapter's
 * internals, and the next adapter's internals are different. Every case is written against the
 * `ChannelAdapter` contract and the fake's control surface, which is what makes the same 24 cases
 * meaningful for Telegram, Signal and a third-party plugin.
 *
 * ## Capability gating, and the one escape hatch
 *
 * `06` §3.25: "All are mandatory unless capability-gated." A case that needs buttons is skipped on
 * Signal, from the profile, with no judgement involved. `opts.skip` exists for the other kind of
 * gap — something a platform genuinely cannot do that no capability describes — and it takes a
 * **justification string** rather than a boolean, because the point of the kit is that a skipped
 * case is visible and argued rather than quietly absent. {@link conformancePlan} reports them, so a
 * milestone report can list what an adapter did not prove.
 *
 * ## `VirtualClock`, not `ManualClock`
 *
 * `06` §3.25 names the type `ManualClock`; this repository's is `VirtualClock` (`11` §3.1.7), which
 * implements `Clock` and `Timers` together — and the second half is what a conformance case needs,
 * since C12 and C21 are both about *when* a call happens. Amended in `06` §3.25 at `M3-T9`.
 */
import type { VirtualClock } from '@comvivo/shared/testing';
import type {
  AdapterContext,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelId,
} from '../contract.js';
import type { FixtureStore } from './fixtures.js';

/** `06` §3.25's 24 cases. */
export const CASE_IDS = [
  'C01',
  'C02',
  'C03',
  'C04',
  'C05',
  'C06',
  'C07',
  'C08',
  'C09',
  'C10',
  'C11',
  'C12',
  'C13',
  'C14',
  'C15',
  'C16',
  'C17',
  'C18',
  'C19',
  'C20',
  'C21',
  'C22',
  'C23',
  'C24',
] as const;
export type CaseId = (typeof CASE_IDS)[number];

/** One platform API call the adapter made. */
export interface RecordedCall {
  /** The platform's own name for it: `sendMessage`, `POST /channels/1/messages`, `setTyping`. */
  readonly method: string;
  readonly args: unknown;
  /** Virtual milliseconds since the fake was created. C12 and C21 are assertions about this. */
  readonly atMs: number;
}

/** A name, or a predicate for the cases where the name is not enough. */
export type CallMatcher = string | ((call: RecordedCall) => boolean);

export function matches(matcher: CallMatcher, call: RecordedCall): boolean {
  return typeof matcher === 'string' ? call.method === matcher : matcher(call);
}

/**
 * The fake platform's control surface (`06` §3.25).
 *
 * `deliver` takes a fixture path **or** a raw payload: a case that needs an exact recorded shape
 * names the file, and a case that needs a variation builds one. The first keeps the corpus
 * authoritative; the second keeps a case from needing a fixture for every permutation.
 */
export interface FakePlatformControl {
  // `unknown`, not `06` §3.25's `string | unknown` — which is the same type written in a way that
  // reads as a union and is not one. A path and a payload are both accepted; see the doc above.
  deliver(fixtureOrRaw: unknown): Promise<void>;
  outbound(): readonly RecordedCall[];
  /**
   * Arm the next `times` matching calls to fail with `response`. One by default.
   *
   * `times` is additive against `06` §3.25 and was added at `M3-T9` for C11. With a single shot, a
   * **retryable** kind never reaches the caller: a conformant adapter retries it and the second
   * call succeeds, so the case saw a resolved send where it expected an error — which is the
   * adapter being right. Arming several is how a retry budget gets exhausted and the mapping
   * becomes observable.
   */
  failNext(match: CallMatcher, response: unknown, times?: number): void;
  /**
   * The messages that actually exist in a chat on the platform.
   *
   * Added to `06` §3.25's control surface at `M3-T9`, because C14 says a retry "produces **no
   * duplicate in the fake**" and nothing in the published surface could answer that: `outbound()`
   * records the *call*, and a natively-idempotent platform answers a second call without creating a
   * second message. Counting calls would pass the case for an adapter that sent twice.
   */
  delivered(chat: string): readonly string[];
  /**
   * Drive a chat into the state a probe scenario describes.
   *
   * Added to `06` §3.25's control surface at `M3-T9`, for C24. A probe answers "can the bot post
   * here, does it read everything, is it an admin" — so a scenario has to be able to say no, and
   * nothing in the published surface could.
   */
  setChatState(
    chat: string,
    state: { readonly canSend?: boolean; readonly isAdmin?: boolean },
  ): void;
  kickBot(chat: string): Promise<void>;
  migrate(chat: string, to: string): Promise<void>;
  revokeAuth(): void;
  /** Drop the connection for `ms` of virtual time. */
  disconnect(ms: number): void;
}

export interface ConformanceHarness<P extends FakePlatformControl = FakePlatformControl> {
  readonly channel: ChannelId;
  /**
   * Build the fake platform.
   *
   * `onCall` is **additive** against `06` §3.25's `{clock, seed}` and was added at `M3-T9` for C05,
   * which is an assertion about the *order* of two acks — the platform's and the ingest's. Each is
   * visible from one side only, and in virtual time both land in the same millisecond, so the kit
   * has to see them in one sequence. A harness forwards it to its fake's call recorder.
   */
  createFake(opts: {
    readonly clock: VirtualClock;
    readonly seed: number;
    readonly onCall: (call: RecordedCall) => void;
  }): Promise<P>;
  createAdapter(fake: P): ChannelAdapter;
  /** `fixtures/channels/<id>/`. */
  readonly fixtures: string;
  /** Must equal `profiles[channel]` — C23 asserts it. */
  readonly capabilities: ChannelCapabilities;
  /**
   * An override for the fixture store.
   *
   * The kit defaults to reading `fixtures` from disk. The simulator (`M3-T11`) and this package's
   * own test supply an in-memory store instead, which is also what keeps the case bodies free of
   * `node:*`.
   */
  readonly store?: FixtureStore;
  /**
   * The platform call that acknowledges an inbound update, if the platform has one.
   *
   * C05's rule is "the platform is not acked before the ingest ack", and the kit cannot know how a
   * given platform acknowledges: Telegram advances a `getUpdates` offset, Slack's Socket Mode
   * expects an `ack`, a webhook adapter returns a 200. So the harness names it, which is where the
   * platform knowledge belongs. Defaults to `ackUpdate`, the reference fake's name; a platform with
   * no ack at all leaves the ordering half of C05 vacuous, which is correct — there is nothing to
   * order.
   */
  readonly ackMethod?: string;
}

/** What a case is given. */
export interface CaseContext<P extends FakePlatformControl = FakePlatformControl> {
  readonly harness: ConformanceHarness<P>;
  readonly fake: P;
  readonly adapter: ChannelAdapter;
  readonly clock: VirtualClock;
  readonly store: FixtureStore;
  /**
   * The context the adapter was started with.
   *
   * C15 restarts the adapter to check that `start` and `stop` are idempotent, which needs the same
   * context back — a second one would give the adapter a second set of stores and make the case
   * about construction rather than about idempotency.
   */
  readonly context: AdapterContext;
  /** Every line the adapter logged, for C22. */
  logs(): readonly LoggedLine[];
  /** Envelopes and events the adapter handed to `ctx.ingest` / `ctx.ingestEvent`. */
  ingested(): readonly IngestedItem[];
  /**
   * The interleaving of ingest acks and platform acks, in order, for C05.
   *
   * Entries read `ingest:<platformMessageId>`, `ingestEvent:<type>` and `call:<method>`. One list
   * rather than two timestamps, because in virtual time both happen in the same millisecond and the
   * *order* is the whole assertion.
   */
  trace(): readonly string[];
  /** Health reports the adapter made, with virtual timings, for C18. */
  health(): readonly { readonly status: string; readonly atMs: number }[];
  /**
   * Let the pending microtasks run.
   *
   * Needed by any case that asserts on *when* something happened. An adapter's work reaches the
   * platform through several `await`s, and `VirtualClock.advanceTo` sets the clock to a timer's due
   * instant **before** firing it — so a call whose continuation is still queued gets recorded at
   * the end of the window rather than at the instant it was made, and a cadence assertion reads one
   * call where there were four. Calling this after driving the adapter and before advancing the
   * clock is the difference between a timing case and a coin flip.
   */
  settle(): Promise<void>;
  /**
   * Run `work` to completion, driving the virtual clock as far as it needs.
   *
   * The tool every case that waits on an adapter needs, and the one whose absence produced three
   * deadlocks on the kit's first full run. A conformant adapter waits on timers — a rate-limit
   * bucket, a retry backoff, a typing refresh — and in virtual time **nothing fires them unless a
   * test does**. The obvious pattern of "start the work, advance a fixed amount, await it" is also
   * wrong: an adapter's first platform call happens a few microtasks in, so the timer it registers
   * is often scheduled *after* the advance has finished scanning, and the await hangs for ever.
   *
   * So this interleaves: settle the microtasks, check whether the work is done, jump to the next
   * due timer, repeat. It fails loudly when the work is unfinished and **nothing is pending**,
   * because that is an adapter waiting on something outside the kit's control — a real socket, a
   * real timer — which is a conformance failure rather than a hang.
   */
  drain<T>(work: Promise<T>): Promise<T>;
}

export interface LoggedLine {
  readonly level: string;
  readonly event: string;
  readonly fields: unknown;
}

export interface IngestedItem {
  readonly kind: 'envelope' | 'event';
  readonly value: unknown;
  readonly atMs: number;
}

/** A case: an id, a sentence from `06` §3.25's table, and how to decide whether it applies. */
export interface ConformanceCase {
  readonly id: CaseId;
  /** `06` §3.25's own wording, so a failure is traceable to the table. */
  readonly name: string;
  /**
   * Why this case does not apply to a platform, or `null` when it does.
   *
   * A function of the capabilities rather than a list of channel names: `06` §3.25 gates on
   * capabilities, and a kit that gated on names would need editing for every new platform — which
   * is exactly the moment a case gets dropped for the wrong reason.
   */
  gate(capabilities: ChannelCapabilities): string | null;
  run(ctx: CaseContext): Promise<void>;
}

export interface ConformanceOptions {
  /** A justification per skipped case, not a boolean: a skip has to be argued to be visible. */
  readonly skip?: Partial<Record<CaseId, string>>;
}

export interface PlannedCase {
  readonly id: CaseId;
  readonly name: string;
  readonly status: 'run' | 'gated' | 'skipped';
  /** The gate's or the skip's reason. */
  readonly reason: string | null;
}

/**
 * What this harness will and will not run.
 *
 * Separate from running it, so a milestone report can state an adapter's coverage without executing
 * anything, and so the kit's own test can assert the gating without needing a platform for every
 * capability combination.
 */
export function conformancePlan(
  cases: readonly ConformanceCase[],
  capabilities: ChannelCapabilities,
  options: ConformanceOptions = {},
): readonly PlannedCase[] {
  return cases.map((entry) => {
    const skip = options.skip?.[entry.id];
    if (skip !== undefined) {
      return { id: entry.id, name: entry.name, status: 'skipped' as const, reason: skip };
    }
    const gate = entry.gate(capabilities);
    return gate === null
      ? { id: entry.id, name: entry.name, status: 'run' as const, reason: null }
      : { id: entry.id, name: entry.name, status: 'gated' as const, reason: gate };
  });
}
