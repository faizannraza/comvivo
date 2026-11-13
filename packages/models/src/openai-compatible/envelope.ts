/**
 * The envelope protocol (`05` §3.5.6 L2/L3; `M2-T12`).
 *
 * ## What it is
 *
 * A server with no native tool calling can still be asked to produce JSON. So the tool catalogue is
 * rendered as compact text into the system prompt and the model is asked to answer with
 *
 * ```json
 * { "reply": string | null, "tool_calls": [ { "name": <one of the tool names>, "input": object } ] }
 * ```
 *
 * under a JSON schema. Each `input` is then validated with **that tool's own zod schema**, and a
 * failure comes back to the model as an `is_error` envelope rather than being executed.
 *
 * ## The three rules that make this safe rather than merely clever
 *
 *  1. **`name` is an enum of the actual tool names**, not a free string. A model that invents
 *     `delete_everything` fails the schema instead of reaching the policy engine with a name it has
 *     to decide about. This is the difference between a text protocol and a text injection.
 *  2. **Per-tool validation is not optional.** The envelope schema can only say "`input` is an
 *     object"; it cannot carry forty different input schemas as a discriminated union that every
 *     local server would handle correctly. So the envelope gets the model to the right *shape* and
 *     zod gets it to the right *value*.
 *  3. **The rendered catalogue is still the catalogue.** It is built from the same `ToolSpec` list
 *     the native path sends, in the same order, so `M2-T17`'s `catalogHash` still describes what
 *     the model was shown — and a server-side KV prefix cache still hits.
 *
 * ## What is lost
 *
 * Parallel calls stop being guaranteed: the array can hold several, and whether a 12B model
 * reliably produces a correct second entry is not something an adapter can promise. `05` §3.5.6
 * says so, and `LEVEL_BEHAVIOUR` records it as a flag the engine reads rather than a hope.
 */
import type { SchemaLike, ToolSpec } from '@comvivo/core';
import type { StrictJsonSchema } from '@comvivo/shared';

/** The envelope's own schema name, as `response_format` wants it. */
export const ENVELOPE_SCHEMA_NAME = 'tool_envelope';

/** How much of a tool description reaches the rendered catalogue. */
export const MAX_RENDERED_DESCRIPTION_CHARS = 200;

/**
 * The envelope JSON Schema for a given tool list.
 *
 * `name` is an `enum` of exactly the available tool names, which is rule 1 above. With no tools the
 * array is constrained to empty rather than omitted: a chat-only turn on L2 should produce
 * `{"reply": "...", "tool_calls": []}`, and leaving the array unconstrained would invite a call to
 * a tool that is not there.
 */
export function envelopeSchema(tools: readonly ToolSpec[]): StrictJsonSchema {
  const names = tools.map((tool) => tool.name);
  return {
    type: 'object',
    properties: {
      reply: { type: ['string', 'null'] },
      tool_calls: {
        type: 'array',
        items:
          names.length === 0
            ? // No tools: an array that can hold nothing. `maxItems: 0` rather than an absent
              // `items`, because a local server given an unconstrained array will eventually fill
              // it.
              { type: 'object', properties: {}, required: [], additionalProperties: false }
            : {
                type: 'object',
                properties: {
                  name: { type: 'string', enum: names },
                  input: { type: 'object' },
                },
                required: ['name', 'input'],
                additionalProperties: false,
              },
        ...(names.length === 0 ? { maxItems: 0 } : {}),
      },
    },
    required: ['reply', 'tool_calls'],
    additionalProperties: false,
  } as unknown as StrictJsonSchema;
}

/**
 * The tool catalogue as compact text for the system prompt.
 *
 * One line per tool, name then a truncated description, then the input schema as minified JSON.
 * Deliberately terse: this text is in the cached prefix on a server with a KV cache, and on an 8 GB
 * host every token of catalogue is a token not available for the conversation. The descriptions are
 * bounded for the same reason — a 1,024-character description times forty tools is most of a small
 * model's window.
 */
export function renderCatalogue(tools: readonly ToolSpec[]): string {
  if (tools.length === 0) return 'No tools are available for this turn.';
  const lines = tools.map((tool) => {
    const description =
      tool.description.length > MAX_RENDERED_DESCRIPTION_CHARS
        ? `${tool.description.slice(0, MAX_RENDERED_DESCRIPTION_CHARS - 1)}…`
        : tool.description;
    return `- ${tool.name}: ${description}\n  input: ${JSON.stringify(tool.inputSchema)}`;
  });
  return lines.join('\n');
}

/**
 * The instruction block that explains the envelope.
 *
 * Written out rather than templated from the schema: a model following instructions does better
 * with a worked example than with a schema restatement, and this text is reviewed as copy. It stays
 * in `05`'s voice — direct, no hedging — because a 12B model treats hedged instructions as
 * optional.
 */
export function envelopeInstruction(tools: readonly ToolSpec[]): string {
  const catalogue = renderCatalogue(tools);
  return [
    'Answer with a single JSON object and nothing else:',
    '{"reply": "<what to say, or null if you are only calling tools>", "tool_calls": []}',
    '',
    'To use a tool, add an entry to tool_calls with its exact name and an input object that',
    "matches that tool's input schema. Use only the tools listed below. If no tool is needed,",
    'leave tool_calls empty and put your answer in reply.',
    '',
    'Available tools:',
    catalogue,
  ].join('\n');
}

