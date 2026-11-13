/**
 * Reading an Anthropic response (`05` §3.5.3.4–§3.5.3.6; `M2-T6`).
 *
 * Four jobs, and the order they happen in is the specification:
 *
 * 1. **`readStop` first, before any content is read** (`05` §3.5.3.4). A `refusal` means the
 *    partial text must be discarded rather than shown; a `max_tokens` means the truncated
 *    `tool_use` block must never be executed. Code that reads content first and checks the stop
 *    reason afterwards has already made both mistakes.
 * 2. **Find the last fallback boundary.** When the server-side refusal fallback answered, the
 *    declining model's partial output is still in `content` — ahead of a `fallback` block — and it
 *    must not reach a member or the tool executor. `visibleTextAfterLastFallback` and
 *    `toolCallsAfterLastFallback` are that rule, and `ModelTurnResult.text` is defined by it.
 * 3. **`normalizeForEcho`** produces what goes back on the next request. This is the documented
 *    echo shape, not a history edit: `01` §2.1 says `response.content` is appended unchanged, and
 *    the one exception the API documents is the pre-fallback thinking and tool-use blocks.
 * 4. **`usageIterations`** maps every billed round trip. A turn that was refused and rescued
 *    produced two iterations at two prices, which one `usage` object cannot express.
 *
 * `request.ts` imports `normalizeForEcho` from here and nothing imports `request.ts` from here —
 * the dependency runs one way, because echoing is a question about a response that happens to be
 * asked while building a request.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  AssistantMessage,
  AssistantPart,
  StopInfo,
  UsageIteration,
  UsageIterationKind,
} from '@comvivo/core';

type Content = Anthropic.Beta.Messages.BetaContentBlock;
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type Message = Anthropic.Beta.Messages.BetaMessage;
type StopReason = Anthropic.Beta.Messages.BetaStopReason;

/** `@comvivo/core`'s `ProviderId` value for this adapter. */
export const ANTHROPIC_PROVIDER = 'anthropic';

/**
 * Which blocks are dropped from the echo when they sit **before** the last `fallback` block.
 *
 * `05` §3.5.3.5: the thinking and tool-use blocks the declining model produced are not valid
 * continuation state for the model that answered. A `server_tool_use` without its matching result
 * joins them, because a tool call with no result is a dangling reference the API rejects.
 */
const DROPPED_BEFORE_FALLBACK: ReadonlySet<string> = new Set([
  'thinking',
  'redacted_thinking',
  'tool_use',
]);

/** The index of the last `fallback` block, or `-1` when the fallback never ran. */
export function lastFallbackIndex(content: readonly Content[]): number {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]?.type === 'fallback') return index;
  }
  return -1;
}

/**
 * Did the server-side refusal fallback answer this turn?
 *
 * `usage.iterations` is the authority rather than the presence of a `fallback` block, because
 * **sticky routing** (`05` §3.5.3.5) means a later request can be served by the fallback model with
 * no block in its content at all. A reader that keyed off the block would bill about an hour of
 * traffic at the wrong model's rates.
 */
export function servedByFallback(message: Message): boolean {
  return (message.usage.iterations ?? []).some(
    (iteration) => iteration.type === 'fallback_message',
  );
}

/**
 * `05` §3.5.3.4's table, total over `BetaStopReason` and over `null`.
 *
 * A `switch` rather than a `Record`, because two arms need the message: a `stop_sequence` is
 * `end_turn` if there is text and `other` otherwise, and a refusal carries `stop_details`.
 *
 * **No `default`**, which is the repository's policy (`eslint.config.ts`'s
 * `allowDefaultCaseForExhaustiveSwitch: false`; the reasoning is in `shared/src/exit-codes.ts`): a
 * switch with a default is a list that silently stops matching the type it switches on. So an SDK
 * bump that adds a stop reason fails **this build** until somebody decides what it means — which is
 * `01` §11.3's rule, and far better than falling through to `other` and turning a new API behaviour
 * into "the model said nothing".
 */
