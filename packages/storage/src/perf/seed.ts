/**
 * The performance fixture generator (`02` §3.16.5).
 *
 * Every latency in `02` §3.16.4 is stated over a *shape* of data, not a row count: a message FTS
 * query against a million identical sentences is a different query plan from one against a
 * Zipf-distributed vocabulary, and a KNN search over uniform random vectors is nearly meaningless
 * because in 384 dimensions uniform points are all about equally far apart. So this generator
 * reproduces the distributions §3.16.5 specifies — Zipf text, lognormal lengths, a diurnal clock,
 * Zipf senders with one organizer, the real label mix, and vectors clustered around 64 centroids
 * per group — and the benches measure against that.
 *
 * ## What it does not own
 *
 * It takes an **open, migrated database**. Opening one means locating the migrations, and
 * `.dependency-cruiser.cjs`'s `testing-subpath-only-from-tests` rightly refuses production code
 * that reaches for a package's `testing` subpath — which is where the migration helpers live. The caller owns the
 * connection; this owns the data. That is better layering anyway: a fixture generator that also
 * decided where the database lived could not be pointed at an existing one.
 *
 * ## The write path
 *
 * Raw prepared statements inside 10,000-row transactions, with triggers **enabled**, which is
 * §3.16.5's instruction and the right one: the FTS and vec triggers are a real part of what an
 * insert costs, and a fixture generated without them would make every search bench measure an
 * index that production would have paid for differently. Labels and reader sets go through
 * `LabelStore` — there are a handful of them and interning is the one part of this where being
 * wrong would make every later measurement meaningless (`I4`).
 *
 * Specification: `docs/plan/02-domain-model-and-storage.md` §3.16.5, §3.16.4.
 */
import type { Label } from '@comvivo/core';
import { expectWritten } from '@comvivo/core';
import type { GroupId, IdGenerator, Logger, MemberId, PersonId, Rng } from '@comvivo/shared';
import { sha256 } from '@comvivo/shared/crypto';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { SqliteStore } from '../db/tx.js';
import { LabelStore } from '../ifc/label-store.js';
import { EmbeddingSpaceManager } from '../search/embedding-spaces.js';
import { VALID_TO_OPEN_ENDED, vec0TableName } from '../search/vec0.js';

/** One group's shape. `02` §3.16.5's `groups[]` entry. */
export interface SeedGroupSpec {
  readonly members: number;
  readonly days: number;
  readonly msgsPerDay: number;
  readonly memoriesTotal: number;
  /** Share of messages in a DM conversation, labelled `{member}`. */
  readonly dmShare: number;
  /** Share of memories owned privately by one member. */
  readonly privateMemoryShare: number;
  /** Share of rows carrying a multi-member subgroup label. */
  readonly subgroupShare: number;
  readonly attachmentsPerDay: number;
}

export type SeedLanguage = 'en' | 'es' | 'de' | 'fr' | 'pt' | 'hi-Latn' | 'ar' | 'ja';

export interface SeedProfile {
  /**
   * `02` §3.16.5's four, plus `knn-50k`.
   *
   * The fifth exists because §3.16.4 has a row for "KNN k=64 over **50k vectors in one
   * partition**" and none of the four profiles produces one: the stress profile's largest group
   * holds 30k memories by §3.16.5's own definition, and the 50k total is spread over five groups —
   * which is a different query, because a vec0 partition key *is* the group. Amended there.
   */
  readonly name: 'release-small' | 'family-1y' | 'busy-3y' | 'stress-50k-1m' | 'knn-50k';
  /** `02` §3.16.5: default 42. The same seed gives the same database, byte for byte. */
  readonly seed: number;
  readonly groups: readonly SeedGroupSpec[];
  readonly languages: readonly { readonly code: SeedLanguage; readonly weight: number }[];
  readonly embedding: {
    readonly dims: 384;
    readonly clustersPerGroup: number;
    readonly noiseSigma: number;
  };
}

/** `02` §3.16.5's language mix. English-heavy, because the shipped evals are. */
const LANGUAGES: readonly { code: SeedLanguage; weight: number }[] = Object.freeze([
  { code: 'en', weight: 0.5 },
  { code: 'es', weight: 0.1 },
  { code: 'de', weight: 0.08 },
  { code: 'fr', weight: 0.08 },
  { code: 'pt', weight: 0.08 },
  { code: 'hi-Latn', weight: 0.06 },
  { code: 'ar', weight: 0.05 },
  { code: 'ja', weight: 0.05 },
]);

const EMBEDDING = Object.freeze({ dims: 384, clustersPerGroup: 64, noiseSigma: 0.35 } as const);

