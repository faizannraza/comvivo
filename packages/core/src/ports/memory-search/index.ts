/**
 * `MemorySearchPort` (`02` §3.7.1, `04` §3.6.3, `01` §14 A11).
 *
 * ## Why this is its own module and its own entry point
 *
 * `.dependency-cruiser.cjs`'s `memory-search-restricted-callers` forbids any module outside
 * `engine/context`, `engine/readmodels` and the storage implementation from importing this path.
 * The reason is in the rule's own comment: both allowed callers "must apply the eligible-label
 * filter, so widening this list silently widens who can read whose memories".
 *
 * So, like `ports/storage/unfiltered.ts`, this is **not re-exported from the package root** — a
 * barrel that re-exported it would be an unrestricted importer, and every consumer of
 * `@comvivo/core` would inherit the edge. It is `@comvivo/core/memory-search`.
 *
 * ## Every method takes an `EligibleLabelSet`
 *
 * `02` §3.2: the branded set "is the only argument `MemorySearchPort` accepts". There is no
 * unfiltered variant of memory search at all, and that asymmetry with messages is deliberate —
 * retention and export walk messages by conversation, while nothing needs to *search* memories it
 * may not read.
 *
 * Storage's filtering exists **for performance, not for correctness** (`02` §3.5): `04` §3.6.3
 * re-checks every hydrated item through core `canRead` and fails closed. That is why these
 * signatures return references and items rather than promising they are readable.
 */
import type { EntityId, GroupId, MemoryId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { EligibleLabelSet } from '../../ifc/eligible.js';
import type { MemoryItem, MemoryKind, RetrievalState } from '../../memory/item.js';
import type { SubjectRef } from '../../memory/subjects.js';

/**
 * A reference with a score, for a channel that ranks (`04` §3.6.4 fuses them).
 *
 * The score's **direction differs by channel**, which is why it is named rather than called
 * `score`: FTS `bm25` is lower-is-better and a vector distance is also lower-is-better, so this
 * one is uniformly "smaller is closer". `04`'s fusion depends on that being true of every channel,
 * and a channel that returned a similarity would silently invert its own ranking.
 */
export interface ScoredRef<T> {
  readonly ref: T;
  readonly rid: number;
  /** Lower is closer, in every channel. */
  readonly distance: number;
}

/** How far down `04` R5's retrieval states a query reaches. `1` is the default. */
export type MaxRetrievalState = RetrievalState;

/** The FTS tokenizer a text query uses (`02` §3.4). */
export type TextSearchMode = 'word' | 'trigram';

export interface TextQuery {
  readonly groupId: GroupId;
  readonly query: string;
  /**
   * `word` uses `memory_fts` (`unicode61`), `trigram` uses `memory_fts_tri`.
   *
   * `04` decides which; `02` §3.4 records the measured constraint that drives it — **a one- or
   * two-character query matches nothing at all** in trigram mode, and for CJK that is most short
   * queries, because two characters is a whole word.
   */
  readonly mode: TextSearchMode;
  readonly limit: number;
  readonly kinds?: readonly MemoryKind[] | undefined;
  readonly maxState: MaxRetrievalState;
  readonly eligible: EligibleLabelSet;
}

export interface VectorQuery {
  readonly groupId: GroupId;
  /** Unit-normalized; the default L2 metric then ranks the same as cosine (`02` §3.5). */
  readonly vector: Float32Array;
  readonly k: number;
  readonly kinds?: readonly MemoryKind[] | undefined;
  readonly maxState: MaxRetrievalState;
  /**
   * `null` includes history (`02` §3.5: "omitted when 04 asks for history").
   *
   * An instant means "valid at this moment", which is the ordinary case. The distinction is a
   * value rather than a boolean because the instant is also the comparison, and a separate
   * `includeHistory` flag plus a `now` would let the two disagree.
   */
  readonly validAt: Temporal.Instant | null;
  readonly eligible: EligibleLabelSet;
}

export interface EntityQuery {
  readonly groupId: GroupId;
  readonly entityIds: readonly EntityId[];
  readonly limit: number;
  readonly maxState: MaxRetrievalState;
  readonly eligible: EligibleLabelSet;
}

export interface AliasQuery {
  readonly groupId: GroupId;
  /** NFKC-lowered alias forms (`02` §3.3.4's `alias_norm`). */
  readonly aliasNorms: readonly string[];
  readonly eligible: EligibleLabelSet;
}

export interface SubjectQuery {
  readonly groupId: GroupId;
  readonly subjectRefs: readonly SubjectRef[];
  readonly limit: number;
  readonly maxState: MaxRetrievalState;
  readonly eligible: EligibleLabelSet;
}

export interface RecentQuery {
  readonly groupId: GroupId;
  readonly limit: number;
  readonly since?: Temporal.Instant | undefined;
  readonly maxState: MaxRetrievalState;
  readonly eligible: EligibleLabelSet;
}

/** An alias that matched, and the entity it names (Q-CTX-8). */
export interface AliasMatch {
  readonly entityId: EntityId;
  readonly aliasNorm: string;
}

/** `02` §3.7.1's `MemorySearchPort`. */
export interface MemorySearchPort {
  /** Q-CTX-2: FTS over `statement` and `terms`, weighted `1.0, 0.8, 0.0`. */
  text(query: TextQuery): readonly ScoredRef<MemoryId>[];
  /** Q-CTX-3: vec0 KNN, filters evaluated into a bitmap before the distance computation. */
  vector(query: VectorQuery): readonly ScoredRef<MemoryId>[];
  /** `04` §3.6.3's entity channel, through `memory_item_entities`. */
  byEntities(query: EntityQuery): readonly ScoredRef<MemoryId>[];
  /** Q-CTX-8: readable entity aliases by normalized form. */
  aliases(query: AliasQuery): readonly AliasMatch[];
  /** Q-CTX-4: memories about a subject, newest validity first. */
  bySubjects(query: SubjectQuery): readonly MemoryItem[];
  /** Q-CTX-5: recent active memories. */
  recent(query: RecentQuery): readonly MemoryItem[];
  /**
   * Load items by id, dropping any this audience may not read.
   *
   * The drop is silent, for the same reason the message reader's is: a trace's context manifest
   * holds ids only (`02` §3.3.9), so the dashboard re-checks eligibility at render time and shows
   * one member a row it hides from another.
   */
  hydrate(ids: readonly MemoryId[], eligible: EligibleLabelSet): readonly MemoryItem[];
}
