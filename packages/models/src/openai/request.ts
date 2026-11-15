/**
 * Building a Responses API request (`05` §3.5.4; `M2-T11`).
 *
 * ## Why Responses and not Chat Completions
 *
 * OpenAI recommends Responses for new projects and lands new capability there. The decisive reason
 * for this product is narrower: a reasoning model's **reasoning items must be passed back** with
 * tool outputs, and with `store: false` they come back as `encrypted_content` that only Responses
 * accepts in its input. Chat Completions has nowhere to put them, so a tool loop on a reasoning
 * model would silently lose the model's own chain of thought between steps.
 *
 * ## `store: false`, and what it costs us
 *
 * `08` §3.11 and `01` §11.7: a family's messages are not left on a provider's disk. `store: false`
 * is how that is said to OpenAI, and it is unconditional — there is no config key to turn it on.
 * The price is that the reasoning state has to travel with us, which is what
 * `include: ['reasoning.encrypted_content']` asks for and what `05` §3.5.4's "replayed verbatim"
 * rule is about.
 *
 * ## Verbatim means verbatim
 *
 * `ResponseOutputItem` is a **28-member union** in the installed SDK (7.55.0, read 2026-11-13) and
 * grows with every release: programs, shell calls, apply-patch calls, compaction items, MCP calls.
 * We understand three of them (`message`, `function_call`, `reasoning`). The rest are kept whole in
 * `AssistantMessage.raw` and replayed unchanged, because an adapter that filtered to the items it
 * recognised would drop a fingerprint the model needs to continue — `ResponseOutputItem.Program`
 * even documents its own field as "opaque program replay fingerprint that must be round-tripped".
 *
 * ## Facts measured against openai 7.55.0, not recalled
 *
 *  - `temperature` and `top_p` **exist** on `ResponseCreateParams`. Unlike Anthropic, where they
 *    are absent from the beta params type entirely, here `01` §2.1's ban has to be enforced by us.
 *  - `ReasoningEffort` is `'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null`.
 *  - `prompt_cache_key` is real, and `user` is deprecated in its favour.
 *  - `EasyInputMessage.role` admits `developer`, which is where turn notes go.
 */

import type {
  Effort,
  ModelMessage,
  ModelTurnRequest,
  SystemBlock,
  ToolSpec,
  UserPart,
} from '@comvivo/core';
import { BRAND } from '@comvivo/shared';
import type OpenAI from 'openai';
import type { RouteBinding } from '../registry/resolve.js';

type ResponseParams = Omit<OpenAI.Responses.ResponseCreateParams, 'stream'>;
type InputItem = OpenAI.Responses.ResponseInputItem;
type Tool = OpenAI.Responses.Tool;

/**
 * Request keys this adapter must never send.
 *
 * `01` §2.1 bans the three sampling parameters and assistant prefill. On Anthropic the ban is free
 * — the beta params type has no `temperature` — but `ResponseCreateParams` *does*, so here the rule
 * is a runtime assertion over the built request. `user` is on the list for a different reason: it
 * is deprecated in favour of `prompt_cache_key`, and it was the field that would have carried a
 * member identifier to a provider.
 */
export const FORBIDDEN_REQUEST_KEYS: readonly string[] = [
  'temperature',
  'top_p',
  'top_logprobs',
  'user',
];

/** Raised when a built request would break one of `01` §2.1's rules. */
export class WireInvariantError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`the built OpenAI request breaks 01 §2.1:\n  - ${violations.join('\n  - ')}`);
    this.name = 'WireInvariantError';
    this.violations = violations;
  }
}

export interface BuildResponsesOptions {
  readonly binding: RouteBinding;
  /** `village:<instanceId>:<route>` (`05` §3.5.4). Omitted when the host has no instance id yet. */
  readonly instanceId?: string;
}

export interface BuiltResponsesRequest {
  readonly params: ResponseParams;
  /** How many times a part had to be rendered the degraded way, for the trace. */
  readonly transformations: number;
}

/**
 * Effort, as this provider spells it.
 *
 * A total mapping over our `Effort` rather than a pass-through, so adding a level to the canonical
 * union is a compile error here instead of a 400 at run time. The values happen to coincide today;
 * writing them out is what makes that a checked fact rather than a coincidence we rely on.
 */
export const EFFORT: Readonly<Record<Effort, OpenAI.ReasoningEffort>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * The system layer.
 *
 * Concatenated in order into `instructions`, with a blank line between blocks — **stable bytes**,
 * because OpenAI's prefix caching is automatic and keyed on the literal prefix (`05` §3.4.8). A
 * join that varied with the block count, or that sorted, would miss the cache on every turn.
 */
