/**
 * `@comvivo/storage/schema` — the column vocabulary, and later the tables.
 *
 * `02` §3.1's custom column types are the whole of this module today. They are exported as a
 * subpath rather than through the package root because `M1-T11` onward adds the tables here, and a
 * schema is the one thing in this package that `drizzle-kit` reads directly.
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
  createdAt,
  instantMs,
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
