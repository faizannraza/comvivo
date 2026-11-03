/**
 * `pnpm secrets:check` — fail if a tracked source file contains a contiguous secret-shaped literal.
 *
 * The policy, and why it exists, is in `./literal-secrets.ts`.
 */
import { execFileSync } from 'node:child_process';
import { exit, stdout } from 'node:process';
import { explain, isScanned, scanFiles } from './literal-secrets.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Tracked files **plus** new files that are not ignored.
 *
 * `git ls-files` alone lists only what is in the index, which makes a scanner blind to exactly the
 * files most likely to contain a problem: the ones just written and not yet added. That is not
 * hypothetical — `pnpm verify` reported this check clean over a tree whose new files it could not
 * see, and the finding only appeared after the commit. `--others --exclude-standard` adds untracked
 * files while still honouring `.gitignore`, so `node_modules`, `dist` and `coverage` stay out.
 */
function listFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path !== '');
}

const tracked = listFiles(ROOT);

const scanned = tracked.filter(isScanned);
const findings = scanFiles(ROOT, tracked);

if (findings.length === 0) {
  stdout.write(
    `secrets: clean — no secret-shaped literal in ${String(scanned.length)} scanned files.\n`,
  );
  exit(0);
}

stdout.write(explain(findings));
exit(1);
