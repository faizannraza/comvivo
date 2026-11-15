/**
 * `structured()` on the Google adapter (`05` §3.5.5; `M2-T13`).
 *
 * Thin on purpose: the outcome taxonomy (`01` §7.5) and the one-repair rule (`05` §3.5.3.3) are
 * provider-independent, so the issue summariser and the repair-prompt tag are shared with the other
 * adapters. Two implementations of "what counts as invalid" would eventually disagree, and a caller
 * would retry on one provider a prompt that can never validate on either.
 */
import type { StructuredRequest, StructuredResult, UsageIteration } from '@comvivo/core';
import type { Content, GenerateContentConfig, GenerateContentResponse } from '@google/genai';
import {
  invalidOutputEvent,
  type StructuredAttempt,
  summariseIssues,
} from '../anthropic/structured.js';
import type { RouteBinding } from '../registry/resolve.js';
import { assertWireInvariants, THINKING_LEVEL } from './request.js';
import { partsOf, readStop, visibleText } from './response.js';

export interface BuildStructuredOptions {
  readonly binding: RouteBinding;
  readonly signal?: AbortSignal;
}

export interface BuiltStructuredRequest {
  readonly model: string;
  readonly contents: readonly Content[];
  readonly config: GenerateContentConfig;
}

/**
 * Build a structured request.
 *
 * `responseMimeType` **and** `responseJsonSchema`, which is how this provider says "one JSON value
 * of this shape". No tools and no `toolConfig`: a structured route asks for a value, and a tool
 * catalogue would sit in the implicit cache prefix for no benefit while inviting a call the caller
 * has nowhere to put.
 */
export function buildStructuredRequest(
  req: StructuredRequest<unknown>,
  options: BuildStructuredOptions,
): BuiltStructuredRequest {
  const { binding } = options;
  const instruction = req.system.map((block) => block.text).join('\n\n');
  const text = req.input.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

  const config: GenerateContentConfig = {
    maxOutputTokens: req.maxOutputTokens,
    thinkingConfig: { thinkingLevel: THINKING_LEVEL[req.effort] },
    responseMimeType: 'application/json',
    responseJsonSchema: req.jsonSchema,
    ...(instruction === '' ? {} : { systemInstruction: instruction }),
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
  };

  assertWireInvariants(config);
  return {
    model: binding.model,
    contents: [{ role: 'user', parts: [{ text }] }],
    config,
  };
}

/**
 * Interpret one structured response.
 *
 * The stop reason first, as everywhere: a blocked prompt's partial text must not be parsed, and a
 * truncated answer is truncated JSON that would fail to parse for a reason the caller has to tell
 * apart from a schema mismatch.
 */
export function readStructured<T>(
  response: GenerateContentResponse,
  schema: StructuredRequest<T>['schema'],
): StructuredAttempt<T> {
  const stop = readStop(response);
  if (stop.reason === 'refusal') return { kind: 'refused', category: stop.category };
  if (stop.reason === 'max_tokens') return { kind: 'truncated' };

  // Thought parts are filtered out by `visibleText`, which is what keeps a reasoning part from
  // being parsed as the answer.
  const text = visibleText(partsOf(response));
  if (text.trim() === '') {
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

  const result = schema.safeParse(parsed);
  if (result.success) return { kind: 'ok', value: result.data };
  return { kind: 'invalid', issues: summariseIssues(result) };
}

/**
 * Append the repair turn: the model's own parts, then the issues.
 *
 * The parts go back unchanged — `01` §2.1's rule, and on this provider also a hard requirement,
 * since a `model` content missing its `thoughtSignature` is a 400 on Gemini 3.
 */
export function withRepairTurn(
  contents: readonly Content[],
  response: GenerateContentResponse,
  issues: string,
): readonly Content[] {
  return [
    ...contents,
    { role: 'model', parts: [...partsOf(response)] },
    { role: 'user', parts: [{ text: invalidOutputEvent(issues) }] },
  ];
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