const FAMILY: SeedGroupSpec = {
  members: 5,
  days: 365,
  msgsPerDay: 200,
  memoriesTotal: 2_000,
  dmShare: 0.1,
  privateMemoryShare: 0.04,
  subgroupShare: 0.01,
  attachmentsPerDay: 8,
};

/**
 * `02` §3.16.5's four profiles.
 *
 * `release-small` is the one CI runs on every push: large enough that the query plans are the
 * production ones, small enough to finish inside a job. The three others are the capacity
 * profiles §3.16.1 and §3.16.3 are written about.
 */
export const SEED_PROFILES: Readonly<Record<SeedProfile['name'], SeedProfile>> = Object.freeze({
  'release-small': {
    name: 'release-small',
    seed: 42,
    groups: [{ ...FAMILY, days: 30, msgsPerDay: 200, memoriesTotal: 2_000 }],
    languages: LANGUAGES,
    embedding: EMBEDDING,
  },
  'family-1y': {
    name: 'family-1y',
    seed: 42,
    groups: [FAMILY],
    languages: LANGUAGES,
    embedding: EMBEDDING,
  },
  'busy-3y': {
    name: 'busy-3y',
    seed: 42,
    groups: [
      {
        members: 60,
        days: 1_095,
        msgsPerDay: 1_500,
        memoriesTotal: 27_000,
        dmShare: 0.1,
        privateMemoryShare: 0.04,
        subgroupShare: 0.01,
        attachmentsPerDay: 40,
      },
    ],
    languages: LANGUAGES,
    embedding: EMBEDDING,
  },
  // `02` §3.16.5: "5 groups; group 0 = 600k msgs / 30k memories / 150 members; others 100k msgs /
  // 5k memories". One group holds the majority, which is what makes a group-scoped query's
  // selectivity realistic — a dataset split evenly across five groups would make every
  // `WHERE group_id = ?` look five times better than production.
  // One group with 50k memories and few messages: §3.16.4's second KNN row, which asks for 50k
  // vectors in a single partition. Few messages because the row is about the vector index.
  'knn-50k': {
    name: 'knn-50k',
    seed: 42,
    groups: [
      {
        members: 20,
        days: 50,
        msgsPerDay: 100,
        memoriesTotal: 50_000,
        dmShare: 0.1,
        privateMemoryShare: 0.04,
        subgroupShare: 0.01,
        attachmentsPerDay: 8,
      },
    ],
    languages: LANGUAGES,
    embedding: EMBEDDING,
  },
  'stress-50k-1m': {
    name: 'stress-50k-1m',
    seed: 42,
    groups: [
      {
        members: 150,
        days: 600,
        msgsPerDay: 1_000,
        memoriesTotal: 30_000,
        dmShare: 0.1,
        privateMemoryShare: 0.04,
        subgroupShare: 0.01,
        attachmentsPerDay: 40,
      },
      ...Array.from({ length: 4 }, () => ({
        members: 20,
        days: 400,
        msgsPerDay: 250,
        memoriesTotal: 5_000,
        dmShare: 0.1,
        privateMemoryShare: 0.04,
        subgroupShare: 0.01,
        attachmentsPerDay: 8,
      })),
    ],
    languages: LANGUAGES,
    embedding: EMBEDDING,
  },
});

export interface SeedReport {
  readonly profile: SeedProfile['name'];
  readonly groups: readonly GroupId[];
  readonly messages: number;
  readonly memories: number;
  readonly vectors: number;
  readonly elapsedMs: number;
  readonly rowsPerSecond: number;
  /** How many planted `perfneedle<n>` terms were written, so recall can be checked. */
  readonly needles: number;
  /** The slug of the embedding space the vectors went into. */
  readonly spaceSlug: string;
}

export interface SeedOptions {
  readonly db: Db;
  readonly connection: Database;
  readonly ids: IdGenerator;
  readonly rng: Rng;
  readonly logger: Logger;
  /** Called after each 10,000-row transaction, for a progress line on a run that takes minutes. */
  readonly onProgress?: (written: number, total: number) => void;
}

/**
 * The first instant of every generated history.
 *
 * A constant rather than an option: the fixture's whole value is that a measurement taken today is
 * comparable with one taken next month, and a timestamp base that moved with the wall clock would
 * give the retention and recent-window rows a different distance from `now` on every run. Exported
 * so a bench that needs a cutoff can compute one from the same anchor the rows were written at.
 */
export const SEED_EPOCH = Temporal.Instant.from('2026-01-01T00:00:00Z');

/** `02` §3.16.5: rows per transaction. */
const BATCH = 10_000;

/** 2% of messages carry a planted term, so a recall check has something to find. */
const NEEDLE_SHARE = 0.02;

/* --- distributions ---------------------------------------------------------------------------- */

