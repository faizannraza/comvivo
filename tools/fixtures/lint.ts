/**
 * `pnpm fixtures:lint` (`06` §3.25; `M3-T9`).
 *
 * `06` §3.25: CI "fails on token, phone and email patterns and on any `source:'recorded'` file
 * without redaction markers". This is the check that makes the redactor's promise enforceable —
 * because the way a secret reaches a fixture corpus is not somebody skipping the redactor, it is a
 * new field the redactor's key list did not know about, carrying a value in a shape nobody
 * anticipated.
 *
 * So the linter is deliberately **not** the redactor's inverse. It re-reads every fixture as raw
 * text and looks for credential patterns wherever they are, which catches exactly the case the
 * key-driven walk misses: a token inside a message body, an email in a `caption`, a signed URL in a
 * field added by a platform last week.
 *
 * ## Why it fails rather than fixes
 *
 * Redaction is lossy and a fixture is evidence. Rewriting a file in CI would mean the corpus a test
 * ran against is not the corpus in the tree, and the one case where that matters is the one where it
 * matters most: a reviewer asking "what did the platform actually send". The linter names the file,
 * the line and the rule, and a human re-records or edits.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { SCRUB_RULES } from './redact.js';

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  /** The matched text, truncated and masked — a finding must not reprint the secret in full. */
  readonly sample: string;
}

/** Enough to recognise what was found, not enough to use. */
function sample(match: string): string {
  const head = match.slice(0, 6);
  return match.length <= 6 ? head : `${head}… (${String(match.length)} chars)`;
}

/**
 * Scan one file's text.
 *
 * Line numbers come from counting newlines up to the match, which is cheap and exact for a JSON
 * file pretty-printed one value per line — the format the recorder writes, for precisely this
 * reason.
 */
export function scanText(text: string, file: string): readonly Finding[] {
  const out: Finding[] = [];
  for (const rule of SCRUB_RULES) {
    // A fresh regex per scan: these are `g`-flagged module constants, and sharing `lastIndex`
    // across files makes the second file's findings depend on the first file's length.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      const at = match.index;
      out.push({
        file,
        line: text.slice(0, at).split('\n').length,
        rule: rule.name,
        sample: sample(match[0]),
      });
    }
  }
  return out.toSorted((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/**
 * A recorded fixture with no redaction marker.
 *
 * Checked from the parsed JSON rather than by pattern, because the absence of a marker is the whole
 * finding: a payload that arrived in the tree with `source: 'recorded'` and nothing saying what was
 * done to it is a member's chat in a public history, and "it looks clean" is not evidence.
 */
export function scanMarkers(value: unknown, file: string): readonly Finding[] {
  if (typeof value !== 'object' || value === null || !('meta' in value)) {
    return [{ file, line: 1, rule: 'no_meta', sample: '' }];
  }
  // `'meta' in value` already narrows it: no assertion needed, and the rule is right to say so.
  const { meta } = value;
  if (typeof meta !== 'object' || meta === null) {
    return [{ file, line: 1, rule: 'no_meta', sample: '' }];
  }
  const source = 'source' in meta ? meta.source : undefined;
  const redaction = 'redaction' in meta ? meta.redaction : undefined;
  if (source === 'recorded' && redaction === undefined) {
    return [{ file, line: 1, rule: 'recorded_without_redaction', sample: '' }];
  }
  return [];
}

/** Every `*.json` under `dir`, recursively, in a stable order. */
export async function jsonFiles(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    // Annotated `Dirent[]`: inferring from `readdir`'s overloads picks the `Buffer`-named variant,
    // and every `name` operation below then fails to compile.
    let entries: Dirent[];
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.json')) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

export async function lintFixtures(roots: readonly string[]): Promise<readonly Finding[]> {
  const out: Finding[] = [];
  for (const root of roots) {
    for (const file of await jsonFiles(root)) {
      const text = await readFile(file, 'utf8');
      const name = relative(process.cwd(), file);
      out.push(...scanText(text, name));
      try {
        const parsed = JSON.parse(text) as unknown;
        if (requiresMarkers(name)) out.push(...scanMarkers(parsed, name));
      } catch {
        out.push({ file: name, line: 1, rule: 'invalid_json', sample: '' });
      }
    }
  }
  return out;
}

/** The directories a fixture may live in. */
export const FIXTURE_ROOTS: readonly string[] = ['fixtures'];

/**
 * Where the redaction-marker rule applies.
 *
 * `06` §3.25's rule is about **channel** fixtures, and the distinction is a real one rather than a
 * convenience: a channel fixture records a member's chat — their name, their chat id, their words —
 * so a recorded one with no marker is a person's conversation in a public history. A provider
 * fixture (`fixtures/providers/`, from `M2`) records a request Village made and a response a model
 * returned; it carries no member data, and `M2` wrote 28 of them before this marker existed.
 *
 * The credential scan above applies to **every** fixture regardless, because a leaked API key is a
 * leaked API key wherever it is written down.
 *
 * Deferred follow-up: back-filling markers onto the provider corpus would make the rule uniform,
 * and is recorded in STATUS rather than done here — re-recording them needs live API spend (`H-1`).
 */
export function requiresMarkers(file: string): boolean {
  return file.replaceAll('\\', '/').includes('fixtures/channels/');
}

export async function main(roots: readonly string[] = FIXTURE_ROOTS): Promise<number> {
  const findings = await lintFixtures(roots);
  if (findings.length === 0) {
    process.stdout.write(`fixtures:lint: clean (${roots.join(', ')})\n`);
    return 0;
  }
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}:${String(finding.line)} ${finding.rule}${finding.sample === '' ? '' : ` ${finding.sample}`}\n`,
    );
  }
  process.stderr.write(
    `\nfixtures:lint: ${String(findings.length)} finding(s). A fixture is evidence, so nothing is ` +
      'rewritten here: re-record with the redactor, or edit the file by hand (06 §3.25).\n',
  );
  return 1;
}
