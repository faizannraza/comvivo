/**
 * The egress manifest matches `08` §3.11.1 (`M2-T16`).
 *
 * The AC is "manifest matches `08` §3.11.1", and the only way to assert that rather than assert
 * that *something* exists is to parse the table out of the plan and compare. `08` SD-15 promises a
 * group honest minimization, and the honesty is entirely in whether this list stays true: the
 * wizard, `doctor`, the dashboard and the privacy disclosure all render from it, so a row that
 * drifted would tell four surfaces the same wrong thing.
 *
 * Lives under `test/plan/` for the same reason the built-in catalogue's cross-check does: reading
 * the plan needs `node:fs`, and this is a code-versus-`docs/plan` consistency check rather than a
 * test of the package.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EGRESS_MANIFEST,
  EGRESS_SURFACES,
  PROVIDER_HYGIENE,
} from '../../packages/models/src/egress-manifest.js';

const SPEC = fileURLToPath(new URL('../../docs/plan/08-security-privacy.md', import.meta.url));

/** The route names `08` §3.11.1's first column uses, in table order. */
function specRouteLabels(): readonly string[] {
  const markdown = readFileSync(SPEC, 'utf8');
  const section = markdown.split('#### 3.11.1')[1];
  if (section === undefined) throw new Error('08 §3.11.1 not found; the heading moved');
  const table = section.split('\nProvider-specific hygiene')[0] ?? section;

  const labels: string[] = [];
  for (const line of table.split('\n')) {
    const match = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(
      line,
    );
    if (match === null) continue;
    const first = match[1];
    if (first === undefined || first.startsWith('---') || first === 'Route') continue;
    labels.push(first);
  }
  return labels;
}

describe('the manifest covers every row of 08 §3.11.1', () => {
  const labels = specRouteLabels();

  it('found the table, so the comparisons below are not comparing nothing', () => {
    expect(labels.length).toBeGreaterThan(10);
    expect(labels[0]).toContain('chat');
  });

  it('is the spec’s rows plus exactly one deliberate split', () => {
    // The spec has 13 rows. The manifest has 14, and the single addition is `extract.dm`.
    //
    // The split is not editorial: `08` §3.11.2 moves **DM** extraction onto the local model in
    // Hybrid and leaves group extraction in the cloud, so one row cannot carry both — its
    // `hybridMovesLocal` would have to be true and false at once. The spec's own `extract` row
    // bolds "DM extraction sends DM text" inside itself, which is the same distinction written as
    // prose rather than as data.
    //
    // Asserted as `length + 1` rather than loosened to a subset check, so a fifteenth row or a
    // removed one still fails here.
    expect(EGRESS_MANIFEST).toHaveLength(labels.length + 1);
    const surfaces = EGRESS_MANIFEST.map((row) => row.surface);
    expect(surfaces).toContain('extract');
    expect(surfaces).toContain('extract.dm');
    // And the two halves really do disagree about Hybrid, which is what the split is for.
    const group = EGRESS_MANIFEST.find((row) => row.surface === 'extract');
    const dm = EGRESS_MANIFEST.find((row) => row.surface === 'extract.dm');
    expect(group?.hybridMovesLocal).toBe(false);
    expect(dm?.hybridMovesLocal).toBe(true);
  });

  it('covers every spec row’s subject, so nothing in the table is missing', () => {
    // A keyword per spec row, matched against the manifest's labels and surfaces. Crude on
    // purpose: the point is that no row of `08` §3.11.1 has been dropped, not that the prose
    // matches word for word — the manifest's text is product copy and the spec's is a table.
    const dumped = JSON.stringify(EGRESS_MANIFEST).toLowerCase();
    for (const keyword of [
      'charter',
      'recent window',
      'consented',
      'constraints',
      'draft',
      'batches api',
      'memory texts',
      'voice note',
      'pdf',
      'query strings',
      'tool arguments',
      'ip address',
    ]) {
      expect(dumped, keyword).toContain(keyword);
    }
  });

  it('names every surface in the enum, with no orphans either way', () => {
    expect(EGRESS_MANIFEST.map((row) => row.surface)).toEqual([...EGRESS_SURFACES]);
  });

  it('carries all four of the spec’s columns for every row', () => {
    for (const row of EGRESS_MANIFEST) {
      expect(row.label, row.surface).not.toBe('');
      expect(row.sends, row.surface).not.toBe('');
      // The column a member actually cares about.
      expect(row.whose, row.surface).not.toBe('');
      expect(row.localAlternative, row.surface).not.toBe('');
    }
  });

  it('marks as local-by-default exactly the two the spec does', () => {
    // `08` §3.11.1 writes "**Local by default.**" for `embed` and `transcribe` and for nothing
    // else. A third row claiming it would be a promise the code does not keep.
    expect(
      EGRESS_MANIFEST.filter((row) => row.byDefault === 'local').map((r) => r.surface),
    ).toEqual(['embed', 'transcribe']);
  });

  it('marks as off-by-default exactly the three opt-ins', () => {
    expect(EGRESS_MANIFEST.filter((row) => row.byDefault === 'off').map((r) => r.surface)).toEqual([
      'web_search',
      'mcp_remote',
      'update_check',
    ]);
  });

  it('keeps the DM warning the spec emphasises', () => {
    const dmExtract = EGRESS_MANIFEST.find((row) => row.surface === 'extract.dm');
    // `08` §3.11.1 bolds "**DM extraction sends DM text**", which is the sentence a member needs
    // to see before consenting.
    expect(dmExtract?.sends).toContain('DM extraction sends DM text');
  });

  it('records the three provider-hygiene claims, and admits which one it cannot enforce', () => {
    expect(PROVIDER_HYGIENE).toHaveLength(3);
    expect(PROVIDER_HYGIENE[0]?.claim).toContain('store: false');
    expect(PROVIDER_HYGIENE[0]?.enforcedBy).toContain('openai');
    // The key-sharing one cannot be checked from inside the process, and saying so is the point:
    // a list where every row claimed enforcement would be overclaiming.
    expect(PROVIDER_HYGIENE.filter((entry) => entry.enforcedBy === undefined)).toHaveLength(1);
  });
});

describe('Hybrid is not pre-selected anywhere (D-6)', () => {
  it('ships `sensitiveRoutesLocal` and `localOnly` off in the config schema', () => {
    // `15` §1 D-6 is the owner's decision and has not been made. Until it is, the wizard shows
    // Hybrid as an **unselected** option (`08` OQ-6), so nothing in the shipped defaults may turn
    // it on — and a default that flipped would pre-empt a decision that is not ours.
    const schema = readFileSync(
      fileURLToPath(new URL('../../packages/shared/src/config/schema.ts', import.meta.url)),
      'utf8',
    );
    expect(schema).toContain('localOnly: z.boolean().default(false)');
    expect(schema).toContain('sensitiveRoutesLocal: z.boolean().default(false)');
  });

  it('has no preset that turns either mode on', () => {
    const presets = readFileSync(
      fileURLToPath(new URL('../../packages/models/src/registry/presets.json', import.meta.url)),
      'utf8',
    );
    expect(presets).not.toContain('sensitiveRoutesLocal');
    expect(presets).not.toContain('localOnly');
  });
});
