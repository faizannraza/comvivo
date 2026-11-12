/**
 * Exhaustiveness checking for discriminated unions (`01` §11.3).
 *
 * Adding a variant to a union breaks the build at every site that must handle it — which is the
 * entire point. `PolicyDecision`, `FlowDecision` and `ToolOutcome` all rely on it: a new
 * `PolicyDecision` kind that silently fell through to a default would be a new way to authorise
 * something nobody reviewed.
 *
 * **This comment used to prescribe a pattern that cannot be written here.** It said "every
 * `switch` over a union ends in `default: return assertNever(x)`", and in this repository that is
 * refused twice over: `switch-exhaustiveness-check` is configured with
 * `allowDefaultCaseForExhaustiveSwitch: false`, so the `default` is a lint error, and moving the
 * call after the switch is a `TS7027 Unreachable code detected` under `allowUnreachableCode:
 * false`. Nobody noticed until `exit-codes.ts` needed a total mapping over `StorageErrorCode` —
 * the first exhaustive switch over a closed union anyone tried to write.
 *
 * So the house idioms are:
 *
 *  - **A total mapping over a closed union — prefer a `Record`.** `Readonly<Record<Union, T>>`
 *    requires every key, so adding a variant is a compile error at the mapping with no `default`
 *    to forget and nothing unreachable. `exit-codes.ts` and `errors.ts` both do this; `STATUS.md`
 *    (2026-11-06) has the longer argument, which is that a `switch` with a `default` is a list
 *    that silently stops matching the type it switches on.
 *  - **Branching logic over a closed union — a `switch` with no `default`.** A missing case is
 *    caught by the function failing to return its declared type.
 *  - **`assertNever` itself** is for a value that reached the code from *outside* the type system
 *    and has been narrowed by hand — a parsed JSON discriminant, a column read back from a
 *    database written by a newer version. There the `default` is not redundant, because the
 *    compiler's exhaustiveness claim is only as good as the parse that produced the value.
 */
import { BugError } from './errors.js';

/**
 * Call in the unreachable branch of an exhaustive `switch`.
 *
 * The parameter is typed `never`, so reaching this line is a **compile** error while the union is
 * fully handled. The throw is for the runtime case the compiler cannot see: data that arrived from
 * a database written by an older version, or from a provider that added a variant.
 */
export function assertNever(value: never, context?: string): never {
  // `value` is typed `never`, so it must be widened before it can be inspected: at runtime this
  // function is reached precisely when something arrived that the type system said could not.
  const actual: unknown = value;
  const rendered =
    typeof actual === 'object' && actual !== null && 'kind' in actual
      ? String(actual.kind)
      : String(actual);
  throw new BugError(
    `Unhandled variant ${JSON.stringify(rendered)}${context === undefined ? '' : ` in ${context}`}. ` +
      'A discriminated union gained a case that some switch does not handle. This is a bug, not ' +
      'bad input: find the switch and handle the case rather than widening a default.',
  );
}
