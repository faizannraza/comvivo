/**
 * Building an Anthropic request, and refusing to send a bad one (`05` §3.5.3.2; `M2-T6`).
 *
 * ## `assertWireInvariants` is the point of this file
 *
 * `01` §2.1's rules — no sampling parameters, no assistant prefill, no forced `tool_choice`,
 * `strict: true` tools, explicit effort, the refusal fallback on Opus — are the ones a provider
 * either silently honours differently or rejects with a 400 nobody reads. They are asserted over
 * the **built request**, not over the caller's intent, so every future adapter change is checked
 * by the same function rather than by whoever remembers the rule. `11` §3.1.9 requires exactly
 * that: the invariants hold for every *captured* request.
 *
 * In production a violation fails the step with `bad_request` (it is a bug in our own request
 * builder, not something a member did); in tests it throws. One code path, two reactions, decided
 * by the caller catching `WireInvariantError`.
 *
 * ## Three corrections to `05` §3.5.3, measured against `@anthropic-ai/sdk` 1.7.0
 *
 * 1. **There is no `AnthropicWireRequest` cast.** §3.5.3.1 says the beta-only fields (`fallbacks`,
 *    per-message `output_config`, `clear_at`, `block_binding`) are ahead of the published typings
 *    and that `toSdkParams()` should cast once at the boundary. At 1.7.0 all four are typed:
 *    `BetaFallbacksParam = Array<BetaFallbackParam> | 'default'`, `BetaSystemMessageParam` carries
 *    `clear_at` and `output_config`, and `BetaThinkingConfigAdaptive` carries `block_binding`. No
 *    cast is strictly better than one cast, so there is none, and `tsc` checks the mapping.
 * 2. **The beta names in §3.5.3.9 are all real**, verbatim, in the SDK's `AnthropicBeta` union:
 *    `server-side-fallback-2026-07-01`, `mid-conversation-output-config-2026-07-01`,
 *    `mid-conversation-system-clear-at-2026-08-21`, `thinking-binding-controls-2026-08-01`,
 *    `cache-diagnosis-2026-04-07`. The `fallbacks: 'default'` scalar form pairs with the `-07-01`
 *    header specifically; the older array form takes `-06-01`, and crossing them is a 400.
 * 3. **`temperature`, `top_p` and `top_k` are not in the beta params type at all.** So the first
 *    guard on `01` §2.1 is the SDK's own typings, the second is `assertWireInvariants`, and the
 *    third is the provider's 400. The assertion is still here, over the serialised object, because
 *    a future cast or a spread from a wider source would get past the type.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  Effort,
  ModelMessage,
  ModelTurnRequest,
  SystemBlock,
  ToolSpec,
  UserPart,
} from '@comvivo/core';
import type { StrictJsonSchema } from '@comvivo/shared';
import type { ModelCapabilities } from '../registry/capabilities.js';
import type { RouteBinding } from '../registry/resolve.js';
import { normalizeForEcho } from './response.js';

type Beta = Anthropic.AnthropicBeta;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type TextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type Tool = Anthropic.Beta.Messages.BetaTool;
type CacheControl = Anthropic.Beta.Messages.BetaCacheControlEphemeral;

/**
 * The request shape both call sites accept.
 *
 * `Omit<…, 'stream'>` because `client.beta.messages.stream()` sets `stream` itself and
 * `client.beta.messages.create()` wants it absent. Verified: this type is assignable to both.
 */
export type AnthropicChatParams = Omit<
  Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
  'stream'
>;

/**
 * The optional betas (`05` §3.5.3.9), every one verbatim from the SDK's `AnthropicBeta` union.
 *
 * `M2-T8` owns the **probe** that decides which are available on a given key; this list is the set
 * the adapter would like. `cache-diagnosis-2026-04-07` is deliberately absent from the request
 * path: `05` §3.5.3.9 marks it doctor-and-eval only, and a diagnostics payload on every turn is
 * both a cost and a field we have no use for.
 */
export const OPTIONAL_BETAS = {
  serverFallback: 'server-side-fallback-2026-07-01',
  perMessageEffort: 'mid-conversation-output-config-2026-07-01',
  turnScopedSystem: 'mid-conversation-system-clear-at-2026-08-21',
  thinkingBinding: 'thinking-binding-controls-2026-08-01',
} as const satisfies Record<string, Beta>;

