/**
 * `pnpm changeset:required` — fail a pull request that changes shipped behaviour with no changeset.
 *
 * The policy, and why the waiver label exists, is in `./changeset-policy.ts`.
 *
 * ## Why the four readers take their inputs
 *
 * `baseRef`, `changedFiles`, `changesets` and `labels` were private and ran at import time, so
 * nothing tested them: only the pure `changeset-policy.ts` had coverage, and a defect in label
 * extraction or base-ref resolution would have made this check pass — or fail — vacuously on every
 * pull request with no test noticing. Found by the M0 independent review.
 *
 * They are exported now and take `argv`, `env` and the repository root as parameters with the real
 * values as defaults, which is what makes them exercisable without a pull request. `main()` sits
 * behind `import.meta.main` so importing the module for a test does not run the check.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { argv, env, exit, stdout } from 'node:process';
import { decide, explain, shouldFail } from './changeset-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

/** The base to diff against: `--base <ref>`, then `GITHUB_BASE_REF`, then `origin/main`. */
export function baseRef(
  args: readonly string[] = argv,
  environment: Readonly<Record<string, string | undefined>> = env,
): string {
  const flag = args.indexOf('--base');
  if (flag !== -1 && args[flag + 1] !== undefined) return args[flag + 1] ?? 'origin/main';
  const github = environment['GITHUB_BASE_REF'];
  return github === undefined || github === '' ? 'origin/main' : `origin/${github}`;
}

export function changedFiles(base: string, root: string = ROOT): string[] {
  try {
    // Three dots: compare against the merge base, so files changed on `main` since the branch
    // started are not attributed to this pull request.
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((path) => path !== '');
  } catch (error) {
    stdout.write(
      `changeset: could not diff against ${base} (${String(error)}).\n` +
        'Fetch the base branch first — in CI, `actions/checkout` needs `fetch-depth: 0`.\n',
    );
    exit(1);
  }
}

export function changesets(root: string = ROOT): string[] {
  try {
    return readdirSync(`${root}/.changeset`).filter(
      (name) => name.endsWith('.md') && name !== 'README.md',
    );
  } catch {
    return [];
  }
}

/** Labels from the pull-request event payload, or `--labels a,b`. */
export function labels(
  args: readonly string[] = argv,
  environment: Readonly<Record<string, string | undefined>> = env,
): string[] {
  const flag = args.indexOf('--labels');
  if (flag !== -1 && args[flag + 1] !== undefined) {
    return (args[flag + 1] ?? '').split(',').map((label) => label.trim());
  }
  const path = environment['GITHUB_EVENT_PATH'];
  if (path === undefined || path === '') return [];
  try {
    const event = JSON.parse(readFileSync(path, 'utf8')) as {
      pull_request?: { labels?: { name?: unknown }[] };
    };
    // Only a string name counts. `String(unknown)` would turn an object into "[object Object]",
    // which could then be compared against the waiver label and quietly not match — or, worse,
    // match a label literally named that. Found once the type-aware rules reached `scripts/**`.
    return (event.pull_request?.labels ?? [])
      .map((label) => label.name)
      .filter((name): name is string => typeof name === 'string' && name !== '');
  } catch {
    return [];
  }
}

/** Run the check. Returns the process exit code rather than calling `exit`, so a test can call it. */
export function main(): number {
  const decision = decide({
    changedFiles: changedFiles(baseRef()),
    changesets: changesets(),
    labels: labels(),
  });
  stdout.write(explain(decision));
  return shouldFail(decision) ? 1 : 0;
}

// `import.meta.main` is Node 24+; this file is also imported by its test, which must not run main.
if (import.meta.main) {
  exit(main());
}
