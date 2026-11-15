/**
 * `pnpm copy:check` — the runtime copy catalog agrees with `05` §3.11, and no member-facing
 * sentence is inlined in code (`01` §11.12, `M3-T12`).
 *
 * ## The two things this checks, and why each needs a script
 *
 * 1. **The catalog and the spec table hold the same keys, in both directions.** `05` §3.11 is the
 *    specification: a key the spec adds and the catalog lacks is a reply that renders as nothing,
 *    and a key the catalog has and the spec does not is copy nobody reviewed. Parsed out of the
 *    spec rather than transcribed, because a transcription is a second list to keep in step.
 * 2. **No catalog sentence appears as a string literal in `src/`.** This is the AC's "lint: no
 *    runtime user string inlined in code", in the form that can be checked without guessing: the
 *    failure it prevents is a developer writing `"Sorry, I didn't get that"` where
 *    `copy.format('err.generic', …)` belongs, and the way that goes wrong is that the two drift —
 *    the catalog is corrected, the literal is not, and two members in one group get different
 *    sentences for one failure.
 *
 * ICU **validity** is not here, deliberately: it needs `intl-messageformat`, and importing a
 * runtime dependency into a repository-wide check script would put it in the root manifest for one
 * `new IntlMessageFormat(…)`. `packages/engine/src/copy.test.ts` already has the dependency and
 * iterates every `copy/runtime.*.json`, so a translation that lands later is parsed by the package
 * that will render it.
 *
 * ## Why (2) is a scan and not an ESLint rule
 *
 * An ESLint rule would have to decide whether a given string literal is **member-facing**, and
 * nothing in the syntax says. `packages/engine` is full of legitimate prose — log messages,
 * `AppError` messages, `StorageError` hints — all of which are host-facing by design (`09` §C's
 * `doctor` reads them aloud). A rule banning prose literals in the engine would fire on every one
 * of those, and the escape hatch would be used until it was the norm. What is *decidable* is
 * whether a literal duplicates copy that already has a key, which is the drift this exists to
 * catch and is also what a reviewer cannot see — the two strings are in different files.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { exit, stdout } from 'node:process';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const SPEC = `${ROOT}/docs/plan/05-agent-runtime.md`;
const KEY_LIST = `${ROOT}/packages/engine/src/copy.ts`;

/** `05` §3.11's heading, and the next heading, which bound the table. */
const SECTION = '### 3.11 Error and fallback UX copy';

interface Problem {
  readonly where: string;
  readonly what: string;
}

/**
 * The keys `05` §3.11's table names.
 *
 * A row's first cell holds one or more backticked keys — the spec writes
 * `` `info.cancelled` / `info.cancelled_with_effects` `` and
 * `` `confirm.result.expired` / `.declined` / `.stale` / `.no_longer_allowed` `` — so a
 * leading-dot entry is completed from the previous key's prefix. That abbreviation is the spec's
 * and reads well in the document; expanding it here is cheaper than asking the spec to repeat
 * itself and is what makes the comparison exact.
 */
