/**
 * `pnpm hygiene:check` — the static checks in `11` §3.1.10–§3.1.11 and `08` §3.15.
 *
 * Runs in the `static` CI job alongside `actionlint`, which this deliberately does not duplicate:
 * actionlint checks workflow syntax and expressions, and `workflow-policy.ts` checks the things it
 * has nothing to say about (SHA pinning, least-privilege tokens).
 *
 * `--gate` tightens the skip rule to `CLAUDE.md` §8: no skipped tests at all at a milestone gate.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { type Finding, type Rule, report } from './finding.js';
import { findSnapshotViolations, SNAPSHOT_RULES } from './snapshot-policy.js';
import { findHygieneViolations, HYGIENE_RULES, isTestFile } from './test-hygiene.js';
import { findWorkflowViolations, WORKFLOW_RULES } from './workflow-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const gate = argv.includes('--gate');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((path) => path !== '');

const read = (path: string): string | undefined => {
  try {
    return readFileSync(`${ROOT}/${path}`, 'utf8');
  } catch {
    return undefined; // deleted between listing and reading
  }
};

const sources = tracked.filter((path) => /\.tsx?$/.test(path) && !path.includes('/__fixtures__/'));
const workflows = tracked.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path));

const findings: Finding[] = [];
let testFiles = 0;

for (const path of sources) {
  const source = read(path);
  if (source === undefined) continue;
  findings.push(...findSnapshotViolations(path, source));
  if (isTestFile(path)) {
    testFiles += 1;
    findings.push(...findHygieneViolations(path, source, { gate }));
  }
}

for (const path of workflows) {
  const source = read(path);
  if (source !== undefined) findings.push(...findWorkflowViolations(path, source));
}

const ALL_RULES: readonly Rule[] = [...SNAPSHOT_RULES, ...HYGIENE_RULES, ...WORKFLOW_RULES];

stdout.write(report('hygiene', ALL_RULES, findings));

if (findings.length === 0) {
  stdout.write(
    `  ${String(testFiles)} test files, ${String(workflows.length)} workflows` +
      `${gate ? ', gate mode (no skips allowed)' : ''}.\n`,
  );
}

// actionlint is a Go binary with no npm distribution, so it is installed by its own action in the
// `static` job rather than as a dependency. Locally it is used when present and reported as
// skipped when not — which is honest, and better than pretending the check ran.
if (workflows.length > 0) {
  try {
    execFileSync('actionlint', ['-color=never', ...workflows], { cwd: ROOT, stdio: 'pipe' });
    stdout.write('  actionlint: clean.\n');
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; code?: string };
    if (failure.code === 'ENOENT') {
      stdout.write('  actionlint: not installed locally; it runs in the `static` CI job.\n');
    } else {
      stdout.write(`\nactionlint:\n${failure.stdout?.toString() ?? ''}\n`);
      exit(1);
    }
  }
}

exit(findings.length === 0 ? 0 : 1);