export function instructionsOf(system: readonly SystemBlock[]): string | undefined {
  if (system.length === 0) return undefined;
  return system.map((block) => block.text).join('\n\n');
}

/** A user part as a Responses content item. */
function contentOf(part: UserPart): OpenAI.Responses.ResponseInputContent | undefined {
  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text };
    case 'image':
      return {
        type: 'input_image',
        detail: 'auto',
        image_url: `data:${part.mime};base64,${bytesToBase64(part.data)}`,
      };
    case 'document':
      return {
        type: 'input_file',
        filename: 'document.pdf',
        file_data: `data:${part.mime};base64,${bytesToBase64(part.data)}`,
      };
    case 'tool_result':
      // Handled by `inputItemsOf`: a tool result is its own top-level item here, not content
      // inside a user message the way Anthropic nests it.
      return undefined;
  }
}

/**
 * Base64 without `node:buffer`.
 *
 * `@comvivo/models` is not a pure package, but this file is reachable from the browser demo
 * through the gateway's types, and `btoa` over a binary string is the portable spelling. Chunked
 * so a large image does not blow the argument limit of `String.fromCharCode`.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * Render our messages as Responses input items.
 *
 * Three rules carry the weight:
 *
 *  - **An assistant turn's `raw` goes back unchanged** when it is a list of Responses items, which
 *    is `01` §2.1's "append `response.content` unchanged" for this provider. A turn we did not
 *    produce — a replayed cassette, a converted transcript — falls back to its typed `view`, and
 *    that fallback is counted as a transformation so the trace shows the loop degraded.
 *  - **Tool results are top-level `function_call_output` items**, not content nested in a user
 *    message. There is no `is_error` flag, so a failure is the JSON error envelope (`05` §3.6.4) in
 *    the same `output` string.
 *  - **Turn notes become `developer` items.** `EasyInputMessage.role` admits `developer`, which is
 *    exactly the mid-conversation operator channel `05` §3.5.2's `developer_role` capability names.
 */
export function inputItemsOf(messages: readonly ModelMessage[]): {
  readonly items: readonly InputItem[];
  readonly transformations: number;
} {
  const items: InputItem[] = [];
  let transformations = 0;

  for (const message of messages) {
    if (message.role === 'system') {
      items.push({
        role: 'developer',
        content:
          message.kind === 'effort'
            ? `Reasoning effort for this turn: ${message.effort}.`
            : message.text,
      });
      continue;
    }
    if (message.role === 'assistant') {
      const raw = message.raw;
      if (Array.isArray(raw) && raw.length > 0) {
        items.push(...(raw as InputItem[]));
        continue;
      }
      // No raw items to replay: a cassette, or a turn built by another provider's adapter. The
      // typed view is lossy by design — `opaque` parts have no text — so this is counted.
      transformations += 1;
      items.push(...viewAsItems(message.view));
      continue;
    }

    const content = message.content.flatMap((part) => {
      const item = contentOf(part);
      return item === undefined ? [] : [item];
    });
    if (content.length > 0) items.push({ role: 'user', content });

    for (const part of message.content) {
      if (part.type !== 'tool_result') continue;
      items.push({
        type: 'function_call_output',
        call_id: part.toolCallId,
        output: part.content,
      });
    }
  }

  return { items, transformations };
}

/** The lossy fallback: a typed view rendered as items. Opaque parts cannot be reconstructed. */
function viewAsItems(view: AssistantView): InputItem[] {
  const items: InputItem[] = [];
  for (const part of view) {
    if (part.type === 'text') {
      items.push({ role: 'assistant', content: part.text });
      continue;
    }
    if (part.type === 'tool_call') {
      items.push({
        type: 'function_call',
        call_id: part.id,
        name: part.name,
        arguments: JSON.stringify(part.input),
      });
    }
    // `opaque` parts are dropped: by construction we hold no bytes for them. That is the loss the
    // transformation count is reporting.
  }
  return items;
}

type AssistantView = Extract<ModelMessage, { readonly role: 'assistant' }>['view'];

/**
 * Tools, in the strict profile.
 *
 * `strict: true` is `01` §2.1's rule and is what makes `JSON.parse(arguments)` safe to trust. The
 * schema is already strict by the time it reaches here — `M2-T4`'s converter produced it and
 * `ToolSpec.inputSchema` is typed as `StrictJsonSchema` — so this does not re-derive it. An adapter
 * that relaxed a schema to make a tool register would be defeating the point.
 */
