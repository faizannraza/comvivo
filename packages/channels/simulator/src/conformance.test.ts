/**
 * `06` §3.25's kit, run against the simulator on every profile it can emulate (`M3-T11`).
 *
 * This is the file that makes `M3-T11`'s acceptance criterion measurable. The simulator is the
 * **second** adapter to run the kit — `M3-T9`'s reference adapter was the first — and the second is
 * where a kit earns its keep: a case that passes for one implementation may be describing that
 * implementation, and a case that passes for two is describing the contract.
 *
 * ## Four profiles, not seven
 *
 * `06` §3.21.7 lists seven and `M3-T4` implements three of the six markups: `discord-md`,
 * `slack-mrkdwn` and `matrix-html` arrive with their adapters in M8, and `renderPart` refuses them
 * by name rather than falling back to `plain`. `createSimulator` refuses those profiles for the
 * same reason, so the run covers `telegram`, `signal`, `web` and `ideal` — three distinct markups
 * and, between them, every value of `deliveryVerification`, both `readsAllGroupMessages` branches,
 * `buttons` on and off, native polls on and off, and all four `ephemeral` levels. `14`'s M3-T11 row
 * is amended to say so.
 */
import { type ChannelCapabilities, type ProfileName, profiles } from '@comvivo/channel-sdk';
import {
  type ConformanceHarness,
  conformanceCases,
  conformancePlan,
  describeAdapterConformance,
  type FakePlatformControl,
  memoryFixtureStore,
  runConformance,
} from '@comvivo/channel-sdk/testing';
import { BRAND } from '@comvivo/shared';
import { VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { simCorpus } from './__fixtures__/corpus.js';
import { createSimulator, SIMULATOR_PROFILES, type Simulator } from './index.js';

/** The fake the kit drives, with the simulator it belongs to. */
interface SimFake extends FakePlatformControl {
  readonly simulator: Simulator;
}

/**
 * The truncation notice the kit's sends carry.
 *
 * A literal here and nowhere else: `CLAUDE.md` §2 keeps bot copy in template files and this is a
 * test supplying what the composition root supplies in production, which is exactly the argument
 * for the parameter existing.
 */
const TRUNCATION_NOTICE = '… (truncated)';

function harnessFor(profile: ProfileName): ConformanceHarness<SimFake> {
  const capabilities: ChannelCapabilities = profiles[profile];
  return {
    channel: 'simulator',
    createFake: (opts) => {
      const simulator = createSimulator({
        profile,
        clock: opts.clock,
        timers: opts.clock,
        seed: opts.seed,
        truncationNotice: TRUNCATION_NOTICE,
        // C04 delivers a message from `bot-self` and expects it to be filtered, so the kit's
        // notion of "the bot" and the platform's have to be the same id.
        selfId: 'bot-self',
        selfName: BRAND.botDefaultName,
        onCall: opts.onCall,
      });
      const { platform } = simulator;
      return Promise.resolve({
        simulator,
        deliver: (raw) => platform.deliver(raw),
        outbound: () => platform.outbound(),
        failNext: (match, response, times) => {
          platform.failNext(match, response, times);
        },
        delivered: (chat) => platform.delivered(chat),
        setChatState: (chat, state) => {
          platform.setChatState(chat, state);
        },
        kickBot: (chat) => platform.kickBot(chat),
        // `migrate` is synchronous on the platform (the chat's id changes, permanently) and the
        // kit's surface returns a promise, because a real platform's equivalent is a call.
        migrate: (chat, to) => {
          platform.migrate(chat, to);
          return Promise.resolve();
        },
        revokeAuth: () => {
          platform.revokeAuth();
        },
        disconnect: (ms) => {
          platform.disconnect(ms);
        },
      });
    },
    createAdapter: (fake) => fake.simulator.adapter,
    fixtures: 'packages/channels/simulator/src/__fixtures__/corpus.ts',
    capabilities,
    store: memoryFixtureStore(simCorpus(capabilities)),
  };
}

for (const profile of SIMULATOR_PROFILES) {
  describe(`sim:${profile}`, () => {
    describeAdapterConformance(harnessFor(profile), { describe, it });
  });
}

describe('the simulator against the kit', () => {
  it('runs on every profile whose markup exists, and refuses the rest', () => {
    expect([...SIMULATOR_PROFILES]).toEqual(['telegram', 'signal', 'web', 'ideal']);
    const clock = new VirtualClock('2026-11-16T09:00:00Z');
    for (const profile of ['discord', 'slack', 'matrix'] as const) {
      expect(() =>
        createSimulator({
          profile,
          clock,
          timers: clock,
          seed: 1,
          truncationNotice: TRUNCATION_NOTICE,
        }),
      ).toThrow(/renderer arrives with/);
    }
  });

  it('passes every case that is not capability-gated, on every profile', async () => {
    // The headline, and the reason this file is the deliverable rather than the description. A
    // `gated` result is a platform that cannot do the thing; a `skipped` one is an argued
    // exemption, and the simulator claims none.
    for (const profile of SIMULATOR_PROFILES) {
      const results = await runConformance(harnessFor(profile));
      const failures = results.filter((result) => result.status === 'failed');
      expect(
        failures.map((result) => `${profile}/${result.id}: ${result.reason ?? ''}`),
        'the simulator must pass the kit on every profile it offers',
      ).toEqual([]);
      expect(results.some((result) => result.status === 'skipped')).toBe(false);
    }
  });

  it('gates more cases on `signal` than on `ideal`, which is what a profile means', () => {
    // Cheap, with a real target: it fails if `createSimulator` ignored its profile and handed every
    // run the same capabilities — the one bug that would make the loop above four copies of one
    // test, all of them passing.
    const gated = (profile: ProfileName): number =>
      conformancePlan(conformanceCases(), profiles[profile]).filter(
        (planned) => planned.status === 'gated',
      ).length;
    expect(gated('signal')).toBeGreaterThan(gated('ideal'));
    // One, not zero: C17 gates on `markup === 'telegram-html'` because in-place group upgrades are
    // Telegram's alone, so even a platform with every capability on has nothing to prove there.
    expect(gated('ideal')).toBe(1);
  });
});
