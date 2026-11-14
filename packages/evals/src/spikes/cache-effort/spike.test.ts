/**
 * The SP-4/SP-5 offline simulation (`M2-T20`'s substitution).
 *
 * The numbers are asserted as **relationships**, not as values. A simulated cost per turn is an
 * artefact of the synthetic week and the `charsPerToken` estimate, so pinning it would pin the
 * fixture rather than the finding — and the first edit to `week.ts` would fail a test for no
 * reason. What has to hold is the *ordering* the live run will confirm or refute, plus the two
 * controls that keep the simulation from passing while measuring nothing.
 */
import { describe, expect, it } from 'vitest';
import { ARMS } from './arms.js';
import { render, runSpike } from './report.js';
import { familyWeek } from './week.js';

describe('the synthetic week', () => {
  it('has bursts with long gaps between them, which is the whole TTL question', () => {
    // The control that matters. A week of evenly-spaced turns would make the 1 h TTL look strictly
    // better and prove nothing, because the arms only differ across a gap longer than 5 minutes.
    const week = familyWeek();
    expect(week.length).toBeGreaterThan(80);
    const gaps = week.slice(1).map((turn, index) => turn.atMinute - (week[index]?.atMinute ?? 0));
    expect(Math.min(...gaps)).toBeLessThanOrEqual(2);
    // And at least one gap longer than an hour, so 1 h expires too and the question is not rigged.
    expect(Math.max(...gaps)).toBeGreaterThan(60);
    expect(gaps.filter((gap) => gap > 5 && gap < 60).length).toBeGreaterThan(5);
  });

  it('mixes effort levels, or the effort arms cannot differ', () => {
    // `top_level` puts effort in the cache key; a week at one effort level never changes the key,
    // so both arms would score identically and the comparison would be vacuous.
    const efforts = new Set(familyWeek().map((turn) => turn.effort));
    expect(efforts.size).toBeGreaterThan(1);
  });
});

describe('the arms', () => {
  it('pairs every question, so each has something to compare against', () => {
    const byQuestion = new Map<string, number>();
    for (const arm of ARMS) byQuestion.set(arm.question, (byQuestion.get(arm.question) ?? 0) + 1);
    expect([...byQuestion.values()]).toEqual([2, 2, 2, 2]);
    expect([...byQuestion.keys()].toSorted()).toEqual([
      'SP-4 BP3',
      'SP-4 TTL',
      'SP-4 effort',
      'SP-5 E-CAT',
    ]);
  });
});

describe('the simulation', () => {
  it('exercises the cache, and lets a bad arm be bad', async () => {
    // Two different requirements, and conflating them was the first version's mistake. The
    // simulation has to be *caching* — a floor on the **best** arm, since a ratio near zero
    // everywhere would make every comparison below noise; `11` §8 puts a warm conversation around
    // 60%. But a floor on **every** arm would be asserting that no arm can lose, and one does:
    // against a family's gap pattern the 5 m TTL reads cache for about a quarter of its prompt
    // tokens, which is the finding rather than a failure.
    const report = await runSpike();
    const ratios = report.results.map((result) => result.cacheReadRatio);
    expect(Math.max(...ratios)).toBeGreaterThan(0.45);
    expect(Math.min(...ratios)).toBeGreaterThan(0);
    // And the arms are not all the same, or nothing is being compared.
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0.05);
  });

  it('reaches a decidable verdict on the TTL, without this test deciding which', async () => {
    // **Not** an assertion that 1 h wins. Which TTL is cheaper is what the simulation is for, and
    // a test that fixed the answer would be this session's own subject: a guard that proves what
    // its author assumed. What a test can honestly require is that the comparison is *capable* of
    // an answer — a non-zero gap between the arms — because a vacuous comparison is the failure
    // mode here. The first version of `week.ts` had bursts hours apart, so both TTLs were expired
    // at every burst, the gap was zero, and the cheaper write won by default.
    const report = await runSpike();
    const ttl = report.recommendations.find((entry) => entry.question === 'SP-4 TTL');
    expect(ttl).toBeDefined();
    expect(Math.abs(ttl?.costDeltaPercent ?? 0)).toBeGreaterThan(0.5);
    // And the winner is one of the two arms, not something invented.
    expect(['ttl:1h', 'ttl:5m']).toContain(ttl?.winner);
  });

  it('prefers the deferred catalogue, which is E-CAT arm C', async () => {
    // `05` §8 estimates arm C roughly halves the cold-write surcharge, and `ADR-023` records it as
    // unproven. This is the offline half of proving it: fewer bytes in the prefix is less to write
    // on every miss. It does **not** measure what arm C costs in extra round trips when a model
    // needs a deferred tool, which is a live behaviour — so the ADR stays Proposed.
    const report = await runSpike();
    const ecat = report.recommendations.find((entry) => entry.question === 'SP-5 E-CAT');
    expect(ecat?.winner).toBe('ecat:C_deferred');
  });

  it('says it is not a live result and that TTFT is not measured', async () => {
    // `CLAUDE.md` §8: a substitution has to be stated where the result is read, not only in a
    // file nobody opens. `M2-T19` does this and the review found `M2-T20` doing neither.
    const text = render(await runSpike());
    expect(text).toContain('NOT A LIVE RESULT');
    expect(text).toContain('TTFT is NOT measured');
    expect(text).toContain('Decides nothing');
  });
});
