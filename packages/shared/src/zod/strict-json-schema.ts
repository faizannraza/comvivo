/**
 * `StrictJsonSchema` — the only JSON Schema shape a provider is ever sent (`05` §3.6.2, `10` §3.2.3).
 *
 * **One implementation, in `shared`.** `05` named `packages/models/src/schema/strict.ts` and `10`
 * named `packages/plugin-sdk/src/schema.ts`; two converters producing "the same" schema is two sets
 * of edge cases, and the schema is what a model's `strict: true` tool validation is checked
 * against. Both packages re-export this one (logged as a plan change at `M2-T4`).
 *
 * ## Why a type before a converter
 *
 * `M2-T1` defines `@comvivo/core/ports/model`, whose `ToolSpec.inputSchema` is this type; `M2-T4`
 * writes the zod → schema converter beside it. The type is the contract and is complete on its
 * own: it says what a tool schema may contain, which is the part the port needs and the part a
 * reviewer can check. There is no stub function here waiting to be filled in — `CLAUDE.md` §8
 * forbids that, and a declaration that is finished is not one.
 *
 * ## What "strict" means
 *
 * `05` §3.6.2 and the Messages API's `strict: true`: every object states `additionalProperties:
 * false` and lists `required` exhaustively, so the model's arguments validate exactly rather than
 * approximately. The type expresses the subset we emit — it is deliberately narrower than JSON
 * Schema, because every construct we allow is one the converter has to get right and the provider
 * has to accept. `$ref`, `oneOf`, `allOf`, `not`, tuple-form `items` and recursion are absent on
 * purpose; `M2-T4`'s converter throws on a zod type that would need one.
 */

/** JSON Schema's primitive type keywords, in the subset we emit. */
export type StrictJsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/**
 * One node of a strict schema.
 *
 * `readonly` throughout: a schema is hashed into `catalogHash` (`M2-T17`) and cached by prefix, so
 * a node that something mutated after the hash was taken is a cache miss nobody can explain.
 */
export interface StrictJsonSchema {
  readonly type: StrictJsonSchemaType | readonly StrictJsonSchemaType[];
  readonly description?: string;
  /** `object`: every property, with `required` listing all of them and `additionalProperties` false. */
  readonly properties?: Readonly<Record<string, StrictJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  /** `array`: one schema for every element. Tuple form is not emitted. */
  readonly items?: StrictJsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  /** `string`/`number`: the constraints a provider honours in strict mode. */
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: string | number | boolean | null;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: 'date-time' | 'date' | 'time' | 'duration' | 'email' | 'uri' | 'uuid';
  /** The only union form we emit: a tagged union becomes `anyOf` over objects with a literal tag. */
  readonly anyOf?: readonly StrictJsonSchema[];
}
