/**
 * Planted-violation fixtures for every hygiene rule.
 *
 * The project's governing lesson, learned three times now: **assert that a guard fails on a planted
 * violation, never that it is configured.** The dependency-cruiser config reported "no violations"
 * over an empty graph, `no-implied-eval` reported nothing because no global was declared, and the
 * Telegram scrub pattern could not match the form it was written for. Each looked correct in
 * review.
 *
 * So each rule gets a fixture that is the plausible wrong turn — a `.only` left in a commit, a real
 * `setTimeout` waiting for an outbox, an action pinned to `@v4` — and a clean counterpart that must
 * produce nothing. The fixtures live in `__fixtures__/*.txt` rather than as strings here: a `.txt`
 * file is never compiled, never executed, and never scanned by the real check, so the fixture can
 * be the actual construct rather than an escaped imitation of it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Finding } from './finding.js';
import { report } from './finding.js';
import { findSnapshotViolations, isSnapshotAllowed, SNAPSHOT_RULES } from './snapshot-policy.js';
import { findHygieneViolations, HYGIENE_RULES, isTestFile } from './test-hygiene.js';
import { findWorkflowViolations, WORKFLOW_RULES } from './workflow-policy.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}.txt`, import.meta.url), 'utf8');

const rulesIn = (findings: readonly Finding[]): string[] => [
  ...new Set(findings.map((finding) => finding.rule)),
];

// A path outside the renderer allowlist, and one inside it.
const ENGINE_TEST = 'packages/engine/src/turn/engine.test.ts';
const RENDER_TEST = 'packages/channels/telegram/src/render.test.ts';

describe('the snapshot policy', () => {
  it('fires every rule on the planted fixture', () => {
    const findings = findSnapshotViolations(ENGINE_TEST, fixture('snapshot-dirty'));
    expect(rulesIn(findings).toSorted()).toEqual([
      'no-anonymous-snapshots',
      'snapshots-only-in-renderers',
    ]);
  });

  it('catches a file snapshot with no real extension, inside the allowlist', () => {
    const findings = findSnapshotViolations(RENDER_TEST, fixture('render-dirty'));
    expect(rulesIn(findings)).toEqual(['file-snapshot-needs-extension']);
  });

  it('allows a renderer snapshot with a real extension', () => {
    expect(findSnapshotViolations(RENDER_TEST, fixture('render-clean'))).toEqual([]);
  });

  it('finds nothing in a test that asserts explicit fields', () => {
    expect(findSnapshotViolations(ENGINE_TEST, fixture('snapshot-clean'))).toEqual([]);
  });

  it('rejects `.snap` even inside the allowlist', () => {
    // `.snap` is the thing being replaced; allowing it would make the rule decorative.
    const findings = findSnapshotViolations(
      RENDER_TEST,
      "await expect(x).toMatchFileSnapshot('./__snapshots__/a.snap');",
    );
    expect(rulesIn(findings)).toEqual(['file-snapshot-needs-extension']);
  });

  it('does not flag a matcher quoted inside a string', () => {
    // Without this, the test above — which quotes `.toMatchFileSnapshot` to check the extension
    // rule — is itself a violation. Found exactly that way: the finding appeared only once this
    // file was committed, because the runner enumerated tracked files and had not seen it before.
    const source = [
      "it('rejects a bare .snap', () => {",
      '  const snippet = "expect(x).toMatchSnapshot();";',
      '  expect(check(snippet)).toHaveLength(1);',
      '});',
    ].join('\n');
    expect(findSnapshotViolations(ENGINE_TEST, source)).toEqual([]);
  });

  it('still flags a real matcher on a line that also contains a string', () => {
    const source = "expect(renderThing('a label')).toMatchSnapshot();";
    expect(rulesIn(findSnapshotViolations(ENGINE_TEST, source))).toEqual([
      'no-anonymous-snapshots',
    ]);
  });

  it('allows snapshots exactly where `11` §3.1.10 says', () => {
    for (const path of [
      'packages/channels/sdk/src/render/markdown.test.ts',
      'packages/channels/telegram/src/render.test.ts',
      'packages/channels/slack/src/render/blocks.test.ts',
    ]) {
      expect(isSnapshotAllowed(path), path).toBe(true);
    }
    for (const path of [
      'packages/engine/src/turn/engine.test.ts',
      'packages/core/src/ifc/join.test.ts',
      'packages/channels/telegram/src/ingest.test.ts',
    ]) {
      expect(isSnapshotAllowed(path), path).toBe(false);
    }
  });
});

describe('the test-hygiene rules', () => {
  it('fires every rule on the planted fixture', () => {
    const findings = findHygieneViolations(ENGINE_TEST, fixture('hygiene-dirty'));
    expect(rulesIn(findings).toSorted(), report('debug', HYGIENE_RULES, findings)).toEqual([
      'no-fixed-listen-port',
      'no-inline-retry',
      'no-module-level-mutable-state',
      'no-only',
      'no-real-timers',
      'no-shared-temp-dir',
      'no-unjustified-skip',
    ]);
  });

  it('finds nothing in the clean fixture', () => {
    expect(findHygieneViolations(ENGINE_TEST, fixture('hygiene-clean'))).toEqual([]);
  });

  it.each([
    ['describe.only(', 'no-only'],
    ['it.only(', 'no-only'],
    ['test.only(', 'no-only'],
    ['fit(', 'no-only'],
    ['fdescribe(', 'no-only'],
  ])('catches %s', (snippet, rule) => {
    const findings = findHygieneViolations(ENGINE_TEST, `${snippet}'x', () => {});`);
    expect(rulesIn(findings)).toContain(rule);
  });

  it('accepts a skip that names a task and a reason', () => {
    const source = [
      '// skip(M5-T12): blocked on the outbound guard landing.',
      "it.skip('blocks a reply', () => {});",
    ].join('\n');
    expect(findHygieneViolations(ENGINE_TEST, source)).toEqual([]);
  });

  it('rejects a skip whose comment has no task id', () => {
    const source = ['// skipped for now', "it.skip('blocks a reply', () => {});"].join('\n');
    expect(rulesIn(findHygieneViolations(ENGINE_TEST, source))).toEqual(['no-unjustified-skip']);
  });

  it('rejects even a justified skip at a gate', () => {
    // `CLAUDE.md` §8: no `.skip`/`.todo` at a milestone gate. A justified skip is a scheduling
    // decision during a milestone and unfinished work at its end.
    const source = [
      '// skip(M5-T12): blocked on the outbound guard landing.',
      "it.skip('blocks a reply', () => {});",
    ].join('\n');
    expect(findHygieneViolations(ENGINE_TEST, source, { gate: true })).toHaveLength(1);
    expect(findHygieneViolations(ENGINE_TEST, source, { gate: true })[0]?.message).toContain(
      'milestone gate',
    );
  });

  it('allows `vi.advanceTimersByTime`, which is the fix, not the problem', () => {
    const source = 'vi.useFakeTimers();\nvi.advanceTimersByTime(250);';
    expect(findHygieneViolations(ENGINE_TEST, source)).toEqual([]);
  });

  it('allows listen(0)', () => {
    expect(findHygieneViolations(ENGINE_TEST, 'server.listen(0);')).toEqual([]);
  });

  it('allows a tmpdir used as the parent of an mkdtemp', () => {
    const source = "const dir = mkdtempSync(join(tmpdir(), 'comvivo-'));";
    expect(findHygieneViolations(ENGINE_TEST, source)).toEqual([]);
  });

  it('ignores files that are not tests', () => {
    // The rules are about test suites. A production module may legitimately set a timer and bind
    // a configured port, and flagging those would make the check something people route around.
    const dirty = fixture('hygiene-dirty');
    expect(findHygieneViolations('packages/engine/src/turn/engine.ts', dirty)).toEqual([]);
    expect(isTestFile('packages/engine/src/turn/engine.ts')).toBe(false);
    for (const path of [
      'packages/engine/src/turn/engine.test.ts',
      'packages/storage/src/db.int.test.ts',
      'packages/models/src/anthropic.contract.test.ts',
      'packages/evals/scenarios/family-week.scenario.ts',
    ]) {
      expect(isTestFile(path), path).toBe(true);
    }
  });

  it('does not flag a rule name quoted in a message', () => {
    // The rules strip string literals first. Without that, every test that asserts on this
    // check's own output would be a violation of it — which is how a linter earns an ignore file.
    const source = `it('rejects .only in a commit', () => { expect(m).toContain('describe.only('); });`;
    expect(findHygieneViolations(ENGINE_TEST, source)).toEqual([]);
  });

  it('exempts the files whose subject is the banned construct', () => {
    const dirty = 'server.listen(7777);';
    expect(findHygieneViolations('scripts/harness/network-guard.test.ts', dirty)).toEqual([]);
    // But not some other file that merely sounds similar.
    expect(
      rulesIn(findHygieneViolations('packages/server/src/http/listen.test.ts', dirty)),
    ).toEqual(['no-fixed-listen-port']);
  });
});

describe('the workflow policy', () => {
  it('fires every rule on the planted workflow', () => {
    const findings = findWorkflowViolations('.github/workflows/ci.yml', fixture('workflow-dirty'));
    expect(rulesIn(findings).toSorted(), report('debug', WORKFLOW_RULES, findings)).toEqual([
      'actions-sha-pinned',
      'job-permissions-declared',
      'job-timeout-declared',
      'no-pull-request-target',
      'no-template-injection',
      'top-level-permissions-empty',
    ]);
  });

  it('finds nothing in a workflow that follows the policy', () => {
    expect(findWorkflowViolations('.github/workflows/ci.yml', fixture('workflow-clean'))).toEqual(
      [],
    );
  });

  it('requires concurrency on a pull_request workflow', () => {
    const source = [
      'name: CI',
      'on:',
      '  pull_request:',
      'permissions: {}',
      'jobs:',
      '  a:',
      '    permissions: {}',
      '    timeout-minutes: 5',
      '    steps:',
      '      - run: echo ok',
    ].join('\n');
    expect(rulesIn(findWorkflowViolations('.github/workflows/ci.yml', source))).toEqual([
      'concurrency-declared',
    ]);
  });

  it('accepts a local action without a SHA, because this commit pins it', () => {
    const findings = findWorkflowViolations(
      '.github/workflows/ci.yml',
      fixture('workflow-clean'),
    ).filter((finding) => finding.rule === 'actions-sha-pinned');
    expect(findings).toEqual([]);
  });

  it.each([
    ['actions/checkout@v4', true],
    ['actions/checkout@main', true],
    ['actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8', false],
    ['./.github/actions/setup', false],
  ])('%s is a finding: %s', (reference, expected) => {
    const source = [
      'name: x',
      'on: { push: {} }',
      'permissions: {}',
      'jobs:',
      '  a:',
      '    permissions: {}',
      '    timeout-minutes: 5',
      '    steps:',
      `      - uses: ${reference}`,
    ].join('\n');
    const fired = findWorkflowViolations('.github/workflows/x.yml', source).some(
      (finding) => finding.rule === 'actions-sha-pinned',
    );
    expect(fired).toBe(expected);
  });

  it('flags an attacker-controlled field only inside run:', () => {
    const inRun = [
      'name: x',
      'on: { pull_request: {} }',
      'permissions: {}',
      'concurrency: { group: x }',
      'jobs:',
      '  a:',
      '    permissions: {}',
      '    timeout-minutes: 5',
      '    steps:',
      '      - run: echo ${{ github.event.pull_request.title }}',
    ].join('\n');
    expect(rulesIn(findWorkflowViolations('.github/workflows/x.yml', inRun))).toContain(
      'no-template-injection',
    );

    // The `env:` form is the fix we recommend, so it must not be a finding.
    const inEnv = inRun.replace(
      '      - run: echo ${{ github.event.pull_request.title }}',
      [
        '      - env:',
        '          TITLE: ${{ github.event.pull_request.title }}',
        '        run: echo "$TITLE"',
      ].join('\n'),
    );
    expect(rulesIn(findWorkflowViolations('.github/workflows/x.yml', inEnv))).not.toContain(
      'no-template-injection',
    );
  });

  it('rejects a non-empty top-level permissions block', () => {
    const source = [
      'name: x',
      'on: { push: {} }',
      'permissions:',
      '  contents: write',
      'jobs:',
      '  a:',
      '    permissions: {}',
      '    timeout-minutes: 5',
      '    steps:',
      '      - run: echo ok',
    ].join('\n');
    const findings = findWorkflowViolations('.github/workflows/x.yml', source);
    expect(rulesIn(findings)).toEqual(['top-level-permissions-empty']);
    expect(findings[0]?.message).toContain('grant what each job needs');
  });

  it('does not require permissions or a timeout on a reusable-workflow call', () => {
    // A `uses:` job inherits permissions from the caller and cannot set `timeout-minutes`, so the
    // rules would be impossible to satisfy rather than merely unmet.
    const source = [
      'name: x',
      'on: { push: {} }',
      'permissions: {}',
      'jobs:',
      '  scan:',
      '    uses: ./.github/workflows/osv.yml',
      '    secrets: inherit',
    ].join('\n');
    expect(findWorkflowViolations('.github/workflows/x.yml', source)).toEqual([]);
  });
});

describe('the report', () => {
  it('prints the rule, the location, the source line and the reason', () => {
    const message = report('hygiene', HYGIENE_RULES, [
      {
        file: 'a.test.ts',
        line: 7,
        rule: 'no-only',
        message: 'remove `.only` before committing.',
        source: "describe.only('x', () => {});",
      },
    ]);
    expect(message).toContain('no-only');
    expect(message).toContain('a.test.ts:7');
    expect(message).toContain("describe.only('x'");
    // The reason is what makes a rule stick, so it is printed on failure.
    expect(message).toContain('why:');
    expect(message).toContain('required check into a decoration');
  });

  it('says so plainly when there is nothing to report', () => {
    expect(report('hygiene', HYGIENE_RULES, [])).toBe('hygiene: clean.\n');
  });

  it('gives every rule a summary and a rationale', () => {
    for (const rule of [...SNAPSHOT_RULES, ...HYGIENE_RULES, ...WORKFLOW_RULES]) {
      expect(rule.summary.length, rule.id).toBeGreaterThan(20);
      expect(rule.rationale.length, rule.id).toBeGreaterThan(40);
      expect(rule.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
