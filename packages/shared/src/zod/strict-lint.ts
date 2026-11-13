/**
 * The strict-schema linter (`10` §3.5.2; `M2-T4`).
 *
 * `toStrictJsonSchema` *produces* a strict schema from a zod type we control. This checks one we do
 * not: a plugin's declared schema, or an MCP server's. `10` §3.5.2 runs the same linter in
 * `comvivo plugin check` and in the host, so a plugin author sees locally exactly what the host will
 * say — and an MCP tool that fails is imported with `strict: false` (§3.9.3) rather than rejected,
 * because an unstrict tool is still useful and refusing it would make us the reason somebody's
 * server does not work.
 *
 * ## Why a linter and not just the converter
 *
 * The converter's input is a zod schema; a plugin hands over **JSON Schema** across an RPC boundary.
 * There is no zod type to convert, and there must not be: deserialising somebody else's schema into
 * zod and back would silently rewrite it, and the host would then validate against a schema the
 * plugin never wrote. So the rules are checked where they are, and `10` §3.5.2's list is the list.
 */
import { z } from '../zod.js';

/** `10` §3.5.2's size ceiling for a plugin tool's serialized schema. */
export const MAX_STRICT_SCHEMA_BYTES = 8 * 1024;

/** How deep `$ref` inlining may go before a schema counts as cyclic (`10` §3.9.3). */
export const MAX_REF_DEPTH = 8;

export interface StrictViolation {
  /** `a.b.c`, or `(root)`. */
  readonly path: string;
  readonly rule:
    | 'root_not_object'
    | 'additional_properties'
    | 'missing_required'
    | 'ref'
    | 'pattern_properties'
    | 'conditional'
    | 'too_large';
  readonly detail: string;
}

/**
 * The keywords `10` §3.5.2 forbids outright.
 *
 * `noThenProperty` fires on the `then` key, and it is right to in almost every other file: a `then`
 * on an object makes it a thenable, which `await` picks up. Here the keys are **JSON Schema keyword
 * names** being matched against somebody else's schema, and renaming one would stop the linter
 * catching `if`/`then`/`else` at all.
 */
const FORBIDDEN: Readonly<Record<string, StrictViolation['rule']>> = {
  $ref: 'ref',
  patternProperties: 'pattern_properties',
  if: 'conditional',
  // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword name, not a thenable
  then: 'conditional',
  else: 'conditional',
};

function isNode(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childPath(parent: string, segment: string): string {
  return parent === '(root)' ? segment : `${parent}.${segment}`;
}

/**
 * Every way a schema fails `10` §3.5.2, all of them.
 *
 * All, not the first: a plugin author fixing one rule per `check` run is an author who gives up,
 * and the host's rejection message is the same list.
 */
export function lintStrictSchema(schema: unknown): readonly StrictViolation[] {
  // Size first, on the schema as given. A 2 MB schema should say "too large" rather than produce
  // two thousand property-level findings.
  // `JSON.stringify` is typed as always returning a string here, so no `?? ''`: it answers
  // `undefined` only for `undefined`, a function or a symbol, and a schema is none of those. The
  // lint rule caught the defensive version as dead.
  const bytes = new TextEncoder().encode(JSON.stringify(schema)).length;
  if (bytes > MAX_STRICT_SCHEMA_BYTES) {
    return [
      {
        path: '(root)',
        rule: 'too_large',
        detail: `the serialized schema is ${String(bytes)} bytes; the limit is ${String(MAX_STRICT_SCHEMA_BYTES)}`,
      },
    ];
  }

  if (!isNode(schema) || schema['type'] !== 'object') {
    return [
      {
        path: '(root)',
        rule: 'root_not_object',
        detail: 'a strict tool schema must have `type: "object"` at the root',
      },
    ];
  }

  const violations: StrictViolation[] = [];
  visit(schema, '(root)', violations, 0);
  return violations;
}

function visit(
  node: Record<string, unknown>,
  path: string,
  violations: StrictViolation[],
  depth: number,
): void {
  if (depth > MAX_REF_DEPTH) {
    violations.push({
      path,
      rule: 'ref',
      detail: `nesting exceeds ${String(MAX_REF_DEPTH)} levels, which a cyclic schema does`,
    });
    return;
  }

  checkForbidden(node, path, violations);
  if (node['type'] === 'object') checkObject(node, path, violations, depth);

  if (isNode(node['items'])) {
    visit(node['items'], childPath(path, '[]'), violations, depth + 1);
  }

  for (const combinator of ['anyOf', 'allOf', 'oneOf'] as const) {
    const branches = node[combinator];
    if (!Array.isArray(branches)) continue;
    for (const [index, branch] of branches.entries()) {
      if (isNode(branch)) {
        visit(branch, childPath(path, `${combinator}[${String(index)}]`), violations, depth + 1);
      }
    }
  }
}

/** The four keywords that are refused wherever they appear. */
function checkForbidden(node: Record<string, unknown>, path: string, out: StrictViolation[]): void {
  for (const [keyword, rule] of Object.entries(FORBIDDEN)) {
    if (!(keyword in node)) continue;
    out.push({
      path,
      rule,
      detail:
        rule === 'ref'
          ? '`$ref` is not allowed: inline the definition so the host and the provider resolve ' +
            'the same schema'
          : `\`${keyword}\` is not allowed in a strict schema`,
    });
  }
}

/** `additionalProperties: false`, an exhaustive `required`, and the same checks on each property. */
function checkObject(
  node: Record<string, unknown>,
  path: string,
  out: StrictViolation[],
  depth: number,
): void {
  if (node['additionalProperties'] !== false) {
    out.push({
      path,
      rule: 'additional_properties',
      detail: 'every object needs `additionalProperties: false`',
    });
  }
  const properties = isNode(node['properties']) ? node['properties'] : {};
  const names = Object.keys(properties);
  const required = new Set(Array.isArray(node['required']) ? (node['required'] as string[]) : []);
  const missing = names.filter((name) => !required.has(name));
  if (missing.length > 0) {
    out.push({
      path,
      rule: 'missing_required',
      detail:
        `every property must be in \`required\`; missing ${missing.join(', ')}. ` +
        'An optional field becomes `anyOf: [T, {"type":"null"}]` and stays required.',
    });
  }
  for (const name of names) {
    const child = properties[name];
    if (isNode(child)) visit(child, childPath(path, name), out, depth + 1);
  }
}

/** Convenience for the host's import path: strict-compatible, or not. */
export function isStrictCompatible(schema: unknown): boolean {
  return lintStrictSchema(schema).length === 0;
}

/**
 * The violations as the message a plugin author reads.
 *
 * One line per violation with its path, because "this schema is not strict-compatible" is not a
 * thing anybody can act on.
 */
export function explainStrictViolations(violations: readonly StrictViolation[]): string {
  if (violations.length === 0) return 'the schema is strict-compatible';
  const lines = violations.map((violation) => `  ${violation.path}: ${violation.detail}`);
  return `${String(violations.length)} strict-schema violation(s):\n${lines.join('\n')}`;
}

/**
 * A zod schema for the subset, for the places that want to parse rather than lint.
 *
 * Deliberately **not** the type `StrictJsonSchema`: that type describes what we *emit*, and a
 * runtime schema over it would reject a valid-but-unusual schema from somebody else. The linter is
 * the check for foreign input; this is for our own fixtures.
 */
export const StrictSchemaRootSchema = z.looseObject({
  type: z.literal('object'),
  additionalProperties: z.literal(false),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()),
});
