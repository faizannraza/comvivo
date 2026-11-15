/**
 * The two output shapes (`09` §3.11.2; `M3-T13`).
 *
 * `main.test.ts` checks these end to end through `run`, which is the right level for "does
 * `--json` print one document". This file is for the properties a command cannot reach from
 * outside: which **stream** each method writes to, the ASCII fallback, and the colour arms — three
 * things that are invisible in a passing end-to-end test and break a host's pipeline when wrong.
 *
 * The stream split is the whole reason this module exists rather than `console.log` at each call
 * site: a warning on stdout breaks `comvivo keys status --json | jq`, and the script that worked
 * yesterday starts failing on a line that was only ever meant for a person.
 */
import { BRAND } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { canPrompt, Printer, versionSkewWarning } from './output.js';

/**
 * The prefix every SGR colour sequence starts with.
 *
 * Built from the character code rather than written as a literal: an ESC byte in a source file is
 * invisible in a diff and in most editors, so the one test that turns on `NO_COLOR`'s guarantee
 * would be the one nobody could read.
 */
const CSI = `${String.fromCharCode(27)}[`;

function capture(options: { json?: boolean; colour?: boolean; unicode?: boolean } = {}): {
  printer: Printer;
  out: () => string;
  err: () => string;
} {
  let out = '';
  let err = '';
  const printer = new Printer({
    streams: {
      out: {
        write(chunk: string) {
          out += chunk;
        },
      },
      err: {
        write(chunk: string) {
          err += chunk;
        },
      },
    },
    json: options.json ?? false,
    colour: options.colour ?? false,
    unicode: options.unicode ?? true,
  });
  return { printer, out: () => out, err: () => err };
}

describe('which stream each method writes to (09 §3.11.2)', () => {
  it('puts the answer on stdout and everything else on stderr', () => {
    const { printer, out, err } = capture();
    printer.line('the answer');
    printer.ok('done');
    printer.fail('did not work');
    printer.detail('under a heading');
    printer.note('working…');
    printer.warn('careful');
    printer.cancelled('Cancelled. Nothing was changed.');

    // `fail` is on **stdout**, which looks wrong and is not: it is the command's answer — `keys
    // verify-recovery` saying "that key does not match" succeeded at the thing it was asked to do.
    // `error` is the one on stderr, and the next test is about the difference.
    expect(out()).toBe(
      ['✔ done', '✖ did not work', '  • under a heading'].join('\n').replace(/^/, 'the answer\n') +
        '\n',
    );
    expect(err()).toBe('working…\n▲ careful\nCancelled. Nothing was changed.\n');
  });

  it('puts an error and its hint on stderr, with the hint indented under it', () => {
    const { printer, out, err } = capture();
    printer.error({
      code: 'MISSING_INPUT',
      message: 'A passphrase is needed.',
      hint: 'Run it in a terminal.',
    });
    expect(out()).toBe('');
    expect(err()).toBe('✖ A passphrase is needed.\n  → Run it in a terminal.\n');
  });

  it('omits the hint line when there is no hint, rather than printing an empty one', () => {
    const { printer, err } = capture();
    printer.error({ code: 'USAGE', message: 'unknown option' });
    expect(err()).toBe('✖ unknown option\n');
  });
});

describe('the ASCII fallback (09 §3.11.1)', () => {
  it('uses words and arrows a legacy code page can render', () => {
    // A Windows console in a legacy code page renders `✔` as mojibake, so the fallback is not a
    // nicety: it is the difference between a readable result and two replacement characters.
    const { printer, out, err } = capture({ unicode: false });
    printer.ok('done');
    printer.detail('a detail');
    printer.warn('careful');
    printer.error({ code: 'X', message: 'nope', hint: 'try this' });
    expect(out()).toBe('OK done\n  - a detail\n');
    expect(err()).toBe('! careful\nX nope\n  -> try this\n');
  });
});

