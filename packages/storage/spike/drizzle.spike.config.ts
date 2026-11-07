/**
 * A drizzle-kit configuration for the spike's throwaway schema.
 *
 * Separate from `packages/storage/drizzle.config.ts` because that one points at
 * `src/schema/index.ts`, which `M1-T11` creates. The spike has to answer "can drizzle-kit express
 * a partial index, an expression index and a CHECK?" before the real schema is written, since the
 * answer decides how `02` §3.3's constraints are enforced.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './spike/schema.fixture.ts',
  // Written into a temp directory by the test, never into the repository.
  out: './spike/.generated',
  strict: true,
  casing: 'snake_case',
});
