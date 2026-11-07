/**
 * drizzle-kit configuration (`02` §3.1, §3.12; D15, D16).
 *
 * This file is read by `drizzle-kit generate` only. It is **not** part of the runtime: nothing in
 * `src/` imports it, and the application never asks drizzle-kit to apply a migration. `02` D15 is
 * explicit that the runner is ours (`src/migrate/`, `M1-T14`) because drizzle-kit's own `migrate`
 * cannot do the three things this product needs — record sha256 checksums so a tampered or
 * reordered migration fails loudly, toggle `foreign_keys` outside the transaction, and take a
 * pre-migration backup.
 *
 * `drizzle-kit migrate` is wired as a package script for one purpose: generating the SQL for a
 * *development* database by hand while iterating on the schema. A host's database is never touched
 * by it.
 *
 * `02` D16 pins `drizzle-orm@0.45.4` / `drizzle-kit@0.31.11` for 1.0 and re-evaluates v1 — whose
 * folder-per-migration layout has no journal — at M14. Our runner already reads both layouts
 * (`M1-T14`, both `MigrationSource` shapes), so that upgrade is a decision rather than a rewrite.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/index.ts',
  out: './migrations',
  // Fail rather than drop: drizzle-kit's interactive prompts cannot run in CI, and a migration
  // that silently renames a column has moved a family's data.
  strict: true,
  verbose: true,
  // Named explicitly so the generated SQL does not depend on the ambient locale.
  casing: 'snake_case',
});
