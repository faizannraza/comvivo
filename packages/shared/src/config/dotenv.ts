/**
 * A minimal `.env` parser.
 *
 * Hand-written rather than taken from a dependency, for two reasons. It is about forty lines of
 * well-understood string handling, so a dependency would be pure supply-chain surface for no
 * benefit — and `08` §3.15 asks core packages to justify every runtime dependency. And the popular
 * parsers differ in exactly the places that matter here: variable expansion (`${OTHER}`) and
 * command substitution are features we do **not** want, because a `.env` holds secrets and the
 * fewer ways a value can be computed, the fewer ways it can surprise a host.
 *
 * Supported: `KEY=value`, `export KEY=value`, `#` comments, blank lines, single and double quotes,
 * and `\n` escapes inside double quotes only. Not supported, deliberately: interpolation,
 * substitution and multi-line unquoted values.
 */

export interface DotenvEntry {
  readonly key: string;
  readonly value: string;
  /** 1-based, for error messages that point at the line. */
  readonly line: number;
}

export interface DotenvResult {
  readonly entries: readonly DotenvEntry[];
  /** Lines that are neither blank, comment, nor assignment. Reported, never guessed at. */
  readonly malformedLines: readonly { readonly line: number; readonly text: string }[];
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === '"' && last === '"') {
      // Escapes are honoured only inside double quotes, matching POSIX shell intuition.
      return trimmed
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    if (first === "'" && last === "'") return trimmed.slice(1, -1);
  }
  // Unquoted: strip a trailing `# comment`, which is why quoting is recommended for anything with
  // a `#` in it. A token with no whitespace before the `#` is kept, so `pa#ss` survives.
  return trimmed.replace(/\s+#.*$/, '').trim();
}

export function parseDotenv(contents: string): DotenvResult {
  const entries: DotenvEntry[] = [];
  const malformedLines: { line: number; text: string }[] = [];

  contents.split(/\r?\n/).forEach((text, index) => {
    const line = index + 1;
    if (text.trim() === '' || text.trimStart().startsWith('#')) return;
    const match = ASSIGNMENT.exec(text);
    if (match === null) {
      // Report the **first token only**, never the line.
      //
      // The commonest way to produce a malformed line is to omit the `=` after a key — that is,
      // on exactly the line holding a credential. Echoing the text would then put the secret in
      // the warning, and from there into whatever logs it (`08` §3.10 S2 forbids secrets in logs
      // outright). Found by the M0 independent review, which reproduced it with a real-shaped
      // Anthropic key.
      //
      // The first token is almost always the variable name, which is the one piece a host needs
      // to find the line, and is not itself a secret.
      const firstToken = text.trim().split(/\s+/)[0] ?? '';
      malformedLines.push({ line, text: firstToken.slice(0, 48) });
      return;
    }
    entries.push({ key: match[1] as string, value: unquote(match[2] as string), line });
  });

  return { entries, malformedLines };
}
