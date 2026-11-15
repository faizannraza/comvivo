/**
 * SP-4 and SP-5's arms, measured **offline** (`M2-T20`; `05` §3.4.8–§3.4.9, §11 Q7/Q11/Q14).
 *
 * ## What this is, and what it is not
 *
 * `M2-T20` is a **live** spike: `14` asks it to report `cache_read_ratio`, cost per turn and
 * **TTFT** for four comparisons — top-level versus per-message effort, 1 h versus 5 m TTL, BP3
 * always versus when-tools-are-expected, and E-CAT arm A versus arm C. It needs an Anthropic key
 * and approved spend, which are H-1 and H-2 and only the owner can supply.
 *
 * `CLAUDE.md` §8: *"If a gate needs something only a human can do, use the strongest automated
 * substitute available. State the substitution explicitly."* The M2 second-pass review pointed out
 * that `M2-T19` states its substitution exemplarily and **`M2-T20` states none and attempts
 * none**, while `CacheSimulator` already models the two questions that do not need the network.
 * So this is the substitute, and these are its exact limits:
 *
 *  - **`cache_read_ratio`: simulated, and the simulation is the same one `M2-T7`'s AC validated**
 *    against the documented behaviour — prefix-hash hits and misses, the 512-token minimum, the
 *    20-block lookback, TTL expiry, and the effort strategy's effect on the cache key. A ratio
 *    here is arithmetic over that model, not a measurement of Anthropic's cache.
 *  - **Cost per turn: real prices, simulated tokens.** The rates come from the shipped price table
 *    (`05` §9.1), so the dollars are right **if** the token counts are. The token counts are
 *    estimated at `charsPerToken`, which `doctor --models` calibrates against the live
 *    `count_tokens` endpoint and which is therefore the largest source of error here.
 *  - **TTFT: not measured, and not estimable.** Time to first token is a property of the
 *    provider's serving path. Nothing offline can stand in for it, and this file does not pretend
 *    otherwise — the arms it ranks are ranked on cache behaviour and cost alone.
 *  - **The refusal-fallback check: not run.** `14`'s cut-line for `M2-T20` says SP-4's
 *    refusal-fallback check must run even under a reduced matrix. It is a live behaviour (does the
 *    server actually rescue a refusal?) and `M2-T8`'s beta probe is as close as offline gets.
 *
 * So: this file can **recommend** a default and **cannot decide** SP-4 or SP-5. Both stay `open`
 * in `15` §1 until the live run, and `ADR-023` stays Proposed. What it does buy is that the live
 * run arrives with a hypothesis and a predicted ordering, so a cheap matrix can confirm or refute
 * rather than explore — which is what makes a one-off spend worth approving.
 */
import type { Effort } from '@comvivo/core';
import { type AnthropicChatParams, costIteration, PRICES, type PriceTable } from '@comvivo/models';
import { CacheSimulator, type EffortStrategy } from '@comvivo/models/testing';
import { VirtualClock } from '@comvivo/shared/testing';

/** One arm of the experiment. */
export interface Arm {
  readonly id: string;
  /** Which question it answers, in the words `15` §1 uses. */
  readonly question: 'SP-4 effort' | 'SP-4 TTL' | 'SP-4 BP3' | 'SP-5 E-CAT';
  readonly effortStrategy: EffortStrategy;
  readonly ttl: '5m' | '1h';
  /** BP3 — the turn layer's breakpoint — always, or only when tools are expected. */
  readonly bp3: 'always' | 'when_tools_expected';
  /** Arm A is the full catalogue in the prefix; arm C defers all but a small core. */
  readonly catalogue: 'full' | 'deferred';
}

export const ARMS: readonly Arm[] = Object.freeze([
  // SP-4, effort: the spine default against the beta.
  Object.freeze({
    id: 'effort:top_level',
    question: 'SP-4 effort',
    effortStrategy: 'top_level',
    ttl: '1h',
    bp3: 'when_tools_expected',
    catalogue: 'full',
  } as const),
  Object.freeze({
    id: 'effort:per_message',
    question: 'SP-4 effort',
    effortStrategy: 'per_message',
    ttl: '1h',
    bp3: 'when_tools_expected',
    catalogue: 'full',
  } as const),
  // SP-4, TTL.
  Object.freeze({
    id: 'ttl:1h',
    question: 'SP-4 TTL',
    effortStrategy: 'top_level',
    ttl: '1h',
    bp3: 'when_tools_expected',
    catalogue: 'full',
  } as const),
  Object.freeze({
    id: 'ttl:5m',
    question: 'SP-4 TTL',
    effortStrategy: 'top_level',
    ttl: '5m',
    bp3: 'when_tools_expected',
    catalogue: 'full',
  } as const),
  // SP-4, BP3.
  Object.freeze({
    id: 'bp3:always',
    question: 'SP-4 BP3',
    effortStrategy: 'top_level',
    ttl: '1h',
    bp3: 'always',
    catalogue: 'full',
  } as const),
  Object.freeze({
    id: 'bp3:when_tools',
    question: 'SP-4 BP3',
    effortStrategy: 'top_level',
    ttl: '1h',
    bp3: 'when_tools_expected',
    catalogue: 'full',
  } as const),
  // SP-5, E-CAT.
  Object.freeze({
    id: 'ecat:A_full',
    question: 'SP-5 E-CAT',
    effortStrategy: 'top_level',
    ttl: '1h',
    bp3: 'when_tools_expected',
    catalogue: 'full',
  } as const),
  Object.freeze({
    id: 'ecat:C_deferred',
    question: 'SP-5 E-CAT',
    effortStrategy: 'top_level',
    ttl: '1h',
    bp3: 'when_tools_expected',
    catalogue: 'deferred',
  } as const),
]);