/**
 * A Zipf(s) sampler over `size` items, as a cumulative table.
 *
 * Precomputed because the alternative — rejection sampling per draw — costs a multiple of the
 * draws for a million messages, and this generator's own runtime is a target in §3.16.5 (≤ 4 min
 * for the stress profile on a CI runner).
 */
export function zipfTable(size: number, s = 1.1): readonly number[] {
  const weights = Array.from({ length: size }, (_, index) => 1 / (index + 1) ** s);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let running = 0;
  return weights.map((weight) => {
    running += weight / total;
    return running;
  });
}

/**
 * Draw an index from a cumulative table. Binary search, so a 5,000-word vocabulary is 13 steps.
 *
 * The `undefined` arm is a **malformed table**, not a missing element: `low <= middle < length`
 * holds for every iteration, so the only way to reach it is to pass a table with a hole in it. It
 * throws rather than falling back, because the three draws built on this function all feed
 * measurements — a silent `?? 1` would quietly bias a distribution that the benchmark numbers are
 * statements about. `seed.test.ts` reaches it with a sparse table.
 */
export function drawFrom(cumulative: readonly number[], unit: number): number {
  let low = 0;
  let high = cumulative.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const boundary = cumulative[middle];
    if (boundary === undefined) throw new RangeError('a cumulative table cannot have a hole');
    if (boundary < unit) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * An element of a list, by an index this generator computed.
 *
 * One guard, reachable and tested, in place of a `?? fallback` at each of a dozen call sites. The
 * alternative — `fixture.memberIds[member] ?? null` — is a dozen branches that cannot run, because
 * every index here is derived from the length of the very list it indexes, and `crypto/random.ts`
 * already records what that costs: they read as handled cases and show as missed coverage forever.
 * Out of range means the fixture is malformed, which is a bug rather than an input, so it throws
 * instead of substituting a row that would quietly bias a measurement.
 */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`index ${String(index)} is outside a list of ${String(items.length)}`);
  }
  return item;
}

/** A uniform choice from a list. */
export function pick<T>(items: readonly T[], rng: Rng): T {
  return at(items, Math.floor(rng.next() * items.length));
}

/** The same, weighted by a cumulative table of the list's own length. */
export function pickWeighted<T>(items: readonly T[], cumulative: readonly number[], rng: Rng): T {
  return at(items, drawFrom(cumulative, rng.next()));
}

