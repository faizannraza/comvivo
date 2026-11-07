/**
 * Test-hygiene rules (`11` §3.1.11, `CLAUDE.md` §8).
 *
 * Seven rules, each one a mistake that makes a suite lie about what it covers. The expensive ones
 * are not the obvious failures — a `.only` left in a commit is caught the first time somebody looks
 * at the test count — but the quiet ones: a real `setTimeout` that passes on a fast machine, a
 * fixed port that passes until two shards collide, a shared temp directory that passes until the
 * suite is parallel.
 *
 * `11` §3.1.11 calls these "prevention rules" and lists them as prose. This turns them into a
 * check, because a prevention rule nothing enforces is a comment.
 */
import type { Finding, Rule } from './finding.js';

export const HYGIENE_RULES: readonly Rule[] = [
  {
    id: 'no-only',
    summary: 'Never commit `.only`.',
    rationale:
      'A `.only` silently reduces the suite to one test while every job still reports green. ' +
      'It is the single cheapest way to turn a required check into a decoration.',
  },
  {
    id: 'no-unjustified-skip',
    summary: 'A skipped test needs `// skip(<task-id>): <reason>` on the line above.',
    rationale:
      'A skip with no reason outlives whatever caused it. With a task id it is a scheduled ' +
      'decision; without one it is a test the suite has quietly stopped making a claim about. ' +
      '`CLAUDE.md` §8 allows none at all at a milestone gate — run with `--gate` to enforce that.',
  },
  {
    id: 'no-real-timers',
    summary: 'Use the virtual clock, never a real `setTimeout` or `setInterval`.',
    rationale:
      'A real timer makes a test slow when it passes and flaky when the machine is loaded, and it ' +
      'is the main source of the "passed and failed on the same commit" definition in §3.1.11. ' +
      '`VirtualClock` from @comvivo/shared/testing advances time deterministically.',
  },
  {
    id: 'no-fixed-listen-port',
    summary: 'Listen on port 0 and read the assigned port.',
    rationale:
      'A fixed port passes alone and fails the moment the suite shards, with an EADDRINUSE that ' +
      'blames whichever test happened to run second.',
  },
  {
    id: 'no-shared-temp-dir',
    summary: 'Create temp directories with `mkdtemp`, never a fixed path.',
    rationale:
      'A fixed temp path makes two tests share state, which shows up as order dependence — and ' +
      '`--sequence.shuffle` in the nightly flake hunt is specifically there to find it.',
  },
  {
    id: 'no-module-level-mutable-state',
    summary: 'Keep mutable state inside a test or a `beforeEach`.',
    rationale:
      'Module-level `let` leaks between tests in the same file, so the suite passes in file order ' +
      'and fails under shuffle. Vitest resets mocks, not your variables.',
  },
  {
    id: 'no-self-satisfied-unreachable',
    summary:
      'An `expect.unreachable` inside a `try` needs a `catch` that its own error would fail.',
    rationale:
      '`expect.unreachable(msg)` throws **into the same `catch`**, so the catch runs whether or ' +
      'not the code under test refused anything. That is harmless when the catch asserts ' +
      'something the harness error cannot satisfy — an error class, a `code`, a `hint` — and ' +
      'vacuous when it does not. Two guards in this repo passed while rejecting nothing: one ' +
      'matched the message "Infinity" against the unreachable text "Infinity should be refused", ' +
      'and one asserted only that the message omitted a credential, which a missing rejection ' +
      'also satisfies. Assign the error to a sentinel outside the `try` and assert on it after.',
  },
  {
    id: 'no-inline-retry',
    summary: 'No `retry:` outside the `live` tag.',
    rationale:
      '§3.1.11 requires zero retries in required checks. A retry converts a flaky test into a ' +
      'slow passing one, which is how a real nondeterminism bug reaches production.',
  },
];

/** Files whose subject matter is the thing being banned. */
const EXEMPT: readonly RegExp[] = [
  // The network guard tests real sockets and must listen and connect for real.
  /^scripts\/harness\/network-guard\.test\.ts$/,
  // The virtual clock's own tests compare it against real timer semantics.
  /^packages\/shared\/src\/testing\/virtual-clock\.test\.ts$/,
  // Planted-violation fixtures, which exist to be found.
  /\/__fixtures__\//,
];

const TEST_FILE = /\.(?:test|contract|int\.test|scenario)\.tsx?$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) || path.endsWith('.scenario.ts');
}

export function isExempt(path: string): boolean {
  return EXEMPT.some((pattern) => pattern.test(path));
}