/** `01` §2.1's forbidden request keys, asserted over the built object. */
export const FORBIDDEN_REQUEST_KEYS: readonly string[] = [
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
];

/** `05` §3.5.3.2's cache ceiling. The API's own limit is 4 breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** What a violated wire invariant throws. Carries every violation, not the first. */
export class WireInvariantError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(
      `the built Anthropic request violates 01 §2.1:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
    this.name = 'WireInvariantError';
    this.violations = violations;
  }
}

export interface BuildChatOptions {
  readonly binding: RouteBinding;
  /** The betas the probe found available. An absent beta degrades the request, never fails it. */
  readonly availableBetas: readonly Beta[];
  /** True when the previous response stopped with `pause_turn`, which allows an assistant-final message. */
  readonly resumingPausedTurn?: boolean;
}

export interface BuiltChatRequest {
  readonly params: AnthropicChatParams;
  readonly betas: readonly Beta[];
  /**
   * How many times the builder had to render something the degraded way (`diagnostics.inputTransformations`).
   *
   * Counted rather than logged, because the number is the signal: a turn with three
   * transformations is a turn whose prompt is not the one `05` §3.4 composed.
   */
  readonly transformations: number;
}

function cacheControlFor(
  cache: { readonly ttl: '5m' | '1h' } | undefined,
): CacheControl | undefined {
  return cache === undefined ? undefined : { type: 'ephemeral', ttl: cache.ttl };
}

/** `system[]` → `system: [{type:'text', …}]`, one block per named layer so a trace can name it. */
function systemBlocks(blocks: readonly SystemBlock[]): TextBlockParam[] {
  return blocks.map((block) => {
    const cacheControl = cacheControlFor(block.cache);
    return {
      type: 'text',
      text: block.text,
      ...(cacheControl === undefined ? {} : { cache_control: cacheControl }),
    };
  });
}

/**
 * A tool as the model sees it.
 *
 * `strict: true` always, and the root must be an object — `strict` is defined over an object's
 * properties, so a non-object root is a schema the provider will reject. The guard is here rather
 * than a cast because `StrictJsonSchema.type` is a union and `BetaTool.InputSchema.type` is the
 * literal `'object'`: narrowing is what the types are asking for.
 */
function toolDefs(tools: readonly ToolSpec[]): Tool[] {
  return tools.map((tool) => {
    if (tool.inputSchema.type !== 'object') {
      throw new WireInvariantError([
        `tool "${tool.name}" has a non-object input schema (${JSON.stringify(tool.inputSchema.type)}); ` +
          'strict tool validation is defined over an object’s properties',
      ]);
    }
    const schema: StrictJsonSchema & { readonly type: 'object' } = {
      ...tool.inputSchema,
      type: 'object',
    };
    return {
      name: tool.name,
      description: tool.description,
      input_schema: schema as unknown as Anthropic.Beta.Messages.BetaTool.InputSchema,
      strict: true,
    };
  });
}

/**
 * One user part → one content block. `tool_result` content is a string, never a nested block.
 *
 * Exhaustive with no `default`, per the repository's policy: adding a `UserPart` variant fails this
 * build rather than silently sending nothing for the new kind.
 */
function userPart(part: UserPart): ContentParam {
  switch (part.type) {
    case 'text': {
      const cacheControl = cacheControlFor(part.cache);
      return {
        type: 'text',
        text: part.text,
        ...(cacheControl === undefined ? {} : { cache_control: cacheControl }),
      };
    }
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mime, data: toBase64(part.data) },
      };
    case 'document':
      return {
        type: 'document',
        source: { type: 'base64', media_type: part.mime, data: toBase64(part.data) },
      };
    case 'tool_result': {
      const cacheControl = cacheControlFor(part.cache);
      return {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: part.content,
        ...(part.isError ? { is_error: true } : {}),
        ...(cacheControl === undefined ? {} : { cache_control: cacheControl }),
      };
    }
  }
}

/**
 * Base64, without `node:Buffer`.
 *
 * `packages/models` is not a pure package, but `btoa` over a binary string is the portable form and
 * this adapter has no other reason to reach for a platform global. The chunking keeps a large PDF
 * from blowing the argument limit on `String.fromCharCode`.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

interface MessageBuild {
  readonly messages: MessageParam[];
  readonly transformations: number;
}

/**
 * `messages[]`, with the two mid-conversation system variants rendered per capability.
 *
 * The degraded renderings are the interesting part. A turn-scoped notice without
 * `mid-conversation-system-clear-at` becomes a text block appended to the preceding user message —
 * it is then permanent rather than one-turn, which is worse but visible, and it counts as a
 * transformation. An effort change without `mid-conversation-output-config` is dropped here and
 * applied at the top level by the caller, which costs the cached prefix.
 */
function buildMessages(
  source: readonly ModelMessage[],
  capabilities: ModelCapabilities,
  betas: readonly Beta[],
): MessageBuild {
  const messages: MessageParam[] = [];
  let transformations = 0;
  const hasTurnScoped = betas.includes(OPTIONAL_BETAS.turnScopedSystem);
  const hasPerMessageEffort = betas.includes(OPTIONAL_BETAS.perMessageEffort);
  const systemInMessages = capabilities.midConversationSystem !== false;

  for (const message of source) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.content.map(userPart) });
      continue;
    }
    if (message.role === 'assistant') {
      // Verbatim, after echo normalization. `01` §2.1: `response.content` is appended unchanged.
      messages.push({ role: 'assistant', content: echoContent(message.raw) });
      continue;
    }
    if (message.kind === 'effort') {
      if (systemInMessages && hasPerMessageEffort) {
        // An effort-only message is exempt from the placement rules, so it may sit anywhere.
        messages.push({ role: 'system', content: [], output_config: { effort: message.effort } });
      } else {
        transformations += 1;
      }
      continue;
    }
    const turnScoped = message.scope === 'turn';
    if (systemInMessages && (!turnScoped || hasTurnScoped)) {
      messages.push({
        role: 'system',
        content: message.text,
        ...(turnScoped ? { clear_at: 'next_user_message' as const } : {}),
      });
      continue;
    }
    transformations += 1;
    appendAsText(messages, message.text);
  }

  return { messages, transformations };
}

/** The degraded rendering: a text block on the last user message, or a new user message. */
function appendAsText(messages: MessageParam[], text: string): void {
  const last = messages.at(-1);
  if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
    messages[messages.length - 1] = {
      role: 'user',
      content: [...last.content, { type: 'text', text }],
    };
    return;
  }
  messages.push({ role: 'user', content: [{ type: 'text', text }] });
}

/**
 * An assistant turn's `raw`, checked rather than trusted.
 *
 * `AssistantMessage.raw` is `unknown` by design — the port refuses to let the engine interpret it.
 * The adapter that produced it wrote an array of content blocks, and `normalizeForEcho` is
 * idempotent, so re-running it here is both the type narrowing and the guarantee that a message
 * composed by hand in a test goes out in the same shape as one that came off the wire.
 */
function echoContent(raw: unknown): ContentParam[] {
  if (!Array.isArray(raw)) {
    throw new WireInvariantError([
      'an assistant message’s `raw` is not a content-block array; it did not come from this adapter',
    ]);
  }
  return normalizeForEcho(raw as never);
}

/**
 * Should the request carry `thinking`?
 *
 * Omitted when the binding beta is unavailable: adaptive thinking is the default on every model we
 * use, so omitting it is the same request with one fewer field. With the beta, `block_binding` is
 * set explicitly — `prefix_mismatch_behavior: 'error'` is the API default and the value `05`
 * §3.5.3.11 wants in CI, and stating it means a future default change does not quietly turn a
 * history edit into a dropped block.
 *
 * `display` is never set. The default on these models is `omitted`, which returns a signature and
 * no reasoning text — and reasoning text is something `08` §3.16 would rather we never hold.
 */
const ADAPTIVE_THINKING: ReadonlySet<string> = new Set([
  'adaptive_always',
  'adaptive_no_disable',
  'adaptive',
]);

function thinkingFor(
  capabilities: ModelCapabilities,
  betas: readonly Beta[],
): Anthropic.Beta.Messages.BetaThinkingConfigParam | undefined {
  // Three of `THINKING_MODES` are adaptive (`adaptive_always` on Opus 5.5, `adaptive_no_disable`,
  // and plain `adaptive`); the difference between them is whether `disabled` is accepted, which we
  // never send. A single-value check against `'adaptive'` silently omitted `block_binding` on
  // every Opus request — found by the registry's own data, not by reading.
  if (!ADAPTIVE_THINKING.has(capabilities.thinking)) return undefined;
  if (!betas.includes(OPTIONAL_BETAS.thinkingBinding)) return undefined;
  return { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } };
}

/** Build the chat request. Throws `WireInvariantError` if what it built violates `01` §2.1. */
export function buildChatRequest(
  req: ModelTurnRequest,
  options: BuildChatOptions,
): BuiltChatRequest {
  const { binding, availableBetas } = options;
  const capabilities = binding.capabilities;

  const wantsFallback = capabilities.serverFallback === 'default';
  const betas = availableBetas.filter((beta) =>
    beta === OPTIONAL_BETAS.serverFallback ? wantsFallback : true,
  );

  const { messages, transformations } = buildMessages(req.messages, capabilities, betas);
  const tools = toolDefs(req.tools);
  const thinking = thinkingFor(capabilities, betas);
  const useFallback = wantsFallback && betas.includes(OPTIONAL_BETAS.serverFallback);

  const params: AnthropicChatParams = {
    model: binding.model,
    max_tokens: req.maxOutputTokens,
    messages,
    // Required, never defaulted (`01` §7.5): the default differs per model, so an omitted effort
    // is a different request on Opus than on Sonnet.
    output_config: { effort: req.effort },
    system: systemBlocks(req.system),
    // Omitted together: `tool_choice` with no tools is a 400, and an empty `tools` array is a
    // request that says "you may call nothing" in two contradictory ways.
    ...(tools.length === 0
      ? {}
      : { tools, tool_choice: { type: req.toolChoice === 'none' ? 'none' : 'auto' } }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(useFallback ? { fallbacks: 'default' as const } : {}),
    ...(betas.length === 0 ? {} : { betas: [...betas] }),
  };

  assertWireInvariants(params, {
    capabilities,
    effort: req.effort,
    resumingPausedTurn: options.resumingPausedTurn ?? false,
  });

  return { params, betas, transformations };
}

export interface InvariantContext {
  readonly capabilities: ModelCapabilities;
  readonly effort: Effort;
  readonly resumingPausedTurn: boolean;
}

/**
 * `05` §3.5.3.2's pre-send assertions, plus `01` §2.1's, over the built request.
 *
 * Every violation is collected rather than the first, because a request that breaks two rules
 * usually broke them for one reason and a reader who sees both finds it faster.
 */
export function assertWireInvariants(params: AnthropicChatParams, context: InvariantContext): void {
  const violations: string[] = [];
  const wide = params as unknown as Record<string, unknown>;

  for (const key of FORBIDDEN_REQUEST_KEYS) {
    if (key in wide) violations.push(`\`${key}\` is present; 01 §2.1 forbids it`);
  }

  if (params.output_config?.effort === undefined) {
    violations.push('`output_config.effort` is missing; 01 §7.5 requires it to be explicit');
  } else if (params.output_config.effort !== context.effort) {
    violations.push(
      `\`output_config.effort\` is ${String(params.output_config.effort)} but the request asked for ${context.effort}`,
    );
  }

  const choice = params.tool_choice?.type;
  if (choice !== undefined && choice !== 'auto' && choice !== 'none') {
    violations.push(
      `\`tool_choice\` is ${JSON.stringify(choice)}; only auto and none are allowed (01 §2.1, and ` +
        'any/tool are 400s on the 5.5 models)',
    );
  }

  for (const tool of params.tools ?? []) {
    if (!('input_schema' in tool)) continue;
    if (tool.strict !== true) violations.push(`tool "${tool.name}" is not \`strict: true\``);
    const schema = tool.input_schema as unknown as Record<string, unknown>;
    if (schema['additionalProperties'] !== false) {
      violations.push(`tool "${tool.name}" does not set \`additionalProperties: false\``);
    }
  }

  if (
    context.capabilities.serverFallback === 'default' &&
    params.fallbacks === undefined &&
    (params.betas ?? []).includes(OPTIONAL_BETAS.serverFallback)
  ) {
    violations.push(
      'the server-side-fallback beta is enabled but `fallbacks` is absent; pairing the header ' +
        'with no parameter is a request that cannot be rescued',
    );
  }

  violations.push(...cacheViolations(params));
  violations.push(...messageViolations(params, context));

  if (violations.length > 0) throw new WireInvariantError(violations);
}

