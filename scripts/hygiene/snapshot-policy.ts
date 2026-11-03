/**
 * The snapshot-testing policy (`11` §3.1.10).
 *
 * Snapshots are allowed in exactly one place: rich-text renderers. Everywhere else a test asserts
 * explicit fields.
 *
 * The reason is worth stating, because "no snapshots" sounds dogmatic. A snapshot asserts that
 * output did not change; it does not assert that output is *correct*. When one fails, the cheapest
 * resolution is `-u`, and the second-cheapest is reading a diff of something nobody chose to care
 * about — so a snapshot suite converges on recording whatever the code currently does. For a
 * renderer that is exactly right: the question genuinely is "does this still produce the same
 * markup", a human can read the diff as rendered output, and `toMatchFileSnapshot` with a real
 * extension means they read it as HTML or Markdown rather than as an escaped string. For a policy
 * decision or an IFC join it is the opposite of a test.
 */
import type { Finding, Rule } from './finding.js';

export const SNAPSHOT_RULES: readonly Rule[] = [
  {
    id: 'no-anonymous-snapshots',
    summary:
      'Use `toMatchFileSnapshot` with a real extension; never `toMatchSnapshot` or `toMatchInlineSnapshot`.',
    rationale:
      'A `.snap` file or an inline blob is read as an escaped string, so a reviewer cannot tell ' +
      'correct markup from a regression. A real extension makes the diff render.',
  },
  {
    id: 'snapshots-only-in-renderers',
    summary: 'Snapshot only rich-text renderers; assert explicit fields everywhere else.',
    rationale:
      'A snapshot asserts that output did not change, not that it is right — and the cheapest fix ' +
      'for a failure is always `-u`. That is the correct trade for markup and the wrong one for a ' +
      'policy decision.',
  },
  {
    id: 'file-snapshot-needs-extension',
    summary: 'Give every `toMatchFileSnapshot` path a real file extension.',
    rationale:
      'The extension is the whole point: `.telegram.html` renders in a review, `.snap` does not.',
  },
];

/**
 * Where a snapshot is legitimate: the rich-text renderers.
 *
 * `11` §3.1.10 names "`packages/channels/sdk/src/render/**` and each adapter's `render*.test.ts`".
 * The third pattern below widens that to a `render/` **directory** inside an adapter, because an
 * adapter with several renderers organises them in a folder and the spec's two spellings describe
 * the same thing. The allowlist is about where renderers live, not how their files are named.
 */
const ALLOWED: readonly RegExp[] = [
  // The shared renderers.
  /^packages\/channels\/sdk\/src\/render\//,
  // An adapter's `render*.test.ts`, at any depth under `src`.
  /^packages\/channels\/[^/]+\/src\/(?:.*\/)?render[^/]*\.test\.tsx?$/,
  // An adapter's `render/` directory.
  /^packages\/channels\/[^/]+\/src\/(?:.*\/)?render\//,
];

/**
 * Extensions that make a diff readable as what it is.
 *
 * Open-ended on purpose — a new channel brings its own markup dialect — but it must be a real
 * extension and not `.snap`, which is the thing being replaced.
 */
const REAL_EXTENSION = /\.[a-z0-9]{2,12}$/i;

export function isSnapshotAllowed(path: string): boolean {
  return ALLOWED.some((pattern) => pattern.test(path));
}

export function findSnapshotViolations(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((text, index) => {
    const line = index + 1;
    const source_ = text.trim();

    for (const matcher of ['toMatchSnapshot', 'toMatchInlineSnapshot']) {
      if (new RegExp(`\\.${matcher}\\s*\\(`).test(text)) {
        findings.push({
          file: path,
          line,
          rule: 'no-anonymous-snapshots',
          message: `${matcher} is never allowed. Use toMatchFileSnapshot with a real extension, or assert explicit fields.`,
          source: source_,
        });
      }
    }

    const fileSnapshot = /\.toMatchFileSnapshot\s*\(\s*(['"`])([^'"`]*)\1/.exec(text);
    if (/\.toMatchFileSnapshot\s*\(/.test(text)) {
      if (!isSnapshotAllowed(path)) {
        findings.push({
          file: path,
          line,
          rule: 'snapshots-only-in-renderers',
          message:
            'snapshots are allowed only in packages/channels/sdk/src/render/** and each adapter’s render*.test.ts.',
          source: source_,
        });
      } else if (fileSnapshot !== null) {
        const target = fileSnapshot[2] ?? '';
        if (!REAL_EXTENSION.test(target) || target.endsWith('.snap')) {
          findings.push({
            file: path,
            line,
            rule: 'file-snapshot-needs-extension',
            message: `"${target}" needs a real extension, e.g. .telegram.html or .slack.mrkdwn.`,
            source: source_,
          });
        }
      }
    }
  });

  return findings;
}