/** A standard normal, by Box–Muller. Needed for lognormal lengths and for vector noise. */
export function standardNormal(rng: Rng): number {
  // `1 - next()` because `next()` can return exactly 0 and `log(0)` is not a number.
  const u = 1 - rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * `02` §3.16.5's diurnal weight curve: peaks at 08:00 and 20:00 local.
 *
 * Two Gaussians over the hour of day. It matters for more than realism: the recent-window query
 * (Q-CTX-1) reads by `(conversation_id, rid)` and the retention sweep reads by `retention_until`,
 * and both are sensitive to how messages clump in time.
 */
export function diurnalWeights(): readonly number[] {
  const bump = (hour: number, centre: number): number =>
    Math.exp(-((hour - centre) ** 2) / (2 * 2.5 ** 2));
  return Array.from({ length: 24 }, (_, hour) => 0.15 + bump(hour, 8) + bump(hour, 20));
}

/**
 * 5,000 synthetic lemmas for one language.
 *
 * `02` §3.16.5 asks for `fixtures/perf/vocab/<lang>.txt`, "5k synthetic lemmas per language,
 * generated, no copyrighted corpora". They are generated **here**, from the seed, rather than
 * committed: 40,000 lines of synthetic noise in the repository would be 400 KB nobody ever reads,
 * and a vocabulary derived from the seed is reproducible in the one way that matters — the same
 * seed gives the same words, so two runs index the same terms. `seed.test.ts` pins the first few
 * per language, so a change to the generator is visible rather than silent.
 *
 * The syllable sets differ per language so that token length and character distribution differ
 * too, which is what the FTS tokenizer and the trigram index actually see. `ja` and `ar` use
 * transliterated syllables rather than their scripts: the trigram tokenizer's behaviour on CJK is
 * `02` §3.6.1's own subject and is measured there, not smuggled into every text bench.
 */
export function vocabularyFor(language: SeedLanguage, rng: Rng, size = 5_000): readonly string[] {
  const syllables: Record<SeedLanguage, readonly string[]> = {
    en: ['ta', 'ber', 'lin', 'mo', 'sted', 'ken', 'ro', 'ful', 'ing', 'ly'],
    es: ['ca', 'lle', 'mi', 'ento', 'ra', 'dor', 'ni', 'cion', 'tar', 'illo'],
    de: ['ber', 'schaft', 'lich', 'ung', 'stadt', 'zeit', 'wer', 'heit', 'bahn', 'kraft'],
    fr: ['che', 'ment', 'eau', 'ier', 'tion', 'ais', 'oir', 'elle', 'ard', 'ure'],
    pt: ['nho', 'ção', 'inha', 'mente', 'dade', 'eiro', 'ar', 'oso', 'lha', 'ento'],
    'hi-Latn': ['kar', 'na', 'hai', 'ghar', 'baat', 'aaj', 'kal', 'wala', 'tha', 'dena'],
    ar: ['kit', 'ab', 'mad', 'ras', 'sa', 'lam', 'bay', 'tun', 'shu', 'kran'],
    ja: ['ka', 'shi', 'tsu', 'ne', 'ro', 'mi', 'ta', 'kyo', 'sa', 'hon'],
  };
  const parts: readonly string[] = syllables[language];
  const words = new Set<string>();
  // A set, because an FTS vocabulary with duplicates is a vocabulary of fewer distinct terms than
  // the number says — and the number is what the index size is reasoned about from.
  while (words.size < size) {
    const count = 2 + Math.floor(rng.next() * 3);
    let word = '';
    for (let part = 0; part < count; part += 1) word += pick(parts, rng);
    words.add(`${language.replace('-', '')}${word}`);
  }
  return [...words];
}

/* --- the generator ---------------------------------------------------------------------------- */

interface GroupFixture {
  readonly index: number;
  readonly groupId: GroupId;
  readonly spec: SeedGroupSpec;
  readonly memberIds: readonly MemberId[];
  readonly conversationIds: readonly string[];
  readonly groupLabelId: number;
  readonly dmLabelIds: readonly number[];
  readonly privateLabelIds: readonly number[];
  readonly subgroupLabelId: number;
  readonly centroids: readonly Float32Array[];
}

/**
 * Generate a fixture into `connection`, and report what it wrote.
 *
 * Deterministic: the same profile and seed produce the same rows, so a measurement taken today is
 * comparable with one taken next month. Nothing here reads the clock except for the report's
 * elapsed time.
 */
export function seedPerfDatabase(profile: SeedProfile, options: SeedOptions): SeedReport {
  const started = performance.now();
  const { connection, ids, rng, logger } = options;
  const startedAt = SEED_EPOCH;
  const store = new SqliteStore({
    db: connection,
    clock: { now: () => startedAt },
    logger,
    ids,
    rng,
    // A 10,000-row batch is *expected* to take a few hundred milliseconds, so the default
    // `slowTxMs` of 50 would log `storage.slow_tx` a hundred times for the stress profile and
    // teach whoever reads that log to ignore it. Raised here rather than silenced: a fixture batch
    // over a minute really is a problem worth a line.
    slowTxMs: 60_000,
  });
  const labels = new LabelStore(connection);
  const spaces = new EmbeddingSpaceManager({ db: options.db, connection, ids });

  const space = store.write((uow) =>
    spaces.ensure(uow, {
      provider: 'local',
      model: 'multilingual-e5-small',
      dims: profile.embedding.dims,
    }),
  );

  // Each language paired with its own words, rather than a map plus a parallel weight list: the
  // weighted draw in `sentence` then yields the vocabulary directly, so there is no lookup that
  // could miss and no guard for a miss that could never happen.
  const vocabularies: readonly SeedVocabulary[] = profile.languages.map(({ code }) => ({
    code,
    words: vocabularyFor(code, rng),
  }));
  const languageTable = cumulativeOf(profile.languages.map((entry) => entry.weight));
  const wordTable = zipfTable(5_000);
  const hourTable = cumulativeOf(diurnalWeights());

  const fixtures = profile.groups.map((spec, index) =>
    buildGroup(spec, index, { ...options, store, labels, profile }),
  );

  let messages = 0;
  let memories = 0;
  let vectors = 0;
  let needles = 0;
  const totalRows = profile.groups.reduce(
    (sum, spec) => sum + spec.days * spec.msgsPerDay + spec.memoriesTotal,
    0,
  );

  for (const fixture of fixtures) {
    const written = writeMessages(fixture, {
      ...options,
      store,
      startedAt,
      vocabularies,
      languageTable,
      wordTable,
      hourTable,
      profile,
      onWritten: (count) => options.onProgress?.(messages + memories + count, totalRows),
    });
    messages += written.messages;
    needles += written.needles;

    const stored = writeMemories(fixture, {
      ...options,
      store,
      startedAt,
      vocabularies,
      languageTable,
      wordTable,
      profile,
      spaceSlug: space.slug,
      onWritten: (count) => options.onProgress?.(messages + memories + count, totalRows),
    });
    memories += stored.memories;
    vectors += stored.vectors;
  }

  const elapsedMs = performance.now() - started;
  return {
    profile: profile.name,
    groups: fixtures.map((fixture) => fixture.groupId),
    messages,
    memories,
    vectors,
    elapsedMs,
    rowsPerSecond: Math.round(((messages + memories) / elapsedMs) * 1000),
    needles,
    spaceSlug: space.slug,
  };
}

/** Normalise weights into a cumulative table. */
function cumulativeOf(weights: readonly number[]): readonly number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let running = 0;
  return weights.map((weight) => {
    running += weight / total;
    return running;
  });
}

