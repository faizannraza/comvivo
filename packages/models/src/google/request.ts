/**
 * Building a `generateContent` request (`05` §3.5.5; `M2-T13`).
 *
 * ## Why `generateContent` and not Interactions (D19)
 *
 * Google calls Interactions GA and recommends it for new projects, but it **stores interactions by
 * default** — 55 days on the paid tier — and its stateless mode drops the server-side state
 * features that are its reason to exist. `generateContent` is stateless, fully supported, and
 * documents thought-signature replay for manual histories, which is what a product that promises a
 * family their messages are not left on a provider's disk needs (`08` §3.11). Revisit after 1.0.
 *
 * ## The thought signature is not optional
 *
 * Gemini 3 **rejects a function-call turn whose `thoughtSignature` is missing with a 400**. So the
 * assistant `Content` goes back with every part unchanged, signatures included. This is the same
 * verbatim-replay rule as the other two adapters, with the difference that here the provider
 * enforces it: an adapter that filtered parts does not degrade, it fails.
 *
 * ## Facts measured against @google/genai 3.0.0 on 2026-11-13, not recalled
 *
 *  - `ThinkingLevel` is `MINIMAL | LOW | MEDIUM | HIGH` (plus `THINKING_LEVEL_UNSPECIFIED`) —
 *    **upper-case**, and with no `XHIGH` or `MAX`. `05` §3.5.5 writes it lower-case.
 *  - `FunctionCallingConfigMode` has five members, and `VALIDATED` is new.
 *  - `FunctionDeclaration` takes `parametersJsonSchema` (an unconstrained `unknown`) beside the
 *    older typed `parameters: Schema`.
 *  - `config` carries `abortSignal` and `httpOptions.timeout` directly, which `05` §3.5.5 asked to
 *    be verified at implementation time. Both names are as written.
 *  - `temperature`, `topP` and `topK` all exist on `GenerateContentConfig`, so `01` §2.1's ban is a
 *    runtime assertion here as it is for OpenAI.
 */

import type { Effort, ModelMessage, ModelTurnRequest, ToolSpec, UserPart } from '@comvivo/core';
import { BRAND } from '@comvivo/shared';
import type { Content, FunctionDeclaration, GenerateContentConfig, Part } from '@google/genai';
import { FunctionCallingConfigMode, ThinkingLevel } from '@google/genai';
import type { RouteBinding } from '../registry/resolve.js';

/** What `generateContent` is called with, minus the model the caller supplies. */
export interface BuiltGenerateContentRequest {
  readonly model: string;
  readonly contents: readonly Content[];
  readonly config: GenerateContentConfig;
  readonly transformations: number;
}

/**
 * Config keys this adapter must never set.
 *
 * `01` §2.1 bans the three sampling parameters. They all exist on `GenerateContentConfig`, so — as
 * on OpenAI and unlike Anthropic — the ban has to be checked rather than relied on.
 */
export const FORBIDDEN_CONFIG_KEYS: readonly string[] = ['temperature', 'topP', 'topK'];

export class WireInvariantError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`the built Google request breaks 01 §2.1:\n  - ${violations.join('\n  - ')}`);
    this.name = 'WireInvariantError';
    this.violations = violations;
  }
}

/**
 * Effort → `thinkingLevel`.
 *
 * A total mapping over our `Effort`, so adding a level is a compile error here rather than a 400.
 * Gemini offers four levels and we have five: **`xhigh` and `max` both land on `HIGH`**, which is
 * the ceiling this provider offers. Rounding up rather than down is the right direction — a route
 * asked for more thinking, and giving it less silently would make a cross-provider eval compare
 * two different questions.
 */
export const THINKING_LEVEL: Readonly<Record<Effort, ThinkingLevel>> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
};

/**
 * The tag that wraps a mid-conversation operator message.
 *
 * Gemini has no developer role, so turn notes travel as a **user** part wrapped in a tag the model
 * is told to treat as operator text. The tag is derived from `BRAND.slug` rather than written out:
 * it sits in the cached prefix, so hard-coding it would mean a product rename invalidated every
 * cached prompt on every instance.
 *
 * The content is escaped, which is the part that matters for safety: a member who types
 * `</comvivo_operator>` into a group chat must not be able to close the tag and have the rest of
 * their message read as operator instruction (`01` §11, prompt injection).
 */