export function toolsOf(tools: readonly ToolSpec[]): readonly Tool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as unknown as Record<string, unknown>,
    strict: true,
  }));
}

/** Build one chat request. */
export function buildResponsesRequest(
  req: ModelTurnRequest,
  options: BuildResponsesOptions,
): BuiltResponsesRequest {
  const { binding } = options;
  const instructions = instructionsOf(req.system);
  const { items, transformations } = inputItemsOf(req.messages);

  const params: ResponseParams = {
    model: binding.model,
    input: [...items],
    max_output_tokens: req.maxOutputTokens,
    // Unconditional. There is no configuration key that turns this on (`08` §3.11).
    store: false,
    // Without this, a stateless reasoning turn loses its chain of thought between tool steps.
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: EFFORT[req.effort] },
    parallel_tool_calls: true,
    tool_choice: req.toolChoice,
    ...(instructions === undefined ? {} : { instructions }),
    ...(req.tools.length === 0 ? {} : { tools: [...toolsOf(req.tools)] }),
    ...(options.instanceId === undefined
      ? {}
      : { prompt_cache_key: promptCacheKey(options.instanceId, req.route) }),
  };

  assertWireInvariants(params);
  return { params, transformations };
}

/**
 * The cache key.
 *
 * Instance and route, and nothing else. **Never a group or a member id**: `prompt_cache_key` is a
 * sharding hint the provider stores, and a per-group key would both tell OpenAI how many groups
 * this host runs and stop two groups with the same catalogue from sharing a prefix — which is the
 * entire point of `01` §14 A13.
 */
export function promptCacheKey(instanceId: string, route: string): string {
  // From `BRAND.slug`, not written out: the brand guard (`13` §3.A.6) forbids a brand literal
  // under `packages/**`, and a cache key is exactly the kind of string a rename must reach.
  return `${BRAND.slug}:${instanceId}:${route}`;
}

/**
 * Assert `01` §2.1 over a built request.
 *
 * Over the **built params**, not over the call site, so the rule holds for every path that reaches
 * the wire — including one somebody adds later without reading this file.
 */
export function assertWireInvariants(params: ResponseParams): void {
  const violations: string[] = [];
  const bag: Record<string, unknown> = params;

  for (const key of FORBIDDEN_REQUEST_KEYS) {
    if (bag[key] !== undefined) violations.push(`"${key}" must never be sent (01 §2.1)`);
  }

  if (params.store !== false) {
    violations.push('`store` must be false: a group’s messages are not left on a provider’s disk');
  }

  // An **allowlist**, not a denylist. The first version listed `'required'` and "any object",
  // which let an out-of-union string through — found by a test that built a request with a bad
  // `toolChoice`. It would also fall behind the SDK: `ToolChoice` already has six members
  // (`ToolChoiceAllowed`, `ToolChoiceMcp`, `ToolChoiceCustom`, …) and gains more. `01` §2.1 names
  // exactly two acceptable values, so those two are what this checks.
  const choice = params.tool_choice;
  if (choice !== undefined && choice !== 'auto' && choice !== 'none') {
    // A forced tool call is how a model ends up inventing arguments for a tool the turn did not
    // need — and on a group's data, inventing arguments means acting on a guess.
    violations.push(
      '`tool_choice` must be "auto" or "none", never forced (01 §2.1); got ' +
        JSON.stringify(choice),
    );
  }

  for (const tool of params.tools ?? []) {
    if (tool.type === 'function' && tool.strict !== true) {
      violations.push(`tool "${tool.name}" must be strict (01 §2.1)`);
    }
  }

  // Prefill: an assistant item as the **last** input is the model being told how to begin.
  const input = params.input;
  if (Array.isArray(input)) {
    const last = input.at(-1);
    if (last !== undefined && isAssistantMessageItem(last)) {
      violations.push('the last input item must not be an assistant message (no prefill, 01 §2.1)');
    }
  }

  if (violations.length > 0) throw new WireInvariantError(violations);
}

/**
 * Whether an input item is an assistant **message**.
 *
 * Only a message carries a role: a `function_call`, a `reasoning` item or a `function_call_output`
 * has none, so the role check alone is the whole test. (An earlier version also compared
 * `item.type === 'message'`, which TypeScript correctly reports as always true once the role has
 * narrowed the union.) Replayed assistant messages mid-history are fine — it is the **final**
 * position that is prefill.
 */
function isAssistantMessageItem(item: InputItem): boolean {
  return 'role' in item && item.role === 'assistant';
}
