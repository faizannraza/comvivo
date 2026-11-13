/**
 * Reading a `generateContent` response (`05` §3.5.5; `M2-T13`).
 *
 * ## `finishReason` has twenty members, not seven
 *
 * `05` §3.5.5 maps five of them. Measured against `@google/genai` 3.0.0 on 2026-11-13 the enum has
 * **twenty**, and three of the new ones are not failures of the kind the spec's table implies:
 *
 *  - **`UNEXPECTED_TOOL_CALL`** and **`TOO_MANY_TOOL_CALLS`** are tool-loop control, not refusals.
 *    Reading either as a refusal would tell a group the bot declined when it did not.
 *  - **`CONTINUATION`** means the response hit a per-request token limit and **can be continued**
 *    with the returned continuation token. That is the same control flow as Anthropic's
 *    `pause_turn`, and reading it as a finished turn silently truncates the answer.
 *
 * The mapping below is a **total** `Record` over the enum, so a member Google adds next is a
 * compile error here rather than a silent `other`.
 *
 * ## Thought signatures are opaque and must survive
 *
 * A `Part` can carry `thoughtSignature`, and Gemini 3 rejects a function-call turn that comes back
 * without it. So `raw` is the model's **whole `parts` array** and the typed view reports a
 * signature only as `opaque` — giving it a readable home is how model reasoning ends up in a
 * disclosure guard's log (`08` §3.16).
 */

import type { AssistantMessage, AssistantPart, StopInfo, UsageIteration } from '@comvivo/core';
import {
  type Candidate,
  FinishReason,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';

export const GOOGLE_PROVIDER = 'google' as const;

/** How a finish reason maps, before the tool-call and block checks refine it. */
type Mapped = 'end_turn' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other' | 'retryable_tool';

/**
 * Every `FinishReason`, mapped.
 *
 * A total `Record` rather than a `switch` with a default: the house idiom (`shared/assert-never.ts`)
 * is that a mapping over a closed union requires every key, so a member added by an SDK bump is a
 * compile error. Getting one wrong in the permissive direction shows a group a truncated answer as
 * if it were complete; in the strict direction it reports a refusal that never happened.
 */
export const FINISH_REASON_MAP: Readonly<Record<FinishReason, Mapped>> = {
  [FinishReason.FINISH_REASON_UNSPECIFIED]: 'other',
  [FinishReason.STOP]: 'end_turn',
  [FinishReason.MAX_TOKENS]: 'max_tokens',
  // The five content-policy reasons `05` §3.5.5 names.
  [FinishReason.SAFETY]: 'refusal',
  [FinishReason.RECITATION]: 'refusal',
  [FinishReason.BLOCKLIST]: 'refusal',
  [FinishReason.PROHIBITED_CONTENT]: 'refusal',
  [FinishReason.SPII]: 'refusal',
  // Image-generation policy stops. We do not generate images, but mapping them to `refusal` is
  // right if we ever do, and leaving them unmapped would be a compile error now rather than a
  // surprise then.
  [FinishReason.IMAGE_SAFETY]: 'refusal',
  [FinishReason.IMAGE_PROHIBITED_CONTENT]: 'refusal',
  [FinishReason.IMAGE_RECITATION]: 'refusal',
  [FinishReason.LANGUAGE]: 'refusal',
  // Not a refusal: the model produced a call we cannot use. `05` §3.5.5 says retry the step once,
  // which is the caller's decision — the adapter reports the kind and does not retry itself.
  [FinishReason.MALFORMED_FUNCTION_CALL]: 'retryable_tool',
  [FinishReason.UNEXPECTED_TOOL_CALL]: 'retryable_tool',
  [FinishReason.MALFORMED_RESPONSE]: 'retryable_tool',
  // Tool-loop control, not a refusal and not a finished turn.
  [FinishReason.TOO_MANY_TOOL_CALLS]: 'other',
  // Continuable: the same control flow as Anthropic's `pause_turn`.
  [FinishReason.CONTINUATION]: 'pause_turn',
  [FinishReason.NO_IMAGE]: 'other',
  [FinishReason.IMAGE_OTHER]: 'other',
  [FinishReason.OTHER]: 'other',
};

function firstCandidate(response: GenerateContentResponse): Candidate | undefined {
  return response.candidates?.[0];
}

/** The parts of the first candidate, or an empty list. */
export function partsOf(response: GenerateContentResponse): readonly Part[] {
  return firstCandidate(response)?.content?.parts ?? [];
}

/**
 * Why the response stopped.
 *
 * `promptFeedback.blockReason` is checked **first**: a blocked prompt produces no candidate at all,
 * so a reader that looked at `finishReason` would see `undefined` and report a finished turn with
 * no text.
 */
export function readStop(response: GenerateContentResponse): StopInfo {
  const blocked = response.promptFeedback?.blockReason;
  if (blocked !== undefined) {
    return {
      reason: 'refusal',
      raw: `blocked:${blocked}`,
      // Already a string enum; `String()` round-tripping it is a no-op the linter rightly refuses.
      category: blocked,
      servedByFallback: false,
    };
  }

  const candidate = firstCandidate(response);
  const finish = candidate?.finishReason;
  if (finish === undefined) {
    // No candidate and no block reason. Not a finished turn, and not something to report as one.
    return { reason: 'other', raw: 'no_candidate' };
  }

  const mapped = FINISH_REASON_MAP[finish];
  const raw: string = finish;
  switch (mapped) {
    case 'refusal':
      return {
        reason: 'refusal',
        raw,
        category: raw,
        ...(candidate?.finishMessage === undefined ? {} : { explanation: candidate.finishMessage }),
        servedByFallback: false,
      };
    case 'max_tokens':
      return { reason: 'max_tokens', raw };
    case 'pause_turn':
      return { reason: 'pause_turn', raw };
    case 'retryable_tool':
    case 'other':
      return { reason: 'other', raw };
    case 'end_turn':
      // `STOP` with function-call parts is a tool round trip, not a finished turn.
      return hasFunctionCall(partsOf(response))
        ? { reason: 'tool_use', raw }
        : { reason: 'end_turn', raw };
  }
}

function hasFunctionCall(parts: readonly Part[]): boolean {
  return parts.some((part) => part.functionCall !== undefined);
}

/**
 * Whether the caller should retry this step once (`05` §3.5.5).
 *
 * Exported rather than acted on here: the adapter reports, and `M3`'s tool loop decides. An adapter
 * that silently retried would hide a model producing malformed calls repeatedly, and would spend a
 * group's budget doing it.
 */
export function isRetryableToolFailure(response: GenerateContentResponse): boolean {
  const finish = firstCandidate(response)?.finishReason;
  return finish !== undefined && FINISH_REASON_MAP[finish] === 'retryable_tool';
}

/** Visible text: every non-thought `text` part, in order. */
export function visibleText(parts: readonly Part[]): string {
  return parts
    .filter((part) => part.thought !== true && part.text !== undefined)
    .map((part) => part.text ?? '')
    .join('');
}

export interface ParsedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Tool calls.
 *
 * `functionCall.id` is optional on this provider. When it is absent the name plus the position is
 * the only stable handle, so one is synthesised — a `functionResponse` has to carry *something*
 * the model can match, and an empty id matches nothing.
 */
export function toolCallsOf(parts: readonly Part[]): readonly ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const [index, part] of parts.entries()) {
    const call = part.functionCall;
    if (call === undefined) continue;
    calls.push({
      id: call.id ?? `${call.name ?? 'call'}_${String(index)}`,
      name: call.name ?? '',
      input: call.args ?? {},
    });
  }
  return calls;
}