/** Everything a group needs before a single message can be written. */
function buildGroup(
  spec: SeedGroupSpec,
  index: number,
  context: SeedOptions & { store: SqliteStore; labels: LabelStore; profile: SeedProfile },
): GroupFixture {
  const { store, labels, rng, profile } = context;
  const groupId = perfId('grp', index, 0) as GroupId;
  const memberIds: MemberId[] = [];
  const conversationIds: string[] = [];

  const interned = store.write((uow) => {
    context.connection
      .prepare(
        `INSERT INTO groups (id, name, archetype, timezone, locale, week_start, status, membership_epoch, created_at, updated_at, version)
         VALUES (?, ?, 'family', 'UTC', 'en', 1, 'active', 1, ?, ?, 1)`,
      )
      .run(groupId, `perf group ${String(index)}`, 0, 0);

    const insertPerson = context.connection.prepare(
      `INSERT INTO persons (id, display_name, display_name_source, created_at, updated_at)
       VALUES (?, ?, 'platform', 0, 0)`,
    );
    const insertMember = context.connection.prepare(
      `INSERT INTO members (id, group_id, person_id, role, age_band, handle, status, consent, joined_at, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, 'adult', ?, 'active', 'memory_on', 0, 0, 0, 1)`,
    );
    for (let member = 0; member < spec.members; member += 1) {
      const personId = perfId('prs', index, member) as PersonId;
      const memberId = perfId('mbr', index, member) as MemberId;
      insertPerson.run(personId, `member ${String(member)}`);
      insertMember.run(
        memberId,
        groupId,
        personId,
        member === 0 ? 'admin' : 'member',
        `m${String(member)}`,
      );
      memberIds.push(memberId);
    }

    const insertConversation = context.connection.prepare(
      // `member_id` is part of the DM constraint rather than decoration: `conversations_dm_ck`
      // makes `kind='dm'` and a non-null member imply each other, which is `03` §3.4.4's rule
      // that a DM has exactly one other party.
      `INSERT INTO conversations (id, group_id, channel, platform_chat_id, kind, member_id, "primary", bound_at, created_at, updated_at)
       VALUES (?, ?, 'simulator', ?, ?, ?, ?, 0, 0, 0)`,
    );
    // One group conversation plus one DM per member: `02` §3.16.5's `dmShare` needs somewhere for
    // the DM traffic to live, and Q-CTX-1 reads by conversation.
    conversationIds.push(perfId('cnv', index, 0));
    insertConversation.run(conversationIds[0], groupId, `chat-${String(index)}`, 'group', null, 1);
    for (let member = 0; member < spec.members; member += 1) {
      const id = perfId('cnv', index, member + 1);
      conversationIds.push(id);
      insertConversation.run(
        id,
        groupId,
        `dm-${String(index)}-${String(member)}`,
        'dm',
        at(memberIds, member),
        0,
      );
    }

    const groupLabel = labels.intern(uow, labelFor(groupId, 'group'));
    const dmLabels = memberIds.map((memberId) =>
      labels.intern(uow, labelFor(groupId, 'members', [memberId])),
    );
    const privateLabels = memberIds.map((memberId) =>
      labels.intern(uow, labelFor(groupId, 'members', [memberId], 'personal', memberId)),
    );
    // One subgroup label, over the first three members or as many as exist.
    const subgroup = labels.intern(
      uow,
      labelFor(groupId, 'members', memberIds.slice(0, Math.min(3, memberIds.length))),
    );
    return { groupLabel, dmLabels, privateLabels, subgroup };
  });

  const centroids = Array.from({ length: profile.embedding.clustersPerGroup }, () =>
    unitVector(profile.embedding.dims, rng),
  );

  return {
    index,
    groupId,
    spec,
    memberIds,
    conversationIds,
    groupLabelId: interned.groupLabel,
    dmLabelIds: interned.dmLabels,
    privateLabelIds: interned.privateLabels,
    subgroupLabelId: interned.subgroup,
    centroids,
  };
}

