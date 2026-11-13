/**
 * A stable hash of a model request (`05` §3.5.7, `11` §12-1; `M2-T7`, moved at `M2-T9`).
 *
 * **Production code, not a test double.** It was written in `src/testing/` for `CassetteModel`,
 * and `M2-T9`'s trace hook then needed the same hash for the trace's `requestHash` — which
 * `testing-subpath-only-from-tests` correctly refused, because a production module must not import
 * a test double. The guard was right about the direction and wrong about nothing: the hash is a
 * production concern that the doubles happen to also use, so it moved up. `11` §12-1 is the
 * production requirement: a replay has to be able to assert it reproduced the same assembly, and a
 * hash settles that without the trace carrying the prompt.
 *
 * `CassetteModel` keys recorded responses by this hash, which makes the whole design hinge on one
 * property: **the same logical request must hash the same on every run, on every machine, forever**
 * — while a request that differs in anything the model can see must hash differently. A cassette
 * keyed by an unstable hash misses on every replay and the suite silently falls back to live calls
 * or fails; keyed by a hash that is too forgiving, it replays an answer to a different question.
 *
 * So the normalisation is a short, explicit list, and `canonical-hash.prop.test.ts` is the
 * assertion that the list is right in both directions.
 *
 * ## What is excluded, and why each one
 *
 * | Excluded | Why |
 * |---|---|
 * | `correlation` (`groupId`, `turnId`, `jobId`, `step`) | Ids are fresh on every run. They are also exactly what must not key a fixture: a cassette recorded for one group would miss for every other. |
 * | `meta` (the context manifest) | Ours, never sent to a provider (`01` §7.5). Hashing it would make a fixture depend on a field the model never saw. |
 * | `purpose` | A cost-attribution label (`02` §3.3.7), not part of the prompt. |
 * | Tool-call ids inside an echoed assistant turn | `toolu_01ABC…` is minted by the provider per call. The *pairing* survives: ids are renumbered in order of appearance, so a reordering still changes the hash. |
 * | `maxOutputTokens` | **Not excluded.** It changes what the model may produce, so it is part of the request. Listed here because it looks like plumbing and is not. |
 *
 * Everything else is included: the route, the variant, the effort, the system blocks and their
 * cache hints, the messages, the tools and their schemas, and `toolChoice`.
 */
import type {
  AssistantMessage,
  AssistantPart,
  ModelMessage,
  ModelTurnRequest,
  StructuredRequest,
  SystemBlock,
  ToolSpec,
  UserPart,
} from '@comvivo/core';
import { type CanonicalValue, canonicalJson } from '@comvivo/shared';

/** `sha256`, hex, lower case. Non-cryptographic use: this is a cache key, not evidence. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Bytes become a length and a digest-free marker: a cassette must not carry a member's photo. */
function normaliseBytes(data: Uint8Array): CanonicalValue {
  return { bytes: data.length };
}

function normaliseUserPart(part: UserPart, ids: ReadonlyMap<string, number>): CanonicalValue {
  switch (part.type) {
    case 'text':
      return {
        type: 'text',
        text: part.text,
        ...(part.cache === undefined ? {} : { ttl: part.cache.ttl }),
      };
    case 'image':
      return { type: 'image', mime: part.mime, data: normaliseBytes(part.data) };
    case 'document':
      return { type: 'document', mime: part.mime, data: normaliseBytes(part.data) };
    case 'tool_result':
      return {
        type: 'tool_result',
        // The renumbered id, so the pairing is hashed and the provider's own id is not.
        toolCallId: ids.get(part.toolCallId) ?? -1,
        content: part.content,
        isError: part.isError,
        ...(part.cache === undefined ? {} : { ttl: part.cache.ttl }),
      };
  }
}

/**
 * Every tool-call id in the request, numbered in order of first appearance.
 *
 * Renumbering rather than dropping: a turn whose two tool results came back in the other order is
 * a different request, and dropping the ids would hash it the same.
 */
function numberToolCallIds(messages: readonly ModelMessage[]): ReadonlyMap<string, number> {
  const ids = new Map<string, number>();
  const note = (id: string): void => {
    if (!ids.has(id)) ids.set(id, ids.size);
  };
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const part of message.view) {
        if (part.type === 'tool_call') note(part.id);
      }
      continue;
    }
    if (message.role !== 'user') continue;
    for (const part of message.content) {
      if (part.type === 'tool_result') note(part.toolCallId);
    }
  }
  return ids;
}