/** Which `AssistantPart` a Gemini part becomes in the engine's typed view. */
function viewPartOf(part: Part, index: number): readonly AssistantPart[] {
  // A thought signature is checked **before** text, because a part can carry both and the
  // signature is the half that must not be readable.
  if (part.thoughtSignature !== undefined) return [{ type: 'opaque', kind: 'thought_signature' }];
  if (part.thought === true) return [{ type: 'opaque', kind: 'reasoning' }];
  if (part.functionCall !== undefined) {
    return [
      {
        type: 'tool_call',
        id: part.functionCall.id ?? `${part.functionCall.name ?? 'call'}_${String(index)}`,
        name: part.functionCall.name ?? '',
        input: part.functionCall.args ?? {},
      },
    ];
  }
  if (part.text !== undefined) return [{ type: 'text', text: part.text }];
  return [{ type: 'opaque', kind: 'other' }];
}

/**
 * The assistant message.
 *
 * `raw` is the **parts array**, which is what `contentsOf` replays inside a `model` content.
 * Storing the whole response would replay `usageMetadata` and `responseId` as parts, which the API
 * rejects.
 */
export function assistantMessageOf(
  response: GenerateContentResponse,
  requestedModel: string,
): AssistantMessage {
  const parts = partsOf(response);
  return {
    role: 'assistant',
    provider: GOOGLE_PROVIDER,
    servedModel: response.modelVersion ?? requestedModel,
    raw: parts,
    view: parts.flatMap((part, index) => viewPartOf(part, index)),
  };
}

/**
 * Usage, as one billed iteration.
 *
 * Measured against 3.0.0: `usageMetadata` carries `promptTokenCount`, `cachedContentTokenCount`,
 * `candidatesTokenCount`, `thoughtsTokenCount` **and `toolUsePromptTokenCount`**, the last of which
 * `05` §3.5.5 does not mention and which is billed input for server-side tool prompts.
 *
 * `promptTokenCount` **includes** the cached tokens, as on OpenAI, so `input` is the remainder.
 * There is no cache-write category: Gemini's caching is implicit and the write is not billed
 * separately, so both write columns are zero — which is a fact about the provider rather than a
 * gap in the mapping, and the test says so.
 *
 * Thoughts are billed as **output** and are reported *within* `candidatesTokenCount`... except that
 * Gemini reports them separately and does **not** include them, so `output` is the sum. Adding them
 * is what makes the bill match: a turn that spent 2,000 tokens thinking and 50 answering is billed
 * for 2,050.
 */
export function usageIterationOf(
  response: GenerateContentResponse,
  requestedModel: string,
): readonly UsageIteration[] {
  const usage = response.usageMetadata;
  if (usage === undefined) return [];

  const cacheRead = usage.cachedContentTokenCount ?? 0;
  const prompt = usage.promptTokenCount ?? 0;
  const toolPrompt = usage.toolUsePromptTokenCount ?? 0;
  const thoughts = usage.thoughtsTokenCount ?? 0;
  const candidates = usage.candidatesTokenCount ?? 0;

  return [
    {
      model: response.modelVersion ?? requestedModel,
      kind: 'message',
      input: Math.max(0, prompt - cacheRead) + toolPrompt,
      cacheRead,
      // Implicit caching: there is no billed write category on this provider.
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: candidates + thoughts,
      ...(thoughts === 0 ? {} : { reasoning: thoughts }),
      batch: false,
    },
  ];
}
