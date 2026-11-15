/**
 * The built-in catalogue's names and order (`05` §3.6.7; `M2-T17`).
 *
 * This parses `05` §3.6.7's table out of the plan and compares it, tool for tool and position for
 * position, with `BUILTIN_BLOCKS`. The spec calls for exactly that cross-check, and the reason is
 * the prompt cache: the catalogue is breakpoint 1, a cache is a byte-prefix match, and reordering
 * two tools silently doubles the cost of the largest layer in the prompt on every group on the
 * host. Nothing fails and nothing logs — so a test has to.
 *
 * ## Why it lives here and not beside `catalog.ts`
 *
 * Reading the plan needs `node:fs`, and `@comvivo/tools` is one of the **pure** packages: `01` §4
 * bans `node:*` there so `core` stays deterministic and the browser demo stays possible. Biome
 * enforces that ban on every file in those packages, including tests, which is stricter than
 * dependency-cruiser's equivalent rule (it exempts test-shaped files). The stricter reading is
 * the right one to keep — a pure package whose own tests need Node is a pure package nobody has
 * checked — and this assertion is not really about the package anyway: it is a consistency check
 * between the code and `docs/plan/`, which is what `test/` and `scripts/plan/trace.py` are for.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// By relative path, not by package name: nothing else under `test/` imports a workspace package,
// and adding `@comvivo/tools` to the root manifest to satisfy one assertion would put a workspace
// package in the root dependency graph for the first time.
import {
  BUILTIN_BLOCKS,
  BUILTIN_TOOL_ORDER,
  OPTIONAL_BUILTIN_TOOLS,
} from '../../packages/tools/src/catalog.js';

const SPEC = fileURLToPath(new URL('../../docs/plan/05-agent-runtime.md', import.meta.url));

/** One row of the §3.6.7 table, as the markdown has it. */
interface SpecRow {
  readonly row: number;
  readonly owner: string;
  readonly tools: readonly string[];
}

/**
 * Parse `05` §3.6.7's table.
 *
 * A tool in the third column is a backticked name followed by its effect marker — `` `x` (r) ``,
 * `` `x` (w) ``, or `` `x` (r; note) ``. Requiring the marker is what distinguishes a tool from the
 * other backticked identifiers in the same cell: row 13 names the capability `` `web.search` `` and
 * the label `` `untrusted` `` in its prose, and a looser pattern reads both as tools.
 */
function parseSpecTable(): readonly SpecRow[] {
  const markdown = readFileSync(SPEC, 'utf8');
  const section = markdown.split('#### 3.6.7')[1];
  if (section === undefined) throw new Error('05 §3.6.7 not found; the heading moved');
  const table = section.split('\n#### ')[0] ?? section;

  const rows: SpecRow[] = [];
  for (const line of table.split('\n')) {
    // `| 1 | Memory (04 §3.9.7) | `memory_recall` (r), … |`
    const match = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (match === null) continue;
    const [, number, owner, tools] = match;
    if (number === undefined || owner === undefined || tools === undefined) continue;
    const names = [...tools.matchAll(/`([a-z][a-z0-9_]*)`\s*\([rw][;)]/g)].map((m) => m[1] ?? '');
    if (names.length === 0) continue;
    rows.push({ row: Number(number), owner, tools: names });
  }
  return rows;
}

describe('the built-in catalogue matches 05 §3.6.7 (the CI cross-check)', () => {
  const spec = parseSpecTable();

  it('found the table, so the comparisons below are not comparing nothing', () => {
    expect(spec.length).toBe(13);
    expect(spec[0]?.tools[0]).toBe('memory_recall');
  });

  it('has the same blocks, in the same order, with the same owners', () => {
    expect(spec.map((row) => row.row)).toEqual(BUILTIN_BLOCKS.map((block) => block.row));
    expect(spec.map((row) => row.owner)).toEqual(BUILTIN_BLOCKS.map((block) => block.owner));
  });

  it('has the same tools in the same positions within every block', () => {
    for (const [index, row] of spec.entries()) {
      const block = BUILTIN_BLOCKS[index];
      // Compared per block rather than as one flat list, so a failure names the owning document
      // and the reader knows which table to open.
      expect([block?.row, block?.tools], `block ${String(row.row)} — ${row.owner}`).toEqual([
        row.row,
        row.tools,
      ]);
    }
  });

  it('has the 62 built-ins the spec counts, plus the one optional tool', () => {
    // The spec states the count in prose. A transcription that dropped a tool would otherwise look
    // exactly like a tool nobody has written yet.
    expect(BUILTIN_TOOL_ORDER).toHaveLength(62);
    expect(OPTIONAL_BUILTIN_TOOLS).toEqual(['web_search']);
  });
});
