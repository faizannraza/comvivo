/**
 * zod → strict JSON Schema (`05` §3.6.2, `10` §3.2.3; `M2-T4`).
 *
 * **One implementation.** `05` §3.6.2 named `models/src/schema/to-strict-json-schema.ts` and `10`
 * §3.5.2 named `plugin-sdk/src/schema/strict.ts`. Two converters producing "the same" schema is two
 * sets of edge cases, and this schema is what a model's `strict: true` tool validation is checked
 * against — a disagreement between them would mean a tool whose arguments validate for the host and
 * not for the provider, or the reverse. So it lives here, at the bottom of the dependency graph,
 * and both packages re-export it. Logged as a plan change.
 *
 * ## The six steps, and why each one is there
 *
 * 1. **`z.toJSONSchema` with `cycles: 'throw'`.** A recursive schema has no strict representation —
 *    `strict: true` requires an exhaustive `required` and a finite shape — so it fails at
 *    registration rather than at the first call. Verified against the installed zod (4.6.7): the
 *    option names below are its own.
 * 2. **Every object gets `additionalProperties: false` and an exhaustive `required`.** That pair is
 *    what "strict" means to the API. The consequence is the interesting part: an *optional* field
 *    cannot stay optional, so it becomes `anyOf: [T, {type: 'null'}]` and its path is recorded.
 * 3. **Unsupported keywords are stripped**, not translated. `minLength`, `pattern`, `minimum` and
 *    the rest are not honoured by strict tool validation, and a schema that carries them invites
 *    the reader to believe the provider is enforcing them. **zod still enforces every one of them
 *    at parse time**, which is where it actually matters: the model's arguments are parsed before a
 *    tool sees them, so a `minLength` violation is an `invalid_input` rather than a bad write.
 * 4. **Canonical bytes.** The schema is part of the cache prefix and of `catalogHash` (`M2-T17`), so
 *    the same schema must serialise to the same bytes on every boot of every process. Key order is
 *    sorted *except* inside `properties`, which keeps declaration order — see `canonicalise`.
 * 5. **`denull` on the way in.** The model sends `null` for an absent optional, because that is what
 *    step 2 asked for. `denull` turns those back into `undefined` before zod parses, so the tool's
 *    own types never learn about this encoding.
 * 6. **The same converter serves structured outputs**, with `io: 'output'`. One set of rules, so a
 *    schema cannot be strict as a tool input and loose as a structured output.
 */
import { z } from '../zod.js';
import type { StrictJsonSchema } from './strict-json-schema.js';

/**
 * Keywords strict tool validation does not honour (`05` §3.6.2 step 3).
 *
 * Stripped rather than kept, because a schema that carries `"minimum": 1` reads as a promise the
 * provider is not making. zod enforces all of them at parse time, which is the layer that can
 * actually reject a value.
 */
export const STRIPPED_KEYWORDS: readonly string[] = [
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
];

/** The only `format` values that survive (`05` §3.6.2 step 3). */
export const KEPT_FORMATS: readonly string[] = [
  'date-time',
  'date',
  'time',
  'duration',
  'email',
  'uri',
  'uuid',
];

/** A JSON Schema node as zod hands it over, before the walk. */
type JsonNode = Record<string, unknown>;

export interface StrictConversion {
  /** The schema, frozen and canonical. */
  readonly schema: StrictJsonSchema;
  /**
   * Every path that was optional and is now `anyOf: [T, null]`, in `a.b.c` form with `[]` for an
   * array element: `denull` walks these rather than guessing from the data.
   */
  readonly nullablePaths: readonly string[];
  /** The canonical bytes, so a caller hashing this does not re-serialise and risk a difference. */
  readonly json: string;
}

export interface ToStrictOptions {
  /** `'input'` for a tool's arguments (the default), `'output'` for a structured result. */
  readonly io?: 'input' | 'output';
}

