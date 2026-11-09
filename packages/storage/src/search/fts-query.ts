/**
 * The FTS5 query builder (`02` §3.4, `04` §3.6.3).
 *
 * **User text is never passed raw to `MATCH`.** `02` §3.4 calls that "a syntax-injection and crash
 * vector", and both halves are literal: FTS5's `MATCH` grammar has operators (`AND`, `OR`, `NOT`,
 * `NEAR`, `*`, `^`, `:`, `{`, `}`, `(`, `)`, `"`) so a message containing `a OR b` would change the
 * query's meaning, and a malformed expression raises `SQLITE_ERROR` out of the middle of a context
 * build. Every term here is emitted as a **quoted phrase**, which has no grammar inside it.
 *
 * ## The column list is a parameter, and `02` §3.4's snippet is wrong about it
 *
 * The spec's `buildFtsQuery` emits `body : "term"` unconditionally — but `memory_fts` has columns
 * `(statement, terms, scope)` and no `body` at all, so that query would raise `no such column:
 * body`. `04` §3.6.3 shows the right form for it, a column-filter *group*:
 * `{statement terms} : ("dentist" OR "leo")`. `messages_fts` and `entity_fts` really do have
 * `body`; `memory_fts_tri` has `body` and **no** `scope`. So the columns are per-table and belong
 * in the call, not in the function. Spec amended; see STATUS → Plan changes.
 *
 * ## Quoting
 *
 * A double quote inside an FTS5 phrase is escaped by doubling it, which is the same rule as SQL
 * string literals. `"` is the only character that needs it: inside a phrase, everything else is a
 * token separator or a token.
 */
/** `02` §3.4: at most this many terms reach the query, so a paste cannot build a huge expression. */
export const FTS_MAX_TERMS = 16;

/**
 * `02` §3.4: the trigram tokenizer needs three characters.
 *
 * Measured in `M1-T2` and worth repeating where the code enforces it: **a one- or two-character
 * query matches nothing at all**, and for CJK that is most short queries, because two characters
 * is a whole word. `04`'s retrieval falls back to vector search below this length rather than
 * returning an empty result.
 */
export const TRIGRAM_MIN_LENGTH = 3;

/** Word mode drops terms shorter than this, where a single letter matches most of the corpus. */
const WORD_MIN_LENGTH = 2;

