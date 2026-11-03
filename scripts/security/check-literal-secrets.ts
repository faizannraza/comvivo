/**
 * `pnpm secrets:check` — fail if a tracked source file contains a contiguous secret-shaped literal.
 *
 * The policy, and why it exists, is in `./literal-secrets.ts`.
 */
import { execFileSync } from 'node:child_process';
import { exit, stdout } from 'node:process';
import { explain, isScanned, scanFiles } from './literal-secrets.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((path) => path !== '');

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