/** One turn of the synthetic week. */
export interface Turn {
  /** Minutes since the start of the week. */
  readonly atMinute: number;
  readonly effort: Effort;
  /** Whether the router expected tools, which is what BP3 keys on. */
  readonly toolsExpected: boolean;
  /** Characters of per-turn context: the window plus the trigger. */
  readonly contextChars: number;
}

export interface ArmResult {
  readonly arm: string;
  readonly question: Arm['question'];
  readonly cacheReadRatio: number;
  readonly microsPerTurn: number;
  readonly turns: number;
}

/** `05` §3.6.7's catalogue, as bytes in the prefix: 62 built-ins at ~340 chars of schema each. */
const CATALOGUE_CHARS = { full: 62 * 340, deferred: 8 * 340 } as const;
/** The charter plus the group layer, which are the stable prefix (`05` §3.4). */
const CHARTER_CHARS = 9_000;
const GROUP_LAYER_CHARS = 3_500;

/** Render one turn as the params the simulator accounts for. */
function paramsFor(arm: Arm, turn: Turn): AnthropicChatParams {
  const bp3 = arm.bp3 === 'always' || turn.toolsExpected;
  return {
    model: 'claude-opus-5-5',
    max_tokens: 1_024,
    output_config: { effort: turn.effort },
    system: [
      {
        type: 'text',
        text: 'c'.repeat(CATALOGUE_CHARS[arm.catalogue] + CHARTER_CHARS),
        cache_control: { type: 'ephemeral', ttl: arm.ttl },
      },
      {
        type: 'text',
        text: 'g'.repeat(GROUP_LAYER_CHARS),
        cache_control: { type: 'ephemeral', ttl: arm.ttl },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'w'.repeat(turn.contextChars),
            ...(bp3 ? { cache_control: { type: 'ephemeral', ttl: '5m' as const } } : {}),
          },
        ],
      },
    ],
  } as unknown as AnthropicChatParams;
}

/**
 * Run one arm over a week of turns.
 *
 * A fresh simulator per arm, because the question is how each arm behaves from cold — a group
 * installs once and the first day is the one that decides whether caching is working.
 */
export async function runArm(
  arm: Arm,
  week: readonly Turn[],
  table: PriceTable = PRICES,
): Promise<ArmResult> {
  const clock = new VirtualClock('2026-11-14T08:00:00Z');
  const sim = new CacheSimulator({ clock, effortStrategy: arm.effortStrategy });
  let cacheRead = 0;
  let promptTokens = 0;
  let micros = 0;
  let atMinute = 0;

  for (const turn of week) {
    // `VirtualClock` moves forward only, through `advance` — which is the point of it: a test that
    // could set the clock backwards could make a cache entry un-expire.
    if (turn.atMinute > atMinute) {
      await clock.advance(`PT${String(turn.atMinute - atMinute)}M`);
      atMinute = turn.atMinute;
    }
    const usage = sim.account(paramsFor(arm, turn));
    cacheRead += usage.cacheRead;
    promptTokens += usage.promptTokens;
    micros += costIteration(
      {
        model: 'anthropic/claude-opus-5-5',
        kind: 'message',
        input: usage.input,
        cacheRead: usage.cacheRead,
        cacheWrite5m: usage.cacheWrite5m,
        cacheWrite1h: usage.cacheWrite1h,
        output: 220,
        batch: false,
      },
      table,
    ).micros;
  }

  return {
    arm: arm.id,
    question: arm.question,
    cacheReadRatio: promptTokens === 0 ? 0 : cacheRead / promptTokens,
    microsPerTurn: week.length === 0 ? 0 : micros / week.length,
    turns: week.length,
  };
}
