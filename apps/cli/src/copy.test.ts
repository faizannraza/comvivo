/**
 * The CLI's copy catalog (`09` §3.11.1: "ALL user-facing CLI strings … snapshot-tested";
 * `M3-T13`).
 *
 * Three properties, and the third is the one that keeps `09` §3.11.1 true over time:
 *
 *  1. **every key renders** with representative substitutions, so a `{placeholder}` cannot reach a
 *     host's terminal;
 *  2. **the brand is never a literal**, so a rename stays one command (`13` §3.A.6's guard checks
 *     the source; this checks the catalog, which the guard exempts by extension);
 *  3. **no prose is inlined in `src/`** — the same check `scripts/copy/check.ts` performs for the
 *     engine's catalog, in the form that is decidable: a literal that duplicates a catalogued
 *     sentence. The failure it prevents is drift, where the catalog is corrected and the literal
 *     is not, and two hosts get different sentences for one error.
 *
 * There is no snapshot. The catalog is one JSON file, so a change to any sentence is already a
 * reviewable diff in prose — and `hygiene:check`'s `snapshots-only-in-renderers` is right that a
 * second escaped copy of it would be review theatre. What the tests add instead are the properties
 * a reviewer would otherwise check by hand ninety-one times: length, and punctuation that matches
 * where the string is read.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND, envVar } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { copy, copyKeys } from './copy.js';

const SRC = new URL('./', import.meta.url).pathname;
const CATALOG = new URL('../copy/en.json', import.meta.url);

/** A value for every placeholder the catalog uses, so `copy` can render all of it. */
const SUBSTITUTIONS: Readonly<Record<string, string>> = {
  advisory: '1073741824',
  arch: 'arm64',
  configFile: BRAND.configFileName,
  consequence: 'The old key stops working.',
  count: '2',
  dir: `/srv/${BRAND.slug}/data/keys`,
  dirVar: envVar('DIR'),
  flag: '`--yes`',
  gen: '3',
  gens: '1, 2',
  instanceId: 'ins_01jd8000000000000000000000',
  node: '26.13.0',
  path: `/srv/${BRAND.slug}/recovery.txt`,
  platform: 'linux',
  slotId: 'mk1',
  slots: 'mk1, mk2',
  store: 'keyfile',
  variable: envVar('PASSPHRASE_FILE'),
  version: '1.0.0',
  what: 'The recovery key',
  wraps: '1073741825',
  yesNo: 'yes',
};

function sourceFiles(): readonly { readonly path: string; readonly text: string }[] {
  const found: { path: string; text: string }[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      // `copy.ts` is the catalog's reader; it holds no catalogued sentence of its own.
      if (entry.name === 'copy.ts') continue;
      found.push({ path: path.replace(SRC, ''), text: readFileSync(path, 'utf8') });
    }
  };
  walk(SRC);
  return found;
}

/**
 * Where a string is read, which is what decides its punctuation.
 *
 *  - **help** — `--json  print one JSON document` — a column where commander's own entries have no
 *    full stop, so one of ours reads as a typo;
 *  - **label** — `key store: keyfile` — a value, not a sentence;
 *  - **prompt** — `Recovery key: ` — a colon and a space, because the cursor sits after it;
 *  - **heading** — `Write this down…:` — introduces the line below it, so a full stop between the
 *    two would read as the end of the instruction;
 *  - **prose** — every error, hint, confirmation and note.
 *
 * Two keys are named rather than left to a prefix, because a taxonomy with invisible exceptions is
 * one that stops matching reality: `keys.status.rotateAdvisory` is a **warning** among labels, and
 * `ceremony.writeDown` is the heading.
 */
type CopyClass = 'help' | 'label' | 'prompt' | 'heading' | 'prose';

function classOf(key: string): CopyClass {
  if (key === 'ceremony.writeDown') return 'heading';
  if (key === 'keys.status.rotateAdvisory') return 'prose';
  if (key.startsWith('prompt.')) return 'prompt';
  if (
    key.endsWith('.description') ||
    key.endsWith('.argument') ||
    key.startsWith('option.') ||
    key.includes('.option.')
  ) {
    return 'help';
  }
  if (
    key.startsWith('version.') ||
    key.startsWith('keys.status.') ||
    ['.via', '.added', '.removed'].some((suffix) => key.endsWith(suffix))
  ) {
    return 'label';
  }
  return 'prose';
}