/**
 * Convert a zod schema to a strict JSON Schema.
 *
 * Throws on a recursive schema, on a type JSON Schema cannot express, and on a root that is not an
 * object — the last because `strict: true` is defined over an object's properties, and a tool whose
 * input is a bare array has nothing to be strict about.
 */
export function toStrictJsonSchema(
  schema: z.ZodType,
  options: ToStrictOptions = {},
): StrictConversion {
  // Step 1. `unrepresentable: 'throw'` and `cycles: 'throw'` are the two that matter: the first
  // refuses a `z.date()` or a `bigint` that would silently become `{}`, the second refuses
  // recursion. `reused: 'inline'` keeps `$defs` out, because a `$ref` is one more thing a provider
  // has to resolve the same way we do.
  const raw = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: options.io ?? 'input',
    unrepresentable: 'throw',
    cycles: 'throw',
    reused: 'inline',
  }) as JsonNode;

  const nullablePaths: string[] = [];
  const walked = walk(raw, '', nullablePaths);
  if (walked['type'] !== 'object') {
    throw new Error(
      `a strict schema's root must be an object, got ${JSON.stringify(walked['type'])}. ` +
        '`strict: true` is defined over an object’s properties, so a bare array or scalar has ' +
        'nothing to be strict about.',
    );
  }

  const canonical = canonicalise(walked);
  const json = JSON.stringify(canonical);
  return {
    // Through `unknown`: the walked node is a `Record<string, unknown>` and the declared type is
    // narrower, which `tsc` is right to refuse as a direct assertion. The guard above has already
    // established the one property the narrower type requires (`type === 'object'`).
    schema: deepFreeze(canonical) as unknown as StrictJsonSchema,
    nullablePaths: Object.freeze([...nullablePaths].toSorted()),
    json,
  };
}

/** Is this an object we should treat as a schema node (and not, say, an `enum` array)? */
function isNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Join a parent path and a segment, keeping the root unprefixed. */
function childPath(parent: string, segment: string): string {
  return parent === '' ? segment : `${parent}.${segment}`;
}

/**
 * Steps 2 and 3, in one pass.
 *
 * One pass rather than two because the optional→nullable rewrite has to happen *before* the
 * stripping walks into the new `anyOf`, and splitting them would mean deciding which order the two
 * walks run in — a decision that is invisible until a schema has both an optional field and a
 * stripped keyword on it.
 */
function walk(node: JsonNode, path: string, nullablePaths: string[]): JsonNode {
  const out = stripKeywords(node);

  if (out['type'] === 'object' && isNode(out['properties'])) {
    closeObject(out, out['properties'], path, nullablePaths);
  }

  if (isNode(out['items'])) {
    // `[]` marks the element, so `denull` knows to map across an array rather than index into it.
    out['items'] = walk(out['items'], childPath(path, '[]'), nullablePaths);
  }

  for (const combinator of ['anyOf', 'allOf', 'oneOf'] as const) {
    const branches: unknown = out[combinator];
    if (Array.isArray(branches)) {
      // `unknown[]`, not the `any[]` `Array.isArray` narrows to: without the annotation `.map`
      // returns `any[]` and the unsafe-return rule is right to object.
      const list = branches as unknown[];
      out[combinator] = list.map((branch) =>
        isNode(branch) ? walk(branch, path, nullablePaths) : branch,
      );
    }
  }

  return out;
}