export function operatorPart(text: string): string {
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

/** A user part as a Gemini `Part`. Tool results are handled by `contentsOf`. */
function partOf(part: UserPart): Part | undefined {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'image':
      return { inlineData: { mimeType: part.mime, data: bytesToBase64(part.data) } };
    case 'document':
      return { inlineData: { mimeType: part.mime, data: bytesToBase64(part.data) } };
    case 'tool_result':
      return undefined;
  }
}

/**
 * A tool result as a `functionResponse` part.
 *
 * The `response` object uses the documented `output` / `error` keys. There is no `is_error` flag on
 * this provider, so a failure is `{ error: … }` — which is more than the other two adapters get and
 * is worth using: a model that is told the call failed retries differently from one handed an error
 * string in the success slot.
 */
function toolResultPart(part: Extract<UserPart, { readonly type: 'tool_result' }>): Part {
  return {
    functionResponse: {
      id: part.toolCallId,
      // `name` is required by the API and we do not carry it on a tool result, so the id stands in.
      // The id is what the model matches on; the name is informational here.
      name: part.toolCallId,
      response: part.isError ? { error: part.content } : { output: part.content },
    },
  };
}

/**
 * Render our messages as Gemini `Content`s.
 *
 * Gemini alternates `user` and `model` roles and has no system role inside `contents`, so:
 *
 *  - an assistant turn becomes a `model` content whose parts are replayed **unchanged** when we
 *    have them (the thought-signature rule above), and are rebuilt from the typed view otherwise —
 *    counted as a transformation, because a rebuilt turn has lost its signatures and the next
 *    function call will 400;
 *  - turn notes become a `user` content carrying the escaped operator tag;
 *  - tool results become `functionResponse` parts, **all in one `user` content**, which `01` §2.1
 *    requires of every adapter.
 */
export function contentsOf(messages: readonly ModelMessage[]): {
  readonly contents: readonly Content[];
  readonly transformations: number;
} {
  const contents: Content[] = [];
  let transformations = 0;

  // Dispatched through three named helpers rather than three inline branches: the function is
  // otherwise over `noExcessiveCognitiveComplexity`'s limit, and the three cases genuinely are
  // three different renderings rather than variations on one.
  for (const message of messages) {
    if (message.role === 'system') {
      contents.push(operatorContent(message));
      continue;
    }
    if (message.role === 'assistant') {
      const rendered = assistantContent(message);
      if (rendered.lossy) transformations += 1;
      contents.push(rendered.content);
      continue;
    }
    const user = userContent(message);
    if (user !== undefined) contents.push(user);
  }

  return { contents, transformations };
}

/** A mid-conversation operator message. Gemini has no developer role, so it travels as user text. */
function operatorContent(message: Extract<ModelMessage, { readonly role: 'system' }>): Content {
  const text =
    message.kind === 'effort' ? `Reasoning effort for this turn: ${message.effort}.` : message.text;
  return { role: 'user', parts: [{ text: operatorPart(text) }] };
}

/**
 * An assistant turn.
 *
 * `lossy` is the signal the caller counts: a turn rebuilt from the typed view has **lost its
 * thought signatures**, and the next function call on this provider is a 400. That is worth a
 * number in the trace rather than a silent degradation.
 */
function assistantContent(message: Extract<ModelMessage, { readonly role: 'assistant' }>): {
  readonly content: Content;
  readonly lossy: boolean;
} {
  const raw = message.raw;
  if (Array.isArray(raw) && raw.length > 0) {
    return { content: { role: 'model', parts: raw as Part[] }, lossy: false };
  }
  return { content: { role: 'model', parts: viewAsParts(message.view) }, lossy: true };
}

/** A user turn: media parts and tool results, all in **one** content (`01` §2.1). */
function userContent(
  message: Extract<ModelMessage, { readonly role: 'user' }>,
): Content | undefined {
  const parts: Part[] = [];
  for (const part of message.content) {
    const rendered = part.type === 'tool_result' ? toolResultPart(part) : partOf(part);
    if (rendered !== undefined) parts.push(rendered);
  }
  return parts.length > 0 ? { role: 'user', parts } : undefined;
}

