/**
 * The SP-4/SP-5 offline report (`M2-T20`).
 *
 * Prints one block per question with both arms' simulated cache-read ratio and cost per turn, then
 * a recommendation and — the part that keeps this honest — **what it cannot decide**. `arms.ts`'s
 * header has the full statement of the substitution's limits; the summary repeats the one that
 * matters most, which is that TTFT is not measured at all.
 */
import { plural } from '@comvivo/shared';
import { ARMS, type Arm, type ArmResult, runArm } from './arms.js';
import { familyWeek } from './week.js';

export interface SpikeReport {
  readonly results: readonly ArmResult[];
  /** Per question: which arm won on cost, and by how much. */
  readonly recommendations: readonly {
    readonly question: Arm['question'];
    readonly winner: string;
    readonly costDeltaPercent: number;
    readonly cacheReadDelta: number;
  }[];
}

export async function runSpike(): Promise<SpikeReport> {
  const week = familyWeek();
  const results: ArmResult[] = [];
  for (const arm of ARMS) results.push(await runArm(arm, week));

  const questions = [...new Set(results.map((result) => result.question))];
  const recommendations = questions.flatMap((question) => {
    const arms = results.filter((result) => result.question === question);
    const ranked = [...arms].toSorted((a, b) => a.microsPerTurn - b.microsPerTurn);
    const best = ranked[0];
    const worst = ranked.at(-1);
    if (best === undefined || worst === undefined) return [];
    return [
      {
        question,
        winner: best.arm,
        costDeltaPercent:
          worst.microsPerTurn === 0
            ? 0
            : ((worst.microsPerTurn - best.microsPerTurn) / worst.microsPerTurn) * 100,
        cacheReadDelta: best.cacheReadRatio - worst.cacheReadRatio,
      },
    ];
  });

  return { results, recommendations };
}

export function render(report: SpikeReport): string {
  const lines: string[] = [
    '',
    'SP-4 / SP-5 — offline simulation. NOT A LIVE RESULT.',
    '',
    `  ${plural(report.results[0]?.turns ?? 0, 'turn')} of synthetic family traffic over 7 days.`,
    '  cache_read_ratio and cost/turn are simulated; TTFT is NOT measured and cannot be.',
    '',
  ];
  for (const result of report.results) {
    lines.push(
      `  ${result.arm.padEnd(20)} cache read ${(result.cacheReadRatio * 100).toFixed(1).padStart(5)}%` +
        `   $${(result.microsPerTurn / 1_000_000).toFixed(5)}/turn`,
    );
  }
  lines.push('');
  for (const recommendation of report.recommendations) {
    lines.push(
      `  ${recommendation.question.padEnd(14)} → ${recommendation.winner} ` +
        `(${recommendation.costDeltaPercent.toFixed(1)}% cheaper, ` +
        `${(recommendation.cacheReadDelta * 100).toFixed(1)} points more cache read)`,
    );
  }
  lines.push(
    '',
    '  Decides nothing. SP-4 and SP-5 stay open in `15` §1 and ADR-023 stays Proposed:',
    '  the live run (H-1, H-2) measures TTFT and the real cache, and these numbers exist so',
    '  that run can confirm an ordering rather than explore one.',
    '',
  );
  return lines.join('\n');
}
