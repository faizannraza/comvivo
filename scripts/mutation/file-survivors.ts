/**
 * One issue per surviving mutant in IFC or policy (`11` §3.1.5).
 *
 * A surviving mutant there is a test gap in the code that enforces `I1` — `M1-T34`'s first run
 * found `every` → `some` surviving in `canRead`, which is containment weakened to overlap with the
 * suite green either way — so it gets an issue rather than a line in a log. Elsewhere in core a
 * survivor is a number on a trend, and the weekly summary is enough.
 *
 * **Idempotent**: the title is derived from the mutant's file, line and mutator, and an open issue
 * with the same title is left alone. A weekly job that opened the same issue every Monday would be
 * read as noise within a month, and then so would the real ones.
 *
 * Runs only in CI, where `gh` and `GH_TOKEN` exist. Locally it prints what it would file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { env, exit, stdout } from 'node:process';

interface Mutant {
  readonly mutatorName: string;
  readonly status: string;
  readonly replacement?: string;
  readonly location: { readonly start: { readonly line: number } };
}
interface Report {
  readonly files: Record<string, { readonly mutants: readonly Mutant[]; readonly source: string }>;
}

const REPORT = 'reports/mutation/ifc-policy.json';
const LABEL = 'mutation-survivor';

if (!existsSync(REPORT)) {
  stdout.write(`mutation: no ${REPORT}; nothing to file.\n`);
  exit(0);
}

const parsed = JSON.parse(readFileSync(REPORT, 'utf8')) as Report;
const survivors = Object.entries(parsed.files).flatMap(([path, file]) =>
  file.mutants
    .filter((mutant) => mutant.status === 'Survived')
    .map((mutant) => ({
      path: path.replace(/^.*packages\/core\//, 'packages/core/'),
      line: mutant.location.start.line,
      mutator: mutant.mutatorName,
      replacement: mutant.replacement ?? '(not recorded)',
      original: file.source.split('\n')[mutant.location.start.line - 1]?.trim() ?? '',
    })),
);

if (survivors.length === 0) {
  stdout.write('mutation: no surviving mutants in ifc or policy.\n');
  exit(0);
}

/** `gh`, or `undefined` when it is not available — which is the local case. */
function gh(args: readonly string[]): string | undefined {
  if (env['GH_TOKEN'] === undefined && env['GITHUB_TOKEN'] === undefined) return undefined;
  return execFileSync('gh', [...args], { encoding: 'utf8' });
}

/** The titles already open under the label, so a weekly run never re-files the same gap. */
function openTitlesOf(): ReadonlySet<string> {
  const listed =
    gh([
      'issue',
      'list',
      '--state',
      'open',
      '--label',
      LABEL,
      '--limit',
      '200',
      '--json',
      'title',
    ]) ?? '[]';
  if (!listed.trim().startsWith('[')) return new Set();
  const issues = JSON.parse(listed) as { title: string }[];
  return new Set(issues.map((issue) => issue.title));
}

const openTitles = openTitlesOf();

let filed = 0;
for (const survivor of survivors) {
  const title = `${LABEL}: ${survivor.mutator} survives at ${survivor.path}:${String(survivor.line)}`;
  if (openTitles.has(title)) {
    stdout.write(`mutation: already open — ${title}\n`);
    continue;
  }
  const body = [
    'A mutant survived in the code that enforces `I1`, which means no test would have noticed the',
    'change below. `11` §3.1.5 files these automatically.',
    '',
    `**File:** \`${survivor.path}:${String(survivor.line)}\``,
    `**Mutator:** \`${survivor.mutator}\``,
    '',
    '```diff',
    `- ${survivor.original}`,
    `+ ${survivor.replacement}`,
    '```',
    '',
    'Either a test is missing, or the mutant is equivalent — it cannot change an answer for any',
    'input. If it is equivalent, say why in a `// Stryker disable next-line <Mutator>: <reason>`',
    'comment rather than closing this, so the next run does not re-file it.',
    '',
    'Reproduce: `pnpm run mutation:ifc`.',
  ].join('\n');
  const created = gh(['issue', 'create', '--title', title, '--label', LABEL, '--body', body]);
  if (created === undefined) {
    stdout.write(`mutation: would file — ${title}\n`);
    continue;
  }
  stdout.write(`mutation: filed — ${created.trim()}\n`);
  filed += 1;
}

stdout.write(
  `mutation: ${String(survivors.length)} survivor(s) in ifc/policy, ${String(filed)} new issue(s).\n`,
);