/** The columns of each FTS table a query may filter on (`02` §3.4). */
export const FTS_COLUMNS = {
  messages_fts: ['body'],
  memory_fts: ['statement', 'terms'],
  memory_fts_tri: ['body'],
  entity_fts: ['body'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type FtsTable = keyof typeof FTS_COLUMNS;

/** Which tables carry a `scope` column (`memory_fts_tri` does not — `02` §3.4). */
export const FTS_HAS_SCOPE = {
  messages_fts: true,
  memory_fts: true,
  memory_fts_tri: false,
  entity_fts: true,
} as const satisfies Readonly<Record<FtsTable, boolean>>;

/**
 * `02` §3.4's scope token: `'g' || substr(group_id, 5)`.
 *
 * A single alphanumeric token, so the FTS index intersects the group's doclist instead of scanning
 * other groups' matches. `substr(…, 5)` drops the `grp_` prefix — written here as a slice past the
 * brand-independent prefix length rather than a hard-coded 4, since the prefix is `02`'s and not
 * the product's.
 */
export function scopeToken(groupId: string): string {
  // `grp_` is four characters and SQLite's `substr` is 1-based, hence its `5`. The underscore is
  // what the token must not contain, because `unicode61` would split on it.
  return `g${groupId.slice('grp_'.length)}`;
}

/**
 * Split input into word-like tokens.
 *
 * `Intl.Segmenter` with `granularity: 'word'` and `isWordLike`, per `02` §3.4 — which is what makes
 * this work for scripts with no spaces. A `split(/\s+/)` would treat a whole Japanese sentence as
 * one token, and a `split(/\W+/)` would break on every non-ASCII letter.
 *
 * `'und'` as the locale, deliberately: the input's language is not known at this point (a group
 * chat mixes languages in one message), and naming a locale would apply its word rules to text
 * that is not in it.
 */
export function tokenizeForFts(input: string): readonly string[] {
  const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
  const terms: string[] = [];
  for (const segment of segmenter.segment(input)) {
    if (segment.isWordLike === true) terms.push(segment.segment);
  }
  return terms;
}

/** NFKC then lower-case, matching what `unicode61 remove_diacritics 2` folds to. */
export function normalizeTerm(term: string): string {
  return term.normalize('NFKC').toLocaleLowerCase('en-US');
}

export interface FtsQueryOptions {
  readonly table: FtsTable;
  readonly scopeToken?: string | undefined;
  /** `all` joins with `AND`, `any` with `OR`. `04` picks; `any` is the recall-friendly default. */
  readonly mode: 'any' | 'all';
  /** Treat the last term as a prefix, for type-ahead. Never in trigram mode. */
  readonly prefixLast?: boolean | undefined;
  readonly maxTerms?: number | undefined;
}

/**
 * Build a `MATCH` expression, or `null` when there is nothing to search for.
 *
 * `null` rather than an empty string, because an empty `MATCH` is a syntax error and a caller that
 * passed one through would turn "the user typed two spaces" into a failed turn. Every caller
 * checks for `null` and skips the FTS channel.
 */
export function buildFtsQuery(input: string, options: FtsQueryOptions): string | null {
  const columns = FTS_COLUMNS[options.table];
  const maxTerms = options.maxTerms ?? FTS_MAX_TERMS;
  const terms = tokenizeForFts(input)
    .map(normalizeTerm)
    .filter((term) => term.length >= WORD_MIN_LENGTH)
    .slice(0, maxTerms);
  if (terms.length === 0) return null;

  const prefixLast = options.prefixLast ?? false;
  const phrases = terms.map((term, index) => {
    const quoted = `"${term.replaceAll('"', '""')}"`;
    // FTS5 spells a prefix as `"term" *` — the asterisk is outside the phrase.
    return prefixLast && index === terms.length - 1 ? `${quoted} *` : quoted;
  });
  const joined = phrases.join(options.mode === 'all' ? ' AND ' : ' OR ');
  // A column filter group when the table has several searchable columns, a bare filter when it has
  // one. `{a b} : (…)` is FTS5's spelling for "match in either column".
  // `columns.join(' ')` for both arms: for a single column it is that column's name, which is
  // exactly the bare filter FTS5 wants — so there is no index access to guard and no unreachable
  // fallback. (A first version wrote `columns[0] ?? ''`, and the lint was right that the `??` was
  // dead: `FTS_COLUMNS` is a tuple type, so TypeScript knows the first element exists.)
  const names = columns.join(' ');
  const filter = columns.length === 1 ? `${names} :` : `{${names}} :`;
  const body = `${filter} (${joined})`;
  if (options.scopeToken === undefined) return body;
  if (!FTS_HAS_SCOPE[options.table]) {
    // `memory_fts_tri` has no `scope` column, so a scoped query against it would raise `no such
    // column`. The caller filters by joining `memory_items.group_id` instead (`02` §3.4).
    return body;
  }
  return `scope : "${options.scopeToken}" AND (${body})`;
}

/**
 * Build a trigram `MATCH`, or `null` when the input is too short to match anything.
 *
 * Separate from `buildFtsQuery` because the trigram tokenizer does not take words: `02` §3.4 says
 * the query is "built from the raw normalized string", so splitting it into terms would be the one
 * transformation that defeats the point — a substring query for `nnweg` has to stay one substring.
 */
export function buildTrigramQuery(input: string): string | null {
  const normalized = normalizeTerm(input).trim();
  if (normalized.length < TRIGRAM_MIN_LENGTH) return null;
  return `body : "${normalized.replaceAll('"', '""')}"`;
}

/**
 * Whether a query is long enough for the trigram index to match anything.
 *
 * Exported so `04`'s retrieval can make the fall-back decision `02` §3.4 asks for — "fall back to
 * vector search below three characters rather than returning an empty result" — without
 * re-deriving the threshold. Named for the question rather than the number, so a reader at the call
 * site sees the reason.
 */
export function trigramCanMatch(input: string): boolean {
  return normalizeTerm(input).trim().length >= TRIGRAM_MIN_LENGTH;
}

/** `memory_fts`'s bm25 weights (`02` §3.4, `04` §3.6.3): statement, terms, scope. */
export const MEMORY_BM25_WEIGHTS = [1.0, 0.8, 0.0] as const;
