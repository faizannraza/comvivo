/**
 * `02` §3.13.1 read as **data**, and checked against the rules that implement it (`M1-T26`).
 *
 * `SWEEPABLE_TABLES` is a list, and a list is a statement about what existed when it was written.
 * §3.13.1 is the specification of what belongs in it, and M3 through M10 add rows to that table —
 * `sessions`, `domain_events`, the MCP logs, the auth secrets. A test that restated the list would
 * prove only that this file agrees with itself; the row added to the spec would pass unnoticed and
 * the data it names would be kept forever.
 *
 * So this parses §3.13.1 out of the plan and requires every row to be **accounted for**: either a
 * rule implements it, or it is listed below with the milestone that will, or its mechanism is
 * something other than the sweep. The lists shrink as those milestones land, and a row that arrives
 * early stops being excused.
 *
 * The same shape as `schema/entity-checklist.test.ts`, which `M1-T12` wrote for §3.3.13's entity
 * checklist and for the same reason.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeDb } from '../db/drizzle.js';
import { LabelStore } from '../ifc/label-store.js';
import { SqliteAuditLog } from '../repos/audit.js';
import { SqliteMessageRepository } from '../repos/messages.js';
import { SqliteTraceRepository } from '../repos/traces.js';
import { withMigratedDb } from '../schema/testing/migrated-db.js';
import { sweepRules } from './rules.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SPEC = resolve(REPO_ROOT, 'docs/plan/02-domain-model-and-storage.md');

interface SpecRow {
  readonly data: string;
  readonly mechanism: string;
}

/** §3.13.1's table, row by row. */
function retentionRows(): readonly SpecRow[] {
  const markdown = readFileSync(SPEC, 'utf8');
  const start = markdown.indexOf('#### 3.13.1 Retention defaults');
  const end = markdown.indexOf('#### 3.13.2', start);
  expect(start, '02 §3.13.1 is still in the plan').toBeGreaterThan(0);
  const rows: SpecRow[] = [];
  for (const line of markdown.slice(start, end).split('\n')) {
    if (!line.startsWith('|') || line.startsWith('|---') || line.startsWith('| Data')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [data, , , mechanism] = cells;
    if (data === undefined || mechanism === undefined) continue;
    rows.push({ data, mechanism });
  }
  return rows;
}

/**
 * Rows whose mechanism is **not** the retention sweep, with what does the work instead.
 *
 * Each of these is implemented somewhere else and tested there, so the sweep must not touch them —
 * which makes this list as load-bearing as the one below it. A row moved into the sweep by mistake
 * would delete something the product promises to keep.
 */
const NOT_SWEPT: Readonly<Record<string, string>> = {
  'Memories, events, tasks, lists, decisions, plans, polls':
    'persist; deleted only by user, policy or erasure (§3.13.3)',
  'Audit events': 'append-only; `reanchorBefore`, and only when a host sets a ceiling',
  Blobs: '§3.11 GC, in `blobs/store.ts` (`M1-T25`)',
  Backups: '§3.14 rotation (`M1-T27`)',
  'Turns + effects': 'swept, but as a cascade from `turns` rather than a row of its own',
};

/**
 * Sweepable rows a later milestone creates the tables for, with the milestone.
 *
 * Every one is a table that does not exist yet, so a rule for it could only be written against a
 * schema that is not there. When the milestone lands, its entry comes off this list and the test
 * fails until a rule names it.
 */
const SCHEDULED_LATER: Readonly<Record<string, string>> = {
  'Unclaimed chats (`chat_bindings` rows only; no messages are stored, A27)': 'M3-T1',
  'Auth/onboarding secrets (`login_tokens`, `pairings`, `claim_codes`, `link_codes`, `invite_codes`, `step_up_challenges`, `idempotency_keys`, `interaction_tokens`)':
    'M9-T2',
  '`sessions`': 'M9-T2',
  '`domain_events`': 'M9-T6',
  '`plugin_egress_log`, `mcp_access_log` / `mcp_idempotency`': 'M10-T3',
};

/** Spec rows one rule covers together, because one column implements both. */
const COVERED_BY: Readonly<Record<string, string>> = {
  'Messages of members whose consent forbids extraction': 'Raw messages (+ attachments, FTS rows)',
};

/** The `spec` strings the implemented rules carry. */
function implementedSpecs(): readonly string[] {
  return withMigratedDb((connection) => {
    const db = makeDb(connection);
    const labels = new LabelStore(connection);
    return sweepRules({
      db,
      messages: new SqliteMessageRepository(db, labels),
      traces: new SqliteTraceRepository(db, labels),
      audit: new SqliteAuditLog(db),
      ids: { next: () => 'aud_01jspec0000000000000000000' } as never,
    }).map((rule) => rule.spec);
  });
}

describe('02 §3.13.1 against the implemented rules', () => {
  it('accounts for every row of the spec table', () => {
    const rows = retentionRows();
    // Non-vacuity: §3.13.1 has nineteen rows, and a parser that found none would make every
    // assertion below trivially true.
    expect(rows.length).toBeGreaterThan(15);

    const implemented = new Set(implementedSpecs());
    const unaccounted: string[] = [];
    for (const row of rows) {
      const name = COVERED_BY[row.data] ?? row.data;
      if (implemented.has(name)) continue;
      if (name in NOT_SWEPT || name in SCHEDULED_LATER) continue;
      unaccounted.push(`${row.data} — mechanism: ${row.mechanism}`);
    }
    // A row added to §3.13.1 lands here with its own text, so the failure says what to do.
    expect(unaccounted).toEqual([]);
  });

  it('has no stale excuses', () => {
    const rows = new Set(retentionRows().map((row) => row.data));
    // An entry for a row that no longer exists is an excuse nobody is using, and the next reader
    // would take it as evidence that the table is still coming.
    for (const name of [...Object.keys(NOT_SWEPT), ...Object.keys(SCHEDULED_LATER)]) {
      expect(rows.has(name), `§3.13.1 still has a row called ${JSON.stringify(name)}`).toBe(true);
    }
    for (const name of Object.keys(COVERED_BY)) {
      expect(rows.has(name), `§3.13.1 still has a row called ${JSON.stringify(name)}`).toBe(true);
    }
  });

  it('implements no rule the spec does not ask for', () => {
    const rows = new Set(retentionRows().map((row) => COVERED_BY[row.data] ?? row.data));
    for (const spec of implementedSpecs()) {
      // A rule naming a row §3.13.1 does not have is a window somebody invented. The sweep is the
      // one place in the product that deletes a member's words without being asked to, so what it
      // takes has to come from the plan rather than from a developer's judgement.
      expect(rows.has(spec), `§3.13.1 has a row called ${JSON.stringify(spec)}`).toBe(true);
    }
  });
});