/** Step 3, on one node: drop the keywords a provider does not honour, and unsupported formats. */
function stripKeywords(node: JsonNode): JsonNode {
  const out: JsonNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_KEYWORDS.includes(key)) continue;
    if (key === 'format' && typeof value === 'string' && !KEPT_FORMATS.includes(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Step 2, on one object node: close it, require everything, and make the optionals nullable.
 *
 * Mutates `out` in place, which is safe because it is the fresh object `stripKeywords` just built
 * and nothing else holds a reference to it yet.
 */
function closeObject(
  out: JsonNode,
  properties: JsonNode,
  path: string,
  nullablePaths: string[],
): void {
  const declared = Object.keys(properties);
  const previouslyRequired = new Set(
    Array.isArray(out['required']) ? (out['required'] as string[]) : [],
  );

  const rewritten: JsonNode = {};
  for (const name of declared) {
    const child = properties[name];
    if (!isNode(child)) continue;
    const here = childPath(path, name);
    const converted = walk(child, here, nullablePaths);
    if (previouslyRequired.has(name)) {
      rewritten[name] = converted;
      continue;
    }
    // Step 2's consequence: an optional property becomes nullable and its path is recorded, so
    // `denull` can undo it. The `description` is hoisted onto the union, because a provider shows
    // the union's description and would otherwise show nothing for every optional field.
    nullablePaths.push(here);
    // Destructured rather than `delete`d: `delete` on a hot-path object deoptimises it, and this
    // runs once per optional field of every tool at boot.
    const { description, ...branch } = converted;
    rewritten[name] = {
      anyOf: [branch, { type: 'null' }],
      ...(typeof description === 'string' ? { description } : {}),
    };
  }

  out['properties'] = rewritten;
  out['required'] = declared;
  out['additionalProperties'] = false;
}

/**
 * Step 4: canonical bytes.
 *
 * Keys are sorted **except** inside `properties`, where declaration order is kept. Both halves are
 * deliberate and they pull in opposite directions:
 *
 *  - Sorting a schema object's own keys makes the bytes independent of the order our own code
 *    happened to build them in, which is what makes the cache prefix stable across versions.
 *  - Keeping `properties` in declaration order preserves the author's intent, which a model reads:
 *    a tool whose fields are listed `amount, currency, note` describes itself better than one
 *    alphabetised into `amount, currency, note`… and far better than `currency, amount, note`. It
 *    is also stable, because it comes from the zod schema's own declaration.
 */
function canonicalise(node: JsonNode): JsonNode {
  const out: JsonNode = {};
  for (const key of Object.keys(node).toSorted()) {
    const value = node[key];
    if (key === 'properties' && isNode(value)) {
      const properties: JsonNode = {};
      // Declaration order, not sorted: `Object.keys` on the walked node preserves it.
      for (const name of Object.keys(value)) {
        const child = value[name];
        properties[name] = isNode(child) ? canonicalise(child) : child;
      }
      out[key] = properties;
      continue;
    }
    if (isNode(value)) {
      out[key] = canonicalise(value);
      continue;
    }
    if (Array.isArray(value)) {
      const list = value as unknown[];
      out[key] = list.map((item) => (isNode(item) ? canonicalise(item) : item));
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Freeze every level, so a cached schema cannot be mutated after it has been hashed. */
function deepFreeze<T>(value: T): T {
  if (isNode(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
  } else if (Array.isArray(value)) {
    for (const item of value as unknown[]) deepFreeze(item);
  }
  return Object.freeze(value);
}

/**
 * Step 5: turn the `null`s step 2 asked for back into absent properties.
 *
 * Only at the recorded paths. A blanket "drop every null" would also drop a field whose type really
 * is `z.null()`, which is a different thing and a silent data loss — the paths are recorded
 * precisely so this is a translation rather than a heuristic.
 *
 * Returns a new value; the input is never mutated, because the caller may be logging it.
 */
export function denull(input: unknown, nullablePaths: readonly string[]): unknown {
  if (nullablePaths.length === 0) return input;
  return strip(input, '', new Set(nullablePaths));
}

function strip(value: unknown, path: string, paths: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => strip(item, childPath(path, '[]'), paths));
  }
  if (!isNode(value)) return value;
  const out: JsonNode = {};
  for (const [key, child] of Object.entries(value)) {
    const here = childPath(path, key);
    if (child === null && paths.has(here)) continue;
    out[key] = strip(child, here, paths);
  }
  return out;
}
