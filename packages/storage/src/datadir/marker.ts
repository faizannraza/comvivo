/**
 * The data-directory marker's **frozen wire constants** (`12` §4.5).
 *
 * ## Do not derive these from `BRAND`
 *
 * This file is exempt from `scripts/brand/check.ts`, and the exemption is a **correctness
 * requirement** rather than a convenience — the second one in this repository, after
 * `shared/src/crypto/labels.ts`, and for the same reason.
 *
 * `DATA_DIR_FORMAT` is written into every host's data directory and compared on every boot. By
 * `12` §3.8.1 step 2, a directory that contains data but no *recognisable* `FORMAT` marker exits
 * 65 — because the only safe reading of "there is a database here and no marker I understand" is
 * "this is not mine, do not touch it". So if a rename changed this string, every existing install
 * on earth would stop being recognised as an install at the same moment, and the product would
 * refuse to start on all of them. There is no migration for that: the marker is how the migration
 * would have known where to look.
 *
 * `BRAND.slug` is `comvivo` **today**, so deriving this value would look correct, pass every test,
 * and fail only at the next rename — in a shipped release, on hosts, all at once. That is exactly
 * the failure mode `labels.ts` warns about, and it is why the protection here is structural rather
 * than a comment: `marker.test.ts` reads this file with comments stripped and asserts it imports
 * nothing and never mentions `BRAND`.
 *
 * A file **name** inside the directory (`comvivo.db`, `comvivo.lock`) is the opposite case and is
 * built from `BRAND` in `layout.ts`: those are renamed by the codemod along with everything else,
 * and a host who renames gets a renamed file. This string is not a name, it is an identity claim.
 */

/** The marker's `format` field. **Frozen.** See the warning above. */
export const DATA_DIR_FORMAT = 'comvivo-data-dir';

/**
 * The layout version this build writes, and the highest it can read (`12` §4.7 `dataDirFormat`).
 *
 * Bumped only by a change that an older build could not safely read. A newer marker makes this
 * build exit rather than guess, which is `12` §3.8.1's rule for every version comparison.
 */
export const DATA_DIR_FORMAT_VERSION = 1;
