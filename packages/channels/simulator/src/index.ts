/**
 * `@comvivo/channel-simulator` — the deterministic channel (`06` §3.21.7; `M3-T11`).
 *
 * Three audiences, one object. `11`'s simulation harness runs a simulated month of a family group
 * through it in seconds; `13`'s in-browser demo *is* it, with no server at all; and every
 * conformance case in `06` §3.25 runs against it on all seven capability profiles, which is what
 * makes the kit's 24 cases evidence rather than prose.
 *
 * ```ts
 * const clock = new VirtualClock('2026-11-16T09:00:00Z');
 * const { adapter, control } = createSimulator({
 *   profile: 'telegram',
 *   clock,
 *   timers: clock,
 *   seed: 42,
 *   truncationNotice: '… (truncated)',
 * });
 * await adapter.start(context);
 * await control.user('ana', 'Ana').says('family', '@Comvivo what is on today?');
 * ```
 *
 * ## Determinism is the product
 *
 * Nothing here reads the wall clock, `Math.random` or `process`; the clock, the timers and the ids
 * are injected, and a lint rule in this package enforces it the way `channel-sdk-purity` does for
 * the SDK. Two runs of one scenario produce byte-identical ledgers, which is the difference between
 * a test suite and a coin flip — and the reason `11` §3.6's chaos oracles can gate duplicates at
 * zero rather than at "usually none".
 */
import type { ChannelAdapter, ProfileName } from '@comvivo/channel-sdk';
import { IMPLEMENTED_MARKUPS, PROFILE_NAMES, profiles } from '@comvivo/channel-sdk';
import type { Clock, Timers } from '@comvivo/shared';
import { createSimulatorAdapter } from './adapter.js';
import { type ControlRecorderSlot, createSimControl, type SimControl } from './control.js';
import { SimPlatform, type SimRecordedCall } from './platform.js';
import type { SimUpdate } from './wire.js';

export interface SimulatorOptions {
  /**
   * Which platform to emulate.
   *
   * `06` §3.21.7's seven: the six real profiles plus `ideal`, which has every capability on and is
   * what a feature scenario should use when the platform is not the thing under test.
   */
  readonly profile: ProfileName;
  readonly clock: Clock;
  /** Usually the same object as `clock`: `VirtualClock` implements both (`11` §3.1.7). */
  readonly timers: Timers;
  readonly seed: number;
  /** `06` §3.5.4's notice, rendered by the caller. See `SimulatorAdapterOptions`. */
  readonly truncationNotice: string;
  readonly selfId?: string;
  readonly selfName?: string;
  readonly rateLimit?: { readonly capacity: number; readonly refillPerSecond: number };
  /** Observe every platform call as it is made, which `06` §3.25's C05 needs. */
  readonly onCall?: (call: SimRecordedCall) => void;
}

/**
 * The profiles the simulator can emulate **today**.
 *
 * Four of `06` §3.21.7's seven, and the gap is `M3-T4`'s deliberate one: `discord-md`,
 * `slack-mrkdwn` and `matrix-html` have no renderer until their adapters land in M8, and
 * `renderPart` refuses them by name rather than falling back to `plain`. A simulator that emulated
 * Discord with Telegram's markup would be the one thing it must never be — a run that shows a test
 * something a member would not see. `M3-T11`'s acceptance criterion is amended in `14` to say so,
 * and M8's renderer tasks inherit the rest.
 */
export const SIMULATOR_PROFILES: readonly ProfileName[] = Object.freeze(
  PROFILE_NAMES.filter((name) => IMPLEMENTED_MARKUPS.includes(profiles[name].markup)),
);

export interface Simulator {
  readonly adapter: ChannelAdapter;
  readonly control: SimControl;
  /** The platform itself, for a conformance harness and for an oracle that reads the ledger. */
  readonly platform: SimPlatform;
}

/**
 * Build a simulator.
 *
 * Takes its ports directly rather than going through `defineAdapter`, and that is not an oversight:
 * `AdapterFactory.create(config)` receives only configuration, and the platform needs the clock at
 * construction so that a member's message is timestamped from the same clock the adapter schedules
 * against. A factory would have to invent a clock and then be handed a different one at `start` —
 * the exact mismatch `createSimulatorAdapter`'s identity check refuses. A composition root already
 * owns the ports (`11` §3.2.1's `composeComvivo`), so it loses nothing.
 */
export function createSimulator(options: SimulatorOptions): Simulator {
  const capabilities = profiles[options.profile];
  if (!IMPLEMENTED_MARKUPS.includes(capabilities.markup)) {
    throw new RangeError(
      `the \`${options.profile}\` profile renders \`${capabilities.markup}\`, whose renderer arrives with ` +
        'its adapter in M8 (06 §3.5.3). Refused here rather than falling back to plain, because a ' +
        'scenario whose whole purpose is to show what a member sees would be showing them ' +
        `something else. Available now: ${SIMULATOR_PROFILES.join(', ')}.`,
    );
  }
  const slot: ControlRecorderSlot = { recorder: undefined };
  const platform = new SimPlatform({
    clock: options.clock,
    timers: options.timers,
    capabilities,
    seed: options.seed,
    ...(options.selfId === undefined ? {} : { selfId: options.selfId }),
    ...(options.selfName === undefined ? {} : { selfName: options.selfName }),
    onCall: (call) => {
      slot.recorder?.outbound(call.method as never, call.args, call.atMs);
      options.onCall?.(call);
    },
    onDeliver: (update: SimUpdate, atMs: number) => {
      slot.recorder?.inbound(update, atMs);
    },
  });
  const adapter = createSimulatorAdapter({
    platform,
    clock: options.clock,
    timers: options.timers,
    truncationNotice: options.truncationNotice,
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  });
  return { adapter, control: createSimControl(platform, slot), platform };
}

export type { SimulatorAdapterOptions } from './adapter.js';
export { createSimulatorAdapter, toChannelError, toEnvelope, toEvent } from './adapter.js';
export type {
  SaysOptions,
  SimControl,
  SimTranscriptLine,
  SimUserHandle,
} from './control.js';
export type {
  SimCallMatcher,
  SimFault,
  SimIdempotencyClass,
  SimLedgerEntry,
  SimPlatformOptions,
  SimRecordedCall,
} from './platform.js';
export {
  callMatches,
  DEDUPE_WINDOW_MS,
  fileBytes,
  idempotencyClassOf,
  SimPlatform,
  SimPlatformError,
} from './platform.js';
export type { ReplayOptions, ReplayTarget, SimRecordSink } from './record.js';
export { arrayRecordSink, replay, SimRecorder } from './record.js';
export type {
  SimCall,
  SimChat,
  SimFile,
  SimRecordLine,
  SimSender,
  SimUpdate,
  SimUpdateType,
} from './wire.js';
export {
  SIM_CALLS,
  SimChatSchema,
  SimRecordLineSchema,
  SimSenderSchema,
  SimUpdateSchema,
} from './wire.js';
