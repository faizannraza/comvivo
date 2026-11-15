/**
 * `bin/comvivo.mjs`'s two rules (`09` §3.11.1; `M3-T13`).
 *
 * The shim exists so a host on too old a Node gets a sentence instead of a stack trace, and that
 * guarantee rests on two properties of the **text above the version check**: nothing is imported
 * there, and nothing there is newer than the runtimes that can reach it.
 *
 * Both are invisible to every other check. `tsc` never sees this file — it is `.mjs` and outside
 * `src/` — and the tests that run the CLI run it on the current Node, where every syntax parses. So
 * the only thing standing between "you need Node 22.12 or newer" and a `SyntaxError` is a reviewer
 * noticing an `import` moved, which is exactly the kind of thing a reviewer does not notice.
 *
 * Checked by **reading the file**, not by running it. A test that spawned an old Node would be the
 * stronger version, and it cannot be written: the oldest Node this repository can install is newer
 * than every version the message is for.
 */
import { readFileSync } from 'node:fs';
import { BRAND } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';

// Derived from `BRAND.cliName`, like the file it points at: a literal would survive a rename and
// then this test would silently pass against a file that no longer exists — `readFileSync` would
// throw, but inside a `try` somebody added later it would not.
const SHIM = new URL(`../bin/${BRAND.cliName}.mjs`, import.meta.url);

/**
 * The source above the dynamic import — everything that must parse on an old runtime.
 *
 * **Comments stripped**, and that is not a convenience: the file's own header *describes* the rule
 * and therefore contains `?.` and `??` as prose. A check that read them as code would fail on the
 * documentation of the thing it is checking, which is the sort of test that gets weakened until it
 * passes.
 */
function preamble(): string {
  const text = readFileSync(SHIM, 'utf8');
  const boundary = text.indexOf('Promise.all([');
  expect(boundary, 'the shim no longer loads the CLI through Promise.all').toBeGreaterThan(0);
  return (
    text
      .slice(0, boundary)
      // The shebang goes too: `#!` is its own grammar production, accepted by every Node that can
      // run a script at all, and leaving it in makes the private-field check below fire on it.
      .replace(/^#!.*\n/, '')
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '')
  );
}

describe('the Node version shim (09 §3.11.1)', () => {
  it('imports nothing above the version check', () => {
    const above = preamble();
    // A static `import` is hoisted and evaluated **before** any statement in the module, so one
    // here would run — and fail to parse, or fail to resolve — before the check could print
    // anything. This is the property the whole file exists to have.
    expect(above, 'a static import above the check defeats the shim').not.toMatch(/^\s*import\s/m);
    // And no dynamic one either: `import(...)` above the check would at least parse, but it would
    // load the CLI — compiled for a newer Node — on the runtime being rejected.
    expect(above).not.toMatch(/\bimport\s*\(/);
    // `require` is the same mistake in CommonJS clothing, and in an `.mjs` it is not even defined.
    expect(above).not.toMatch(/\brequire\s*\(/);
  });

  it('uses no syntax above the check that an old runtime would refuse', () => {
    const above = preamble();
    // ES2020 and later, in the order they would bite. `??` and `?.` parse on Node 14+ and would in
    // fact be safe — see the file's header — but above the check there is nothing they would make
    // clearer, and the rule is easier to hold as "nothing newer than ES2019 up here" than as a
    // version table nobody looks up.
    expect(above, 'optional chaining above the check').not.toMatch(/\?\./);
    expect(above, 'nullish coalescing above the check').not.toMatch(/\?\?/);
    // Top-level `await` is the one that is genuinely unsafe rather than merely newer: a module
    // containing it is parsed in a mode older Node refuses outright.
    expect(above, 'top-level await above the check').not.toMatch(/^\s*await\s/m);
    expect(above, 'a class field above the check').not.toMatch(/^\s*(?:static\s+)?#/m);
  });

  it('refuses with 78, which is what an orchestrator can act on', () => {
    const above = preamble();
    // `12` §4.2's "configuration": a human has to change something before another start can work.
    // Not 2, which `09` §3.11.2 reserves for a usage error — a wrapper that read one of those
    // would retry the command in a loop against a runtime that will never satisfy it.
    expect(above).toContain('process.exit(78)');
  });

  it('passes no test seam into run(), and `run` offers none', () => {
    // `RunOptions` used to carry an `answers` object "for tests": pre-baked replies that made
    // `confirm`, the passphrase prompt and the recovery-key ceremony return without reading
    // anything. It is gone, replaced by an injected `input` stream, and this test asserts both
    // halves — the seam is not set here **and** no longer exists to be set.
    //
    // `CLAUDE.md` §8's "no mock data in production code paths", checked rather than intended: the
    // thing a seam like that could do, if a flag ever reached it, is make a destructive command
    // proceed unasked.
    expect(readFileSync(SHIM, 'utf8')).not.toContain('answers');
    const main = readFileSync(new URL('main.ts', import.meta.url), 'utf8');
    expect(main).not.toContain('options.answers');
    // And the entry point hands `run` the real streams and the real stdin, which is what makes
    // the injected version equivalent in production.
    expect(readFileSync(SHIM, 'utf8')).toContain('input: process.stdin');
  });

  it('names the floor once, so the message and the comparison cannot disagree', () => {
    const above = preamble();
    // `09` §3.11.1's floor is 22.12. One constant, printed into the message by `join('.')`: two
    // literals would let the check and the sentence drift, and the sentence is the half a host
    // reads.
    expect(above).toMatch(/var MINIMUM = \[22, 12\];/);
    expect(above).toContain("MINIMUM.join('.')");
    expect(above, 'the floor is written twice').not.toMatch(/'22\.12'/);
  });
});
