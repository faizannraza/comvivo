/**
 * The mutation reports as one markdown table, for `$GITHUB_STEP_SUMMARY` (`11` §3.1.5).
 *
 * Stryker's own HTML report is the place to read a surviving mutant; this is the place to see that
 * there is one, on the day a run happens, without downloading an artefact. It reads the JSON
 * reports both configurations write and prints a row per file, worst score first, so the thing
 * that needs attention is at the top.
 *
 * Exits 0 even with nothing to read: the summary is a courtesy, and a workflow step that fails
 * because a *previous* step failed to produce a report reports the wrong problem.
 */
import { existsSync, readFileSync } from 'node:fs';
import { stdout } from 'node:process';

/** The slice of `mutation-testing-report-schema` this reads. */
interface Report {
  readonly files: Record<string, { readonly mutants: readonly { readonly status: string }[] }>;
}

const REPORTS = [
  { name: 'ifc and policy', path: 'reports/mutation/ifc-policy.json', breakAt: 75 },
  { name: 'rest of core', path: 'reports/mutation/core.json', breakAt: 60 },
] as const;

/**
 * `11` §3.1.5's score: killed over the mutants that could have been killed.
 *
 * `CompileError` and `Ignored` mutants are excluded from the denominator, which is the standard
 * definition — a mutant the TypeScript checker refused is not a test gap, it is a mutant that
 * could never have run. `NoCoverage` *is* in the denominator, because a line no test reaches is
 * exactly what this measures.
 */
function scoreOf(mutants: readonly { readonly status: string }[]): {
  score: number;
  killed: number;
  survived: number;
  noCoverage: number;
  errors: number;
} {
  const count = (status: string): number => mutants.filter((m) => m.status === status).length;
  const killed = count('Killed') + count('Timeout');
  const survived = count('Survived');
  const noCoverage = count('NoCoverage');
  const errors = count('CompileError') + count('Ignored');
  const denominator = killed + survived + noCoverage;
  return {
    score: denominator === 0 ? 100 : (killed / denominator) * 100,
    killed,
    survived,
    noCoverage,
    errors,
  };
}

let wrote = false;
for (const report of REPORTS) {
  if (!existsSync(report.path)) continue;
  const parsed = JSON.parse(readFileSync(report.path, 'utf8')) as Report;
  const all = Object.values(parsed.files).flatMap((file) => [...file.mutants]);
  const total = scoreOf(all);
  const verdict = total.score >= report.breakAt ? '✅' : '❌';
  stdout.write(`### Mutation — ${report.name}\n\n`);
  stdout.write(
    `${verdict} **${total.score.toFixed(2)}%** against a break threshold of ${String(report.breakAt)} ` +
      `· ${String(total.killed)} killed · ${String(total.survived)} survived · ` +
      `${String(total.noCoverage)} uncovered · ${String(total.errors)} not compilable\n\n`,
  );
  const rows = Object.entries(parsed.files)
    .map(([path, file]) => ({ path, ...scoreOf(file.mutants) }))
    .filter((row) => row.survived + row.noCoverage > 0)
    .toSorted((left, right) => left.score - right.score)
    .slice(0, 15);
  if (rows.length > 0) {
    stdout.write('| file | score | survived | uncovered |\n|---|---|---|---|\n');
    for (const row of rows) {
      const name = row.path.replace(/^.*packages\/core\//, '');
      stdout.write(
        `| \`${name}\` | ${row.score.toFixed(1)}% | ${String(row.survived)} | ${String(row.noCoverage)} |\n`,
      );
    }
    stdout.write('\n');
  }
  wrote = true;
}

if (!wrote) stdout.write('### Mutation\n\nNo report was produced — see the step logs.\n');