/** `// skip(M5-T12): blocked on the guard landing` — a task id and a reason. */
const JUSTIFIED_SKIP = /\/\/\s*skip\((M\d+-T\d+|[a-z-]+#\d+)\)\s*:\s*\S/;

export interface HygieneOptions {
  /**
   * Fail on **any** skip, justified or not.
   *
   * `CLAUDE.md` §8: no `.skip`/`.todo` at a milestone gate. During a milestone a justified skip is
   * a scheduling decision; at the gate it is unfinished work.
   */
  readonly gate?: boolean;
}

interface LineContext {
  /** The raw line. */
  readonly text: string;
  /**
   * The line with string and template literals blanked out.
   *
   * Every construct rule matches against this rather than the raw text, so a rule name quoted in
   * an assertion is not mistaken for the construct itself. Without it, every test asserting on this
   * check's own output would violate it — which is how a linter earns an ignore file.
   */
  readonly code: string;
  readonly previous: string;
  readonly gate: boolean;
}

interface LineRule {
  readonly id: string;
  /** The message to report, or `undefined` when the line is fine. */
  readonly check: (context: LineContext) => string | undefined;
}

/**
 * One entry per rule, so the dispatcher is a loop over data rather than a wall of `if`.
 *
 * Each `check` is independent and sees one line plus the one above it. That is deliberately less
 * powerful than a parser: these rules exist to catch the one-line mistake quickly, in every file,
 * including ones that do not compile yet. The structural versions of the same concerns live in
 * typescript-eslint and zizmor.
 */
const LINE_RULES: readonly LineRule[] = [
  {
    id: 'no-only',
    check: ({ code }) =>
      /\b(?:describe|it|test|bench|suite)\s*\.\s*only\s*[(<]/.test(code)
        ? 'remove `.only` before committing.'
        : /\b(?:fit|fdescribe)\s*\(/.test(code)
          ? '`fit`/`fdescribe` is `.only` under another name.'
          : undefined,
  },
  {
    id: 'no-unjustified-skip',
    check: ({ text, code, previous, gate }) => {
      const skipped =
        /\b(?:describe|it|test|bench|suite)\s*\.\s*(?:skip|todo|skipIf|concurrent\.skip)\s*[(<]/.test(
          code,
        ) || /\b(?:xit|xdescribe)\s*\(/.test(code);
      if (!skipped) return undefined;
      if (gate) return 'no skipped tests at a milestone gate (CLAUDE.md §8).';
      const justified = JUSTIFIED_SKIP.test(previous) || JUSTIFIED_SKIP.test(text);
      return justified
        ? undefined
        : 'add `// skip(<task-id>): <reason>` on the line above, or delete the test.';
    },
  },
  {
    id: 'no-real-timers',
    check: ({ code }) =>
      /(?<![.\w])(?:setTimeout|setInterval)\s*\(/.test(code) &&
      !/vi\.(?:useFakeTimers|advanceTimers)/.test(code)
        ? 'use VirtualClock from @comvivo/shared/testing.'
        : undefined,
  },
  {
    id: 'no-fixed-listen-port',
    check: ({ code }) => {
      // `.listen(3000)` and `.listen({ port: 3000 })` — anything but 0.
      const match = /\.listen\s*\(\s*(?:\{[^}]*\bport\s*:\s*)?([1-9]\d*)/.exec(code);
      return match === null
        ? undefined
        : `listen(0) and read the assigned port, not ${match[1] ?? ''}.`;
    },
  },
  {
    id: 'no-shared-temp-dir',
    check: ({ text }) =>
      // Matched against the raw text: the path is the string literal.
      /(?:['"]\/tmp\/|tmpdir\s*\(\s*\))/.test(text) && !/mkdtemp/i.test(text)
        ? 'use fs.mkdtemp/mkdtempSync so each run gets its own directory.'
        : undefined,
  },
  {
    id: 'no-inline-retry',
    check: ({ code }) =>
      /\bretry\s*:\s*[1-9]/.test(code)
        ? 'required checks run with retry: 0; only the `live` tag may retry.'
        : undefined,
  },
  {
    id: 'no-module-level-mutable-state',
    check: ({ text }) =>
      /^(?:let|var)\s+[A-Za-z_$]/.test(text)
        ? 'move it inside the test or a beforeEach.'
        : undefined,
  },
];

/**
 * Assertions in a `catch` that `expect.unreachable`'s own error could not satisfy.
 *
 * Reading a property other than `message` counts, because the harness error is a plain `Error`:
 * `expect(undefined).toContain(…)` throws rather than passing. An error class, a code or a
 * `toMatchObject` counts for the obvious reason.
 */
const DISCRIMINATING =
  /toBeInstanceOf\s*\(|toMatchObject\s*\(|\.(?:hint|code|storageCode|detail|cause|findings|issues)\b/;

/** A positive string matcher and its literal argument, e.g. `toContain('no passphrase slot')`. */
const POSITIVE_LITERAL = /(?<!not)\.(?:toContain|toMatch|toBe)\s*\(\s*(['"])(.*?)\1\s*\)/g;

/** A positive matcher whose argument is not a string literal, so the scanner cannot evaluate it. */
const POSITIVE_COMPUTED = /(?<!not)\.(?:toContain|toMatch)\s*\(\s*[^'"\s)]/;

/**
 * `expect.unreachable` inside a `try` whose `catch` the harness error would also satisfy.
 *
 * A line scanner cannot see this — it is a relationship between two blocks — so this one rule works
 * over the file. It stays textual rather than becoming a parser: the question is "does any
 * assertion in this catch exclude a plain `Error` whose message is the unreachable string", which
 * is decidable from the text. Measured against all 75 `expect.unreachable` sites in this repo, it
 * reported the two that were genuinely vacuous and nothing else.
 */
/**
 * The body of the `catch` the `try` containing line `index` ends with, or `undefined`.
 *
 * Stops at the next test, because an `expect.unreachable` with no catch below it is fine — that is
 * most of its uses, and the whole point of this rule is to leave those alone.
 */
function catchBlockAfter(lines: readonly string[], index: number): string | undefined {
  let open = index + 1;
  while (open < lines.length && !/\}\s*catch\b/.test(lines[open] ?? '')) {
    if (/^\s*(?:it|test|describe)\s*[(.]/.test(lines[open] ?? '')) return undefined;
    open += 1;
  }
  if (open >= lines.length) return undefined;

  const indent = /^\s*/.exec(lines[open] ?? '')?.[0] ?? '';
  const body: string[] = [];
  for (let k = open + 1; k < lines.length && lines[k] !== `${indent}}`; k += 1) {
    body.push(lines[k] ?? '');
  }
  return body.join('\n');
}

/**
 * The literals a catch block matches positively, or `undefined` when it discriminates.
 *
 * "Discriminates" means the block contains an assertion that a plain `Error` carrying `message`
 * would fail, so `expect.unreachable` cannot satisfy it and the guard is sound. A positive matcher
 * whose argument is not a string literal also counts: the scanner cannot evaluate it, and guessing
 * would turn a real guard into a false positive.
 */
function selfSatisfiedMatches(block: string, message: string): string[] | undefined {
  if (DISCRIMINATING.test(block) || POSITIVE_COMPUTED.test(block)) return undefined;
  const positives = [...block.matchAll(POSITIVE_LITERAL)].map((match) => match[2] ?? '');
  if (positives.some((literal) => literal !== '' && !message.includes(literal))) return undefined;
  return positives;
}

/**
 * `expect.unreachable` inside a `try` whose `catch` the harness error would also satisfy.
 *
 * A line scanner cannot see this — it is a relationship between two blocks — so this one rule works
 * over the file. It stays textual rather than becoming a parser: the question is "does any
 * assertion in this catch exclude a plain `Error` whose message is the unreachable string", which
 * is decidable from the text. Measured against all 75 `expect.unreachable` sites in this repo, it
 * reported the two that were genuinely vacuous and nothing else.
 */
function findSelfSatisfiedUnreachable(path: string, source: string): Finding[] {
  const lines = source.split(/\r?\n/);
  const found: Finding[] = [];

  lines.forEach((text, index) => {
    const call = /expect\s*\.\s*unreachable\s*\(\s*(['"`])(.*?)\1\s*\)/.exec(text);
    if (call === null) return;
    const message = call[2] ?? '';
    const block = catchBlockAfter(lines, index);
    if (block === undefined) return;
    const positives = selfSatisfiedMatches(block, message);
    if (positives === undefined) return;

    found.push({
      file: path,
      line: index + 1,
      rule: 'no-self-satisfied-unreachable',
      message:
        positives.length === 0
          ? 'this catch asserts nothing the unreachable error would fail, so it passes when ' +
            'nothing is rejected. Use a sentinel outside the `try`.'
          : `the catch only matches ${positives.map((literal) => `"${literal}"`).join(', ')}, ` +
            'which the unreachable message already contains. Use a sentinel outside the `try`.',
      source: text.trim(),
    });
  });

  return found;
}

export function findHygieneViolations(
  path: string,
  source: string,
  options: HygieneOptions = {},
): Finding[] {
  if (!isTestFile(path) || isExempt(path)) return [];

  const findings: Finding[] = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((text, index) => {
    const context: LineContext = {
      text,
      code: text.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""'),
      previous: lines[index - 1] ?? '',
      gate: options.gate === true,
    };
    for (const rule of LINE_RULES) {
      const message = rule.check(context);
      if (message !== undefined) {
        findings.push({
          file: path,
          line: index + 1,
          rule: rule.id,
          message,
          source: text.trim(),
        });
      }
    }
  });

  findings.push(...findSelfSatisfiedUnreachable(path, source));
  return findings;
}
