/**
 * `pnpm bench` — discover every benchmark suite, run it, and write the results (`11` §3.9).
 *
 * A benchmark file is `*.bench.ts` beside the code it measures, and it default-exports an array of
 * `BenchDefinition`. That shape is deliberate: a benchmark that is a *value* can be imported by a
 * test and run with `scale: 0.01`, which is how `11` §3.1's tiers get to prove the harness works
 * without spending a minute on it. A benchmark that registered itself through a global — the shape
 * `vitest bench` would have given us — cannot be.
 *
 * Usage:
 *
 *     pnpm bench                       # every suite, results to `.bench/results.json`
 *     pnpm bench --out pi.json         # somewhere else
 *     pnpm bench --summary table.md    # also write the table as markdown, for a job summary
 *     pnpm bench --filter queue        # only suites whose path contains `queue`
 *     pnpm bench --profile pi          # label the results as a Pi run (`11` §3.9.4)
 *     pnpm bench --scale 0.05          # a smoke run, for checking the plumbing
 *     pnpm bench --sha <commit>        # attribute the results to another commit
 *     pnpm bench --gate                # exit 1 if a row misses the budget it declares
 *
 * **Gating is opt-in**, which is what `11` §3.9.3 asks for: a push to `main` records a trend and
 * never fails on it (`fail-on-alert: false`), a PR is gated on the interleaved A/B ratio rather
 * than on an absolute number, and the absolute budgets in `11` §3.9.1 and `02` §3.16.4 are hard
 * gates **on the reference runners at release**. `--gate` is that check, added with the dataset
 * those budgets are stated over (`M1-T33`); each row carries its own budget, so there is no table
 * here to drift from the benchmarks.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { argv, env, exit, stdout } from 'node:process';
import {
  type BenchProfile,
  BenchProfileSchema,
  type BenchResult,
  budgetShare,
  budgetVerdict,
  currentEnv,
  type ErasedBench,
  largerIsBetter,
  runSuite,
  toGab,
} from '../../packages/evals/src/perf/index.js';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * The commit a result belongs to.
 *
 * Here rather than in `@comvivo/evals`, because asking git means spawning a subprocess and
 * `08` PSC-8 allows that only in the plugin sandbox and the transcription worker. A script is not
 * subject to that rule and is the right place for it anyway: the library measures, the CLI knows
 * where it is running.
 *
 * `GITHUB_SHA` when CI set it. A result with no commit is a result nobody can bisect from, so this
 * throws rather than filling in a placeholder.
 */
function headSha(): string {
  const fromCi = env['GITHUB_SHA'];
  if (fromCi !== undefined && fromCi.length >= 7) return fromCi;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: ROOT }).trim();
  } catch (cause) {
    throw new Error('a benchmark result needs a commit; `git rev-parse HEAD` failed', { cause });
  }
}

interface Options {
  readonly out: string;
  /** Override the commit, for a run whose results belong to a build somewhere else. */
  readonly sha: string | undefined;
  readonly summary: string | undefined;
  readonly filter: string | undefined;
  readonly profile: BenchProfile | undefined;
  readonly scale: number | undefined;
  /** Fail the process when a row misses its budget (`11` §3.9.3's release gate). */
  readonly gate: boolean;
}

function parseArgs(args: readonly string[]): Options {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const scale = value('scale');
  const profile = value('profile');
  return {
    out: value('out') ?? '.bench/results.json',
    sha: value('sha'),
    summary: value('summary'),
    filter: value('filter'),
    profile: profile === undefined ? undefined : BenchProfileSchema.parse(profile),
    scale: scale === undefined ? undefined : Number(scale),
    gate: args.includes('--gate'),
  };
}

/** Every `*.bench.ts` under `packages/` and `scripts/`, in a stable order. */
async function suiteFiles(filter: string | undefined): Promise<readonly string[]> {
  const found: string[] = [];
  for await (const entry of glob('{packages,scripts}/**/*.bench.ts', {
    cwd: ROOT,
    exclude: (name) => name === 'node_modules' || name === 'dist',
  })) {
    if (filter === undefined || entry.includes(filter)) found.push(entry);
  }
  return found.toSorted();
}