function keysInSpec(): readonly string[] {
  const spec = readFileSync(SPEC, 'utf8');
  const start = spec.indexOf(SECTION);
  if (start < 0) throw new Error(`copy: ${SECTION} is not in 05`);
  const after = spec.indexOf('\n---', start);
  const section = spec.slice(start, after < 0 ? undefined : after);

  const keys: string[] = [];
  for (const line of section.split('\n')) {
    // Table rows only, and not the header or the separator.
    if (!line.startsWith('| `')) continue;
    const firstCell = line.slice(1, line.indexOf('|', 1));
    for (const match of firstCell.matchAll(/`([^`]+)`/g)) {
      const raw = match[1];
      if (raw === undefined) continue;
      if (!raw.startsWith('.')) {
        keys.push(raw);
        continue;
      }
      const previous = keys.at(-1);
      if (previous === undefined) throw new Error(`copy: ${raw} abbreviates nothing`);
      keys.push(`${previous.slice(0, previous.lastIndexOf('.'))}${raw}`);
    }
  }
  return keys;
}

/** The keys `RUNTIME_COPY_KEYS` declares, read as text so this script needs no build. */
function keysInCode(): readonly string[] {
  const source = readFileSync(KEY_LIST, 'utf8');
  const start = source.indexOf('export const RUNTIME_COPY_KEYS = [');
  const end = source.indexOf('] as const;', start);
  if (start < 0 || end < 0) throw new Error('copy: RUNTIME_COPY_KEYS is not in src/copy.ts');
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** Every committed catalog, by locale. */
function catalogs(): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const found = new Map<string, Readonly<Record<string, string>>>();
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'packages/engine/copy'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter((path) => path.endsWith('.json'));
  for (const path of listed) {
    const locale = /runtime\.([^.]+)\.json$/.exec(path)?.[1];
    if (locale === undefined) throw new Error(`copy: ${path} is not named runtime.<locale>.json`);
    found.set(locale, JSON.parse(readFileSync(`${ROOT}/${path}`, 'utf8')));
  }
  return found;
}

/**
 * Files a copy sentence must not be inlined in.
 *
 * Every tracked `.ts` outside tests, plus the dashboard's `.tsx`. Tests are excluded because a
 * test that asserts the rendered sentence is the test that proves the catalog says what `05`
 * §3.11 says — which is the opposite of the problem.
 */
function sourceFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(
      (path) =>
        (path.endsWith('.ts') || path.endsWith('.tsx')) &&
        (path.startsWith('packages/') || path.startsWith('apps/')) &&
        !/\.(?:test|bench|scenario)\.ts$/.test(path) &&
        !path.includes('/testing/') &&
        !path.includes('/__fixtures__/'),
    );
}

/**
 * The literal part of an ICU pattern, long enough to be worth matching.
 *
 * `"Okay, stopped. I'd already done this: {doneLines}"` becomes `Okay, stopped. I'd already done
 * this:` — matching the whole pattern would miss the case that matters, which is a developer
 * inlining the sentence *with* their own interpolation. Fragments shorter than this are words
 * rather than copy: `"On it — "` would fire on anything.
 */
const MIN_FRAGMENT = 24;

function fragmentsOf(message: string): readonly string[] {
  return message
    .split(/\{[^}]*\}|\{[\s\S]*?\}\}/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= MIN_FRAGMENT);
}

const problems: Problem[] = [];

// --- 1. The catalog, the key list and the spec table all hold the same keys ----------------------
const spec = keysInSpec();
const declared = keysInCode();
const base = catalogs().get('en');
if (base === undefined) {
  problems.push({ where: 'packages/engine/copy', what: 'there is no runtime.en.json' });
}
const inBase = base === undefined ? [] : Object.keys(base);

for (const [label, actual] of [
  ['src/copy.ts RUNTIME_COPY_KEYS', declared],
  ['copy/runtime.en.json', inBase],
] as const) {
  for (const key of spec) {
    if (!actual.includes(key)) {
      problems.push({ where: label, what: `missing \`${key}\`, which 05 §3.11 specifies` });
    }
  }
  for (const key of actual) {
    if (!spec.includes(key)) {
      problems.push({ where: label, what: `has \`${key}\`, which 05 §3.11 does not specify` });
    }
  }
}

// --- 2a. A translation carries no key 05 does not specify -------------------------------------
for (const [locale, catalog] of catalogs()) {
  if (locale === 'en') continue;
  for (const key of Object.keys(catalog)) {
    if (!spec.includes(key)) {
      // Dead weight: a key nothing will ever ask for. Reported rather than ignored, because the
      // likely cause is a translator working from an older spec and the next key they add may be
      // one that *is* needed.
      problems.push({ where: `copy/runtime.${locale}.json`, what: `\`${key}\` has no key in 05` });
    }
  }
}

// --- 2b. No catalog sentence is inlined in code ---------------------------------------------------
const fragments = inBase.flatMap((key) =>
  fragmentsOf(base?.[key] ?? '').map((fragment) => ({ key, fragment })),
);
for (const path of sourceFiles()) {
  // `src/copy.ts` is excluded for the obvious reason, and `scripts/copy/` for this file's own
  // doc comment, which quotes `err.generic` to explain what it is preventing.
  if (path === 'packages/engine/src/copy.ts') continue;
  const text = readFileSync(`${ROOT}/${path}`, 'utf8');
  for (const { key, fragment } of fragments) {
    if (!text.includes(fragment)) continue;
    problems.push({
      where: path,
      what: `inlines \`${key}\`'s copy ("${fragment.slice(0, 48)}…"). Use the catalog.`,
    });
  }
}

if (problems.length > 0) {
  stdout.write(`copy: ${String(problems.length)} problem(s).\n\n`);
  for (const problem of problems) stdout.write(`  ${problem.where}: ${problem.what}\n`);
  stdout.write('\n');
  exit(1);
}

stdout.write(
  `copy: ${String(spec.length)} keys in 05 §3.11, all present in ` +
    `${String(catalogs().size)} catalog(s) and in RUNTIME_COPY_KEYS; ` +
    `no catalog sentence is inlined in ${String(sourceFiles().length)} source files.\n`,
);
