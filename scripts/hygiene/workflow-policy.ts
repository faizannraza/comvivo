/**
 * GitHub Actions workflow policy (`08` §3.15, `11` §3.8.1–§3.8.3).
 *
 * These are the rules `actionlint` does **not** check. actionlint validates syntax, expressions and
 * `runs-on` labels — all worth having, and it runs in the `static` job via its own action. It has
 * nothing to say about whether an action is pinned to a SHA or whether a job can write to the
 * repository, which are the two things that decide what a compromised dependency can do to us.
 *
 * The threat these address is specific. A workflow runs with a token, on our repository, with our
 * secrets in reach. `uses: some/action@v4` is a mutable tag: whoever controls that repository
 * controls what runs here, retroactively, without a commit in our history. A job with the default
 * `permissions` can push to `main`. Neither of those is a hypothetical — both are how real
 * supply-chain compromises of CI have worked.
 */
import { parse as parseYaml } from 'yaml';
import type { Finding, Rule } from './finding.js';

export const WORKFLOW_RULES: readonly Rule[] = [
  {
    id: 'top-level-permissions-empty',
    summary: 'Declare `permissions: {}` at the top of every workflow.',
    rationale:
      'Without it a job inherits the repository default, which on many repositories is write. ' +
      'Starting from nothing and granting per job means a new job cannot quietly acquire more ' +
      'than it needs.',
  },
  {
    id: 'job-permissions-declared',
    summary: 'Every job declares its own `permissions`.',
    rationale:
      'With `permissions: {}` at the top, a job that needs `contents: read` must say so — which ' +
      'makes the diff that grants `contents: write` something a reviewer sees.',
  },
  {
    id: 'actions-sha-pinned',
    summary: 'Pin every third-party action to a full 40-character commit SHA.',
    rationale:
      'A tag is mutable. `@v4` means "whatever that repository calls v4 today", so whoever ' +
      'controls it controls what runs in our CI, with our token, without appearing in our history.',
  },
  {
    id: 'no-pull-request-target',
    summary: 'Never use `pull_request_target`.',
    rationale:
      'It runs with a writable token in the context of the base repository while checking out a ' +
      'fork’s code. That combination is the textbook CI compromise.',
  },
  {
    id: 'job-timeout-declared',
    summary: 'Every job sets `timeout-minutes`.',
    rationale:
      'The default is six hours. A hung job holds the merge queue and burns the runner budget ' +
      'that `11` §8 accounts for.',
  },
  {
    id: 'no-template-injection',
    summary: 'Never interpolate attacker-controlled `github.event` fields into `run:`.',
    rationale:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax quoted in prose, not a JS template literal.
      'A PR title is user input. `run: echo ${{ github.event.pull_request.title }}` executes it ' +
      'as shell. Pass it through `env:` and quote the variable.',
  },
  {
    id: 'concurrency-declared',
    summary: 'Declare `concurrency` on workflows triggered by `pull_request`.',
    rationale:
      'Without it every push to a branch starts another full run, and the queue fills with work ' +
      'whose result nobody will read.',
  },
];

/** Fields of `github.event` an outside contributor controls. */
const ATTACKER_CONTROLLED = [
  'github.event.pull_request.title',
  'github.event.pull_request.body',
  'github.event.pull_request.head.ref',
  'github.event.pull_request.head.label',
  'github.event.pull_request.head.repo.description',
  'github.event.issue.title',
  'github.event.issue.body',
  'github.event.comment.body',
  'github.event.review.body',
  'github.event.head_commit.message',
  'github.head_ref',
];

const SHA_PINNED = /@[0-9a-f]{40}$/;

interface WorkflowJob {
  readonly permissions?: unknown;
  readonly 'timeout-minutes'?: unknown;
  readonly uses?: unknown;
}

interface Workflow {
  readonly on?: unknown;
  readonly permissions?: unknown;
  readonly concurrency?: unknown;
  readonly jobs?: Readonly<Record<string, WorkflowJob | null>>;
}

/** Line number of the first line matching `pattern`, 1-based, or 1 if absent. */
function lineOf(source: string, pattern: RegExp): number {
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? 1 : index + 1;
}

type Add = (line: number, rule: string, message: string) => void;

/** `permissions: {}` parses to an empty object. Anything else, including absent, is a finding. */
function checkTopLevelPermissions(workflow: Workflow, source: string, add: Add): void {
  const permissions = workflow.permissions;
  const isEmptyObject =
    typeof permissions === 'object' &&
    permissions !== null &&
    !Array.isArray(permissions) &&
    Object.keys(permissions).length === 0;
  if (isEmptyObject) return;
  add(
    lineOf(source, /^permissions\s*:/),
    'top-level-permissions-empty',
    permissions === undefined
      ? 'add `permissions: {}` at the top level and grant per job.'
      : 'the top level must be `permissions: {}`; grant what each job needs on the job.',
  );
}

