/**
 * `pnpm changeset:required` — fail a pull request that changes shipped behaviour with no changeset.
 *
 * The policy, and why the waiver label exists, is in `./changeset-policy.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { argv, env, exit, stdout } from 'node:process';
import { decide, explain, shouldFail } from './changeset-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

/** The base to diff against: `--base <ref>`, then `GITHUB_BASE_REF`, then `origin/main`. */
function baseRef(): string {
  const flag = argv.indexOf('--base');
  if (flag !== -1 && argv[flag + 1] !== undefined) return argv[flag + 1] ?? 'origin/main';
  const github = env['GITHUB_BASE_REF'];
  return github === undefined || github === '' ? 'origin/main' : `origin/${github}`;
}

function changedFiles(base: string): string[] {
  try {
    // Three dots: compare against the merge base, so files changed on `main` since the branch
    // started are not attributed to this pull request.
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: ROOT,
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

function changesets(): string[] {
  try {
    return readdirSync(`${ROOT}/.changeset`).filter(
      (name) => name.endsWith('.md') && name !== 'README.md',
    );
  } catch {
    return [];
  }
}

/** Labels from the pull-request event payload, or `--labels a,b`. */
function labels(): string[] {
  const flag = argv.indexOf('--labels');
  if (flag !== -1 && argv[flag + 1] !== undefined) {
    return (argv[flag + 1] ?? '').split(',').map((label) => label.trim());
  }
  const path = env['GITHUB_EVENT_PATH'];
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

const decision = decide({
  changedFiles: changedFiles(baseRef()),
  changesets: changesets(),
  labels: labels(),
});

stdout.write(explain(decision));
exit(shouldFail(decision) ? 1 : 0);
