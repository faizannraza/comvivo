/**
 * `DeletionProgress` — the resume point of a purge or erasure (`02` §3.3.8, §3.13.4, §3.13.5).
 *
 * `02` D18 is the decision this type serves: a group delete marks the group `deleting` so access
 * stops immediately, then purges in a **resumable chunked job**, because a one-million-row cascade
 * in a single transaction would block the event loop for seconds. Resumability is the whole point,
 * and `deletions.progress` is where the resume point lives — so this shape is what makes a crash
 * mid-purge recoverable rather than a half-deleted group.
 *
 * `02` §3.3.9 lists this column's maximum size as "—", which means bounded by its fields rather
 * than by a byte cap. The fields are bounded here for the same reason `ErrorInfoSchema`'s
 * `message` is: a cursor that grows without limit is a column that eventually cannot be written.
 *
 * ## Why `step` is a slug and not an enum
 *
 * `02` §3.13.4 and §3.13.5 give two *different* step sequences — a group purge walks table groups
 * in FK order, a person erasure walks nine numbered policy steps — and `03` parameterises parts of
 * the second one. An enum would have to be the union of both sequences and would turn adding a
 * table to the purge order into a schema change on a column that may hold in-flight rows. A slug
 * keeps the vocabulary with the job that owns it (`M1-T24`), and `counts` keys use the same shape
 * so a progress record reads as one vocabulary rather than two.
 */
import { capped, z } from '@comvivo/shared';

/**
 * The shape of a step name and of a `counts` key.
 *
 * Lower-case, dot-separated, so `messages`, `memory.items` and `vec.partitions` are all valid and
 * all safe to put in a log line or a metric label (`11` §3.1.6) without quoting.
 */
export const DELETION_STEP_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

/** How many distinct counters one progress record may carry. */
export const DELETION_COUNTS_MAX_KEYS = 64;

/**
 * The resume point of one deletion job.
 *
 * `cursor` is `null` when a step has not started or has finished; a number when the step resumes
 * from a `rid` (the chunked deletes of `02` §3.13.4 walk `rid` ranges); a string when it resumes
 * from a TypeID or a table name. Three cases rather than one, because forcing a `rid` through a
 * string would make the comparison that drives `WHERE rid > ?` a string comparison, and `'1000'`
 * sorts before `'99'`.
 */
export interface DeletionProgress {
  step: string;
  cursor: string | number | null;
  counts: Readonly<Record<string, number>>;
}

/** A generous overall bound; the field bounds below are what actually constrain this column. */
const DELETION_PROGRESS_MAX_BYTES = 4 * 1024;

export const DeletionProgressSchema = capped(
  z.object({
    step: z
      .string()
      .regex(
        DELETION_STEP_PATTERN,
        'a deletion step is a lower-case dotted slug, e.g. `memory.items`',
      ),
    cursor: z.union([z.string().max(256), z.int(), z.null()]),
    counts: z
      .record(
        z.string().regex(DELETION_STEP_PATTERN, 'a counter key is a lower-case dotted slug'),
        z.int().min(0),
      )
      .refine(
        (counts) => Object.keys(counts).length <= DELETION_COUNTS_MAX_KEYS,
        `a progress record carries at most ${String(DELETION_COUNTS_MAX_KEYS)} counters`,
      ),
  }),
  DELETION_PROGRESS_MAX_BYTES,
  'deletion progress',
);
