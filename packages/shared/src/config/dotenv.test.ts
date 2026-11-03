/**
 * The `.env` parser. It holds API keys and bot tokens, so the interesting cases are the ones where
 * a careless parser would hand back a subtly wrong secret — and then produce a 401 that is
 * genuinely hard to diagnose.
 */
import { describe, expect, it } from 'vitest';
import { parseDotenv } from './dotenv.js';

const entriesOf = (text: string): Record<string, string> =>
  Object.fromEntries(parseDotenv(text).entries.map((e) => [e.key, e.value]));

describe('parseDotenv', () => {
  it('reads a plain assignment', () => {
    expect(entriesOf('ANTHROPIC_API_KEY=sk-ant-123')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-123' });
  });

  it('accepts the `export` prefix people copy from a shell', () => {
    expect(entriesOf('export TELEGRAM_BOT_TOKEN=abc')).toEqual({ TELEGRAM_BOT_TOKEN: 'abc' });
  });

  it('skips blank lines and comments', () => {
    expect(entriesOf('\n# a comment\n   \nA=1\n  # indented comment\nB=2\n')).toEqual({
      A: '1',
      B: '2',
    });
  });

  it('keeps an empty value, which is how a host clears a variable', () => {
    expect(entriesOf('A=')).toEqual({ A: '' });
  });

  it('preserves a value containing `=`, which base64 and JWTs do constantly', () => {
    expect(entriesOf('TOKEN=aGVsbG8=')).toEqual({ TOKEN: 'aGVsbG8=' });
  });

  it('strips surrounding double quotes and honours escapes inside them', () => {
    expect(entriesOf('A="one\\ntwo"')).toEqual({ A: 'one\ntwo' });
    expect(entriesOf('A="say \\"hi\\""')).toEqual({ A: 'say "hi"' });
  });

  it('strips single quotes and treats the contents literally', () => {
    // A secret containing a backslash must survive verbatim; single quotes are how a host says so.
    expect(entriesOf("A='one\\ntwo'")).toEqual({ A: 'one\\ntwo' });
  });

  it('keeps whitespace inside quotes and trims it outside', () => {
    expect(entriesOf('A=  spaced  ')).toEqual({ A: 'spaced' });
    expect(entriesOf('A="  spaced  "')).toEqual({ A: '  spaced  ' });
  });

  it('strips a trailing comment from an unquoted value', () => {
    expect(entriesOf('A=value # explanation')).toEqual({ A: 'value' });
  });

  it('does NOT strip a `#` that is part of the value', () => {
    // `pa#ss` is a perfectly ordinary password, and eating it would produce a baffling auth error.
    expect(entriesOf('A=pa#ss')).toEqual({ A: 'pa#ss' });
  });

  it('keeps a `#` inside quotes untouched', () => {
    expect(entriesOf('A="value # not a comment"')).toEqual({ A: 'value # not a comment' });
  });

  it('does NOT expand variables, deliberately', () => {
    // Interpolation is a feature we do not want in a file full of secrets: the fewer ways a value
    // can be computed, the fewer ways it can surprise a host.
    expect(entriesOf('A=1\nB=${A}')).toEqual({ A: '1', B: '${A}' });
  });

  it('reports malformed lines rather than guessing at them', () => {
    const result = parseDotenv('A=1\nthis is not an assignment\nB=2\n');
    expect(Object.fromEntries(result.entries.map((e) => [e.key, e.value]))).toEqual({
      A: '1',
      B: '2',
    });
    expect(result.malformedLines).toEqual([{ line: 2, text: 'this is not an assignment' }]);
  });

  it('gives a 1-based line number, so an error message can point at the line', () => {
    expect(parseDotenv('\n\nA=1').entries[0]?.line).toBe(3);
  });

  it('rejects a key that is not a legal identifier', () => {
    expect(parseDotenv('9BAD=1').malformedLines).toHaveLength(1);
    expect(parseDotenv('has-dash=1').malformedLines).toHaveLength(1);
  });

  it('handles CRLF files, which is what a Windows host produces', () => {
    expect(entriesOf('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('lets a later assignment win, matching shell intuition', () => {
    expect(entriesOf('A=1\nA=2')).toEqual({ A: '2' });
  });

  it('handles an empty file', () => {
    expect(parseDotenv('')).toEqual({ entries: [], malformedLines: [] });
  });
});