const ENDINGS: Readonly<Record<CopyClass, (rendered: string) => boolean>> = {
  // Trimmed before these run, except `prompt`, whose trailing space is load-bearing — which is
  // why `copy` never trims and why nothing downstream does either.
  help: (rendered) => !/[.?!]$/.test(rendered),
  label: (rendered) => !/[.?!]$/.test(rendered),
  prompt: () => true,
  heading: (rendered) => rendered.endsWith(':'),
  prose: (rendered) => /[.?!]$/.test(rendered),
};

const EXPECTED: Readonly<Record<CopyClass, string>> = {
  help: 'a help column takes no full stop',
  label: 'a label line is a value, not a sentence',
  prompt: 'should end in ": "',
  heading: 'should end in ":"',
  prose: 'should end with punctuation',
};

describe('the CLI copy catalog (09 §3.11.1)', () => {
  it('renders every key to a sentence with no placeholder left in it', () => {
    const keys = copyKeys();
    // Non-vacuity: an empty catalog would make the loop assert nothing.
    expect(keys.length).toBeGreaterThan(50);
    for (const key of keys) {
      const rendered = copy(key, SUBSTITUTIONS);
      expect(rendered.length, key).toBeGreaterThan(0);
      // A surviving `{` is a placeholder the catalog uses and `SUBSTITUTIONS` does not supply —
      // which in production is a `{resetAt}` printed to a host.
      expect(rendered, key).not.toContain('{');
    }
  });

  it('throws for a key that does not exist, rather than printing nothing', () => {
    // `09` §3.11.2's output is a contract, and a blank line in it is worse than a crash: a host
    // reading an empty error learns nothing, and a script parsing `--json` gets a valid envelope
    // with an empty message.
    expect(() => copy('nope.not.a.key')).toThrow(/there is no message for nope\.not\.a\.key/);
  });

  it('holds no brand literal, so a rename stays one command', () => {
    const text = readFileSync(CATALOG, 'utf8');
    // `{product}`, `{cli}` and `{docs}` are substituted from `BRAND`. A literal `Comvivo` here
    // would survive a rename and read as a stale name in the one place a host looks first.
    expect(text).not.toContain(BRAND.displayName);
    expect(text).not.toContain(BRAND.slug);
  });

  it('inlines no catalogued sentence in src/', () => {
    // The decidable half of `01` §11.12 for this package, and the same rule
    // `scripts/copy/check.ts` applies to the engine's catalog. The fragments are the literal parts
    // of each template, long enough not to fire on a word.
    const fragments = copyKeys().flatMap((key) =>
      copy(key, SUBSTITUTIONS)
        .split(/\b(?:1073741824|1073741825|arm64|linux|26\.13\.0|1\.0\.0|mk1|ins_\w+)\b/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 28)
        .map((fragment) => ({ key, fragment })),
    );
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const { key, fragment } of fragments) {
        if (file.text.includes(fragment)) offenders.push(`${file.path} inlines ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every sentence short enough to read in a terminal', () => {
    // `09` §3.11.1 asks for these to be "snapshot-tested", and the review surface is the catalog
    // itself: it is **one JSON file**, so a change to any sentence already appears in a diff as
    // prose. A snapshot of it would be a byte-for-byte second copy, which `hygiene:check`'s
    // `snapshots-only-in-renderers` refuses for a good reason — an escaped blob nobody reads is
    // not review. Recorded as a refinement in `STATUS.md` → Plan changes.
    //
    // What a test *can* add is the property a reviewer would otherwise have to eyeball 91 times.
    // A hint that wraps over three lines in an 80-column terminal is a hint a host skims.
    const long = copyKeys()
      .map((key) => ({ key, rendered: copy(key, SUBSTITUTIONS) }))
      .filter((each) => each.rendered.length > 240)
      .map((each) => `${each.key} (${String(each.rendered.length)} chars)`);
    expect(long).toEqual([]);
  });

  it('punctuates by where the string is read, not by habit', () => {
    // Four places, four conventions, and they differ because a reader's expectation does. The
    // taxonomy is `classOf` below: by key, spelled out rather than inferred, because a predicate
    // that guessed the class from the sentence would be deciding the thing it checks.
    const wrong = copyKeys()
      .map((key) => ({ key, rendered: copy(key, SUBSTITUTIONS), kind: classOf(key) }))
      .filter((each) => !ENDINGS[each.kind](each.rendered.trimEnd()))
      .map((each) => `${each.key} (${each.kind}: ${EXPECTED[each.kind]})`);
    expect(wrong).toEqual([]);
  });
});
