/**
 * Building a Chat Completions request for a local server (`05` §3.5.6; `M2-T12`).
 *
 * ## Every omission here is a compatibility decision
 *
 * This is the one adapter whose request shape is governed by what the **weakest** of four servers
 * accepts, and `05` §3.5.6 enumerates them:
 *
 *  - **`tool_choice` is omitted.** Ollama does not support it. Sending it to be "explicit" would
 *    make Ollama the one server where every turn 400s.
 *  - **No mid-conversation system messages.** Many chat templates reject a system message that is
 *    not the first one, and a rejected template is a 400 with no useful text. So turn notes travel
 *    inside the **user** message as an escaped operator tag.
 *  - **`temperature` is omitted** unless a registry override sets it, which is both `01` §2.1's ban
 *    and the right default — a local model's sampler defaults are tuned by whoever packaged it.
 *  - **`reasoning_effort` is sent only if the probe accepted it.** Not "if the model looks like a
 *    reasoning model": the field is rejected outright by servers that do not know it.
 *
 * ## The system message comes first, and stays identical
 *
 * All four servers do server-side **KV prefix caching**, which is a byte-prefix match exactly like
 * a cloud prompt cache. So the charter and the group layer are one stable system message in
 * position zero, and everything per-turn goes after it. Getting this backwards does not fail — it
 * just re-processes the whole prompt on every turn, which on an 8 GB host is the difference between
 * a two-second reply and a twenty-second one.
 */

import type { ModelMessage, ModelTurnRequest, UserPart } from '@comvivo/core';
import { BRAND } from '@comvivo/shared';
import type OpenAI from 'openai';
import type { RouteBinding } from '../registry/resolve.js';
import { ENVELOPE_SCHEMA_NAME, envelopeInstruction, envelopeSchema } from './envelope.js';
import { type LadderLevel, LEVEL_BEHAVIOUR } from './ladder.js';

type ChatParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, 'stream'>;
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Request keys this adapter must never send.
 *
 * `tool_choice` is on the list for a **compatibility** reason rather than a policy one, which is
 * worth distinguishing: the other three are `01` §2.1's ban, and this one is Ollama's limitation.
 * Both end in the same assertion.
 */
export const FORBIDDEN_REQUEST_KEYS: readonly string[] = ['top_p', 'top_k', 'tool_choice', 'user'];

export class WireInvariantError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`the built local request breaks 01 §2.1 or 05 §3.5.6:\n  - ${violations.join('\n  - ')}`);
    this.name = 'WireInvariantError';
    this.violations = violations;
  }
}

export interface BuildLocalOptions {
  readonly binding: RouteBinding;
  readonly level: LadderLevel;
  /** From the probe. When false, `reasoning_effort` is omitted (`05` §3.5.6). */
  readonly reasoningEffortAccepted: boolean;
  /** A registry override's `temperature`, which is the only way one is ever sent. */
  readonly temperatureOverride?: number;
}

export interface BuiltLocalRequest {
  readonly params: ChatParams;
  readonly transformations: number;
  /** True when the tool catalogue went into the prompt as text rather than as `tools`. */
  readonly envelope: boolean;
}

/**
 * The operator tag, escaped.
 *
 * Same construction and same reason as the Google adapter: a member who types the closing tag into
 * a group chat must not be able to close ours and have the rest of their message read as operator
 * instruction. Derived from `BRAND.slug` because it sits in the cached prefix.
 */
