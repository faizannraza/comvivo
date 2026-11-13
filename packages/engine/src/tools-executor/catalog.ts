/**
 * The group tool catalogue and its hash (`10` §3.5.1; `05` §3.4.8–§3.4.9; `01` §14 A13; `M2-T17`).
 *
 * ## What this is for
 *
 * `05` §3.4.8 puts the tool catalogue plus the charter at **breakpoint 1** of the prompt cache, with
 * a one-hour TTL, and `01` §14 A13 keys that layer by a **catalogue hash** rather than by group. Two
 * groups with the same enabled tools share one cache entry; on a single-group instance it behaves
 * exactly like a global layer. That is the whole design, and it has one hard requirement:
 *
 * > the same enabled set must produce the same bytes, every time, on every host.
 *
 * A prompt cache is a byte-prefix match. If the order depended on a `Map`'s insertion order, or on
 * which plugin finished loading first, the layer would be rewritten on turns that changed nothing —
 * no error, no log line, identical answers, roughly double the cost of the largest layer in the
 * prompt. That failure is invisible by construction, so the ordering is pinned here and asserted as
 * a property (P5): invariant to registration order, and changing **iff** a model-facing definition
 * changes.
 *
 * ## The order
 *
 * 1. Built-ins, in `packages/tools/src/catalog.ts`'s fixed order (`05` §3.6.7's table).
 * 2. Then every enabled provider sorted by `providerId` **bytewise**, and within each, its tools
 *    sorted by `localName`. Plugins and MCP servers interleave rather than forming two groups,
 *    because they share one id namespace (`10` X-5) — so a reader cannot tell which kind a provider
 *    is from its position, and neither can the hash.
 *
 * Bytewise, not `localeCompare`: a locale-aware sort puts `a` before `B` in some locales and after
 * it in others, so the catalogue would hash differently depending on the host's `LANG`.
 *
 * ## Why this file takes descriptors rather than `ToolDefinition`s
 *
 * `01` §14 A11 lets the engine import `@comvivo/plugin-sdk` **types only** — a runtime import would
 * pull the plugin compatibility surface into the turn loop. Converting a zod schema is a runtime
 * call, so conversion happens in the provider that owns the tool (`@comvivo/tools` for built-ins
 * through `toolSchemas`, `@comvivo/plugin-host` for extensions) and this module composes what it is
 * given. That is also the better layering: the engine never needs to know that a tool was ever a
 * zod type.
 */
import type { ToolSpec } from '@comvivo/core';
import type { CanonicalValue, StrictJsonSchema } from '@comvivo/shared';
import { canonicalJson } from '@comvivo/shared';
import { sha256Hex } from '@comvivo/shared/crypto';

/**
 * Where a tool came from.
 *
 * Structurally the same as `@comvivo/plugin-sdk`'s `ToolProvider`, declared again rather than
 * imported, because A11's types-only rule is enforced on the import *graph* and a type import from
 * the engine to the plugin SDK is permitted but pointless here: this is the engine's own view of a
 * provider, and the two are free to diverge if the SDK's ever gains a field the catalogue should
 * not hash.
 */
export type CatalogProvider =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'plugin' | 'mcp'; readonly id: string };

/** One tool as the model will see it, already converted. */
export interface CatalogTool {
  /** The tool's own name, before the provider prefix. `^[a-z][a-z0-9_]{0,47}$`, no `__`. */
  readonly localName: string;
  readonly provider: CatalogProvider;
  readonly description: string;
  readonly inputSchema: StrictJsonSchema;
  /** Whether the provider accepts the schema as strict. Part of the hash: it changes the wire. */
  readonly strict: boolean;
}

/** A tool in a built catalogue, with the name the model is given. */
export interface CatalogEntry extends CatalogTool {
  readonly modelName: string;
}

export interface GroupCatalog {
  readonly tools: readonly CatalogEntry[];
  /** `sha256` over the canonical JSON of the model-facing fields. Lowercase hex. */
  readonly hash: string;
}

/**
 * The longest model-facing tool name any of the three providers accepts.
 *
 * 64 characters and `^[a-zA-Z0-9_-]{1,64}$` is the intersection of Anthropic's, OpenAI's and
 * Google's rules (`10` §3.5.1). Validating against the intersection rather than per provider means
 * a plugin that installs on an Anthropic host also works on a Google one, which is the difference
 * between a portable extension ecosystem and one that fragments by provider.
 */
export const MAX_MODEL_TOOL_NAME_CHARS = 64;
export const MODEL_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Raised when a provider/tool combination cannot be named for the wire. */
export class ToolNameTooLongError extends Error {
  readonly modelName: string;

  constructor(modelName: string) {
    super(
      `the tool name "${modelName}" is ${String(modelName.length)} characters; the limit is ` +
        `${String(MAX_MODEL_TOOL_NAME_CHARS)}. Shorten the provider id or the tool name.`,
    );
    this.name = 'ToolNameTooLongError';
    this.modelName = modelName;
  }
}

/**
 * The name the model is given.
 *
 * Built-ins keep their own name — `05` §3.6.7 guarantees none contains `__`, which is what makes
 * the two namespaces distinguishable at a glance and unspoofable by an extension.
 *
 * Extensions become `` `${providerId.replaceAll('-', '_')}__${localName}` ``. The `-` → `_` mapping
 * exists because `-` is legal in a provider id and awkward in several providers' tool names; it is
 * safe because `10` §3.2.3 forbids `--` inside a provider id, so the mapping can never manufacture
 * a `__` *inside* an id and collide with the separator.
 */
export function modelToolName(provider: CatalogProvider, localName: string): string {
  if (provider.kind === 'builtin') return localName;
  const name = `${provider.id.replaceAll('-', '_')}__${localName}`;
  if (!MODEL_TOOL_NAME_PATTERN.test(name)) throw new ToolNameTooLongError(name);
  return name;
}