/** One parsed call, before its input has been validated against the tool's own schema. */
export interface EnvelopeCall {
  readonly name: string;
  readonly input: unknown;
}

export interface ParsedEnvelope {
  readonly reply: string | null;
  readonly toolCalls: readonly EnvelopeCall[];
}

export type EnvelopeOutcome =
  | { readonly kind: 'ok'; readonly envelope: ParsedEnvelope }
  /** The text was not JSON, or not the envelope's shape. `L3` retries once. */
  | { readonly kind: 'malformed'; readonly issue: string };

/**
 * Parse the model's text as an envelope.
 *
 * Tolerant of two things real local servers do and nothing else:
 *
 *  - **A fenced code block.** Many chat templates wrap JSON in ```` ```json ```` whatever the
 *    instruction said, and refusing that would put every L3 turn through a repair for a formatting
 *    habit.
 *  - **Leading or trailing prose.** The first `{` to the last `}` is taken when the whole string
 *    does not parse, because a model that says "Sure! {json}" has still answered.
 *
 * Deliberately **not** tolerant of a missing `tool_calls`, a non-array one, or a call with no
 * `name`. Those are the cases where guessing would mean executing something the model did not ask
 * for, and the repair path exists for exactly them.
 */
export function parseEnvelope(text: string): EnvelopeOutcome {
  const candidate = extractJson(text);
  if (candidate === undefined) {
    return { kind: 'malformed', issue: 'the response contained no JSON object' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      kind: 'malformed',
      issue: `the response is not JSON: ${error instanceof Error ? error.name : 'parse error'}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', issue: 'the response is not a JSON object' };
  }
  const bag = parsed as Record<string, unknown>;

  const rawReply = bag['reply'];
  if (rawReply !== null && rawReply !== undefined && typeof rawReply !== 'string') {
    return { kind: 'malformed', issue: '"reply" must be a string or null' };
  }

  const rawCalls = bag['tool_calls'];
  if (rawCalls !== undefined && !Array.isArray(rawCalls)) {
    return { kind: 'malformed', issue: '"tool_calls" must be an array' };
  }

  const calls: EnvelopeCall[] = [];
  for (const entry of rawCalls ?? []) {
    if (typeof entry !== 'object' || entry === null) {
      return { kind: 'malformed', issue: 'every tool_calls entry must be an object' };
    }
    const call = entry as Record<string, unknown>;
    const name = call['name'];
    if (typeof name !== 'string' || name === '') {
      return { kind: 'malformed', issue: 'every tool_calls entry needs a "name"' };
    }
    // A missing `input` is read as `{}` rather than refused: a tool with no required fields is a
    // real thing (`memory_about`, `agenda_view`), and the per-tool zod parse below is what decides
    // whether `{}` is acceptable for *this* tool.
    calls.push({ name, input: call['input'] ?? {} });
  }

  return {
    kind: 'ok',
    envelope: { reply: typeof rawReply === 'string' ? rawReply : null, toolCalls: calls },
  };
}

/** The JSON object inside a response, unwrapping a code fence and surrounding prose. */
function extractJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  if (body.startsWith('{') && body.endsWith('}')) return body;

  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  return first !== -1 && last > first ? body.slice(first, last + 1) : undefined;
}

/** A validated call, or the reason its input was refused. */
export type ValidatedCall =
  | { readonly kind: 'ok'; readonly name: string; readonly input: unknown }
  | { readonly kind: 'rejected'; readonly name: string; readonly issue: string };

/**
 * Validate each call's input against its own tool schema.
 *
 * A rejected call becomes an `is_error` result the model sees on the next step, which is `05`
 * §3.5.6's rule and the right one: the model asked for something malformed, and telling it so is
 * how it corrects itself. Silently dropping the call would leave it waiting for a result that never
 * comes; executing it would run a tool with an input nobody validated.
 *
 * A call naming a tool that is not in the list is rejected rather than dropped, for the same
 * reason — and it should be unreachable, because the envelope schema's `enum` already refused it.
 * Unreachable-by-construction is still worth a branch when the construction is a local model
 * honouring a schema.
 */
export function validateCalls(
  calls: readonly EnvelopeCall[],
  schemas: ReadonlyMap<string, SchemaLike<unknown>>,
): readonly ValidatedCall[] {
  return calls.map((call): ValidatedCall => {
    const schema = schemas.get(call.name);
    if (schema === undefined) {
      return {
        kind: 'rejected',
        name: call.name,
        issue: `there is no tool called "${call.name}"`,
      };
    }
    const result = schema.safeParse(call.input);
    return result.success
      ? { kind: 'ok', name: call.name, input: result.data }
      : { kind: 'rejected', name: call.name, issue: 'the input did not match the tool’s schema' };
  });
}

/**
 * A deterministic call id for an envelope call.
 *
 * The envelope has no ids — the model is not asked to invent them, because a model that invents ids
 * eventually reuses one and a tool result then attaches to the wrong call. So the id is positional
 * and derived here, which makes it unique within the turn and reproducible in a replay.
 */
export function envelopeCallId(step: number, index: number): string {
  return `env_${String(step)}_${String(index)}`;
}