async function main(): Promise<void> {
  const options = parseArgs(argv.slice(2));
  const files = await suiteFiles(options.filter);
  if (files.length === 0) {
    // Not an error: a filter that matches nothing is a typo, and a tree with no benchmarks yet is
    // a legitimate state. Both are clearer as a message than as an empty results file.
    stdout.write('bench: no `*.bench.ts` suites matched.\n');
    return;
  }

  const machine = currentEnv(options.profile);
  const sha = options.sha ?? headSha();
  const results: BenchResult[] = [];
  for (const file of files) {
    const module = (await import(resolve(ROOT, file))) as {
      default?: readonly ErasedBench[];
    };
    const definitions = module.default;
    if (definitions === undefined || definitions.length === 0) {
      throw new Error(`${file} exports no benchmarks; a bench file default-exports an array`);
    }
    stdout.write(`bench: ${file} (${String(definitions.length)})\n`);
    results.push(
      ...(await runSuite(definitions, {
        env: machine,
        gitSha: sha,
        ...(options.scale === undefined ? {} : { scale: options.scale }),
      })),
    );
  }

  const outPath = resolve(ROOT, options.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ results, gab: toGab(results) }, null, 2)}\n`);

  if (options.summary !== undefined) {
    // Markdown, written here rather than assembled in a workflow: the formatter that already
    // builds the table for a terminal is the one place that knows the columns, and a shell script
    // doing it again is a second place to get them wrong.
    const summaryPath = resolve(ROOT, options.summary);
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, markdown(results, machine.arch));
  }

  stdout.write(`\n${table(results)}\n`);
  stdout.write(
    `bench: ${String(results.length)} result(s) → ${relative(ROOT, outPath)} ` +
      `(${machine.profile} on ${machine.runner}, ${machine.arch})\n`,
  );

  const missed = results.filter((result) => budgetVerdict(result) === 'miss');
  if (missed.length > 0) {
    // Printed whether or not `--gate` is set: a row over budget is worth saying out loud on a
    // laptop too, and `02` §3.16.4's own rule is that a miss becomes a deviation filed in `15`
    // rather than a budget quietly raised.
    for (const result of missed) {
      stdout.write(
        `bench: ${result.id} missed its budget — ${String(round(result.value))} ${result.unit} ` +
          `against ${largerIsBetter(result.unit) ? '≥' : '≤'} ${String(result.budget ?? 0)} ` +
          `${result.unit} (${String(budgetShare(result) ?? 0)}%)\n`,
      );
    }
    if (options.gate) exit(1);
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** A row's budget as a cell: the limit and the share of it used, or empty for a trend row. */
function budgetCell(result: BenchResult): string {
  if (result.budget === undefined) return '';
  const verdict = budgetVerdict(result);
  const limit = `${largerIsBetter(result.unit) ? '≥' : '≤'} ${String(result.budget)} ${result.unit}`;
  // `<1%` rather than `0%`: three of `02` §3.16.4's rows use a fraction of a percent of their
  // budget, and printing that as zero reads like a row that did not run.
  const share = budgetShare(result) ?? 0;
  return `${verdict === 'miss' ? '✗' : '✓'} ${limit} (${share === 0 ? '<1' : String(share)}%)`;
}

/**
 * The same table as markdown, for `$GITHUB_STEP_SUMMARY`.
 *
 * `11` §3.9.3's dashboard is the long-term view; this is the one a person reads on the day a push
 * lands, without downloading an artefact.
 */
function markdown(results: readonly BenchResult[], arch: string): string {
  const rows = results.map(
    (result) =>
      `| ${result.id} | ${result.name} | ${String(round(result.value))} ${result.unit} | ` +
      `${result.range ?? ''} | ${budgetCell(result)} |`,
  );
  const missed = results.filter((result) => budgetVerdict(result) === 'miss').length;
  return [
    `### Benchmarks (${arch})`,
    '',
    '| id | name | value | spread | budget |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    missed === 0
      ? 'Every row with a budget is inside it. A trend run does not gate (`11` §3.9.3); ' +
        '`pnpm bench --gate` is the release check.'
      : `**${String(missed)} row(s) over budget.** \`02\` §3.16.4: a miss is a deviation filed in ` +
        '`15` and `STATUS.md`, not a budget raised.',
    '',
  ].join('\n');
}

/** A table, because a benchmark nobody reads is a benchmark nobody acts on. */
function table(results: readonly BenchResult[]): string {
  const rows = results.map((result) => [
    result.id,
    result.name,
    `${String(round(result.value))} ${result.unit}`,
    result.range ?? '',
    budgetCell(result),
  ]);
  const widths = [0, 1, 2, 3, 4].map((column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length), 0),
  );
  return rows
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  '))
    .join('\n');
}

try {
  await main();
} catch (error) {
  stdout.write(`bench: ${(error as Error).message}\n`);
  exit(1);
}