/** Lowercase Crockford base32 — the alphabet a typeid suffix is read back with. */
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * A distinct id for row `ordinal` of group `groupIndex`.
 *
 * Every id in this generator goes through here, and three mistakes are baked into its shape.
 * **Left**-padding, because the first version right-padded to 26 characters with zeros — so
 * ordinals `1`, `10` and `100` became the same id, and the run died on `UNIQUE constraint failed:
 * messages.id`. **Crockford** base32 rather than `toString(36)`, because the id columns parse what
 * they read and base 36 contains `i`, `l`, `o` and `u`, which a typeid suffix does not. And
 * **one function for all of them**: the same padding bug then appeared again in the member ids,
 * 150 members into the stress profile, because that spelling was written out separately.
 */
function perfId(prefix: string, groupIndex: number, ordinal: number): string {
  let rest = ordinal;
  let digits = '';
  do {
    digits = CROCKFORD.charAt(rest % 32) + digits;
    rest = Math.floor(rest / 32);
  } while (rest > 0);
  const body = `${CROCKFORD.charAt(groupIndex % 32)}${digits.padStart(22, '0')}`;
  return `${prefix}_01j${body}`;
}

/** A label, in the shape `LabelStore` interns. */
function labelFor(
  groupId: GroupId,
  kind: 'group' | 'members',
  memberIds: readonly MemberId[] = [],
  sensitivity: Label['sensitivity'] = 'normal',
  owner: Label['owner'] = 'group',
): Label {
  return {
    groupId,
    readers:
      kind === 'group'
        ? { kind: 'group', groupId }
        : { kind: 'members', groupId, memberIds: [...memberIds].toSorted() },
    owner,
    coOwners: [],
    sensitivity,
    influence: 'none',
    untrusted: false,
  };
}

/** A unit vector in `dims` dimensions. */
function unitVector(dims: number, rng: Rng): Float32Array {
  const vector = new Float32Array(dims);
  let norm = 0;
  for (let index = 0; index < dims; index += 1) {
    const value = standardNormal(rng);
    vector[index] = value;
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm);
  for (const [index, value] of vector.entries()) vector[index] = value * scale;
  return vector;
}

/** One language's generated words, drawn as a unit. */
interface SeedVocabulary {
  readonly code: SeedLanguage;
  readonly words: readonly string[];
}

interface TextContext {
  readonly rng: Rng;
  readonly vocabularies: readonly SeedVocabulary[];
  readonly languageTable: readonly number[];
  readonly wordTable: readonly number[];
  readonly profile: SeedProfile;
}

/** One message's text: Zipf words, lognormal length, and sometimes a planted needle. */
function sentence(context: TextContext, needle: number | undefined): string {
  const vocabulary = pickWeighted(context.vocabularies, context.languageTable, context.rng).words;
  // Lognormal: median 8 tokens, σ = 0.8 (`02` §3.16.5).
  const tokens = Math.max(1, Math.round(Math.exp(Math.log(8) + 0.8 * standardNormal(context.rng))));
  const words: string[] = [];
  for (let token = 0; token < tokens; token += 1) {
    words.push(pickWeighted(vocabulary, context.wordTable, context.rng));
  }
  if (needle !== undefined) words.push(`perfneedle${String(needle)}`);
  return words.join(' ');
}

/**
 * `02` §3.16.5's sender distribution: Zipf over members, with one organizer carrying about 30%.
 *
 * The organizer is explicit rather than emergent. A pure Zipf over 150 members gives the top
 * member about 20% at s = 1.1, and the shape that matters for the sender index is one member being
 * much busier than the rest — which is what a family or a class group actually looks like.
 */
function senderOf(fixture: GroupFixture, rng: Rng, senderTable: readonly number[]): MemberId {
  if (rng.next() < 0.3) return at(fixture.memberIds, 0);
  return at(
    fixture.memberIds,
    Math.min(1 + drawFrom(senderTable, rng.next()), fixture.memberIds.length - 1),
  );
}