export function readStop(message: Message): StopInfo {
  const reason: StopReason | null = message.stop_reason;
  const raw = reason ?? 'null';
  switch (reason) {
    case 'end_turn':
      return { reason: 'end_turn', raw };
    case 'tool_use':
      return { reason: 'tool_use', raw };
    case 'max_tokens':
      return { reason: 'max_tokens', raw };
    case 'pause_turn':
      return { reason: 'pause_turn', raw };
    case 'model_context_window_exceeded':
      return { reason: 'context_overflow', raw };
    case 'refusal': {
      // `stop_details` is populated **only** for a refusal and `category` may be `null`
      // (`05` §3.5.3.4; confirmed in `BetaRefusalStopDetails`). `explanation` is documented as
      // unstable text, so it is carried for the trace and never shown to a member.
      const details = message.stop_details;
      const explanation = details?.explanation;
      return {
        reason: 'refusal',
        raw,
        category: details?.category ?? null,
        ...(explanation === null || explanation === undefined ? {} : { explanation }),
        servedByFallback: servedByFallback(message),
      };
    }
    case 'stop_sequence':
      // We never send `stop_sequences`, so this should be unreachable. If it arrives, a reply with
      // text is a finished turn and one without is a failure — mapping both to `end_turn` would
      // hand the engine an empty answer to show somebody.
      return visibleTextAfterLastFallback(message.content) === ''
        ? { reason: 'other', raw }
        : { reason: 'end_turn', raw };
    case 'compaction':
      // Server-side compaction is not enabled in v1 (`context_management` is never sent), so this
      // is a response to a request we did not make. `other` with the raw value preserved, so the
      // trace shows what actually happened instead of an invented interpretation.
      return { reason: 'other', raw };
    case null:
      // Non-streaming responses always carry a stop reason, and `finalMessage()` returns an
      // accumulated message rather than the `message_start` frame. Defensive.
      return { reason: 'other', raw };
  }
}

/**
 * The engine's view of the content (`01` §7.5's `AssistantPart`).
 *
 * Every provider-private block becomes `opaque` with a coarse `kind`. That is a disclosure
 * decision, not laziness: giving thinking text a typed home in the engine's view is how model
 * reasoning ends up in a log, and `08` §3.16 and `11` §3.10.2 both forbid it. The text is still in
 * `assistant.raw`, which is re-sent verbatim and never read.
 *
 * Every one of the SDK's eighteen block types is named and there is no `default`, so an SDK bump
 * that adds a nineteenth fails the build here. That is deliberate: a new content block is a new
 * thing the model can say, and a `default` would classify it as `other` without anybody looking.
 */
export function assistantPartsOf(content: readonly Content[]): AssistantPart[] {
  // A named function rather than an inline callback: Biome's `useIterableCallbackReturn` wants a
  // callback that provably returns on every path, and an exhaustive switch with no `default` is a
  // shape it cannot see through — while ESLint's `switch-exhaustiveness-check` forbids the
  // `default` that would satisfy it. A declared return type satisfies both, and `tsc` is the one
  // actually proving the switch is total.
  return content.map(partOf);
}

function partOf(block: Content): AssistantPart {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_call', id: block.id, name: block.name, input: block.input };
    case 'thinking':
      return { type: 'opaque', kind: 'thinking' };
    case 'redacted_thinking':
      return { type: 'opaque', kind: 'redacted_thinking' };
    case 'fallback':
      return { type: 'opaque', kind: 'fallback' };
    case 'compaction':
    case 'container_upload':
      // Neither feature is enabled in v1. Named rather than defaulted so that enabling one is a
      // decision somebody makes here, with the engine's view in front of them.
      return { type: 'opaque', kind: 'other' };
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
    case 'advisor_tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'tool_search_tool_result':
    case 'mcp_tool_use':
    case 'mcp_tool_result':
    case 'mcp_tool_listing':
      return { type: 'opaque', kind: 'server_tool' };
  }
}

/** Concatenated text blocks after the last fallback boundary (`ModelTurnResult.text`). */
export function visibleTextAfterLastFallback(content: readonly Content[]): string {
  const start = lastFallbackIndex(content) + 1;
  return content
    .slice(start)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}

/** Tool calls after the last fallback boundary — the only ones the executor may run. */
export function toolCallsAfterLastFallback(
  content: readonly Content[],
): { readonly id: string; readonly name: string; readonly input: unknown }[] {
  const start = lastFallbackIndex(content) + 1;
  return content
    .slice(start)
    .flatMap((block) =>
      block.type === 'tool_use' ? [{ id: block.id, name: block.name, input: block.input }] : [],
    );
}

/** The ids of every `tool_use` block in the whole content, for the echo's pairing check. */
function toolUseIds(content: readonly Content[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const block of content) {
    if (block.type === 'server_tool_use') ids.add(block.id);
  }
  return ids;
}

/** Which server-tool results are present, so an unmatched `server_tool_use` can be found. */
function resultToolUseIds(content: readonly Content[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const block of content) {
    if ('tool_use_id' in block && typeof block.tool_use_id === 'string') {
      ids.add(block.tool_use_id);
    }
  }
  return ids;
}

/**
 * `05` §3.5.3.5's echo normalization.
 *
 * With no `fallback` block the content goes back **unchanged** — that is `01` §2.1's rule and the
 * common case. With one, the blocks listed in `DROPPED_BEFORE_FALLBACK` that sit before the *last*
 * boundary are removed, plus any `server_tool_use` whose result is missing. Everything after the
 * boundary is kept, including its thinking.
 *
 * Two things this is **not**. It is not a history edit: the API documents this shape, and
 * `preservedThinking` (`05` §3.5.3.11) would reject an edit we invented. And it is not a filter on
 * empty thinking blocks — those are kept, because `display: 'omitted'` is the default on the models
 * we use and an empty `thinking` with a signature is exactly what a valid continuation looks like.
 */