export function operatorBlock(text: string): string {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<${BRAND.slug}_operator>${escaped}</${BRAND.slug}_operator>`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** A user part as Chat Completions content. Tool results are separate messages. */
function contentPartOf(
  part: UserPart,
  vision: boolean,
): OpenAI.Chat.Completions.ChatCompletionContentPart | undefined {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      // Dropped rather than sent when the model is text-only: a local server handed an image part
      // it cannot use either 400s or silently ignores it, and the second is worse — the turn reads
      // as if the picture was understood.
      return vision
        ? {
            type: 'image_url',
            image_url: { url: `data:${part.mime};base64,${bytesToBase64(part.data)}` },
          }
        : undefined;
    case 'document':
      // No local server in `05` §3.5.6's list accepts a PDF part on Chat Completions.
      return undefined;
    case 'tool_result':
      return undefined;
  }
}

/**
 * A user turn: pending operator text, then the member's own content.
 *
 * That order is `05` §3.5.6's request shape and the one that puts the instruction before the thing
 * it is about. `dropped` counts the media parts this model cannot take, which is a transformation
 * the trace reports rather than a silent omission.
 */
function userMessage(
  parts: readonly UserPart[],
  pendingOperator: readonly string[],
  vision: boolean,
): { readonly message: ChatMessage | undefined; readonly dropped: number } {
  let dropped = 0;
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

  const operator = pendingOperator.join('\n');
  if (operator !== '') content.push({ type: 'text', text: operator });

  for (const part of parts) {
    const rendered = contentPartOf(part, vision);
    if (rendered === undefined) {
      if (part.type === 'image') dropped += 1;
      continue;
    }
    content.push(rendered);
  }

  return { message: content.length > 0 ? { role: 'user', content } : undefined, dropped };
}

/**
 * Render our messages for a local server.
 *
 * The transformation count is the honest record of what had to be given up: a dropped image, a
 * mid-conversation system message folded into a user turn, an assistant turn rebuilt from its view.
 * `11` §12-1 puts that number in the trace, which is how a host asking "why is my local bot worse"
 * gets an answer other than a shrug.
 */
/** An assistant turn, rebuilt from the typed view. */
function assistantMessage(
  message: Extract<ModelMessage, { readonly role: 'assistant' }>,
  native: boolean,
): ChatMessage {
  const text = message.view.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  const calls = message.view.flatMap((part) =>
    part.type === 'tool_call'
      ? [
          {
            id: part.id,
            type: 'function' as const,
            function: { name: part.name, arguments: JSON.stringify(part.input) },
          },
        ]
      : [],
  );
  // Always rebuilt from the view: there is no opaque provider state on these servers to replay, so
  // this is not a degradation and is not counted.
  return {
    role: 'assistant',
    content: text === '' ? null : text,
    ...(calls.length === 0 || !native ? {} : { tool_calls: calls }),
  };
}

/** The operator text a system message becomes. */
function operatorTextOf(message: Extract<ModelMessage, { readonly role: 'system' }>): string {
  return operatorBlock(
    message.kind === 'effort' ? `Reasoning effort for this turn: ${message.effort}.` : message.text,
  );
}

/** One tool result, as the level allows it to travel. */
function toolResultMessage(
  part: Extract<UserPart, { readonly type: 'tool_result' }>,
  native: boolean,
): ChatMessage {
  if (native) return { role: 'tool', tool_call_id: part.toolCallId, content: part.content };
  // On the envelope levels there is no `tool` role the server will match to a call, so the result
  // comes back as user text naming it.
  return {
    role: 'user',
    content: operatorBlock(
      `Result of ${part.toolCallId}${part.isError ? ' (error)' : ''}: ${part.content}`,
    ),
  };
}

/**
 * Render our messages for a local server.
 *
 * The transformation count is the honest record of what had to be given up: a dropped image, a
 * mid-conversation system message folded into a user turn, a tool result the model has to re-read
 * from text. `11` §12-1 puts that number in the trace, which is how a host asking "why is my local
 * bot worse" gets an answer other than a shrug.
 *
 * The per-message work is in the four helpers above, which is what keeps this loop readable — and
 * what `noExcessiveCognitiveComplexity` was right to insist on at 35.
 */
export function messagesOf(
  req: ModelTurnRequest,
  options: { readonly level: LadderLevel; readonly vision: boolean },
): { readonly messages: readonly ChatMessage[]; readonly transformations: number } {
  const native = LEVEL_BEHAVIOUR[options.level].tools === 'native';
  const messages: ChatMessage[] = [];
  let transformations = 0;

  // Position zero, and stable. Everything the server can KV-cache goes here and nothing else does.
  const system = [
    req.system.map((block) => block.text).join('\n\n'),
    ...(LEVEL_BEHAVIOUR[options.level].tools === 'envelope'
      ? [envelopeInstruction(req.tools)]
      : []),
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  if (system !== '') messages.push({ role: 'system', content: system });

  // Pending operator text, flushed into the **next** user message rather than sent as a second
  // system message. `05` §3.5.6: many chat templates reject one.
  let pendingOperator: string[] = [];

  for (const message of req.messages) {
    if (message.role === 'system') {
      transformations += 1;
      pendingOperator.push(operatorTextOf(message));
      continue;
    }
    if (message.role === 'assistant') {
      messages.push(assistantMessage(message, native));
      continue;
    }

    const results = message.content.filter(
      (part): part is Extract<UserPart, { readonly type: 'tool_result' }> =>
        part.type === 'tool_result',
    );
    const other = message.content.filter((part) => part.type !== 'tool_result');

    if (other.length > 0 || pendingOperator.length > 0) {
      const rendered = userMessage(other, pendingOperator, options.vision);
      pendingOperator = [];
      transformations += rendered.dropped;
      if (rendered.message !== undefined) messages.push(rendered.message);
    }

    for (const part of results) {
      if (!native) transformations += 1;
      messages.push(toolResultMessage(part, native));
    }
  }

  // Operator text with no following user turn still has to reach the model.
  if (pendingOperator.length > 0) {
    messages.push({ role: 'user', content: pendingOperator.join('\n') });
  }

  return { messages, transformations };
}

/** Build one chat request. */
export function buildLocalRequest(
  req: ModelTurnRequest,
  options: BuildLocalOptions,
): BuiltLocalRequest {
  const { binding, level } = options;
  const behaviour = LEVEL_BEHAVIOUR[level];
  const { messages, transformations } = messagesOf(req, {
    level,
    vision: binding.features.vision,
  });

  const params: ChatParams = {
    model: binding.model,
    messages: [...messages],
    // `max_tokens` and **not** `max_completion_tokens`, which OpenAI now prefers. This adapter is
    // governed by what the weakest of four servers accepts (`05` §3.5.6), and `max_tokens` is the
    // field Ollama, LM Studio, llama.cpp and vLLM all implement. Sending the newer name would make
    // the output limit silently unenforced on the servers that ignore an unknown field, and a 400
    // on the ones that do not — which is the whole failure mode this file exists to avoid. The
    // deprecation is OpenAI's own surface, where this adapter never points.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
    max_tokens: req.maxOutputTokens,
    ...(behaviour.tools === 'native' && req.tools.length > 0
      ? {
          tools: req.tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema as unknown as Record<string, unknown>,
              strict: true,
            },
          })),
        }
      : {}),
    ...(behaviour.tools === 'envelope' ? envelopeFormat(req, behaviour.structured) : {}),
    ...(options.reasoningEffortAccepted ? { reasoning_effort: effortFor(req.effort) } : {}),
    ...(options.temperatureOverride === undefined
      ? {}
      : { temperature: options.temperatureOverride }),
  };

  assertWireInvariants(params, options);
  return { params, transformations, envelope: behaviour.tools === 'envelope' };
}

/** The `response_format` that constrains the envelope, at whichever strength the level allows. */
function envelopeFormat(
  req: ModelTurnRequest,
  structured: 'json_schema' | 'json_object' | 'none',
): Partial<ChatParams> {
  if (structured === 'json_schema') {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: ENVELOPE_SCHEMA_NAME,
          strict: true,
          schema: envelopeSchema(req.tools) as unknown as Record<string, unknown>,
        },
      },
    };
  }
  if (structured === 'json_object') return { response_format: { type: 'json_object' } };
  return {};
}

/**
 * Our effort as this field's values.
 *
 * `reasoning_effort` on an OpenAI-compatible server accepts the three OpenAI levels. Our `xhigh`
 * and `max` round **up** to `high`, same reasoning as the Google adapter: a route that asked for
 * more thinking and silently got less makes a cross-provider comparison meaningless.
 */
function effortFor(effort: ModelTurnRequest['effort']): 'low' | 'medium' | 'high' {
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  return 'high';
}

/** Assert `01` §2.1 and `05` §3.5.6's compatibility rules over a built request. */
export function assertWireInvariants(
  params: ChatParams,
  options: Pick<BuildLocalOptions, 'temperatureOverride'>,
): void {
  const violations: string[] = [];
  const bag = params as Readonly<Record<string, unknown>>;

  for (const key of FORBIDDEN_REQUEST_KEYS) {
    if (bag[key] === undefined) continue;
    violations.push(
      key === 'tool_choice'
        ? '`tool_choice` must be omitted: Ollama does not support it (05 §3.5.6)'
        : `"${key}" must never be sent (01 §2.1)`,
    );
  }

  // `temperature` is allowed **only** when a registry override asked for it. Checked against the
  // option rather than merely allowed, so a stray `temperature` from some other path is still a
  // violation of `01` §2.1.
  if (params.temperature !== undefined && options.temperatureOverride === undefined) {
    violations.push('`temperature` is only sent when a registry override sets it (01 §2.1)');
  }

  // Exactly one system message, in position zero. `05` §3.5.6: many chat templates reject any
  // other arrangement, and the failure is a 400 with no useful text.
  const systems = params.messages.filter((message) => message.role === 'system');
  if (systems.length > 1) {
    violations.push(
      `there must be at most one system message and it must be first; found ${String(systems.length)} (05 §3.5.6)`,
    );
  }
  if (systems.length === 1 && params.messages[0]?.role !== 'system') {
    violations.push('the system message must be the first message (05 §3.5.6)');
  }

  for (const tool of params.tools ?? []) {
    if (tool.type === 'function' && tool.function.strict !== true) {
      violations.push(`tool "${tool.function.name}" must be strict (01 §2.1)`);
    }
  }

  // Prefill: an assistant message last is the model being told how to begin. These servers
  // **accept** it — the registry row says `prefill: true` — which is exactly why it has to be
  // refused here rather than relied on to fail.
  if (params.messages.at(-1)?.role === 'assistant') {
    violations.push('the last message must not be an assistant turn (no prefill, 01 §2.1)');
  }

  if (violations.length > 0) throw new WireInvariantError(violations);
}