function writeMessages(
  fixture: GroupFixture,
  context: SeedOptions & {
    store: SqliteStore;
    startedAt: Temporal.Instant;
    vocabularies: readonly SeedVocabulary[];
    languageTable: readonly number[];
    wordTable: readonly number[];
    hourTable: readonly number[];
    profile: SeedProfile;
    onWritten: (count: number) => void;
  },
): { messages: number; needles: number } {
  const { connection, rng } = context;
  const insert = connection.prepare(
    `INSERT INTO messages
       (id, group_id, conversation_id, kind, sender_member_id, text, untrusted, label_id,
        sent_at, received_at, delivered_late, truncated, edit_count)
     VALUES (?, ?, ?, 'member', ?, ?, 0, ?, ?, ?, 0, 0, 0)`,
  );
  const senderTable = zipfTable(Math.max(1, fixture.memberIds.length - 1));
  const total = fixture.spec.days * fixture.spec.msgsPerDay;
  const dayMs = 86_400_000;
  let written = 0;
  let needles = 0;

  /**
   * `02` §3.16.5's label mix for one row: the member's DM label, a subgroup label, or the group's.
   *
   * Extracted from the batch below to keep it inside the cognitive-complexity bar, and extracted
   * *here* rather than anywhere larger for one reason: **the draw order is part of the fixture's
   * identity.** §3.16.5's determinism is the guarantee that a measurement taken today compares
   * with one taken next month, and that holds only if the same seed consumes the generator in the
   * same sequence — so a refactor that moves an `rng.next()` past another silently rewrites every
   * row and invalidates every published number. This one consumes the subgroup draw exactly where
   * the inline version did, which is why `senderOf` below is still called from inside the argument
   * list rather than hoisted into a tidier local.
   */
  const labelOf = (isDm: boolean, member: number): number => {
    if (isDm) return at(fixture.dmLabelIds, member);
    return rng.next() < fixture.spec.subgroupShare ? fixture.subgroupLabelId : fixture.groupLabelId;
  };

  // A transaction per batch: `02` §3.16.5's 10,000-row transactions. One transaction for a million
  // rows would hold the write lock for minutes and make the WAL grow without a checkpoint.
  //
  // Through `store.write`, not `connection.transaction`: `02` §3.7.2 reserves transaction opening
  // for `SqliteStore` and the lint rule says why — a raw transaction loses the `IMMEDIATE` lock,
  // the synchronous-callback guard, `afterCommit` ordering and the slow-transaction log. §3.16.5
  // says "raw prepared statements", and they are; what it does not get to decide is who opens the
  // transaction, and a fixture generator writing through the product's own wrapper is a fixture
  // generated the way production writes.
  const batch = (count: number, offset: number): void => {
    for (let index = 0; index < count; index += 1) {
      const ordinal = offset + index;
      const day = Math.floor(ordinal / fixture.spec.msgsPerDay);
      const hour = drawFrom(context.hourTable, rng.next());
      const sentAt =
        context.startedAt.epochMilliseconds +
        day * dayMs +
        hour * 3_600_000 +
        Math.floor(rng.next() * 3_600_000);
      const isDm = rng.next() < fixture.spec.dmShare;
      const member = Math.floor(rng.next() * fixture.memberIds.length);
      const labelId = labelOf(isDm, member);
      const needle = rng.next() < NEEDLE_SHARE ? ordinal : undefined;
      if (needle !== undefined) needles += 1;
      insert.run(
        perfId('msg', fixture.index, ordinal),
        fixture.groupId,
        // Conversation 0 is the group chat and conversation `member + 1` is that member's DM,
        // which is how `seedGroup` above built the list.
        at(fixture.conversationIds, isDm ? member + 1 : 0),
        isDm ? at(fixture.memberIds, member) : senderOf(fixture, rng, senderTable),
        sentence(context, needle),
        labelId,
        sentAt,
        sentAt,
      );
    }
  };

  while (written < total) {
    const count = Math.min(BATCH, total - written);
    const offset = written;
    context.store.write(() => {
      batch(count, offset);
    });
    written += count;
    context.onWritten(written);
  }
  return { messages: written, needles };
}

