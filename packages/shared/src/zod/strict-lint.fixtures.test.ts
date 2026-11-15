/**
 * `10` §3.5.2's strict linter against 30 fixture schemas (`M2-T4`'s AC).
 *
 * The AC reads "the 10 strict linter passes 30 fixture schemas". It was exercised with **six**
 * converted schemas and a handful of hand-built nodes, which the M2 second-pass review measured and
 * reported as unmet — never deferred, never stated as a substitution, just not done.
 *
 * Why thirty matters here rather than being a round number somebody wrote down: this linter is a
 * **public contract**. `10` §3.5.2 is what a plugin author runs their tool schema against before
 * publishing, and `@comvivo/plugin-sdk` ships it. A linter that accepts something the provider
 * rejects sends an author's tool out broken; one that rejects something the provider accepts stops
 * a working tool from shipping. Both failures land on somebody outside this repository, so the
 * accept and reject sides both need real coverage.
 *
 * So the table below is **half accept and half reject**, each reject naming the rule it must fire.
 * The accept half is the one that catches an over-eager rule, which is the failure a test suite
 * built only from violations cannot see.
 */
import { describe, expect, it } from 'vitest';
import type { StrictViolation } from './strict-lint.js';
import { lintStrictSchema, MAX_STRICT_SCHEMA_BYTES } from './strict-lint.js';

/** A closed object, which is what every fixture here is built from. */
function closed(properties: Record<string, unknown>, required?: readonly string[]) {
  return {
    type: 'object',
    properties,
    required: required ?? Object.keys(properties),
    additionalProperties: false,
  };
}

interface Fixture {
  readonly name: string;
  readonly schema: unknown;
  /** The rule that must fire, or `undefined` for a schema that must lint clean. */
  readonly rule?: StrictViolation['rule'];
}

const FIXTURES: readonly Fixture[] = [
  // --- accept: the shapes a real tool is made of ----------------------------------------------
  { name: 'a single string field', schema: closed({ text: { type: 'string' } }) },
  { name: 'an integer field', schema: closed({ count: { type: 'integer' } }) },
  { name: 'a boolean field', schema: closed({ done: { type: 'boolean' } }) },
  { name: 'a number with bounds', schema: closed({ n: { type: 'number', minimum: 0 } }) },
  { name: 'an enum', schema: closed({ mode: { type: 'string', enum: ['a', 'b'] } }) },
  {
    name: 'a string with a format',
    schema: closed({ at: { type: 'string', format: 'date-time' } }),
  },
  {
    name: 'an array of one type',
    schema: closed({ who: { type: 'array', items: { type: 'string' } } }),
  },
  {
    name: 'an array of closed objects',
    schema: closed({
      rows: { type: 'array', items: closed({ k: { type: 'string' }, v: { type: 'number' } }) },
    }),
  },
  {
    name: 'a nested closed object',
    schema: closed({ inner: closed({ deep: { type: 'string' } }) }),
  },
  {
    name: 'three levels of nesting',
    schema: closed({ a: closed({ b: closed({ c: { type: 'boolean' } }) }) }),
  },
  {
    name: 'a nullable field as anyOf, which is how the converter spells optional',
    schema: closed({ maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] } }),
  },
  {
    name: 'anyOf over two closed objects',
    schema: closed({
      choice: { anyOf: [closed({ k: { const: 'a' } }), closed({ k: { const: 'b' } })] },
    }),
  },
  { name: 'a const', schema: closed({ kind: { const: 'reminder' } }) },
  { name: 'an empty object with no properties at all', schema: closed({}) },
  {
    name: 'a description on every field, which the model reads',
    schema: closed({ text: { type: 'string', description: 'what to remember' } }),
  },

  // --- reject: every rule, by name ------------------------------------------------------------
  { name: 'a bare string root', schema: { type: 'string' }, rule: 'root_not_object' },
  {
    name: 'an array root',
    schema: { type: 'array', items: { type: 'string' } },
    rule: 'root_not_object',
  },
  {
    name: 'an object that never closes',
    schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    rule: 'additional_properties',
  },
  {
    name: 'additionalProperties as a schema rather than false',
    schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: { type: 'string' },
    },
    rule: 'additional_properties',
  },
  {
    name: 'a nested object that never closes',
    schema: closed({
      inner: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    }),
    rule: 'additional_properties',
  },
  {
    name: 'a property missing from required',
    schema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    },
    rule: 'missing_required',
  },
  {
    name: 'required omitted entirely',
    schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
    rule: 'missing_required',
  },
  { name: 'a $ref', schema: closed({ a: { $ref: '#/$defs/x' } }), rule: 'ref' },
  {
    name: 'patternProperties',
    schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
      patternProperties: { '^x': { type: 'string' } },
    },
    rule: 'pattern_properties',
  },
  {
    name: 'an if/then conditional',
    schema: {
      ...closed({ a: { type: 'string' } }),
      if: { const: 1 },
      // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword name, not a thenable
      then: { const: 2 },
    },
    rule: 'conditional',
  },
  {
    name: 'oneOf, which a discriminated union produces',
    schema: closed({ u: { oneOf: [{ type: 'string' }] } }),
    rule: 'combinator',
  },
  { name: 'allOf', schema: closed({ u: { allOf: [{ type: 'string' }] } }), rule: 'combinator' },
  { name: 'not', schema: closed({ u: { not: { type: 'string' } } }), rule: 'combinator' },
  {
    name: 'prefixItems, which a tuple produces',
    schema: closed({ t: { type: 'array', prefixItems: [{ type: 'string' }], items: false } }),
    rule: 'tuple',
  },
  {
    name: 'a schema over the size ceiling',
    schema: closed({ text: { type: 'string', description: 'x'.repeat(MAX_STRICT_SCHEMA_BYTES) } }),
    rule: 'too_large',
  },
];

describe('the strict linter over 30 fixture schemas (10 §3.5.2)', () => {
  it('has thirty of them, half accepting and half rejecting', () => {
    // The AC's number, asserted so it cannot drift back down. The balance matters more than the
    // count: a suite built only from violations cannot catch an over-eager rule, which is the
    // failure that stops a working tool from shipping.
    expect(FIXTURES).toHaveLength(30);
    expect(FIXTURES.filter((fixture) => fixture.rule === undefined)).toHaveLength(15);
    expect(new Set(FIXTURES.map((fixture) => fixture.name)).size).toBe(30);
    // Every rule the linter can report is exercised by at least one fixture.
    const rules = new Set(
      FIXTURES.flatMap((fixture) => (fixture.rule === undefined ? [] : [fixture.rule])),
    );
    expect([...rules].toSorted()).toEqual([
      'additional_properties',
      'combinator',
      'conditional',
      'missing_required',
      'pattern_properties',
      'ref',
      'root_not_object',
      'too_large',
      'tuple',
    ]);
  });

  it.each(FIXTURES.filter((fixture) => fixture.rule === undefined))(
    'accepts $name',
    ({ schema }) => {
      expect(lintStrictSchema(schema)).toEqual([]);
    },
  );

  it.each(FIXTURES.filter((fixture) => fixture.rule !== undefined))(
    'rejects $name with $rule',
    ({ schema, rule }) => {
      const violations = lintStrictSchema(schema);
      expect(violations.length, JSON.stringify(violations)).toBeGreaterThan(0);
      expect(violations.map((violation) => violation.rule)).toContain(rule);
    },
  );
});
