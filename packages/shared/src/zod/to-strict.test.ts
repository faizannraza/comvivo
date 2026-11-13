/**
 * The converter and the linter (`M2-T4`; `05` §9.1's three named tests plus `10` §3.5.2's fixtures).
 *
 * `05` §9.1 asks for: "Golden output per built-in tool. Property: every object node has
 * `additionalProperties:false` and `required ⊇ keys(properties)`. Round trip `denull` → zod accepts
 * the original optional semantics." The property is the one that matters — a golden file proves one
 * schema, and the property proves every schema the generator can produce.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fcConfig } from '../testing/fc-config.js';
import { z } from '../zod.js';
import {
  explainStrictViolations,
  isStrictCompatible,
  lintStrictSchema,
  MAX_STRICT_SCHEMA_BYTES,
} from './strict-lint.js';
import { denull, KEPT_FORMATS, STRIPPED_KEYWORDS, toStrictJsonSchema } from './to-strict.js';

describe('05 §3.6.2 step 1: what cannot be strict fails at registration', () => {
  it('throws on a recursive schema', () => {
    // `strict: true` needs an exhaustive `required` and a finite shape, so recursion has no strict
    // representation at all. Failing here means a plugin author learns at `check` time rather than
    // a host learning at the first tool call.
    const Node: z.ZodType = z.lazy(() => z.object({ name: z.string(), children: z.array(Node) }));
    expect(() => toStrictJsonSchema(z.object({ tree: Node }))).toThrow();
  });

  it('throws on a type JSON Schema cannot express', () => {
    // `unrepresentable: 'throw'`. The alternative is `{}`, which a provider reads as "anything" —
    // a tool whose `when` argument accepts anything is a tool with no schema.
    expect(() => toStrictJsonSchema(z.object({ when: z.date() }))).toThrow();
    expect(() => toStrictJsonSchema(z.object({ big: z.bigint() }))).toThrow();
  });

  it('throws when the root is not an object', () => {
    expect(() => toStrictJsonSchema(z.array(z.string()))).toThrow(/root must be an object/);
    expect(() => toStrictJsonSchema(z.string())).toThrow(/root must be an object/);
  });
});

describe('05 §3.6.2 step 2: additionalProperties, required, and the optional rewrite', () => {
  it('closes every object and requires every property', () => {
    const { schema } = toStrictJsonSchema(
      z.object({ title: z.string(), nested: z.object({ a: z.number() }) }),
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['title', 'nested']);
    const nested = schema.properties?.['nested'];
    expect(nested?.additionalProperties).toBe(false);
    expect(nested?.required).toEqual(['a']);
  });

  it('turns an optional field into a nullable union and records its path', () => {
    const { schema, nullablePaths } = toStrictJsonSchema(
      z.object({ title: z.string(), note: z.string().optional() }),
    );
    // Still required — that is the point. The *value* may be null; the key may not be absent.
    expect(schema.required).toEqual(['title', 'note']);
    expect(schema.properties?.['note']?.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    expect(nullablePaths).toEqual(['note']);
  });

  it('hoists the description onto the union, where a provider shows it', () => {
    // Without the hoist the description sits on a branch and a provider renders nothing for every
    // optional field — which is most of the fields on a tool with sensible defaults.
    const { schema } = toStrictJsonSchema(
      z.object({ note: z.string().describe('a short note').optional() }),
    );
    const note = schema.properties?.['note'];
    expect(note?.description).toBe('a short note');
    expect(note?.anyOf?.[0]).toEqual({ type: 'string' });
  });

  it('records nested and array-element paths in the form denull walks', () => {
    const { nullablePaths } = toStrictJsonSchema(
      z.object({
        outer: z.object({ inner: z.string().optional() }),
        list: z.array(z.object({ tag: z.string().optional() })),
      }),
    );
    expect(nullablePaths).toEqual(['list.[].tag', 'outer.inner']);
  });
});

describe('05 §3.6.2 step 3: unsupported keywords are stripped, not translated', () => {
  it('drops every keyword strict validation does not honour', () => {
    const { json } = toStrictJsonSchema(
      z.object({
        name: z
          .string()
          .min(2)
          .max(10)
          .regex(/^[a-z]+$/),
        count: z.number().int().min(1).max(9).multipleOf(3),
        tags: z.array(z.string()).min(1).max(4),
      }),
    );
    for (const keyword of STRIPPED_KEYWORDS) {
      expect(json, keyword).not.toContain(`"${keyword}"`);
    }
  });

  it('keeps the seven formats a provider understands and drops the rest', () => {
    const { schema } = toStrictJsonSchema(
      z.object({ at: z.iso.datetime(), who: z.email(), ip: z.ipv4() }),
    );
    expect(schema.properties?.['at']?.format).toBe('date-time');
    expect(schema.properties?.['who']?.format).toBe('email');
    // `ipv4` is not in the kept list, so the constraint lives only in zod — which still enforces it
    // at parse time, where an invalid value becomes `invalid_input` rather than a bad write.
    expect(schema.properties?.['ip']?.format).toBeUndefined();
    expect(KEPT_FORMATS).not.toContain('ipv4');
  });

  it('leaves zod still enforcing what the schema no longer says', () => {
    // The half of step 3 that makes it safe. The wire schema says `string`; zod says `min(2)`.
    const input = z.object({ name: z.string().min(2) });
    toStrictJsonSchema(input);
    expect(input.safeParse({ name: 'a' }).success).toBe(false);
    expect(input.safeParse({ name: 'ab' }).success).toBe(true);
  });
});

describe('05 §3.6.2 step 4: the bytes are identical on every run', () => {
  it('serialises the same schema to the same string twice', () => {
    const build = (): string =>
      toStrictJsonSchema(z.object({ b: z.string(), a: z.number().optional() })).json;
    expect(build()).toBe(build());
  });

  it('sorts a schema object’s own keys', () => {
    const { json } = toStrictJsonSchema(z.object({ a: z.string() }));
    // Through the parsed object's key order rather than string indices: `JSON.parse` preserves
    // insertion order for non-numeric keys, and an `indexOf` search finds `"type"` inside the
    // nested property first — which is how the first version of this assertion failed on correct
    // output.
    expect(Object.keys(JSON.parse(json) as Record<string, unknown>)).toEqual([
      '$schema',
      'additionalProperties',
      'properties',
      'required',
      'type',
    ]);
  });

  it('keeps properties in declaration order, not alphabetical', () => {
    // The author's order is information a model reads: `amount, currency, note` describes a tool
    // better than `amount, currency, note` alphabetised into something else. It is also stable,
    // because it comes from the zod declaration.
    const { schema, json } = toStrictJsonSchema(
      z.object({ zebra: z.string(), apple: z.string(), mango: z.string() }),
    );
    expect(Object.keys(schema.properties ?? {})).toEqual(['zebra', 'apple', 'mango']);
    expect(json.indexOf('"zebra"')).toBeLessThan(json.indexOf('"apple"'));
    expect(schema.required).toEqual(['zebra', 'apple', 'mango']);
  });

  it('freezes the schema, so nothing can mutate it after it has been hashed', () => {
    const { schema } = toStrictJsonSchema(z.object({ a: z.object({ b: z.string() }) }));
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.properties?.['a'])).toBe(true);
    // The schema is part of the cache prefix and of `catalogHash`; a node something mutated after
    // the hash was taken is a cache miss nobody can explain.
    expect(() => {
      (schema as { type: string }).type = 'string';
    }).toThrow();
  });
});

describe('05 §3.6.2 step 5: denull round-trips the optional semantics', () => {
  it('turns a null at a recorded path back into an absent property', () => {
    const input = z.object({ title: z.string(), note: z.string().optional() });
    const { nullablePaths } = toStrictJsonSchema(input);
    // What the model sends, because step 2 asked for it.
    const fromModel = { title: 'x', note: null };
    const cleaned = denull(fromModel, nullablePaths);
    expect(cleaned).toEqual({ title: 'x' });
    expect(input.safeParse(cleaned).success).toBe(true);
    // And the original is untouched, because a caller may be logging it.
    expect(fromModel.note).toBeNull();
  });

  it('keeps a null whose type really is null', () => {
    // The reason the paths are recorded rather than "drop every null": a field declared
    // `z.null()` means null, and dropping it is silent data loss.
    const input = z.object({ cleared: z.null(), note: z.string().optional() });
    const { nullablePaths } = toStrictJsonSchema(input);
    expect(nullablePaths).toEqual(['note']);
    const cleaned = denull({ cleared: null, note: null }, nullablePaths);
    expect(cleaned).toEqual({ cleared: null });
    expect(input.safeParse(cleaned).success).toBe(true);
  });

  it('walks into arrays and nested objects', () => {
    const input = z.object({
      outer: z.object({ inner: z.string().optional() }),
      list: z.array(z.object({ tag: z.string().optional(), id: z.string() })),
    });
    const { nullablePaths } = toStrictJsonSchema(input);
    const cleaned = denull(
      {
        outer: { inner: null },
        list: [
          { tag: null, id: 'a' },
          { tag: 'b', id: 'c' },
        ],
      },
      nullablePaths,
    );
    expect(cleaned).toEqual({ outer: {}, list: [{ id: 'a' }, { tag: 'b', id: 'c' }] });
    expect(input.safeParse(cleaned).success).toBe(true);
  });

  it('is a no-op when nothing was optional', () => {
    const value = { a: 1, b: null };
    expect(denull(value, [])).toBe(value);
  });
});

describe('05 §9.1’s property: every object node is closed and exhaustively required', () => {
  /** A generator of nested zod object schemas, with optional fields at every level. */
  const arbSchema = (depth = 0): fc.Arbitrary<z.ZodType> =>
    fc
      .array(
        fc.tuple(
          fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/),
          depth >= 2
            ? fc.constantFrom<z.ZodType>(z.string(), z.number(), z.boolean())
            : fc.oneof(
                // Weighted toward scalars, so the generator produces shallow schemas most of the
                // time and deep ones sometimes — a uniform choice would make almost every case
                // three levels deep and almost none of them a single field.
                {
                  arbitrary: fc.constantFrom<z.ZodType>(z.string(), z.number(), z.boolean()),
                  weight: 3,
                },
                { arbitrary: arbSchema(depth + 1), weight: 1 },
                {
                  arbitrary: arbSchema(depth + 1).map((inner) => z.array(inner) as z.ZodType),
                  weight: 1,
                },
              ),
          fc.boolean(),
        ),
        { minLength: 1, maxLength: 4 },
      )
      .map((fields) => {
        const shape: Record<string, z.ZodType> = {};
        for (const [name, type, isOptional] of fields) {
          shape[name] = isOptional ? type.optional() : type;
        }
        return z.object(shape);
      });

  /** Every object node in a converted schema, so the property is about all of them. */
  function objectNodes(
    node: unknown,
    found: Record<string, unknown>[] = [],
  ): Record<string, unknown>[] {
    if (Array.isArray(node)) {
      for (const item of node) objectNodes(item, found);
      return found;
    }
    if (typeof node !== 'object' || node === null) return found;
    const record = node as Record<string, unknown>;
    if (record['type'] === 'object') found.push(record);
    for (const value of Object.values(record)) objectNodes(value, found);
    return found;
  }

  it('holds for every schema the generator can produce', () => {
    fc.assert(
      fc.property(arbSchema(), (schema) => {
        const { schema: converted } = toStrictJsonSchema(schema);
        const nodes = objectNodes(converted);
        expect(nodes.length).toBeGreaterThan(0);
        for (const node of nodes) {
          expect(node['additionalProperties']).toBe(false);
          const properties = Object.keys((node['properties'] ?? {}) as Record<string, unknown>);
          const required = (node['required'] ?? []) as string[];
          // `required ⊇ keys(properties)`, which with `additionalProperties: false` means the two
          // sets are equal — an optional field is nullable, never absent.
          for (const name of properties) expect(required).toContain(name);
        }
      }),
      fcConfig({ numRuns: 200 }),
    );
  });

  it('round-trips through denull for every generated schema', () => {
    // The property form of step 5: whatever the generator produces, a payload of nulls at the
    // recorded paths parses as the original optional semantics.
    fc.assert(
      fc.property(arbSchema(), (schema) => {
        const { nullablePaths } = toStrictJsonSchema(schema);
        const nulled = nullPayload(schema);
        const cleaned = denull(nulled, nullablePaths);
        const outcome = schema.safeParse(cleaned);
        expect(outcome.success, JSON.stringify({ nulled, cleaned })).toBe(true);
      }),
      fcConfig({ numRuns: 200 }),
    );
  });

  /** A payload where every optional field is `null` and every required one has a value. */
  function nullPayload(schema: z.ZodType): unknown {
    const json = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
      cycles: 'throw',
      reused: 'inline',
    }) as Record<string, unknown>;
    return fromJson(json);
  }

  function fromJson(node: Record<string, unknown>): unknown {
    const required = new Set((node['required'] ?? []) as string[]);
    if (node['type'] === 'object') {
      const properties = (node['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const out: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(properties)) {
        out[name] = required.has(name) ? fromJson(child) : null;
      }
      return out;
    }
    if (node['type'] === 'array') return [];
    if (node['type'] === 'number' || node['type'] === 'integer') return 1;
    if (node['type'] === 'boolean') return true;
    return 'x';
  }
});

