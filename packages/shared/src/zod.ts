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

export { z };