export function normalizeForEcho(content: readonly Content[]): ContentParam[] {
  const boundary = lastFallbackIndex(content);
  // The common path: nothing to normalise, so nothing is touched. No cast — measured: the SDK's
  // response blocks are assignable to its request blocks, which is the echo contract expressed as
  // a type. `no-unnecessary-type-assertion` caught the cast that assumed otherwise.
  if (boundary === -1) return [...content];

  const results = resultToolUseIds(content);
  const unmatched = new Set([...toolUseIds(content)].filter((id) => !results.has(id)));

  const kept = content.filter((block, index) => {
    if (index > boundary) return true;
    if (DROPPED_BEFORE_FALLBACK.has(block.type)) return false;
    if (block.type === 'server_tool_use' && unmatched.has(block.id)) return false;
    return true;
  });
  return [...kept];
}

/**
 * Usage as it may **actually** arrive, with every numeric field optional.
 *
 * One documented cast at the boundary, which is the pattern `05` §3.5.3.1 anticipated for fields
 * the typings describe differently from the wire. It is needed in the other direction from the one
 * the spec expected: the published types are *too confident*, not too old. A message assembled by
 * the SDK's stream accumulator carries only the fields the stream actually sent — `iterations` is
 * `undefined` where the non-streaming type says `BetaIterationsUsage | null`, and `message_start`
 * does not carry an `output_tokens_details` at all.
 *
 * Found by the contract test against a real socket: every successful streamed turn threw
 * `Cannot read properties of undefined (reading 'length')`, and the adapter reported it as a
 * provider error of kind `unknown`. A unit test with a hand-built `Message` could not find it,
 * because a hand-built one sets `null`.
 */
interface WireUsage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_creation?: Anthropic.Beta.Messages.BetaCacheCreation | null;
  readonly output_tokens_details?: { readonly thinking_tokens?: number | null } | null;
  readonly iterations?: readonly WireIteration[] | null;
}

interface WireIteration extends WireUsage {
  readonly type: UsageIterationKind;
  readonly model?: string | null;
}

/** The cache-write split, with a missing breakdown falling back to the undifferentiated total. */
function cacheWrites(usage: WireUsage): {
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
} {
  const breakdown = usage.cache_creation;
  if (breakdown !== null && breakdown !== undefined) {
    return {
      cacheWrite5m: breakdown.ephemeral_5m_input_tokens,
      cacheWrite1h: breakdown.ephemeral_1h_input_tokens,
    };
  }
  // `05` §3.5.3.6: a missing field is treated as 0. An undifferentiated total is attributed to the
  // 5-minute TTL, which is the API's own default — guessing 1h would price it 2× too high.
  return { cacheWrite5m: usage.cache_creation_input_tokens ?? 0, cacheWrite1h: 0 };
}

/**
 * Every billed round trip (`05` §3.5.3.6).
 *
 * `usage.iterations` when the API sent one, the top-level `usage` otherwise — the same fallback the
 * spec's loop uses, because a single-iteration response does not carry the array.
 *
 * The model attribution per kind is the part worth reading twice. A `message` iteration is the
 * model we asked for; a `fallback_message` is a *different* model, priced at its own rates, and its
 * own `model` field is the authority. `compaction` carries no model at all, so it is attributed to
 * the requested one — dropping it instead would be spend that never reaches the budget.
 */
export function usageIterations(
  message: Message,
  requestedModel: string,
  options: { readonly batch?: boolean } = {},
): UsageIteration[] {
  const batch = options.batch ?? false;
  const usage: WireUsage = message.usage;
  const iterations = usage.iterations ?? [];

  if (iterations.length === 0) {
    return [one(usage, 'message', message.model, batch)];
  }
  return iterations.map((iteration) =>
    one(iteration, iteration.type, iteration.model ?? requestedModel, batch),
  );
}

/** One `UsageIteration` from one wire usage object. */
function one(
  usage: WireUsage,
  kind: UsageIterationKind,
  model: string,
  batch: boolean,
): UsageIteration {
  const { cacheWrite5m, cacheWrite1h } = cacheWrites(usage);
  const reasoning = usage.output_tokens_details?.thinking_tokens;
  return {
    model,
    kind,
    input: usage.input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m,
    cacheWrite1h,
    output: usage.output_tokens ?? 0,
    ...(reasoning === undefined || reasoning === null ? {} : { reasoning }),
    batch,
  };
}

/** The assistant turn, with `raw` holding exactly what goes back on the next request. */
export function assistantMessageOf(message: Message): AssistantMessage {
  return {
    role: 'assistant',
    provider: ANTHROPIC_PROVIDER,
    servedModel: message.model,
    raw: normalizeForEcho(message.content),
    view: assistantPartsOf(message.content),
  };
}