/**
 * Every `cache_control` TTL, in render order: `tools` → `system` → `messages` (`05` §3.5.3.2).
 *
 * Render order matters and is not the order the fields appear in the object: caching is a prefix
 * match, so "non-increasing" is a statement about where a breakpoint sits in the rendered prompt.
 */
function cacheTtls(params: AnthropicChatParams): ('5m' | '1h')[] {
  const ttls: ('5m' | '1h')[] = [];
  const collect = (control: CacheControl | null | undefined): void => {
    if (control === null || control === undefined) return;
    ttls.push(control.ttl ?? '5m');
  };

  for (const tool of params.tools ?? []) {
    if ('cache_control' in tool) collect(tool.cache_control);
  }
  if (Array.isArray(params.system)) for (const block of params.system) collect(block.cache_control);
  for (const message of params.messages) {
    if (typeof message.content === 'string' || message.content === undefined) continue;
    for (const block of message.content) {
      if ('cache_control' in block) collect(block.cache_control);
    }
  }
  return ttls;
}

/** ≤ 4 breakpoints, with TTLs non-increasing through the prompt (`05` §3.5.3.2). */
function cacheViolations(params: AnthropicChatParams): string[] {
  const ttls = cacheTtls(params);
  const violations: string[] = [];
  if (ttls.length > MAX_CACHE_BREAKPOINTS) {
    violations.push(
      `${String(ttls.length)} cache_control markers; the API allows ${String(MAX_CACHE_BREAKPOINTS)}`,
    );
  }
  // Non-increasing: a 1h breakpoint after a 5m one would cache a longer-lived prefix behind a
  // shorter-lived one, so the longer entry can never be read.
  const rank = (ttl: '5m' | '1h'): number => (ttl === '1h' ? 1 : 0);
  for (let index = 1; index < ttls.length; index += 1) {
    const previous = ttls[index - 1];
    const current = ttls[index];
    if (previous !== undefined && current !== undefined && rank(current) > rank(previous)) {
      violations.push(
        `cache TTLs increase (${previous} then ${current}); 05 §3.5.3.2 requires them non-increasing`,
      );
      break;
    }
  }
  return violations;
}

