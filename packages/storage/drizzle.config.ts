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
 * `drizzle-kit migrate` is **not** wired as a package script at all. It was until `M1-T14`, as a
 * development convenience, and that was a mistake: a convenience command that behaves differently
 * from the production path is how a developer learns the wrong thing. `pnpm db:migrate` now runs
 * our own runner (`src/migrate/cli.mjs`), which is the same code `apps/server` calls at boot.
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
