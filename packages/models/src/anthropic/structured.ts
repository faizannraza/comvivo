/**
 * `structured()` on the Anthropic adapter (`05` §3.5.3.3; `M2-T8`).
 *
 * The extract, route, declassify, guard and consolidate routes all go through here, which makes one
 * design question the important one: **what happens when the model returns something the schema
 * rejects?**
 *
 * `05` §3.5.3.3's answer is one repair attempt and then give up, and the reasoning is worth keeping
 * in front of the reader. A schema failure is usually a prompt problem, not a transient one, so
 * retrying the same request is a second bill for the same answer. Re-asking *with the issues
 * attached* is different: the model is told what was wrong and can fix it. One attempt, because a
 * second has a vanishing success rate and a turn has a deadline.
 *
 * The four outcomes stay distinct (`01` §7.5): `invalid` means the model answered and the answer
 * did not validate, `truncated` means it ran out of output tokens, `refused` means a policy
 * decline. Collapsing them is how a caller ends up retrying a prompt that will never validate.
 *
 * ## Reading the content
 *
 * `05` §3.5.3.3: read the **first `text` block, skipping any leading `thinking` blocks**. Adaptive
 * thinking is on by default on every model we use, so a reader that took `content[0]` would parse a
 * thinking block as JSON and report `invalid` for a perfectly good answer.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { StructuredRequest, StructuredResult, UsageIteration } from '@comvivo/core';
import { BRAND } from '@comvivo/shared';
import type { RouteBinding } from '../registry/resolve.js';
import type { AnthropicChatParams } from './request.js';
import { OPTIONAL_BETAS, WireInvariantError } from './request.js';
import { readStop, servedByFallback, usageIterations } from './response.js';

type Message = Anthropic.Beta.Messages.BetaMessage;
type Beta = Anthropic.AnthropicBeta;

/**
 * The prompt tag for a structured-output repair.
 *
 * Derived from `BRAND.slug` rather than written out. `05` §3.5.3.3 spells it `<village_event …>`,
 * which is the codename (`01` §14 A2) — and a prompt tag is **part of the cache prefix**, so
 * hard-coding it would mean a product rename invalidated every cached prompt on every instance and
 * required editing every template. Deriving it is what `BRAND` exists for.
 */
