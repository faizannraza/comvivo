/**
 * `pnpm labels:sync` — reconcile the repository's labels with `.github/labels.yml` (`13` §3.F.2).
 *
 * The policy — and why extras are reported rather than deleted — is in `./label-policy.ts`.
 *
 * Uses `gh` rather than a third-party action. The action would be one more thing holding a token
 * on this repository (`08` §3.15), for a job that is one API call per label.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { type Label, parseLabels, planSync } from './label-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const dryRun = argv.includes('--check');

function gh(args: readonly string[]): string {
  return execFileSync('gh', [...args], { cwd: ROOT, encoding: 'utf8' });
}

const labels = parseLabels(readFileSync(`${ROOT}/.github/labels.yml`, 'utf8'));

let existing: Label[];
try {
  existing = (
    JSON.parse(gh(['label', 'list', '--limit', '200', '--json', 'name,color,description'])) as {
      name: string;
      color: string;
      description: string | null;
    }[]
  ).map((label) => ({
    name: label.name,
    color: label.color.toUpperCase(),
    description: label.description ?? '',
  }));
} catch (error) {
  stdout.write(
    `labels: could not list the repository's labels (${String(error)}).\n` +
      'This needs `gh` authenticated with repo access. In CI it runs with GITHUB_TOKEN.\n',
  );
  exit(1);
}

const plan = planSync(labels, existing);

for (const label of plan.create) {
  if (!dryRun) {
    gh(['label', 'create', label.name, '--color', label.color, '--description', label.description]);
  }
  stdout.write(`  ${dryRun ? 'would create' : 'created'}  ${label.name}\n`);
}
for (const label of plan.update) {
  if (!dryRun) {
    gh(['label', 'edit', label.name, '--color', label.color, '--description', label.description]);
  }
  stdout.write(`  ${dryRun ? 'would update' : 'updated'}  ${label.name}\n`);
}
for (const name of plan.extra) {
  stdout.write(`  extra (not deleted)  ${name}\n`);
}

stdout.write(
  `labels: ${String(plan.create.length)} to create, ${String(plan.update.length)} to update, ` +
    `${String(plan.unchanged)} unchanged, ${String(plan.extra.length)} extra.\n`,
);

// `--check` is for CI: the file is the source of truth, so a drift is a failure there even though
// it is only a report locally.
exit(dryRun && (plan.create.length > 0 || plan.update.length > 0) ? 1 : 0);
