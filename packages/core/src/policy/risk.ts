/**
 * The risk vocabulary (`01` §7.3, §7.4; `03` §3.1.2; `10` §3.2.3).
 *
 * Three levels, one ordering, and two combinators. It is a separate module rather than a line in
 * `capability.ts` because risk is attached to four different things that know nothing about each
 * other: a capability's `defaultRisk` (`03` §3.1.2), an action's registry entry (`03` §3.3.1), a
 * tool's declared `risk` (`01` §7.4) and the draft a tool's `action()` returns (`10` §3.2.3). The
 * one rule they all share is that risk **composes upward** — see `maxRisk`.
 *
 * `CAPABILITY_CATALOG`, the action registry and `authorize()` land at `M4-T1`, `M4-T2` and
 * `M4-T8`. This module is pulled forward to `M2-T5` because `ToolDefinition.risk` needs it and
 * `10` §3.2.3's rules 1 and 2 are pure functions over it.
 */
import { z } from '@comvivo/shared';

/**
 * The three levels, in increasing order.
 *
 * Array order **is** the ordering: `riskRank` reads the index, so adding a level means putting it
 * in the right place rather than updating a second table that could disagree.
 */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

export type Risk = (typeof RISK_LEVELS)[number];

export const riskSchema = z.enum(RISK_LEVELS);

/** `0` for `low`, `2` for `high`. Only for comparison; never persist the number. */
export function riskRank(risk: Risk): number {
  return RISK_LEVELS.indexOf(risk);
}

/**
 * The highest of the given levels, `low` for none.
 *
 * **Risk only ever composes upward.** `10` §3.2.3's rule 1 — effective risk is
 * `max(definition.risk, action().risk ?? low)` — is this function, and the reason it is a `max`
 * rather than an override is that a tool must not be able to talk its way *down*: a plugin that
 * declares `risk: 'high'` and then returns a `low` draft for the one call that matters would
 * otherwise skip the confirmation the host promised the group.
 *
 * `low` for an empty list, because the identity of `max` over this lattice is its bottom.
 */
export function maxRisk(...risks: readonly Risk[]): Risk {
  let highest: Risk = 'low';
  for (const risk of risks) {
    if (riskRank(risk) > riskRank(highest)) highest = risk;
  }
  return highest;
}

/** `risk`, raised to `floor` if it sits below it. The one-sided form of `maxRisk`, named for what it is used for. */
export function atLeastRisk(risk: Risk, floor: Risk): Risk {
  return maxRisk(risk, floor);
}
