/**
 * Span and metric attributes, with content made unrepresentable.
 *
 * `01` §11.7 promises that message and memory content never leaves the process through telemetry.
 * The logger earns that with four layers (`logger/index.ts`); this is the same argument applied to
 * traces, and it needs to be, because a span attribute is the easier mistake: the GenAI conventions
 * *define* attributes for prompts and completions, so emitting one looks like compliance rather
 * than a leak.
 *
 * Three layers here:
 *
 *  1. **The type.** `Attributes` rejects any forbidden key at compile time, by family rather than
 *     by exact name, so an attribute the registry adds next week is rejected before anyone updates
 *     a list. Nine `@ts-expect-error` assertions in the tests hold this shut.
 *  2. **The runtime filter.** `sanitizeAttributes()` drops forbidden keys at any depth, because an
 *     attribute bag assembled from `unknown` data loses the type on the way in.
 *  3. **The loud failure in tests.** Under `COMVIVO_TEST_MODE` a forbidden key throws instead of
 *     being dropped, so a test that would have shipped a leak fails rather than passing quietly.
 *     In production it drops, because a telemetry mistake must never take down a family's bot.
 */
import { BRAND } from '../brand.js';
import { BugError } from '../errors.js';
import { FORBIDDEN_FIELD_NAMES } from '../logger/fields.js';
import { scrubSecretShapes } from '../logger/scrub.js';

/** What OTel accepts as an attribute value. */
export type AttributeValue = string | number | boolean | readonly string[] | readonly number[];

/**
 * Attribute families that may never be set, as string prefixes.
 *
 * Deliberately prefixes and not exact names. The GenAI registry is Development status and grew its
 * opt-in content set from 6 to 15 attributes in the two days between the plan being written and
 * this task; `gen_ai.input.messages_ref` in particular is new, and an exact-match denylist written
 * on Sunday would have let it through on Tuesday. A family covers what has not been invented yet.
 *
 * Each entry is as narrow as it can be while still being a family. `gen_ai.output.messages` rather
 * than `gen_ai.output.`, because `gen_ai.output.type` is a legitimate attribute we do emit; and
 * `gen_ai.memory.query.` rather than `gen_ai.memory.`, because a memory record *count* is not
 * content.
 */
export const FORBIDDEN_ATTRIBUTE_FAMILIES: readonly string[] = [
  // Prompts and completions.
  'gen_ai.input.',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  // Tool definitions, arguments and results. `gen_ai.tool.call.id` stays allowed.
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  // Memory and retrieval payloads — the ones that would carry what a family told the bot last year.
  'gen_ai.memory.query.',
  'gen_ai.memory.records',
  'gen_ai.retrieval.query.',
  'gen_ai.retrieval.documents',
  // Prompt template variables, which carry member names and whatever the template interpolates.
  'gen_ai.prompt.variable',
];

/**
 * The same families as a type, for the compile-time layer.
 *
 * Kept beside `FORBIDDEN_ATTRIBUTE_FAMILIES` rather than derived from it: TypeScript cannot turn a
 * `readonly string[]` into template-literal types, and the alternative (a `const` tuple widened
 * into a union) produces errors that name a mapped type instead of the attribute. A test asserts
 * the two lists agree, so the duplication cannot drift.
 */
type ForbiddenAttributeFamily =
  | `gen_ai.input.${string}`
  | `gen_ai.output.messages${string}`
  | `gen_ai.system_instructions${string}`
  | `gen_ai.tool.definitions${string}`
  | `gen_ai.tool.call.arguments${string}`
  | `gen_ai.tool.call.result${string}`
  | `gen_ai.memory.query.${string}`
  | `gen_ai.memory.records${string}`
  | `gen_ai.retrieval.query.${string}`
  | `gen_ai.retrieval.documents${string}`
  | `gen_ai.prompt.variable${string}`;