/** The message-shape assertions: no prefill, paired tool results in one message, system placement. */
function messageViolations(params: AnthropicChatParams, context: InvariantContext): string[] {
  const violations: string[] = [];
  const messages = params.messages;

  const last = messages.at(-1);
  if (last?.role === 'assistant' && !context.resumingPausedTurn) {
    violations.push(
      'the last message is `assistant`, which is an assistant prefill; 01 §2.1 forbids it and the ' +
        '5.5 models return a 400. Only a `pause_turn` resume may end on an assistant turn.',
    );
  }

  const first = messages[0];
  if (first?.role === 'system') {
    const effortOnly = Array.isArray(first.content) && first.content.length === 0;
    if (!effortOnly) {
      violations.push(
        'a `role: "system"` message is first; only an effort-only one may be, and the API rejects ' +
          'the rest at index 0',
      );
    }
  }

  violations.push(...toolResultViolations(messages));
  return violations;
}

/**
 * Every `tool_result` pairs with a `tool_use` in the preceding assistant message, and a round's
 * results all sit in **one** user message.
 *
 * The single-message rule is not cosmetic: `11` §3.1.9 and the API's own guidance say that
 * splitting parallel results across messages trains the model to stop making parallel calls at
 * all. That is a quality regression with no error attached to it, which is exactly the kind this
 * assertion exists to catch.
 */
function toolResultViolations(messages: readonly MessageParam[]): string[] {
  const violations: string[] = [];
  let offered: ReadonlySet<string> = new Set();
  let seenResultMessage = false;

  for (const message of messages) {
    if (message.role === 'assistant') {
      offered = assistantToolUseIds(message.content);
      seenResultMessage = false;
      continue;
    }
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    const results = message.content.filter((block) => block.type === 'tool_result');
    if (results.length === 0) continue;
    if (seenResultMessage) {
      violations.push(
        'tool results are split across more than one user message; they must all go back in one',
      );
    }
    seenResultMessage = true;
    for (const result of results) {
      if (!offered.has(result.tool_use_id)) {
        violations.push(
          `tool_result ${JSON.stringify(result.tool_use_id)} has no matching tool_use in the ` +
            'preceding assistant message',
        );
      }
    }
  }
  return violations;
}

function assistantToolUseIds(content: MessageParam['content']): ReadonlySet<string> {
  if (typeof content === 'string' || content === undefined) return new Set();
  const ids = new Set<string>();
  for (const block of content) {
    if (block.type === 'tool_use') ids.add(block.id);
  }
  return ids;
}
