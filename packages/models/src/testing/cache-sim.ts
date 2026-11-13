/**
 * Prompt-cache simulation (`05` §3.5.7's `cache-sim.ts`; `M2-T7`).
 *
 * The M2 exit gate asks for `usage.cache_read_input_tokens > 0` on the second identical request —
 * in the fake **and** in the live smoke, and for the two to agree. That is only worth asserting if
 * the simulation reproduces the real thing's *hierarchy*: a prefix match, a per-TTL expiry, a
 * minimum cacheable size, a lookback window, and a miss on a model or effort change. A fake that
 * just returned a non-zero number would make the gate's clause decorative.
 *
 * So this renders the request through **the real `buildChatRequest`** and hashes the byte prefix at
 * each `cache_control` marker. Rendering through the adapter is the load-bearing part: a
 * simulation with its own idea of the wire form would agree with itself and disagree with the
 * provider, and the disagreement would show up as a cost surprise rather than a test failure.
 *
 * ## The model, and where each rule comes from
 *
 * | Rule | Source |
 * |---|---|
 * | Prefix match: any byte change invalidates everything after it | render order is `tools`, then `system`, then `messages` |
 * | A read lands only where a previous request **wrote** a breakpoint | reads cannot land where nothing was written |
 * | Entries expire per TTL (`5m` / `1h`) under the injected clock | the two TTLs are priced separately |
 * | A prefix shorter than the model's minimum silently does not cache | `minCacheableTokens` from the registry (512 on Opus 5.5) |
 * | More than 20 appended positions pushes the previous entry out of the lookback | the documented 20-block lookback window |
 * | A model switch misses; an effort change misses under `top_level` | both are in the cache key |
 *
 * `top_level` versus `per_message` is `05` §5's open question, which `M2-T20`'s spike settles. Both
 * are implemented here, because the whole point of the spike is to measure the difference.
 */
import type { Clock } from '@comvivo/shared';
import type { AnthropicChatParams } from '../anthropic/request.js';

/** How effort participates in the cache key (`05` §5; settled by `M2-T20`). */
export type EffortStrategy = 'top_level' | 'per_message';

export interface CacheSimOptions {
  readonly clock: Clock;
  /** Below this, a prefix silently does not cache. The registry's `minCacheableTokens`. */
  readonly minCacheableTokens?: number;
  /** The documented lookback: an entry more than this many positions from the end is unreadable. */
  readonly lookbackBlocks?: number;
  /** Characters per token, for the estimator. `05` §3.4 calibrates the real one per model. */
  readonly charsPerToken?: number;
  /**
   * `top_level` (the spine default) puts effort in the cache key, so changing it misses.
   * `per_message` carries effort in a system message instead and leaves the prefix intact.
   */
  readonly effortStrategy?: EffortStrategy;
}

export const CACHE_SIM_DEFAULTS = {
  minCacheableTokens: 512,
  lookbackBlocks: 20,
  charsPerToken: 4,
  effortStrategy: 'top_level',
} as const satisfies Required<Omit<CacheSimOptions, 'clock'>>;

/** What one accounted request would report in `usage`. */
export interface CacheSimUsage {
  /** The **uncached remainder**, as the API reports it. */
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  /** Total prompt tokens: `input + cacheRead + cacheWrite5m + cacheWrite1h`. */
  readonly promptTokens: number;
}

/** One renderable unit of the prompt, in render order. */
interface Block {
  readonly bytes: number;
  readonly ttl: '5m' | '1h' | undefined;
}

interface Entry {
  readonly tokens: number;
  /** Milliseconds since the epoch, after which the entry is gone. */
  readonly expiresAtMs: number;
}

const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const;

function textBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The byte length of one content block, as the wire would carry it. */
function blockBytes(block: unknown): number {
  return textBytes(JSON.stringify(block ?? null));
}

function cacheTtlOf(block: unknown): '5m' | '1h' | undefined {
  if (typeof block !== 'object' || block === null) return undefined;
  const control = (block as { cache_control?: { ttl?: '5m' | '1h' } | null }).cache_control;
  if (control === null || control === undefined) return undefined;
  return control.ttl ?? '5m';
}

/**
 * The prompt as an ordered list of blocks, in the API's render order.
 *
 * `tools`, then `system`, then `messages` — which is the order the prefix match walks. Getting this
 * wrong would make every simulated hit land in the wrong place.
 */
export function renderBlocks(params: AnthropicChatParams): readonly Block[] {
  const blocks: Block[] = [];
  for (const tool of params.tools ?? []) {
    blocks.push({ bytes: blockBytes(tool), ttl: cacheTtlOf(tool) });
  }
  if (typeof params.system === 'string') {
    blocks.push({ bytes: textBytes(params.system), ttl: undefined });
  } else {
    for (const block of params.system ?? []) {
      blocks.push({ bytes: blockBytes(block), ttl: cacheTtlOf(block) });
    }
  }
  for (const message of params.messages) {
    const content = message.content;
    if (typeof content === 'string') {
      blocks.push({ bytes: textBytes(content), ttl: undefined });
      continue;
    }
    for (const block of content ?? []) {
      blocks.push({ bytes: blockBytes(block), ttl: cacheTtlOf(block) });
    }
  }
  return blocks;
}

