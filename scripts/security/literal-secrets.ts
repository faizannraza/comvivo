/**
 * Detect **contiguous** secret-shaped literals in tracked source.
 *
 * `08` §3.15 lists GitHub secret scanning and push protection as always-on repository settings.
 * This is their local counterpart, and it exists because of a concrete failure during `M0-T8`: the
 * scrubber's tests need fixtures with the exact shapes it must catch, and writing them out whole
 * got the commit **rejected by push protection**, after the work was done, with no explanation of
 * what to do instead.
 *
 * The fix is not to allowlist them — clicking through a secret-scanning block is a habit worth not
 * forming, and the next block might be a real key. It is to assemble such fixtures at runtime from
 * separate string literals: the code under test still receives the exact shape, because the pieces
 * are joined before it is passed in, while the source file never contains it.
 *
 * This matters increasingly. `M5` adds a red-team suite of 500+ adversarial scenarios, `M11` adds
 * media and email injection fixtures, and every one of those files is full of deliberately
 * dangerous-looking strings. Catching it here, in a second, with an explanation, is far kinder than
 * a rejected push.
 */
import { readListed } from '../support/read-listed.js';

/**
 * Shapes a scanner recognises with high confidence.
 *
 * Deliberately narrower than `shared/src/logger/scrub.ts`'s list. That one scrubs defensively and
 * is right to over-match: a false positive there costs a redacted log line. A false positive here
 * blocks a commit, so each pattern needs a distinctive prefix or separator, not just entropy.
 */
export const SECRET_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'Slack token', pattern: /xox[bpasr]-[0-9]{6,}-[0-9A-Za-z-]{8,}/ },
  { name: 'Slack app token', pattern: /xapp-[0-9]-[A-Z0-9]{8,}-[0-9]{6,}-[0-9a-f]{8,}/ },
  { name: 'Anthropic API key', pattern: /sk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{16,}/ },
  { name: 'OpenAI API key', pattern: /sk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'Telegram bot token', pattern: /[0-9]{8,12}:[A-Za-z0-9_-]{30,}/ },
  { name: 'Matrix access token', pattern: /syt_[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'AWS access key id', pattern: /A(?:KIA|SIA|ROA|IDA)[0-9A-Z]{16}/ },
  { name: 'private key block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
];

/**
 * Files whose whole purpose is to describe these shapes.
 *
 * Kept to three entries on purpose. Every addition is a file where a real credential could now sit
 * unnoticed, so the bar is "this file cannot do its job without naming the shape".
 */
export const EXEMPT: readonly RegExp[] = [
  // This file. Its patterns necessarily resemble what they match.
  /^scripts\/security\/literal-secrets\.ts$/,
  // The scrubber, for the same reason.
  /^packages\/shared\/src\/logger\/scrub\.ts$/,
  // Plan and reference documents quote provider formats as prose.
  /^docs\//,
];

/** Extensions worth scanning: anything a credential plausibly gets pasted into. */
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|jsonc|ya?ml|toml|sh|example)$/;

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly shape: string;
}

export function isScanned(path: string): boolean {
  if (EXEMPT.some((re) => re.test(path))) return false;
  return SOURCE.test(path);
}

/** Scan one file's text. Separated from the filesystem so the patterns can be unit-tested. */
export function findInSource(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  source.split(/\r?\n/).forEach((text, index) => {
    for (const { name, pattern } of SECRET_SHAPES) {
      if (pattern.test(text)) findings.push({ file: path, line: index + 1, shape: name });
    }
  });
  return findings;
}

export function scanFiles(root: string, paths: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const path of paths.filter(isScanned)) {
    const read = readListed(`${root}/${path}`);
    // Gone between the listing and the read: the `git ls-files` race, and genuinely nothing.
    if (read.kind === 'missing') continue;
    if (read.kind === 'failed') {
      // Everything else is a **finding**. This used to be one `catch { continue }` justified as
      // the race, so a file that was present and unreadable — wrong permissions, a path that is
      // now a directory — passed the secret scanner silently. For this check of all checks, an
      // unreadable file is the one worth asking about. Found by the M1 exit gate's reviewer.
      findings.push({ file: path, line: 1, shape: `file that could not be read (${read.reason})` });
      continue;
    }
    findings.push(...findInSource(path, read.text));
  }
  return findings;
}

/** The advice is the point: a contributor who hits this needs to know the alternative. */
export function explain(findings: readonly Finding[]): string {
  const lines = findings.map((f) => `  ${f.file}:${String(f.line)}  looks like a ${f.shape}`);
  return [
    `secrets: ${String(findings.length)} secret-shaped literal(s) found.`,
    '',
    ...lines,
    '',
    'If this is a real credential: remove it, rotate it, and never commit it (08 §3.10).',
    '',
    'If it is a test fixture — which it usually is — assemble it at runtime from separate string',
    'literals instead of writing it out whole:',
    '',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sample code printed for the author to copy; the placeholders must stay literal.
    "    const token = `xoxb${'-'}${['1234567890', '0987654321', body].join('-')}`;",
    '',
    'The code under test still receives the exact shape, because the pieces are joined before it is',
    'passed in. Only the source text is split, which is what keeps GitHub push protection and every',
    'other scanner quiet. See packages/shared/src/logger/scrub.test.ts for the pattern in use.',
    '',
  ].join('\n');
}
