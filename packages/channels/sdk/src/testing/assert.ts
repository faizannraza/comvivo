/**
 * The conformance kit's assertions (`06` §3.25; `M3-T9`).
 *
 * Four functions, and the reason they exist rather than `expect` from a test runner is that the
 * cases are plain async functions. A case that threw a Vitest assertion would tie the kit to Vitest
 * for its *content* rather than only for its binding — and `06` §3.25 asks third-party channel
 * plugins to pass the kit, which means an author running Jest, `node:test` or a bare script.
 *
 * It also makes the failure messages the kit's own to write. A conformance failure is read by
 * somebody who did not write the kit, often months later, and `expected true to be false` tells
 * them nothing about which rule of `06` they broke. Every message here names the case, the rule and
 * what to do.
 */

/** A conformance failure. Carries the case id so a runner can group without parsing a message. */
export class ConformanceFailure extends Error {
  override readonly name = 'ConformanceFailure';
  constructor(
    readonly caseId: string,
    message: string,
  ) {
    super(`${caseId}: ${message}`);
  }
}

export function check(caseId: string, condition: boolean, message: string): void {
  if (!condition) throw new ConformanceFailure(caseId, message);
}

/**
 * Deep equality, with the difference in the message.
 *
 * The diff is a JSON dump of both sides rather than a structural minimal-difference report. That is
 * a deliberate floor: a real diff is a library, and the thing an adapter author needs is the two
 * payloads side by side — which is also what they will paste into an issue.
 */
export function checkEqual(
  caseId: string,
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (!deepEqual(actual, expected)) {
    throw new ConformanceFailure(
      caseId,
      `${message}\n  expected: ${render(expected)}\n  actual:   ${render(actual)}`,
    );
  }
}

export function checkMatch(caseId: string, actual: string, pattern: RegExp, message: string): void {
  if (!pattern.test(actual)) {
    throw new ConformanceFailure(
      caseId,
      `${message}\n  ${pattern.source} did not match ${render(actual)}`,
    );
  }
}

/** Assert that `fn` rejects, and hand the error back so a case can inspect it. */
export async function checkRejects(
  caseId: string,
  fn: () => Promise<unknown>,
  message: string,
): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new ConformanceFailure(caseId, `${message}: it resolved instead`);
}

/**
 * A value as a diff line.
 *
 * The three inputs `JSON.stringify` answers with `undefined` are named on the way in rather than
 * checked on the way out. Its declared return type is `string`, so a `text === undefined` guard is
 * dead code to the compiler and live code at runtime — and the version that tested the output
 * printed the word `undefined` as a JSON string once the annotation was taken at face value.
 */
function render(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return truncate(String(value));
  }
  try {
    return truncate(JSON.stringify(value));
  } catch {
    // A cycle, or a `toJSON` that throws. Both happen in a payload an adapter assembled, and
    // `String(value)` on one of those is `[object Object]` — which tells a reader nothing. The
    // constructor name at least says *what* could not be rendered.
    return `[unserialisable ${describeShape(value)}]`;
  }
}

/** What kind of thing could not be rendered. */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array of ${String(value.length)}`;
  if (typeof value === 'object')
    return (value.constructor as { name?: string } | null)?.name ?? 'object';
  return typeof value;
}

/** Long enough to see the shape, short enough to read in a terminal. */
function truncate(text: string): string {
  return text.length <= 600 ? text : `${text.slice(0, 600)}… (${String(text.length)} chars)`;
}

/**
 * Structural equality over JSON-shaped values.
 *
 * `undefined` and a missing key are treated as **the same**, which is the one judgement call here
 * and the right one for this kit: `exactOptionalPropertyTypes` means an adapter omits an optional
 * field rather than setting it to `undefined`, while a fixture's `expect` is JSON and cannot say
 * `undefined` at all. Treating them apart would make every optional field in every fixture a
 * failure nobody could fix.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, at) => deepEqual(entry, b[at]));
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] === undefined && right[key] === undefined) continue;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}
