/**
 * `structured()` on the local adapter (`05` §3.5.6; `M2-T12`).
 *
 * The outcome taxonomy and the one-repair rule are shared with the other three adapters, so this
 * file is the request shape plus a reader. What differs is the **strength of the constraint**: at
 * L2 the server honours a strict JSON schema, at L3 only `json_object`, and at L4 the structured
 * routes are off entirely (the adapter refuses before reaching here).
 */
import type { StructuredRequest } from '@comvivo/core';
import type OpenAI from 'openai';
import {
  invalidOutputEvent,
  type StructuredAttempt,
  summariseIssues,
} from '../anthropic/structured.js';
import type { RouteBinding } from '../registry/resolve.js';
import { type LadderLevel, LEVEL_BEHAVIOUR } from './ladder.js';
import { assertWireInvariants, operatorBlock } from './request.js';
import { readStop, visibleText } from './response.js';

type ChatParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, 'stream'>;
type Completion = OpenAI.Chat.Completions.ChatCompletion;

export interface BuildLocalStructuredOptions {
  readonly binding: RouteBinding;
  readonly level: LadderLevel;
  readonly reasoningEffortAccepted: boolean;
  readonly temperatureOverride?: number;
}

export interface BuiltLocalStructuredRequest {
  readonly params: ChatParams;
  /** The repair request, built from the failed attempt. `L3` only (`LEVEL_BEHAVIOUR`). */
  readonly repair: (completion: Completion, issues: string) => ChatParams;
}

/**
 * Build a structured request.
 *
 * The schema goes in `response_format` at whichever strength the level allows, and **also** into
 * the system message as text. That duplication is deliberate for the local path: a 12B model given
 * only a `json_object` constraint produces valid JSON of the wrong shape, and the shape written
 * out in the prompt is what gets it right often enough for one repair to be sufficient rather than
 * necessary.
 */
export function buildLocalStructuredRequest(
  req: StructuredRequest<unknown>,
  options: BuildLocalStructuredOptions,
): BuiltLocalStructuredRequest {
  const { binding, level } = options;
  const structured = LEVEL_BEHAVIOUR[level].structured;
  const schemaText = JSON.stringify(req.jsonSchema);
  const system = [
    req.system.map((block) => block.text).join('\n\n'),
    `Answer with a single JSON object and nothing else. It must match this schema:\n${schemaText}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n');

  const userText = req.input
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');

  const baseParams: ChatParams = {
    model: binding.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userText },
    ],
    // See `request.ts`: `max_tokens` is the field all four local servers implement, and the
    // deprecation is on OpenAI's own surface, where this adapter never points.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see request.ts
    max_tokens: req.maxOutputTokens,
    ...(structured === 'json_schema'
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: req.schemaName,
              strict: true,
              schema: req.jsonSchema as unknown as Record<string, unknown>,
            },
          },
        }
      : structured === 'json_object'
        ? { response_format: { type: 'json_object' as const } }
        : {}),
    ...(options.reasoningEffortAccepted
      ? {
          reasoning_effort:
            req.effort === 'low' ? 'low' : req.effort === 'medium' ? 'medium' : 'high',
        }
      : {}),
    ...(options.temperatureOverride === undefined
      ? {}
      : { temperature: options.temperatureOverride }),
  };

  assertWireInvariants(baseParams, options);

  return {
    params: baseParams,
    repair: (completion, issues): ChatParams => {
      const answered = visibleText(completion);
      const repaired: ChatParams = {
        ...baseParams,
        messages: [
          ...baseParams.messages,
          // The model's own answer goes back, then the issues — which is what makes a repair
          // different from a retry. As text, because there is no assistant-with-structure role
          // these servers would match.
          { role: 'assistant', content: answered === '' ? '(no answer)' : answered },
          { role: 'user', content: operatorBlock(invalidOutputEvent(issues)) },
        ],
      };
      assertWireInvariants(repaired, options);
      return repaired;
    },
  };
}

/**
 * Interpret one structured response.
 *
 * The stop reason first, as everywhere. The one local-specific tolerance is a **fenced** answer:
 * many chat templates wrap JSON in a code fence whatever the instruction said, and treating that
 * as invalid would send every L3 turn through a repair for a formatting habit.
 */
export function readLocalStructured<T>(
  completion: Completion,
  schema: StructuredRequest<T>['schema'],
): StructuredAttempt<T> {
  const stop = readStop(completion);
  if (stop.reason === 'refusal') return { kind: 'refused', category: stop.category };
  if (stop.reason === 'max_tokens') return { kind: 'truncated' };

  const text = visibleText(completion);
  if (text.trim() === '') {
    return { kind: 'invalid', issues: 'the response carried no text to parse' };
  }

  const candidate = unfence(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
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

/** The JSON inside a code fence, or the text unchanged. */
export function unfence(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}