export function invalidOutputEvent(issues: string): string {
  // The issues are already a bounded summary from zod; attributes are escaped so a schema path
  // containing a quote cannot break the tag.
  const escaped = issues.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<${BRAND.slug}_event kind="invalid_output" issues="${escaped}"/>`;
}

/** How long a repair's issue summary may be, so it cannot crowd out the prompt. */
export const MAX_ISSUE_SUMMARY_CHARS = 400;

export interface BuiltStructuredRequest {
  readonly params: AnthropicChatParams;
  readonly betas: readonly Beta[];
}

/**
 * Build a structured request.
 *
 * Three differences from a chat request, each with a reason:
 *
 *  - **`output_config.format`**, carrying the schema the caller already converted.
 *  - **No tools and no `tool_choice`**: a structured route asks for one JSON value. Sending a tool
 *    catalogue would put it in the cache prefix for no benefit and invite a tool call the caller
 *    has nowhere to put.
 *  - **No `fallbacks`.** `05` §3.5.3.2 gates the refusal fallback on `caps.serverFallback`, and the
 *    structured routes run on Haiku, which does not offer it. The capability check does the work;
 *    this comment records that the omission is deliberate rather than forgotten.
 *
 * Citations are never combined with `output_config.format` — a 400 — and are never sent anyway.
 */
export function buildStructuredRequest(
  req: StructuredRequest<unknown>,
  options: { readonly binding: RouteBinding; readonly availableBetas: readonly Beta[] },
): BuiltStructuredRequest {
  const { binding } = options;
  if (req.jsonSchema.type !== 'object') {
    throw new WireInvariantError([
      `structured route "${req.route}" has a non-object output schema ` +
        `(${JSON.stringify(req.jsonSchema.type)}); a JSON-schema format is defined over an object`,
    ]);
  }
  // The refusal-fallback beta is dropped: it pairs with a `fallbacks` parameter this request does
  // not send, and `assertWireInvariants` would rightly refuse the pair.
  const betas = options.availableBetas.filter((beta) => beta !== OPTIONAL_BETAS.serverFallback);

  const params: AnthropicChatParams = {
    model: binding.model,
    max_tokens: req.maxOutputTokens,
    messages: [
      {
        role: 'user',
        content: req.input.map((part) =>
          part.type === 'text' ? { type: 'text', text: part.text } : { type: 'text', text: '' },
        ),
      },
    ],
    output_config: {
      effort: req.effort,
      format: { type: 'json_schema', schema: req.jsonSchema as unknown as Record<string, unknown> },
    },
    system: req.system.map((block) => ({
      type: 'text',
      text: block.text,
      ...(block.cache === undefined
        ? {}
        : { cache_control: { type: 'ephemeral', ttl: block.cache.ttl } }),
    })),
    ...(betas.length === 0 ? {} : { betas: [...betas] }),
  };
  return { params, betas };
}

/** The first `text` block, skipping leading `thinking` blocks (`05` §3.5.3.3). */
export function firstTextBlock(message: Message): string | undefined {
  for (const block of message.content) {
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    if (block.type === 'text') return block.text;
    // Anything else in the first position is not an answer: a structured request that came back
    // with a tool use or a server-tool result has not produced JSON, and guessing would hide it.
    return undefined;
  }
  return undefined;
}

/** A bounded, readable summary of why a value failed its schema. */
export function summariseIssues(error: unknown): string {
  const issues = extractIssues(error);
  const joined = issues.join('; ');
  return joined.length > MAX_ISSUE_SUMMARY_CHARS
    ? `${joined.slice(0, MAX_ISSUE_SUMMARY_CHARS - 1)}…`
    : joined;
}

function extractIssues(error: unknown): string[] {
  if (typeof error === 'object' && error !== null && 'issues' in error) {
    const raw: unknown = error.issues;
    if (Array.isArray(raw)) {
      return (raw as unknown[]).flatMap((issue) => {
        if (typeof issue !== 'object' || issue === null) return [];
        const path = 'path' in issue && Array.isArray(issue.path) ? issue.path.join('.') : '';
        const message =
          'message' in issue && typeof issue.message === 'string' ? issue.message : '';
        return [path === '' ? message : `${path}: ${message}`];
      });
    }
  }
  return ['the value did not match the schema'];
}

/** What the adapter does with one response, before deciding whether to repair. */
export type StructuredAttempt<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused'; readonly category: string | null }
  | { readonly kind: 'truncated' }
  | { readonly kind: 'invalid'; readonly issues: string };

/**
 * Interpret one structured response.
 *
 * The stop reason is read **first** (`05` §3.5.3.4): a refusal's partial text must not be parsed,
 * and a `max_tokens` answer is truncated JSON that would fail to parse for a reason the caller
 * needs to tell apart from a schema mismatch.
 */
export function readStructured<T>(
  message: Message,
  schema: StructuredRequest<T>['schema'],
): StructuredAttempt<T> {
  const stop = readStop(message);
  if (stop.reason === 'refusal') {
    return { kind: 'refused', category: stop.category };
  }
  if (stop.reason === 'max_tokens') return { kind: 'truncated' };

  const text = firstTextBlock(message);
  if (text === undefined || text.trim() === '') {
    return { kind: 'invalid', issues: 'the response carried no text block to parse' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'invalid',
      issues: `the response is not JSON: ${error instanceof Error ? error.name : 'parse error'}`,
    };
  }

  // Re-validated through the caller's own zod type, not just against the wire schema. A provider
  // can return something schema-valid and semantically wrong — a date string that is not a date,
  // an enum member that was removed — and the zod type is where that is caught.
  const result = schema.safeParse(parsed);
  if (result.success) return { kind: 'ok', value: result.data };
  return { kind: 'invalid', issues: summariseIssues(result) };
}

/** Append the repair turn: the model's own answer, then the issues (`05` §3.5.3.3). */
export function withRepairTurn(
  params: AnthropicChatParams,
  message: Message,
  issues: string,
): AnthropicChatParams {
  return {
    ...params,
    messages: [
      ...params.messages,
      // The model's content goes back unchanged, which `01` §2.1 requires and which is also what
      // lets it see what it wrote.
      { role: 'assistant', content: message.content },
      { role: 'user', content: [{ type: 'text', text: invalidOutputEvent(issues) }] },
    ],
  };
}

/** Sum the usage of every attempt: a failed call is a billed call (`02` §3.3.7). */
export function mergeUsage(
  attempts: readonly Message[],
  requestedModel: string,
): readonly UsageIteration[] {
  return attempts.flatMap((message) => usageIterations(message, requestedModel));
}

/** The final result, from the last attempt's outcome and every attempt's usage. */
export function structuredResultOf<T>(
  attempt: StructuredAttempt<T>,
  usage: readonly UsageIteration[],
  message: Message,
): StructuredResult<T> {
  const model = message.model;
  switch (attempt.kind) {
    case 'ok':
      return { kind: 'ok', value: attempt.value, usage, model };
    case 'refused':
      return { kind: 'refused', category: attempt.category, usage, model };
    case 'truncated':
      return { kind: 'truncated', usage, model };
    case 'invalid':
      return { kind: 'invalid', issues: attempt.issues, usage, model };
  }
}

/** Whether the refusal fallback answered, for the trace. */
export function structuredServedByFallback(message: Message): boolean {
  return servedByFallback(message);
}
