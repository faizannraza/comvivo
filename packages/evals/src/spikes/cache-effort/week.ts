/**
 * A week of family traffic, as `11` §8 and `00` describe one.
 *
 * Synthetic and **declared**, not generated: a spike's answer is only as good as its traffic, and
 * a reader has to be able to disagree with the shape. The numbers below come from `00`'s picture of
 * a family group and `11` §8's cost model — a handful of bursts a day, clustered around morning
 * logistics and the evening, with long quiet gaps that are exactly where a 5 m TTL expires and a
 * 1 h one does not. That gap is the whole of the TTL question.
 *
 * What makes it a fair test rather than a leading one: the bursts are close enough together to
 * reward either TTL, and the gaps are long enough to punish the short one. A week of evenly-spaced
 * turns would make 1 h look strictly better and prove nothing.
 */
import type { Turn } from './arms.js';

/**
 * Minutes past midnight for each burst of a weekday.
 *
 * The **medium gaps** are the ones that decide SP-4's TTL question, and the first version of this
 * file had none: bursts hours apart mean a 5 m and a 1 h entry are both gone by the next one, so
 * the comparison was vacuous and the cheaper write won by default. A family group is not like
 * that — somebody asks a question, goes into a meeting, and comes back twenty-five minutes later.
 * That gap is inside an hour and outside five minutes, which is exactly and only where the longer
 * TTL pays for itself.
 *
 * So each day has all three spacings: minutes within a burst, 20–40 minutes between a burst and
 * its continuation, and hours between the clusters. Getting that mix wrong in either direction
 * decides the answer in the fixture instead of in the measurement.
 */
const WEEKDAY_BURSTS: readonly { readonly at: number; readonly turns: number }[] = [
  { at: 7 * 60 + 20, turns: 4 }, // breakfast: who is where today
  { at: 7 * 60 + 52, turns: 2 }, // …resumed on the way out the door (32 min later)
  { at: 12 * 60 + 40, turns: 2 }, // a question at lunch
  { at: 13 * 60 + 5, turns: 2 }, // …answered after a meeting (25 min later)
  { at: 17 * 60 + 5, turns: 3 }, // pickup logistics
  { at: 20 * 60 + 30, turns: 5 }, // the evening, the longest burst
  { at: 21 * 60 + 8, turns: 2 }, // …and the last word (38 min later)
];

/** A weekend day: later, longer, and one big planning burst that keeps coming back. */
const WEEKEND_BURSTS: readonly { readonly at: number; readonly turns: number }[] = [
  { at: 9 * 60 + 45, turns: 3 },
  { at: 14 * 60, turns: 6 },
  { at: 14 * 60 + 38, turns: 3 }, // planning resumes (38 min later)
  { at: 19 * 60 + 15, turns: 3 },
];

/**
 * Minutes between turns inside a burst.
 *
 * Two minutes, which is the number that matters most in this file: it is well inside both TTLs, so
 * within a burst every arm hits the cache. The arms differ **between** bursts, which is where a
 * family's day actually has its gaps.
 */
const WITHIN_BURST_MINUTES = 2;

/** Context grows through a burst as the window fills, then resets with the next one. */
const BASE_CONTEXT_CHARS = 2_400;
const CONTEXT_GROWTH_CHARS = 900;

export function familyWeek(): readonly Turn[] {
  const turns: Turn[] = [];
  for (let day = 0; day < 7; day += 1) {
    const bursts = day >= 5 ? WEEKEND_BURSTS : WEEKDAY_BURSTS;
    for (const burst of bursts) {
      for (let index = 0; index < burst.turns; index += 1) {
        turns.push({
          atMinute: day * 24 * 60 + burst.at + index * WITHIN_BURST_MINUTES,
          // `05` §3.9's economy variant is the step-down; a normal week mixes low and medium, and
          // the **mix** is what makes the effort question real. A week at one effort level could
          // not distinguish `top_level` from `per_message`, because the cache key never changes.
          effort: index === 0 ? 'low' : 'medium',
          // The router expects tools on roughly the turns that ask for something to be done.
          toolsExpected: index % 3 === 1,
          contextChars: BASE_CONTEXT_CHARS + index * CONTEXT_GROWTH_CHARS,
        });
      }
    }
  }
  return turns;
}