/** `providerId` for sorting. Built-ins never reach the sort; they keep the fixed order. */
function providerIdOf(provider: CatalogProvider): string {
  return provider.kind === 'builtin' ? '' : provider.id;
}

/** Bytewise, so the catalogue does not hash differently depending on the host's locale. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What the hash is computed over: the model-facing fields and nothing else.
 *
 * `10` §3.5.1 step 4 names the four: name, description, schema, strict. Deliberately **not** the
 * capability, the risk, the timeout or the effect — none of those reaches the model, so a change to
 * one must not invalidate a cache layer shared by every group on the host. Equally deliberately
 * **not** the provider kind: whether a tool arrived by plugin or by MCP does not change a byte the
 * model reads.
 */
function hashShape(entry: CatalogEntry): CanonicalValue {
  return {
    n: entry.modelName,
    d: entry.description,
    s: entry.inputSchema as unknown as CanonicalValue,
    st: entry.strict,
  };
}

/**
 * The catalogue hash.
 *
 * RFC 8785 canonical JSON, then sha256, lowercase hex. `canonicalJson` is `@comvivo/shared`'s — a
 * second JCS implementation beside it would be a second thing to get right, and two canonicalizers
 * that disagreed on, say, a lone surrogate in a description would produce two hashes for one
 * catalogue and silently halve the cache hit rate.
 */
export function catalogHash(entries: readonly CatalogEntry[]): string {
  return sha256Hex(canonicalJson(entries.map(hashShape)));
}

export interface BuildCatalogInput {
  /**
   * Built-in tools, already in `packages/tools/src/catalog.ts` order.
   *
   * Passed in rather than imported so the engine depends on the registry's *shape* and not on which
   * built-ins happen to be implemented — which is what lets a test build a catalogue of two tools
   * and assert the ordering property without the whole product existing.
   */
  readonly builtins: readonly CatalogTool[];
  /** Every tool from every provider enabled in this group, in any order. */
  readonly extensions: readonly CatalogTool[];
}

/**
 * Build a group's catalogue.
 *
 * The extension half is sorted here rather than trusted from the caller, which is the point: a
 * registry that enumerated providers in load order, or a `Map` that preserved insertion order,
 * would otherwise decide the cache key.
 */
export function buildCatalog(input: BuildCatalogInput): GroupCatalog {
  const extensions = [...input.extensions].sort(
    (a, b) =>
      byteCompare(providerIdOf(a.provider), providerIdOf(b.provider)) ||
      byteCompare(a.localName, b.localName),
  );

  const tools: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const tool of [...input.builtins, ...extensions]) {
    const modelName = modelToolName(tool.provider, tool.localName);
    if (seen.has(modelName)) {
      // A collision means two providers claim one name, which would make the model's choice
      // ambiguous and the policy decision arbitrary. Registration rejects it (`10` §3.5.1); this
      // is the second line, because a catalogue that silently dropped one would be a tool that
      // vanished for one group and worked for another.
      throw new Error(
        `two tools claim the model name "${modelName}"; provider ids are collision-checked at ` +
          'registration (10 §3.5.1), so this is a registry bug',
      );
    }
    seen.add(modelName);
    tools.push({ ...tool, modelName });
  }

  return { tools, hash: catalogHash(tools) };
}

/** The catalogue as the model port wants it (`05` §4.1's `ToolSpec`). */
export function toolSpecs(catalog: GroupCatalog): readonly ToolSpec[] {
  return catalog.tools.map((entry) => ({
    name: entry.modelName,
    description: entry.description,
    inputSchema: entry.inputSchema,
  }));
}

/** What a group's catalogue is memoized against (`10` §3.5.1 step 5). */
export interface CatalogVersion {
  /** Bumped by `ExtensionRegistry` when a provider is installed, updated or removed. */
  readonly registryGeneration: number;
  /** Bumped when this group enables, disables or overrides a tool. */
  readonly groupExtensionsVersion: number;
}

export interface CatalogSource {
  readonly builtins: () => readonly CatalogTool[];
  readonly extensionsFor: (groupId: string) => readonly CatalogTool[];
  readonly versionFor: (groupId: string) => CatalogVersion;
}

/**
 * Per-group catalogues, memoized.
 *
 * A class rather than a module-level cache because a module-level `Map` is process-global state
 * that two tests, or two instances in one process, would share — and because `scripts/hygiene`
 * rightly bans it.
 *
 * **A running turn keeps its snapshot** (`10` F9). `forGroup` returns a frozen object, and the
 * turn holds that reference: a plugin enabled halfway through a turn must not change the catalogue
 * the model was given, or the tool it then calls will not be in the list it was shown.
 */
export class ToolCatalogService {
  readonly #source: CatalogSource;
  readonly #cache = new Map<
    string,
    { readonly version: CatalogVersion; readonly catalog: GroupCatalog }
  >();

  constructor(source: CatalogSource) {
    this.#source = source;
  }

  forGroup(groupId: string): GroupCatalog {
    const version = this.#source.versionFor(groupId);
    const cached = this.#cache.get(groupId);
    if (
      cached !== undefined &&
      cached.version.registryGeneration === version.registryGeneration &&
      cached.version.groupExtensionsVersion === version.groupExtensionsVersion
    ) {
      return cached.catalog;
    }
    const catalog = Object.freeze(
      buildCatalog({
        builtins: this.#source.builtins(),
        extensions: this.#source.extensionsFor(groupId),
      }),
    );
    this.#cache.set(groupId, { version, catalog });
    return catalog;
  }

  /** Drop every memo. For a test, and for the host's hot-reload path. */
  clear(): void {
    this.#cache.clear();
  }
}