/** The separator in a cache key. A model id and an effort level contain no pipe. */
const KEY_SEPARATOR = '|';

/**
 * A prompt-cache simulator with its own store.
 *
 * One per simulated provider account, because the real cache is scoped to the organisation and the
 * model: two groups on one host share it, which is exactly the behaviour a multi-group cost test
 * needs to be able to see.
 */
export class CacheSimulator {
  readonly #clock: Clock;
  readonly #minTokens: number;
  readonly #lookback: number;
  readonly #charsPerToken: number;
  readonly #effortStrategy: EffortStrategy;
  /**
   * Keyed by the **prefix itself**, not a digest.
   *
   * A simulation does not need collision resistance, and a digest would add a failure mode — two
   * prefixes colliding, producing a hit nobody can explain — for no benefit. The keys are bounded
   * by the test's own prompts.
   */
  readonly #entries = new Map<string, Entry>();

  constructor(options: CacheSimOptions) {
    this.#clock = options.clock;
    this.#minTokens = options.minCacheableTokens ?? CACHE_SIM_DEFAULTS.minCacheableTokens;
    this.#lookback = options.lookbackBlocks ?? CACHE_SIM_DEFAULTS.lookbackBlocks;
    this.#charsPerToken = options.charsPerToken ?? CACHE_SIM_DEFAULTS.charsPerToken;
    this.#effortStrategy = options.effortStrategy ?? CACHE_SIM_DEFAULTS.effortStrategy;
  }

  /** How many live entries the store holds. Expired ones are swept on read. */
  size(): number {
    this.#sweep();
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  #nowMs(): number {
    return this.#clock.now().epochMilliseconds;
  }

  #sweep(): void {
    const now = this.#nowMs();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAtMs <= now) this.#entries.delete(key);
    }
  }

  #tokens(bytes: number): number {
    return Math.max(0, Math.round(bytes / this.#charsPerToken));
  }

  /**
   * The cache key's prefix for a model and effort.
   *
   * The model is always in the key; effort is in it only under `top_level`. That is the documented
   * hierarchy: changing `output_config.effort` at the top level behaves like changing the thinking
   * parameters and invalidates the messages cache, while the per-message effort system message
   * exists precisely to avoid that.
   */
  #keyPrefix(params: AnthropicChatParams): string {
    const effort = params.output_config?.effort ?? 'default';
    return this.#effortStrategy === 'top_level'
      ? `${params.model}${KEY_SEPARATOR}${effort}${KEY_SEPARATOR}`
      : `${params.model}${KEY_SEPARATOR}`;
  }

  /**
   * Account for one request and return the usage it would produce.
   *
   * Reads the longest live entry that a previous request wrote and that is still inside the
   * lookback window; writes an entry at every marker from there on.
   */
  account(params: AnthropicChatParams): CacheSimUsage {
    this.#sweep();
    const blocks = renderBlocks(params);
    const keyPrefix = this.#keyPrefix(params);
    const now = this.#nowMs();

    // Walk the prompt once, accumulating the byte prefix and noting every marker.
    let prefix = '';
    let bytes = 0;
    const markers: {
      readonly key: string;
      readonly tokens: number;
      readonly index: number;
      readonly ttl: '5m' | '1h';
    }[] = [];
    for (const [index, block] of blocks.entries()) {
      bytes += block.bytes;
      prefix += `${String(block.bytes)}:`;
      if (block.ttl === undefined) continue;
      markers.push({
        key: `${keyPrefix}${prefix}`,
        tokens: this.#tokens(bytes),
        index,
        ttl: block.ttl,
      });
    }

    const promptTokens = this.#tokens(bytes);

    // The longest marker that is already cached, live, inside the lookback, and big enough.
    let read = 0;
    let readMarker = -1;
    for (const [markerIndex, marker] of markers.entries()) {
      const entry = this.#entries.get(marker.key);
      if (entry === undefined) continue;
      const appended = blocks.length - 1 - marker.index;
      if (appended > this.#lookback) continue;
      if (entry.tokens < this.#minTokens) continue;
      read = entry.tokens;
      readMarker = markerIndex;
    }

    // Writes: every marker after the one that was read, if it clears the minimum.
    let write5m = 0;
    let write1h = 0;
    let written = read;
    for (const [markerIndex, marker] of markers.entries()) {
      if (markerIndex <= readMarker) continue;
      if (marker.tokens < this.#minTokens) continue;
      const increment = Math.max(0, marker.tokens - written);
      written = marker.tokens;
      if (marker.ttl === '1h') write1h += increment;
      else write5m += increment;
      this.#entries.set(marker.key, {
        tokens: marker.tokens,
        expiresAtMs: now + TTL_MS[marker.ttl],
      });
    }

    return {
      input: Math.max(0, promptTokens - read - write5m - write1h),
      cacheRead: read,
      cacheWrite5m: write5m,
      cacheWrite1h: write1h,
      promptTokens,
    };
  }
}
