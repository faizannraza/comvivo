/**
 * `@comvivo/storage/schema` — the column vocabulary and the tables.
 *
 * This module is what `drizzle-kit` reads (`drizzle.config.ts`: `schema: './src/schema/index.ts'`),
 * so a table that is not re-exported here does not exist as far as migration generation is
 * concerned. It is exported as a subpath rather than through the package root for that reason: the
 * generator needs one file that names every table, and nothing else does.
 *
 * The three invariants these carry, in one line each, because they are the reason the helpers exist
 * rather than bare `text()` and `integer()`:
 *
 *  - an id is **parsed** on read, so a corrupt row says `STORAGE_ID_INVALID` rather than handing
 *    back a branded string that is not one;
 *  - an instant is epoch **milliseconds**, bounded by what Temporal can represent, and rejected
 *    rather than truncated if it carries nanoseconds;
 *  - a JSON column is validated **both** ways, with the column named in the error.
 */

export {
  bool,
  boolCheck,
  boolCheckSql,
  createdAt,
  instantMs,
  type JsonColumnConfig,
  jsonColumnTag,
  jsonOf,
  labelRef,
  MAX_EPOCH_MS,
  plainDateText,
  plainDateTimeText,
  tid,
  tzText,
  updatedAt,
  version,
} from './_columns.js';
export { blobs } from './blobs.js';
export { conversations, groups, guardianRelations, members } from './groups.js';
// --- Tables (M1-T11: `02` §3.3.1–§3.3.3, §3.3.8) ------------------------------------------------
//
// Alphabetical, because Biome's `organizeImports` sorts this block and a hand-kept order would
// drift back on every `--write`. Order is immaterial here: `drizzle-kit` resolves foreign keys
// from the schema graph and emits `CREATE TABLE` in its own order.
export { channelIdentities, instance, persons } from './identity.js';
export {
  declassifications,
  labels,
  readerSetMembers,
  readerSetSeats,
  readerSets,
} from './ifc.js';
export {
  embeddingSpaces,
  extractionCursors,
  forgetFingerprints,
  forgetSourceBlocks,
  memoryAccessStats,
  memoryConsolidationState,
  memoryEntities,
  memoryEntityAliases,
  memoryEvents,
  memoryItemEntities,
  memoryItems,
  memoryOpsApplied,
  memorySources,
  memorySubjects,
  memoryTombstones,
} from './memory.js';
export { messageAttachments, messageReactions, messages } from './messages.js';
export { appMeta, deletions, settings } from './system.js';
