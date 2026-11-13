/**
 * `structured()` on the OpenAI adapter (`05` §3.5.4; `M2-T11`).
 *
 * The outcome taxonomy and the one-repair rule are provider-independent (`01` §7.5, `05`
 * §3.5.3.3), so this file is deliberately thin: it builds a `text.format` request, reads the
 * answer, and reuses the shared issue-summarising and repair-prompt helpers from the Anthropic
 * path. Two implementations of "what counts as invalid" would eventually disagree, and the caller
 * would be retrying a prompt that will never validate on one provider and not the other.
 */
import type { StructuredRequest, StructuredResult, UsageIteration } from '@comvivo/core';
import type OpenAI from 'openai';
import {
  invalidOutputEvent,
  type StructuredAttempt,
  summariseIssues,
} from '../anthropic/structured.js';
import type { RouteBinding } from '../registry/resolve.js';
import { assertWireInvariants, EFFORT, instructionsOf, promptCacheKey } from './request.js';
import { readStop } from './response.js';

type ResponseParams = Omit<OpenAI.Responses.ResponseCreateParams, 'stream'>;
type Response = OpenAI.Responses.Response;

export interface BuildStructuredOptions {
  readonly binding: RouteBinding;
  readonly instanceId?: string;
}

/**
 * Build a structured request.
 *
 * Three differences from a chat request, each with a reason:
 *
 *  - **`text.format`** carrying the schema the caller already converted, with `strict: true`.
 *  - **No tools.** A structured route asks for one JSON value; a tool catalogue would sit in the
 *    cached prefix for no benefit and invite a call the caller has nowhere to put.
 *  - **No `include: ['reasoning.encrypted_content']`.** That exists so a *tool loop* can replay the
 *    model's reasoning between steps. A structured call is a single round trip, so asking for the
 *    encrypted blob would add bytes to a response nobody replays.
 */
export function buildStructuredRequest(
  req: StructuredRequest<unknown>,
  options: BuildStructuredOptions,
): { readonly params: ResponseParams } {
  const { binding } = options;
  const instructions = instructionsOf(req.system);

  const params: ResponseParams = {
    model: binding.model,
    input: [
      {
        role: 'user',
        content: req.input.flatMap((part) =>
          part.type === 'text' ? [{ type: 'input_text' as const, text: part.text }] : [],
        ),
      },
    ],
    max_output_tokens: req.maxOutputTokens,
    store: false,
    reasoning: { effort: EFFORT[req.effort] },
    text: {
      format: {
        type: 'json_schema',
        name: req.schemaName,
        strict: true,
        schema: req.jsonSchema as unknown as Record<string, unknown>,
      },
    },
    ...(instructions === undefined ? {} : { instructions }),
    ...(options.instanceId === undefined
      ? {}
      : { prompt_cache_key: promptCacheKey(options.instanceId, req.route) }),
  };

  assertWireInvariants(params);
  return { params };
}

/**
 * Interpret one structured response.
 *
 * The stop reason is read first, same as everywhere: a filtered answer's partial text must not be
 * parsed, and a truncated one is truncated JSON that would fail to parse for a reason the caller
 * has to tell apart from a schema mismatch.
 */
export function readStructured<T>(
  response: Response,
  schema: StructuredRequest<T>['schema'],
): StructuredAttempt<T> {
  const stop = readStop(response);
  if (stop.reason === 'refusal') {
    return { kind: 'refused', category: stop.category };
  }
  if (stop.reason === 'max_tokens') return { kind: 'truncated' };

  // `output_text` across every message item. A reasoning item carries no answer, which is why this
  // cannot be `output[0]`.
  const text = firstOutputText(response);
  if (text === undefined || text.trim() === '') {
    return { kind: 'invalid', issues: 'the response carried no text to parse' };
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

  // Re-validated through the caller's own zod type, not only against the wire schema: a provider
  // can return something schema-valid and semantically wrong, and the zod type is where that is
  // caught.
  const result = schema.safeParse(parsed);
  if (result.success) return { kind: 'ok', value: result.data };
  return { kind: 'invalid', issues: summariseIssues(result) };
}

/** The first `output_text`, skipping reasoning and any other item kind. */
export function firstOutputText(response: Response): string | undefined {
  for (const item of response.output) {
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message') return undefined;
    for (const content of item.content) {
      if (content.type === 'output_text') return content.text;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Append the repair turn: the model's own output items, then the issues.
 *
 * The items go back **unchanged** — `01` §2.1's rule, and also what lets the model see what it
 * wrote. On this provider that includes any reasoning item, which is the whole reason the output
 * array is kept whole rather than filtered to what we understand.
 */
export function withRepairTurn(
  params: ResponseParams,
  response: Response,
  issues: string,
): ResponseParams {
  const input = Array.isArray(params.input) ? params.input : [];
  return {
    ...params,
    input: [
      ...input,
      ...(response.output as OpenAI.Responses.ResponseInputItem[]),
      { role: 'user', content: invalidOutputEvent(issues) },
    ],
  };
}

/** The final result, from the last attempt's outcome and every attempt's usage. */
export function structuredResultOf<T>(
  attempt: StructuredAttempt<T>,
  usage: readonly UsageIteration[],
  model: string,
): StructuredResult<T> {
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