/**
 * An assistant turn, from its `view` rather than its `raw`.
 *
 * `raw` is provider-shaped and carries signatures and ids that differ per call; `view` is the
 * normalisation the port already defines, and it holds everything the next request's *meaning*
 * depends on. An `opaque` part contributes its kind — so a turn that had thinking hashes
 * differently from one that did not, without the thinking text entering a fixture.
 */
function normaliseAssistant(
  message: AssistantMessage,
  ids: ReadonlyMap<string, number>,
): CanonicalValue {
  return {
    role: 'assistant',
    provider: message.provider,
    // A named function, not an inline callback: Biome's `useIterableCallbackReturn` cannot see
    // through an exhaustive switch with no `default`, and ESLint forbids the `default` that would
    // satisfy it. A declared return type satisfies both, and `tsc` proves the switch is total.
    parts: message.view.map((part) => normaliseAssistantPart(part, ids)),
  };
}

function normaliseAssistantPart(
  part: AssistantPart,
  ids: ReadonlyMap<string, number>,
): CanonicalValue {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'tool_call':
      return {
        type: 'tool_call',
        id: ids.get(part.id) ?? -1,
        name: part.name,
        input: (part.input ?? null) as CanonicalValue,
      };
    case 'opaque':
      return { type: 'opaque', kind: part.kind };
  }
}

function normaliseMessage(message: ModelMessage, ids: ReadonlyMap<string, number>): CanonicalValue {
  if (message.role === 'user') {
    return { role: 'user', content: message.content.map((part) => normaliseUserPart(part, ids)) };
  }
  if (message.role === 'assistant') return normaliseAssistant(message, ids);
  if (message.kind === 'effort') return { role: 'system', kind: 'effort', effort: message.effort };
  return { role: 'system', kind: message.kind, text: message.text, scope: message.scope };
}

function normaliseSystem(blocks: readonly SystemBlock[]): CanonicalValue {
  // `id` is included: `05` §3.4 assembles the system prompt from named layers, and two layers with
  // the same text in a different order are a different prompt.
  return blocks.map((block) => ({
    id: block.id,
    text: block.text,
    ...(block.cache === undefined ? {} : { ttl: block.cache.ttl }),
  }));
}

function normaliseTools(tools: readonly ToolSpec[]): CanonicalValue {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: tool.inputSchema as unknown as CanonicalValue,
  }));
}

/** The canonical form of a turn request: the JSON a hash is taken of. */
export function canonicalTurnRequest(req: ModelTurnRequest): CanonicalValue {
  const ids = numberToolCallIds(req.messages);
  return {
    kind: 'turn',
    route: req.route,
    variant: req.variant ?? 'default',
    effort: req.effort,
    maxOutputTokens: req.maxOutputTokens,
    toolChoice: req.toolChoice,
    system: normaliseSystem(req.system),
    messages: req.messages.map((message) => normaliseMessage(message, ids)),
    tools: normaliseTools(req.tools),
  };
}

/** The canonical form of a structured request. */
export function canonicalStructuredRequest(req: StructuredRequest<unknown>): CanonicalValue {
  const ids: ReadonlyMap<string, number> = new Map();
  return {
    kind: 'structured',
    route: req.route,
    variant: req.variant ?? 'default',
    effort: req.effort,
    maxOutputTokens: req.maxOutputTokens,
    // The schema **name**, not the schema: `StructuredRequest.schema` is a zod type with no stable
    // serialisation, and §3.6 already requires the name to be stable because it is part of the
    // cache prefix. A schema change with the same name is a fixture the author must re-record,
    // which is the same rule as for a prompt change.
    schemaName: req.schemaName,
    system: normaliseSystem(req.system),
    input: req.input.map((part) => normaliseUserPart(part, ids)),
  };
}

/** The cassette key for a turn request. */
export async function hashTurnRequest(req: ModelTurnRequest): Promise<string> {
  return sha256Hex(canonicalJson(canonicalTurnRequest(req)));
}

/** The cassette key for a structured request. */
export async function hashStructuredRequest(req: StructuredRequest<unknown>): Promise<string> {
  return sha256Hex(canonicalJson(canonicalStructuredRequest(req)));
}