type AssistantView = Extract<ModelMessage, { readonly role: 'assistant' }>['view'];

/** The lossy fallback. Opaque parts carry no bytes, so a replayed signature is gone with them. */
function viewAsParts(view: AssistantView): Part[] {
  const parts: Part[] = [];
  for (const part of view) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
      continue;
    }
    if (part.type === 'tool_call') {
      parts.push({
        functionCall: {
          id: part.id,
          name: part.name,
          args: part.input as Record<string, unknown>,
        },
      });
    }
  }
  return parts;
}

/**
 * Tools, as function declarations.
 *
 * `parametersJsonSchema` and not the older typed `parameters: Schema`: our schemas are already
 * strict JSON Schema from `M2-T4`'s converter, and round-tripping them through Google's own
 * `Schema` type would be a second conversion with its own opinions about what survives.
 */
export function functionDeclarationsOf(tools: readonly ToolSpec[]): readonly FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  }));
}

export interface BuildOptions {
  readonly binding: RouteBinding;
  readonly signal?: AbortSignal;
}

/** Build one chat request. */
export function buildGenerateContentRequest(
  req: ModelTurnRequest,
  options: BuildOptions,
): BuiltGenerateContentRequest {
  const { binding } = options;
  const { contents, transformations } = contentsOf(req.messages);
  const instruction = req.system.map((block) => block.text).join('\n\n');

  const config: GenerateContentConfig = {
    maxOutputTokens: req.maxOutputTokens,
    thinkingConfig: { thinkingLevel: THINKING_LEVEL[req.effort] },
    toolConfig: {
      functionCallingConfig: {
        // `AUTO` or `NONE` only. `ANY` and `VALIDATED` are the forced forms `01` §2.1 bans.
        mode:
          req.toolChoice === 'none'
            ? FunctionCallingConfigMode.NONE
            : FunctionCallingConfigMode.AUTO,
      },
    },
    httpOptions: { timeout: binding.attemptTimeoutMs },
    ...(instruction === '' ? {} : { systemInstruction: instruction }),
    ...(req.tools.length === 0
      ? {}
      : { tools: [{ functionDeclarations: [...functionDeclarationsOf(req.tools)] }] }),
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
  };

  assertWireInvariants(config);
  return { model: binding.model, contents, config, transformations };
}

/**
 * Assert `01` §2.1 over a built config.
 *
 * Over the built value rather than the call site, so the rule holds for every path that reaches the
 * wire — including one somebody adds later without reading this file.
 */
export function assertWireInvariants(config: GenerateContentConfig): void {
  const violations: string[] = [];
  // A read-through view. `GenerateContentConfig` is a closed interface, so reading a forbidden
  // key by name needs the widening — which is exactly the point: the check must see keys the type
  // says cannot be there, because a caller spreading an untyped object can put them there.
  const bag = config as Readonly<Record<string, unknown>>;

  for (const key of FORBIDDEN_CONFIG_KEYS) {
    if (bag[key] !== undefined) violations.push(`"${key}" must never be sent (01 §2.1)`);
  }

  // An allowlist, as on OpenAI: `FunctionCallingConfigMode` has five members and `VALIDATED` was
  // added after `05` §3.5.5 was written. A denylist would have to be updated for every new one.
  const mode = config.toolConfig?.functionCallingConfig?.mode;
  if (
    mode !== undefined &&
    mode !== FunctionCallingConfigMode.AUTO &&
    mode !== FunctionCallingConfigMode.NONE
  ) {
    violations.push(
      `function calling mode must be AUTO or NONE, never forced (01 §2.1); got ${mode}`,
    );
  }

  // Prefill: a `model` content in the final position is the model being told how to begin. Checked
  // by the caller, which holds the contents — see `buildGenerateContentRequest`'s caller in
  // `adapter.ts`. Kept here as a named export so the contract suite can assert it directly.
  if (violations.length > 0) throw new WireInvariantError(violations);
}

/** `01` §2.1's no-prefill rule over the contents array. */
export function assertNoPrefill(contents: readonly Content[]): void {
  const last = contents.at(-1);
  if (last?.role === 'model') {
    throw new WireInvariantError([
      'the last content must not be a model turn (no prefill, 01 §2.1)',
    ]);
  }
}