describe('10 §3.5.2’s linter, over a plugin’s own schema', () => {
  const strict = {
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'string' } },
    required: ['a'],
  } as const;

  it('passes a strict schema', () => {
    expect(lintStrictSchema(strict)).toEqual([]);
    expect(isStrictCompatible(strict)).toBe(true);
    expect(explainStrictViolations([])).toContain('strict-compatible');
  });

  it('passes everything the converter produces', () => {
    // The two halves agreeing is the point of having one implementation: a schema we emit must pass
    // the linter we apply to somebody else's.
    const cases = [
      z.object({ a: z.string() }),
      z.object({ a: z.string().optional(), b: z.array(z.object({ c: z.number() })) }),
      z.object({ nested: z.object({ deep: z.object({ deeper: z.boolean() }) }) }),
      z.object({
        choice: z.union([z.object({ k: z.literal('a') }), z.object({ k: z.literal('b') })]),
      }),
      z.object({ when: z.iso.datetime(), who: z.email() }),
    ];
    for (const schema of cases) {
      const { schema: converted } = toStrictJsonSchema(schema);
      expect(lintStrictSchema(converted), JSON.stringify(converted)).toEqual([]);
    }
  });

  it.each([
    ['a root that is not an object', { type: 'string' }, 'root_not_object'],
    [
      'a missing additionalProperties',
      { ...strict, additionalProperties: undefined },
      'additional_properties',
    ],
    [
      'an open additionalProperties',
      { ...strict, additionalProperties: true },
      'additional_properties',
    ],
    ['a property missing from required', { ...strict, required: [] }, 'missing_required'],
    ['a $ref', { ...strict, properties: { a: { $ref: '#/$defs/x' } } }, 'ref'],
    [
      'patternProperties',
      { ...strict, patternProperties: { '^x': { type: 'string' } } },
      'pattern_properties',
    ],
    // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword in a fixture schema
    ['an if/then', { ...strict, if: {}, then: {} }, 'conditional'],
  ])('refuses %s', (_label, schema, rule) => {
    const violations = lintStrictSchema(schema);
    expect(violations.map((v) => v.rule)).toContain(rule);
    // And the message names the path, because "not strict-compatible" is not actionable.
    expect(explainStrictViolations(violations)).toMatch(/:/);
  });

  it('finds every violation rather than the first', () => {
    const violations = lintStrictSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'object', properties: { c: {} } } },
      required: [],
    });
    expect(violations.length).toBeGreaterThan(2);
  });

  it('refuses a schema over the size ceiling before looking at its properties', () => {
    // A 2 MB schema should say "too large" rather than produce two thousand property findings.
    const big = {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        Array.from({ length: 2_000 }, (_unused, index) => [
          `field_${String(index)}`,
          { type: 'string', description: 'x'.repeat(40) },
        ]),
      ),
      required: [],
    };
    const violations = lintStrictSchema(big);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('too_large');
    expect(violations[0]?.detail).toContain(String(MAX_STRICT_SCHEMA_BYTES));
  });

  it('treats deep nesting as the cycle it probably is', () => {
    let node: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < 12; depth += 1) {
      node = {
        type: 'object',
        additionalProperties: false,
        properties: { n: node },
        required: ['n'],
      };
    }
    expect(lintStrictSchema(node).some((v) => v.rule === 'ref')).toBe(true);
  });
});