function writeMemories(
  fixture: GroupFixture,
  context: SeedOptions & {
    store: SqliteStore;
    startedAt: Temporal.Instant;
    vocabularies: readonly SeedVocabulary[];
    languageTable: readonly number[];
    wordTable: readonly number[];
    profile: SeedProfile;
    spaceSlug: string;
    onWritten: (count: number) => void;
  },
): { memories: number; vectors: number } {
  const { connection, rng, profile } = context;
  const insert = connection.prepare(
    `INSERT INTO memory_items
       (id, group_id, kind, content, statement, search_terms, language, fingerprint, label_id,
        provenance, confidence, status, valid_from, contradicts, links, retrieval_state,
        pinned, portable, embedding_state, created_at, updated_at, version)
     VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, ?, ?, 0.9, 'active', ?, '[]', '[]', 0, 0, 0, 'done', ?, ?, 1)`,
  );
  // Every integer is bound as a **BigInt**, exactly as `SqliteMemoryRepository` does: sqlite-vec
  // refuses a JS `number` for an integer column with *Only integers are allowed for primary key
  // values*, because better-sqlite3 binds a number as a float. Mirrored rather than rediscovered.
  const insertVector = connection.prepare(
    `INSERT INTO ${vec0TableName(context.spaceSlug)}
       (rid, group_id, embedding, label_id, kind, state, valid_to_ms)
     VALUES (?, ?, ?, ?, 'fact', ?, ?)`,
  );

  const total = fixture.spec.memoriesTotal;
  let written = 0;
  let vectors = 0;

  // `store.write` for the same reason as the message batches above: `02` §3.7.2 reserves
  // transaction opening for `SqliteStore`.
  const batch = (count: number, offset: number): void => {
    for (let index = 0; index < count; index += 1) {
      const ordinal = offset + index;
      const statement = sentence(context, rng.next() < NEEDLE_SHARE ? ordinal : undefined);
      const member = Math.floor(rng.next() * fixture.memberIds.length);
      const labelId =
        rng.next() < fixture.spec.privateMemoryShare
          ? at(fixture.privateLabelIds, member)
          : rng.next() < fixture.spec.subgroupShare
            ? fixture.subgroupLabelId
            : fixture.groupLabelId;
      const id = perfId('mem', fixture.index, ordinal);
      const createdAt = context.startedAt.epochMilliseconds + ordinal * 60_000;
      // `rid` is `INTEGER PRIMARY KEY`, so the insert's own `lastInsertRowid` *is* the rid — one
      // fewer query per memory than looking it up by `id` (50,000 of them on the stress profile),
      // and no "the row I just wrote is missing" arm that could never run. The FTS and vec triggers
      // insert too, but SQLite restores `last_insert_rowid()` when a trigger ends, so this is the
      // memory's rowid rather than a posting's; `seed.int.test.ts` asserts the mapping on real rows.
      const info = insert.run(
        id,
        fixture.groupId,
        JSON.stringify({
          kind: 'fact',
          attribute: 'topic',
          value: statement.slice(0, 40),
          polarity: 'affirm',
        }),
        statement,
        JSON.stringify(statement.split(' ').slice(0, 5)),
        'en',
        // The dedupe fingerprint is the first 16 bytes of a digest of the statement, which is what
        // `02` §3.5.1 stores — and distinct per row, so the unique index is exercised.
        sha256(statement).subarray(0, 16),
        labelId,
        JSON.stringify({
          source: 'extraction',
          sourceMessageIds: [],
          windowKey: null,
          extractor: null,
          assertion: 'explicit',
          assertedBy: 'system',
          rawConfidence: null,
          calibration: null,
          confirmedBy: [],
          derivedFrom: [],
          turnId: null,
        }),
        createdAt,
        createdAt,
        createdAt,
      );
      // `normalize(centroid + N(0, σ))` — with σ as the noise's **norm**, which is the reading
      // that produces what `02` §3.16.5 asks for.
      //
      // Measured: taken per *dimension*, σ = 0.35 gives a noise vector of expected norm
      // √384 × 0.35 ≈ 6.9 against a unit centroid, so the centroid is irrelevant and every vector
      // is a uniform random direction. The nearest neighbour of 2,000 such vectors sat at 1.287
      // where two uniform ones sit at √2 ≈ 1.414 — in other words, the spec's own parameter, read
      // the obvious way, produces exactly the failure the same paragraph warns about ("uniform
      // random vectors in high dimensions are nearly equidistant, which would make KNN timing and
      // recall unrealistic"). Dividing by √dims makes σ the fraction of the centroid the noise
      // displaces, which is what clusters the data. `02` §3.16.5 amended.
      const centroid = pick(fixture.centroids, rng);
      const perDimension = profile.embedding.noiseSigma / Math.sqrt(profile.embedding.dims);
      const vector = new Float32Array(profile.embedding.dims);
      let norm = 0;
      // Over the centroid's own entries: a typed-array *read* is `number | undefined` under
      // `noUncheckedIndexedAccess` (measured on TypeScript 6.0.3, which older versions did not do),
      // while `entries()` yields a `number` and a write is unaffected. So the loop needs no
      // `?? 0` — which could not have run, since the centroid has `dims` dimensions by
      // construction.
      for (const [dimension, base] of centroid.entries()) {
        const value = base + perDimension * standardNormal(rng);
        vector[dimension] = value;
        norm += value * value;
      }
      const scale = 1 / Math.sqrt(norm);
      for (const [dimension, value] of vector.entries()) vector[dimension] = value * scale;
      insertVector.run(
        BigInt(info.lastInsertRowid),
        fixture.groupId,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        BigInt(labelId),
        BigInt(0),
        BigInt(VALID_TO_OPEN_ENDED),
      );
      vectors += 1;
    }
  };

  while (written < total) {
    const count = Math.min(BATCH, total - written);
    const offset = written;
    context.store.write(() => {
      batch(count, offset);
    });
    written += count;
    context.onWritten(written);
  }
  return { memories: written, vectors };
}

/** Re-exported so a caller can assert a write landed, as the repositories do. */
export { expectWritten };
