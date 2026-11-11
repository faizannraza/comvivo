/**
 * `02` §3.3.13's entity → table checklist, read from the spec as **data** (`M1-T12`, `M1-T35`).
 *
 * §3.3.13 is the `01` §14 A7 audit's result: a list of entities from the other subsystem specs
 * that had no table, each with the table it must get. The section says `scripts/schema-doc.ts`
 * fails CI when one of them does not, and this module is the part both that script and its test
 * share — a restated checklist would only prove the restatement agrees with itself, so the real
 * section is parsed and compared against the real schema.
 *
 * Moved here from `packages/storage/src/schema/entity-checklist.test.ts` at `M1-T35`, where
 * `M1-T12` left it with a note that the script would own the complete check. A package may not
 * import from `scripts/` (`storage-only-core-shared`), so the shared half lives on this side.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tables the checklist names that a later milestone creates.
 *
 * Each with the milestone that owns it, so the list shrinks as those land and a table that arrives
 * early stops being excused: `auditChecklist` fails on an entry that already exists. Without that
 * second direction the list would rot into a permanent excuse.
 */
export const SCHEDULED_LATER: Readonly<Record<string, string>> = {
  // 06 — channels and onboarding (M3).
  chat_bindings: 'M3-T1',
  channel_chat_aliases: 'M3-T1',
  dm_contexts: 'M3-T1',
  claim_codes: 'M3-T1',
  link_codes: 'M3-T1',
  interaction_tokens: 'M3-T1',
  channel_state: 'M3-T1',
  rate_limits: 'M3-T1',
  // 09 — dashboard, API and CLI (M9).
  sessions: 'M9',
  login_tokens: 'M9',
  pairings: 'M9',
  invite_codes: 'M9',
  step_up_challenges: 'M9',
  idempotency_keys: 'M9',
  ha_links: 'M9',
  domain_events: 'M9',
  exports: 'M9',
  // 10 — extensibility (M10).
  plugin_installations: 'M10',
  plugin_versions: 'M10',
  group_extensions: 'M10',
  plugin_delegations: 'M10',
  plugin_store_entries: 'M10',
  plugin_egress_log: 'M10',
  mcp_tokens: 'M10',
  mcp_access_log: 'M10',
  mcp_idempotency: 'M10',
  mcp_client_servers: 'M10',
  mcp_tool_snapshots: 'M10',
  skill_records: 'M10',
  // 11 — quality (M11).
  feedback_items: 'M11',
};

/**
 * The entities §3.3.13 resolves with **no table**, and where the decision is recorded.
 *
 * The section's own parenthesis — "or explicit *no table* row" — and the reason the check needs
 * them listed: a reader of this audit should be able to tell "nobody has built it" from "it was
 * decided against", and only the second is allowed to stay unbuilt forever.
 */
export const NO_TABLE: Readonly<Record<string, string>> = {
  ControlToken:
    '02 §3.3.11 — a file under `data/`, so that losing the database does not lock the host out',
};

export interface Reference {
  readonly table: string;
  /** Present for a `table.column` or `table.{a, b}` reference. */
  readonly columns: readonly string[];
}

/** A newline, built from its code point so this source holds no literal control character. */
const LF = String.fromCharCode(10);

/**
 * Parse one backticked token into a table and column reference, or `undefined` if it is neither.
 *
 * Split out from `parseChecklist` because that function was doing two jobs — locating the section
 * and decoding each token — and scored 23 against biome's cognitive-complexity limit of 20. The
 * three spellings `02` §3.3.13 uses are a decision table, so they read better as one.
 */
function parseReference(token: string): Reference | undefined {
  const braced = /^([a-z0-9_]+)\.\{([^}]*)\}$/.exec(token);
  if (braced) {
    return {
      table: braced[1] ?? '',
      columns: (braced[2] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    };
  }
  const dotted = /^([a-z0-9_]+)\.([a-z0-9_]+)$/.exec(token);
  if (dotted) return { table: dotted[1] ?? '', columns: [dotted[2] ?? ''] };
  if (/^[a-z][a-z0-9_]*$/.test(token)) return { table: token, columns: [] };
  return undefined;
}

/** Slice §3.3.13 out of the spec and decode every table reference in its right-hand column. */
export function parseChecklist(markdown: string): readonly Reference[] {
  const start = markdown.indexOf('#### 3.3.13 Entity → table checklist');
  if (start === -1) throw new Error('02 §3.3.13 is not in the spec; the parser needs updating');
  const section = markdown.slice(start, markdown.indexOf('### 3.4 Full-text search', start));

  const references: Reference[] = [];
  for (const line of section.split(LF)) {
    if (!line.startsWith('|') || line.startsWith('|---')) continue;
    const right = line.split('|')[2] ?? '';
    for (const match of right.matchAll(/`([^`]+)`/g)) {
      const reference = parseReference((match[1] ?? '').trim());
      if (reference !== undefined) references.push(reference);
    }
  }
  return references;
}

/** The checklist, read from the repository's own copy of `02`. */
export function checklistOf(root: string): readonly Reference[] {
  return parseChecklist(
    readFileSync(join(root, 'docs/plan/02-domain-model-and-storage.md'), 'utf8'),
  );
}

export interface ChecklistProblem {
  readonly kind: 'missing-table' | 'missing-column' | 'premature-deferral' | 'unowned-deferral';
  readonly message: string;
}

/**
 * Audit the checklist against the schema, in both directions.
 *
 * Returns problems rather than throwing, so the caller decides: the script fails CI on any of
 * them, and the test asserts the list is empty with the whole list in the failure message.
 */
export function auditChecklist(
  references: readonly Reference[],
  tables: ReadonlyMap<string, ReadonlySet<string>>,
): readonly ChecklistProblem[] {
  const problems: ChecklistProblem[] = [];
  for (const table of [...new Set(references.map((reference) => reference.table))].toSorted()) {
    if (tables.has(table)) continue;
    const owner = SCHEDULED_LATER[table];
    if (owner === undefined) {
      problems.push({
        kind: 'missing-table',
        message: `02 §3.3.13 names \`${table}\`, which is neither in the schema nor scheduled in SCHEDULED_LATER`,
      });
    }
  }
  for (const { table, columns } of references) {
    const known = tables.get(table);
    if (known === undefined) continue;
    for (const column of columns) {
      if (known.has(column)) continue;
      problems.push({
        kind: 'missing-column',
        message: `02 §3.3.13 names \`${table}.${column}\`, and the table has no such column`,
      });
    }
  }
  for (const [table, owner] of Object.entries(SCHEDULED_LATER)) {
    if (tables.has(table)) {
      problems.push({
        kind: 'premature-deferral',
        message: `\`${table}\` now exists and should leave SCHEDULED_LATER (it names ${owner})`,
      });
    }
    if (!/^M\d+/.test(owner)) {
      problems.push({
        kind: 'unowned-deferral',
        message: `\`${table}\` is deferred to "${owner}", which is not a milestone`,
      });
    }
  }
  return problems;
}