function triggerNamesOf(workflow: Workflow): string[] {
  const triggers = workflow.on;
  if (typeof triggers === 'string') return [triggers];
  if (Array.isArray(triggers)) return triggers.map(String);
  if (typeof triggers === 'object' && triggers !== null) return Object.keys(triggers);
  return [];
}

function checkTriggers(workflow: Workflow, source: string, add: Add): void {
  const names = triggerNamesOf(workflow);

  if (names.includes('pull_request_target')) {
    add(
      lineOf(source, /pull_request_target/),
      'no-pull-request-target',
      'use `pull_request` and, if a privileged step is genuinely needed, a separate workflow on `workflow_run`.',
    );
  }

  if (names.includes('pull_request') && workflow.concurrency === undefined) {
    add(
      lineOf(source, /^on\s*:/),
      'concurrency-declared',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax for the author to copy, not a JS template literal.
      'add `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`.',
    );
  }
}

function checkJobs(workflow: Workflow, source: string, add: Add): void {
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    const line = lineOf(source, new RegExp(`^\\s{2}${name}\\s*:`));
    // A job that calls a reusable workflow inherits permissions from the caller and cannot set
    // `timeout-minutes`, so for it these rules would be impossible rather than merely unmet.
    if (typeof job?.uses === 'string') continue;

    if (job?.permissions === undefined) {
      add(line, 'job-permissions-declared', `job \`${name}\` declares no permissions.`);
    }
    if (job?.['timeout-minutes'] === undefined) {
      add(
        line,
        'job-timeout-declared',
        `job \`${name}\` has no timeout-minutes (default: 6 hours).`,
      );
    }
  }
}

function checkUses(text: string, line: number, add: Add): void {
  const match = /^\s*(?:-\s*)?uses\s*:\s*["']?([^"'\s#]+)/.exec(text);
  if (match === null) return;
  const reference = match[1] ?? '';
  // A local action or reusable workflow is pinned by being in this commit.
  if (reference.startsWith('./') || SHA_PINNED.test(reference)) return;
  add(
    line,
    'actions-sha-pinned',
    `\`${reference}\` is not pinned to a 40-character SHA. Use owner/repo@<sha> # vX.Y.Z.`,
  );
}

function checkInjection(lines: readonly string[], index: number, add: Add): void {
  const text = lines[index] ?? '';
  for (const field of ATTACKER_CONTROLLED) {
    if (!text.includes(`\${{ ${field}`) && !text.includes(`\${{${field}`)) continue;
    // Only inside a `run:` block. Flagging the whole file would also flag the `env:` form, which
    // is the fix being recommended.
    if (!isInsideRun(lines, index)) continue;
    add(
      index + 1,
      'no-template-injection',
      `\`${field}\` is attacker-controlled. Put it in \`env:\` and reference "$VAR" in the script.`,
    );
  }
}

export function findWorkflowViolations(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split(/\r?\n/);
  const add: Add = (line, rule, message) => {
    findings.push({ file: path, line, rule, message, source: (lines[line - 1] ?? '').trim() });
  };

  let workflow: Workflow;
  try {
    const parsed: unknown = parseYaml(source, { merge: false });
    if (parsed === null || typeof parsed !== 'object') {
      add(1, 'top-level-permissions-empty', 'this file is not a workflow mapping.');
      return findings;
    }
    workflow = parsed as Workflow;
  } catch (cause) {
    add(1, 'top-level-permissions-empty', `not valid YAML: ${String(cause)}`);
    return findings;
  }

  checkTopLevelPermissions(workflow, source, add);
  checkTriggers(workflow, source, add);
  checkJobs(workflow, source, add);
  lines.forEach((text, index) => {
    checkUses(text, index + 1, add);
    checkInjection(lines, index, add);
  });

  return findings;
}

/**
 * Whether a line sits inside a `run:` block.
 *
 * Walks back to the nearest key at a shallower indent. Good enough and deliberately simple: this
 * rule exists to catch the one-line mistake, and the structural version of the same check is
 * zizmor's job (`08` §3.15).
 */
function isInsideRun(lines: readonly string[], index: number): boolean {
  const indentOf = (text: string): number => text.length - text.trimStart().length;
  const own = indentOf(lines[index] ?? '');
  if (/^\s*(?:-\s*)?run\s*:/.test(lines[index] ?? '')) return true;
  for (let i = index - 1; i >= 0; i--) {
    const text = lines[i] ?? '';
    if (text.trim() === '') continue;
    if (indentOf(text) >= own) continue;
    return /^\s*(?:-\s*)?run\s*:/.test(text);
  }
  return false;
}
