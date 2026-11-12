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
import { argv, exit, stdout } from 'node:process';
import { validateChooserConfig, validateIssueForm } from '../github/issue-forms.js';
import { readListed } from '../support/read-listed.js';
import { type Finding, type Rule, report } from './finding.js';
import { findSnapshotViolations, SNAPSHOT_RULES } from './snapshot-policy.js';
import { findHygieneViolations, HYGIENE_RULES, isTestFile } from './test-hygiene.js';
import { findWorkflowViolations, WORKFLOW_RULES } from './workflow-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const gate = argv.includes('--gate');

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

/**
 * Read a listed file, or record why not.
 *
 * `undefined` used to mean "deleted between listing and reading" *and* "could not be read for any
 * other reason", so a file with the wrong permissions passed every hygiene rule silently. Now only
 * the race is silent; anything else becomes a problem, because a file this check could not read is
 * a file it did not check. Found by the M1 exit gate's reviewer.
 */
const unreadable: { path: string; reason: string }[] = [];
const read = (path: string): string | undefined => {
  const result = readListed(`${ROOT}/${path}`);
  if (result.kind === 'text') return result.text;
  if (result.kind === 'failed') unreadable.push({ path, reason: result.reason });
  return undefined;
};

const sources = tracked.filter((path) => /\.tsx?$/.test(path) && !path.includes('/__fixtures__/'));
const workflows = tracked.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path));
const shellScripts = tracked.filter((path) => path.endsWith('.sh'));
const issueForms = tracked.filter((path) => /^\.github\/ISSUE_TEMPLATE\/[^/]+\.ya?ml$/.test(path));

/** `1 workflow`, `3 workflows`. Tool output is copy too. */
function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

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

/**
 * Issue forms, validated against GitHub's own schema.
 *
 * A malformed form **fails silently** — GitHub drops it from the chooser and reports nothing. The
 * GraphQL `issueTemplates` field covers only legacy Markdown templates (verified by control:
 * `vitejs/vite` has four YAML forms and that field reports zero), so there is no way to ask
 * GitHub whether a form parsed. This is the only check there is.
 */
for (const path of issueForms) {
  const source = read(path);
  if (source === undefined) continue;
  const basename = path.split('/').pop() ?? '';
  const found =
    basename === 'config.yml'
      ? validateChooserConfig(path, source)
      : validateIssueForm(path, source);
  for (const problem of found) {
    findings.push({
      file: problem.file,
      line: 1,
      rule: 'issue-form-schema',
      message: problem.detail,
      source: '',
    });
  }
}

const ISSUE_FORM_RULE: Rule = {
  id: 'issue-form-schema',
  summary: "Issue forms must match GitHub's schema.",
  rationale:
    'A malformed form is dropped from the chooser silently — no error, no API signal. The only ' +
    'way anybody finds out is that the option is missing when they try to file an issue.',
};

const UNREADABLE_RULE: Rule = {
  id: 'file-unreadable',
  summary: 'Every listed file must be readable, or this check has not checked it.',
  rationale:
    'A read failure used to be indistinguishable from the `git ls-files` race, so a file with ' +
    'the wrong permissions passed every rule below in silence. The race (`ENOENT`) is still ' +
    'ignored; anything else is reported, because "could not look" is not "looked and found ' +
    'nothing".',
};

// After every rule has had its turn, so the list reads in the order the checks ran.
for (const entry of unreadable) {
  findings.push({
    file: entry.path,
    line: 1,
    rule: 'file-unreadable',
    message: `could not be read (${entry.reason}), so no rule was applied to it`,
    source: '',
  });
}

const ALL_RULES: readonly Rule[] = [
  ...SNAPSHOT_RULES,
  ...HYGIENE_RULES,
  ...WORKFLOW_RULES,
  ISSUE_FORM_RULE,
  UNREADABLE_RULE,
];

stdout.write(report('hygiene', ALL_RULES, findings));

if (findings.length === 0) {
  stdout.write(
    `  ${count(testFiles, 'test file')}, ${count(workflows.length, 'workflow')}, ` +
      `${count(shellScripts.length, 'shell script')}, ` +
      count(issueForms.length, 'issue form') +
      (gate ? ', gate mode (no skips allowed)' : '') +
      '.\n',
  );
}

// actionlint is a Go binary with no npm distribution, so it is installed by its own action in the
// `static` job rather than as a dependency. Locally it is used when present and reported as
// skipped when not — which is honest, and better than pretending the check ran.
if (workflows.length > 0) {
  try {
    // `-no-color` is the flag. `-color=never` is a usage error: `-color` is a boolean meaning
    // "always colourful". actionlint then exits non-zero having written its usage to **stderr** —
    // which, with only stdout printed below, produced a CI failure with no message at all. Both
    // streams are reported now, because a check that fails silently is worse than no check.
    //
    // Only workflow files are passed: actionlint treats a composite action as a workflow and
    // reports its missing `on` and `jobs` sections.
    execFileSync('actionlint', ['-no-color', ...workflows], { cwd: ROOT, stdio: 'pipe' });
    stdout.write('  actionlint: clean.\n');
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer; code?: string };
    if (failure.code === 'ENOENT') {
      stdout.write('  actionlint: not installed locally; it runs in the `static` CI job.\n');
    } else {
      const out = failure.stdout?.toString() ?? '';
      const err = failure.stderr?.toString() ?? '';
      stdout.write(`\nactionlint:\n${out}${err}`);
      if (out === '' && err === '') {
        stdout.write(`actionlint exited ${String(failure.status ?? '?')} with no output.\n`);
      }
      exit(1);
    }
  }
}

/**
 * shellcheck on our own `.sh` files.
 *
 * actionlint already runs shellcheck on every workflow `run:` block — which is how SC2129 in
 * `release.yml` was caught, after it had passed locally where shellcheck was not installed. A
 * standalone script is not a workflow, so nothing was checking `install-actionlint.sh`: the one
 * file in the tree whose job is to verify a download. `12` §9's `packaging` job adds hadolint and
 * shellcheck over the deploy scripts; this covers ours now, at the same cost.
 */
if (shellScripts.length > 0) {
  try {
    execFileSync('shellcheck', ['--color=never', ...shellScripts], { cwd: ROOT, stdio: 'pipe' });
    stdout.write('  shellcheck: clean.\n');
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer; code?: string };
    if (failure.code === 'ENOENT') {
      stdout.write('  shellcheck: not installed locally; it runs in the `static` CI job.\n');
    } else {
      const out = failure.stdout?.toString() ?? '';
      const err = failure.stderr?.toString() ?? '';
      stdout.write(`\nshellcheck:\n${out}${err}`);
      if (out === '' && err === '') {
        stdout.write(`shellcheck exited ${String(failure.status ?? '?')} with no output.\n`);
      }
      exit(1);
    }
  }
}

exit(findings.length === 0 ? 0 : 1);