describe('colour', () => {
  it('leaves the text alone when colour is off', () => {
    const { printer, out } = capture({ colour: false });
    printer.ok('done');
    printer.detail('dimmed');
    // No escape sequence at all, which is what `09` §3.11.1's `NO_COLOR` has to mean: a dim
    // `  •` that still carried an SGR sequence would break every `grep` a host wrote against the
    // output.
    expect(out()).not.toContain(CSI);
  });

  it('keeps every line intact with colour on, through all four of picocolors’ arms', () => {
    const { printer, out, err } = capture({ colour: true });
    printer.ok('ok');
    printer.fail('fail');
    printer.detail('detail');
    printer.warn('warn');
    // What is **not** asserted here, and why, because the obvious version of this test is a lie:
    // picocolors decides from `isColorSupported` at import time and a test runner's stdout is not
    // a TTY, so under Vitest it is a pass-through and an assertion about an SGR sequence would
    // fail for a reason that has nothing to do with this module. Forcing it would test picocolors.
    //
    // So this exercises all four arms of `#paint` — one wrong arm is the classic silent bug in a
    // switch over a closed set — and asserts what holds either way: the words reach the stream
    // unchanged, so a host with colour on and a host with colour off read the same thing.
    expect(out()).toContain('ok');
    expect(out()).toContain('fail');
    expect(out()).toContain('detail');
    expect(err()).toContain('warn');
  });
});

describe('--json prints exactly one document (09 §3.11.2)', () => {
  it('writes the envelope to stdout and suppresses the human lines', () => {
    const { printer, out, err } = capture({ json: true });
    printer.line('the answer');
    printer.ok('done');
    printer.note('working…');
    printer.envelope({ ok: true, data: { generations: 2 } });
    expect(JSON.parse(out())).toEqual({ ok: true, data: { generations: 2 } });
    // `note` still goes to stderr under `--json`: progress is not part of the document, and a
    // caller reading stdout is unaffected by it.
    expect(err()).toBe('working…\n');
  });

  it('throws on a second envelope rather than printing invalid stdout', () => {
    const { printer, out } = capture({ json: true });
    printer.envelope({ ok: true });
    expect(() => {
      printer.envelope({ ok: false });
    }).toThrow(/exactly one/);
    // And the first document is intact: the refusal happens before the write, so stdout is still
    // something `JSON.parse` accepts.
    expect(JSON.parse(out())).toEqual({ ok: true });
  });

  it('routes an error into the envelope instead of to stderr', () => {
    const { printer, out, err } = capture({ json: true });
    printer.error({ code: 'MISSING_INPUT', message: 'needs a passphrase', hint: 'use a terminal' });
    expect(JSON.parse(out())).toEqual({
      ok: false,
      error: { code: 'MISSING_INPUT', message: 'needs a passphrase', hint: 'use a terminal' },
    });
    expect(err()).toBe('');
  });

  it('does nothing at all when `envelope` is called outside a --json run', () => {
    // So a command can call it unconditionally. The alternative — every command asking `if
    // (printer.json)` — is the branch that gets forgotten in the eleventh command.
    const { printer, out } = capture({ json: false });
    printer.envelope({ ok: true, data: { a: 1 } });
    expect(out()).toBe('');
  });

  it('reports whether this run is a --json run, for a command that must shape its answer', () => {
    expect(capture({ json: true }).printer.json).toBe(true);
    expect(capture({ json: false }).printer.json).toBe(false);
  });
});

describe('canPrompt (09 §3.11.2)', () => {
  it('needs all four conditions, because the cost of a wrong answer is a hung CI job', () => {
    const base = { isTty: true, nonInteractive: false, ci: false, json: false };
    expect(canPrompt(base)).toBe(true);
    // Each one alone is enough to refuse. A command that prompted in CI hangs until the job times
    // out, which looks like an infrastructure problem and takes an afternoon to attribute.
    expect(canPrompt({ ...base, isTty: false })).toBe(false);
    expect(canPrompt({ ...base, nonInteractive: true })).toBe(false);
    expect(canPrompt({ ...base, ci: true })).toBe(false);
    expect(canPrompt({ ...base, json: true })).toBe(false);
  });
});

describe('versionSkewWarning (09 §3.11.2)', () => {
  it('names the exact command that matches the server', () => {
    const warning = versionSkewWarning('1.2.0', '1.3.1');
    expect(warning).toContain('1.2.0');
    // The server's version in the `npx` line, not the CLI's: the point of the sentence is to get
    // the host onto the server's version, and a warning that told them to re-run what they just
    // ran would be worse than silence.
    expect(warning).toContain(`npx ${BRAND.npmCliPackage}@1.3.1`);
  });
});
