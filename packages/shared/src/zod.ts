/**
 * zod helpers for the boundaries.
 *
 * `01` §11.2: *"Every boundary is validated with zod: config, HTTP, adapters, tool I/O, LLM
 * structured output, DB JSON columns."* Two things that needs in practice:
 *
 *  - **`Result` instead of a throw.** A boundary failure is an expected outcome — a platform sent a
 *    shape we do not recognise, a model returned something off-schema — so it belongs in the type.
 *  - **Error text a human can act on.** `00` §3 promises a clear fix-it message for every error.
 *    zod's default rendering is accurate and unreadable; `formatIssues` turns it into lines a host
 *    can fix without reading our source.
 */
import { z } from 'zod';
import { ValidationError } from './errors.js';
import { err, ok, type Result } from './result.js';

export interface FormattedIssue {
  /** Dotted path, or `(root)` for a whole-value problem. */
  readonly path: string;
  readonly message: string;
}

/** zod's issue list, flattened into something worth printing. */
export function formatIssues(error: z.ZodError): FormattedIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** One human-readable block, newline separated. Used by the CLI, `doctor` and startup failures. */
export function describeIssues(error: z.ZodError, subject = 'value'): string {
  const issues = formatIssues(error);
  const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`);
  const plural = issues.length === 1 ? 'problem' : 'problems';
  return `${String(issues.length)} ${plural} in ${subject}:\n${lines.join('\n')}`;
}

/** Parse, returning a `Result` rather than throwing. The normal way to cross a boundary. */
export function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
): Result<z.output<S>, ValidationError> {
  const outcome = schema.safeParse(value);
  if (outcome.success) return ok(outcome.data);
  return err(
    new ValidationError(describeIssues(outcome.error), formatIssues(outcome.error), {
      // Deliberately no `detail`: the rejected value may be message content, and `01` §11.7 forbids
      // that above debug level. The paths and messages are enough to fix the problem.
      userMessage: 'That did not look like something I understand.',
    }),
  );
}

/**
 * Parse or throw. Only for places where a failure genuinely is a fault rather than an answer:
 * reading our own database, or a value we constructed ourselves.
 */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
  subject = 'value',
): z.output<S> {
  const outcome = schema.safeParse(value);
  if (outcome.success) return outcome.data;
  throw new ValidationError(describeIssues(outcome.error, subject), formatIssues(outcome.error));
}

/**
 * A branded string type, so two ids can never be swapped.
 *
 * ADR-019 uses TypeIDs (`grp_01j…`, `mbr_01j…`): type-prefixed, UUIDv7-based, sortable. The brand
 * makes `GroupId` and `MemberId` mutually unassignable at compile time, which matters because the
 * single most dangerous bug class in this product is operating on the wrong group or the wrong
 * member — that is invariant **I4** failing.
 */
export type Branded<T, B extends string> = T & { readonly __brand: B };

/**
 * `brandedId` lived here until `M1-T3`.
 *
 * It took a prefix and a brand as *independent* arguments, so `brandedId('grp', 'member')`
 * produced a schema that accepted group ids and typed them as member ids — the exact confusion
 * branding exists to prevent. Its pattern also accepted any 26 base32 characters, including a
 * leading `8`–`z`, which decodes past 128 bits and which `typeid-js` refuses.
 *
 * `idSchema` in `ids.ts` replaces it: the brand **is** the prefix, the prefix comes from the
 * registry, and it reports the same distinctions `parseId` does, so an API error and a storage
 * error say the same thing about the same string.
 */

/**
 * Bound a JSON value by the size of its **serialised** form (`02` §3.3.9).
 *
 * `02` §3.3.9 gives every JSON column a maximum size and says it is "enforced by schema". That
 * placement is the point. The alternatives both fail in ways this one does not:
 *
 *  - a `CHECK (length(col) <= n)` runs after the row has been built and serialised, and reports a
 *    constraint name rather than which field grew — and `length()` on SQLite counts *characters*
 *    for text, so a column holding emoji would be allowed past its byte budget;
 *  - a check in each repository is a check each new call site can forget.
 *
 * Here it travels with the schema, so `jsonOf` enforces it on write **and** on read: a row written
 * by an older build whose schema had a larger cap is caught as a damaged row rather than read back
 * into a context window it no longer fits.
 *
 * The bound is on UTF-8 bytes of `JSON.stringify(value)`, because that is exactly what `jsonOf`
 * hands the driver. Two fast paths avoid encoding the string at all: UTF-8 uses between one and
 * three bytes per UTF-16 code unit, so a string shorter than `maxBytes / 3` is certainly within
 * budget and one longer than `maxBytes` is certainly not. Only the band between them is measured,
 * which keeps `messages.rich_text` off the critical path of the 3 ms ingestion budget (`M1-T17`).
 *
 * The return type is `S` rather than a widened `ZodType`, because `superRefine` returns the schema
 * it was called on: a capped object schema is still a `ZodObject`, so it can still be extended,
 * picked from, or used as a member of a discriminated union.
 *
 * @param schema the value's own schema; the cap is applied to its **output**
 * @param maxBytes the limit from `02` §3.3.9
 * @param what the subject named in the error, e.g. `'rich text'`
 */
export function capped<S extends z.ZodType>(schema: S, maxBytes: number, what: string): S {
  return schema.superRefine((value, context) => {
    const size = jsonByteLength(value, maxBytes);
    if (size === undefined) return;
    context.addIssue({
      code: 'too_big',
      origin: 'value',
      maximum: maxBytes,
      inclusive: true,
      message: `${what} is ${String(size)} bytes of JSON, over the ${String(maxBytes)}-byte limit`,
    });
  });
}

/**
 * The serialised byte length of `value`, or `undefined` when it is certainly within `maxBytes`.
 *
 * Returning `undefined` for the common case is what lets the two fast paths skip the encode: the
 * caller only needs the exact number when it has to report the overage.
 */
function jsonByteLength(value: unknown, maxBytes: number): number | undefined {
  const text = stringifyJson(value);
  // `undefined` means the value was a bare `undefined`, a function or a symbol. None can reach a
  // validated column, and a zero-byte write is within every cap, so treat it as empty.
  if (text === undefined) return undefined;
  if (text.length * 3 <= maxBytes) return undefined;
  if (text.length > maxBytes) return byteLength(text);
  const bytes = byteLength(text);
  return bytes > maxBytes ? bytes : undefined;
}

/**
 * `JSON.stringify`, typed as it actually behaves.
 *
 * `lib.es5.d.ts` declares the single-argument overload as returning `string`, but it returns
 * `undefined` for a bare `undefined`, a function or a symbol. Writing the check against the
 * inferred type makes `no-unnecessary-condition` call a live guard dead code, and an annotation
 * does not help: TypeScript narrows a declared `string | undefined` straight back to `string` when
 * the initialiser is one. Correcting the type here, once, beats a suppression at the call site.
 */
function stringifyJson(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/** UTF-8 byte length without `Buffer`, so `@comvivo/core` can use this (`01` §1: no `node:*`). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export { z };
