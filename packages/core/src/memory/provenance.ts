/**
 * Where a memory came from, and how much to trust it (`04` §3.2.4).
 *
 * `00` §6.1 promises that every memory carries provenance, and this is the shape of that promise.
 * Three groups of fields, each answering a different question a user or an auditor will ask.
 *
 * **"Who said this, and how directly?"** `assertion` separates `explicit` ("I'm vegetarian") from
 * `reported` ("Sam says he's vegetarian") from `inferred`. `assertedBy` names the member, or
 * `system`/`external`. Those two fields are what let the agent say *"Sam mentioned you prefer…"*
 * instead of asserting it as fact, and `03`'s declassifier reads them before relaying anything.
 *
 * **"Which message, and can I still see it?"** `sourceMessageIds` points at messages that may
 * later be swept by retention, which is why `02` §3.3.4 also keeps `memory_sources` with a
 * `source_ref` copy: the provenance survives the message. `windowKey` is the extraction
 * idempotency key, so the same conversation window never produces the memory twice.
 *
 * **"How confident, and by what measure?"** `rawConfidence` is the model's self-report, which is
 * not a probability. `calibration` records the table that turned it into one. Keeping both means a
 * recalibration can be re-applied to old items instead of being lost in a single overwritten
 * number — and `extractor.version` plus `promptHash` say exactly which bundle produced it, so a
 * bad extractor release can be found and its output re-examined.
 */
import { capped, idSchema, z } from '@comvivo/shared';

/** `02` §3.3.9: `memory_items.provenance` is capped at 4 KiB. */
export const MEMORY_PROVENANCE_MAX_BYTES = 4 * 1024;

export const MemoryProvenanceSchema = capped(
  z.object({
    source: z.enum([
      'extraction',
      'explicit',
      'tool',
      'correction',
      'consolidation',
      'mirror',
      'import',
    ]),
    sourceMessageIds: z.array(idSchema('msg')).max(50),
    /** The extraction idempotency key (`04` §3.3.2); `null` for anything not extracted. */
    windowKey: z.string().max(200).nullable(),
    extractor: z
      .object({
        /** Semver of the prompt + schema + post-process bundle, e.g. `extract-1.3.0`. */
        version: z.string().max(60),
        /** sha256 of the rendered static prompt, so a prompt change is visible after the fact. */
        promptHash: z.string().max(64),
        route: z.literal('extract'),
        provider: z.string().max(60),
        model: z.string().max(120),
      })
      .nullable(),
    assertion: z.enum(['explicit', 'implied', 'reported', 'inferred']),
    assertedBy: z.union([idSchema('mbr'), z.literal('system'), z.literal('external')]),
    /** The model's self-report. Not a probability — see `calibration`. */
    rawConfidence: z.number().min(0).max(1).nullable(),
    calibration: z.object({ table: z.string().max(60), p: z.number().min(0).max(1) }).nullable(),
    confirmedBy: z.array(idSchema('mbr')).max(64),
    derivedFrom: z.array(idSchema('mem')).max(500),
    /** For `explicit`, `tool` and `correction`: the turn that produced it. */
    turnId: idSchema('trn').nullable(),
  }),
  MEMORY_PROVENANCE_MAX_BYTES,
  'memory provenance',
);

export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

/**
 * `memory_sources.span` (`02` §3.3.9): a character range into the source message.
 *
 * Half-open, `[start, end)`, and bounded by `end >= start` — a reversed span would make a
 * highlight render as nothing, which looks like missing provenance rather than a bad offset.
 * `02` §3.3.9 lists no byte cap for this column; the two integers are the bound.
 */
export const SourceSpanSchema = z
  .object({ start: z.int().min(0), end: z.int().min(0) })
  .refine((span) => span.end >= span.start, 'a source span ends at or after it starts');

export type SourceSpan = z.infer<typeof SourceSpanSchema>;
