/**
 * Exhaustiveness checking for discriminated unions (`01` §11.3).
 *
 * Every `switch` over a union ends in `default: return assertNever(x)`. Adding a variant then
 * breaks the build at every site that must handle it — which is the entire point. `PolicyDecision`,
 * `FlowDecision` and `ToolOutcome` all rely on this: a new `PolicyDecision` kind that silently fell
 * through to a default would be a new way to authorise something nobody reviewed.
 *
 * The companion lint rule is `@typescript-eslint/switch-exhaustiveness-check`, which catches the
 * case where someone omits the `default` entirely.
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