/** The logger's forbidden field names are forbidden here too, so the two systems cannot disagree. */
type ForbiddenBareName =
  | 'text'
  | 'content'
  | 'content_text'
  | 'prompt'
  | 'messages'
  | 'richText'
  | 'rich_text'
  | 'raw'
  | 'body'
  | 'args'
  | 'result'
  | 'payload'
  | 'memberName'
  | 'displayName'
  | 'token'
  | 'apiKey'
  | 'password'
  | 'secret'
  | 'authorization'
  | 'headers'
  | 'cookie';

export type ForbiddenAttributeName = ForbiddenAttributeFamily | ForbiddenBareName;

/**
 * An attribute bag.
 *
 * Open to any key — OTel attributes are an open set and a typo is not a safety problem — but
 * closed against the forbidden families. `{ 'gen_ai.input.messages': text }` does not compile.
 */
export type Attributes = Readonly<Record<string, AttributeValue>> &
  Partial<Record<ForbiddenAttributeName, never>>;

/**
 * Bare attribute names that are forbidden, at runtime.
 *
 * `content` is added to the logger's list: it is not a `LogFields` name (the logger's content
 * channel owns that word) but it is the single most likely attribute name for a leak.
 */
export const FORBIDDEN_ATTRIBUTE_NAMES: readonly string[] = [...FORBIDDEN_FIELD_NAMES, 'content'];

const FORBIDDEN_EXACT = new Set(FORBIDDEN_ATTRIBUTE_NAMES.map((name) => name.toLowerCase()));

/** Whether an attribute name may never be emitted. */
export function isForbiddenAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  if (FORBIDDEN_EXACT.has(lower)) return true;
  return FORBIDDEN_ATTRIBUTE_FAMILIES.some((family) => lower.startsWith(family.toLowerCase()));
}

/**
 * How many values an attribute array may carry.
 *
 * `gen_ai.response.finish_reasons` is the only array we emit and it has one or two entries. A cap
 * stops an unbounded array — a list of every tool name considered, say — from turning a span into
 * a payload.
 */
const MAX_ARRAY_VALUES = 32;

/** Longest a single attribute string may be, after scrubbing. */
export const MAX_ATTRIBUTE_LENGTH = 256;

function truncate(value: string): string {
  return value.length <= MAX_ATTRIBUTE_LENGTH
    ? value
    : `${value.slice(0, MAX_ATTRIBUTE_LENGTH - 1)}…`;
}

function testMode(): boolean {
  // Read lazily rather than at module load: `vitest.config.ts` sets this in the main process, and a
  // module-load read would also freeze the value for anything that spawns a child with it unset.
  return process.env[`${BRAND.envPrefix}TEST_MODE`] === '1';
}

/**
 * Drop every forbidden attribute, scrub secret shapes from the rest, and bound the sizes.
 *
 * Returns a plain record rather than `Attributes`: the output is for a backend to consume, and
 * typing it as `Attributes` would invite a caller to read a value back out of it.
 *
 * Throws in test mode. That asymmetry is deliberate — a dropped attribute in production is a
 * missing data point, while a dropped attribute in a test is a bug that just passed CI.
 */
export function sanitizeAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(attributes)) {
    if (isForbiddenAttribute(key)) {
      rejected.push(key);
      continue;
    }
    const clean = sanitizeValue(value);
    if (clean !== undefined) out[key] = clean;
  }

  if (rejected.length > 0 && testMode()) {
    throw new BugError(
      `Telemetry attributes included forbidden name(s): ${rejected.join(', ')}. ` +
        'Span and metric attributes never carry message or memory content (01 §11.7). ' +
        `If you need to correlate, emit an id — ${BRAND.slug}.turn.id or gen_ai.conversation.id ` +
        '— and ' +
        'look the content up through the dashboard, where the reader has been authorised.',
    );
  }

  return out;
}

function sanitizeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string') return truncate(scrubSecretShapes(value));
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_VALUES);
    if (items.every((item) => typeof item === 'number')) {
      return items.filter((item: number) => Number.isFinite(item));
    }
    return items.map((item) => truncate(scrubSecretShapes(String(item))));
  }
  // Objects, functions, symbols, null and undefined are not attribute values. Stringifying an
  // object here is exactly how a message would arrive as `[object Object]`'s more useful cousin,
  // so they are dropped instead.
  return undefined;
}
