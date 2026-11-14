/**
 * `RecordingGateway` — the record half of record-and-replay (`05` §3.5.7; `M2-T7`).
 *
 * Wraps a real adapter in the nightly live evals and stores scrubbed request/response pairs under
 * `fixtures/model/<provider>/`. Those fixtures feed `11` §3.1.9's adapter contract tests and
 * `CassetteModel`'s replay.
 *
 * ## Scrubbing is not optional, and it is not a filter
 *
 * A recording is made from a **live** eval, which means it is made from real prompts. `08` §3.16
 * and `11` §3.1.9's recorder policy both say the same thing: the fixture that lands in the
 * repository must carry no member's name, no phone number, no email, no token and no address. The
 * implementation is a *substitution*, not a redaction: names become personas and digits are
 * shuffled, so the fixture keeps the **shape** of real text — its length, its punctuation, its
 * sentence rhythm — which is what makes it a useful test input. A fixture of `[REDACTED]` tests
 * nothing.
 *
 * Determinism matters as much as coverage: the same name must become the same persona on every
 * pass, or a two-turn conversation stops being a conversation. So the mapping is seeded from the
 * text itself.
 *
 * ## What a pattern can and cannot promise
 *
 * The M2 second-pass review measured the gap between the paragraph above and the code, and it was
 * wide. `NAME_LIKE` is `\p{Lu}\p{Ll}{2,}` — a capitalised Latin word — so **all** of these came
 * through a scrub unchanged:
 *
 *     requester: @sam · audience: @ana @ben @leo @mia @sam
 *     MARIA will collect LEO
 *     ana lopez called about leo
 *     mom is upset about the divorce, please do not tell dad
 *
 * An `@handle` is the dominant form a member is named in a `05` §3.4 prompt, and it survived
 * intact. So did every lower-case and ALL-CAPS name, and all free text.
 *
 * Two changes, and the second is the one that makes the promise keepable:
 *
 *  1. **Patterns cover more**: `@handle`s, ALL-CAPS words, and URL path segments that look like
 *     opaque ids (a Drive link identifies a household as surely as a surname).
 *  2. **`identities` is an exact list** — the members' names and handles, which only the caller
 *     knows. Those are replaced before any pattern runs, and `RecordingGateway` **refuses to
 *     record** an exchange where one survives. A denylist of shapes is a best effort; a list of
 *     the actual people is a guarantee, and `scripts/evals/record.ts` has the group to hand.
 *
 * The honest statement of the limit: with `identities` supplied, no listed name or handle reaches a
 * fixture, enforced by a throw. Without it, this is heuristic — it catches the common shapes and
 * cannot catch "mom", a nickname, or a surname nobody listed.
 *
 * ## The writer is injected
 *
 * `write` is a port, not `node:fs`. That keeps `@comvivo/models/testing` free of the platform —
 * the package is consumed from a browser demo — and it makes the scrubbing testable in memory,
 * which is the half that actually needs testing. `scripts/evals/record.ts` passes `writeFile`.
 */
import type {
  ModelGateway,
  ModelRoute,
  ModelTurnRequest,
  ModelTurnResult,
  RouteInfo,
  RouteVariant,
  StructuredRequest,
  StructuredResult,
} from '@comvivo/core';
import { canonicalJson } from '@comvivo/shared';
import { canonicalTurnRequest, hashTurnRequest } from '../request-hash.js';

/** Where a recording goes. Relative to `fixtures/model/`. */
export type FixtureWriter = (relativePath: string, contents: string) => Promise<void>;

export interface RecordingGatewayOptions {
  readonly inner: ModelGateway;
  readonly provider: string;
  readonly write: FixtureWriter;
  /** Replaces the default persona list, for a locale a scenario needs. */
  readonly personas?: readonly string[];
  /**
   * The group's members, by every name and handle they are known by.
   *
   * Supplied by the caller because only the caller has the group — `scripts/evals/record.ts` does.
   * These are replaced **exactly** before any pattern runs, and an exchange where one survives is
   * **not written**: `08` §3.16's promise that a committed fixture carries no member's name is not
   * the kind that can be kept on a best-effort basis, because once a fixture is committed it is
   * public. Omit it and the scrub is heuristic — see the header.
   */
  readonly identities?: readonly string[];
}

/**
 * The persona pool.
 *
 * Deliberately plain, short and unmistakably synthetic: a reviewer scanning a fixture should be
 * able to tell at a glance that no real name survived. Mixed scripts because the scenarios are
 * multilingual (`11` §3.5) and a Latin-only pool would make a Spanish transcript read as English.
 */
const DEFAULT_PERSONAS: readonly string[] = [
  'Avery',
  'Blake',
  'Casey',
  'Devon',
  'Emery',
  'Frankie',
  'Lucía',
  'Mateo',
  'Nadia',
  'Omar',
];

/**
 * A word that looks like a name: capitalised and alphabetic, **anywhere** in the string.
 *
 * The first version required a preceding space and excluded sentence openers, to avoid turning
 * "The recital" into "Avery recital". That was the wrong trade and a test caught it: a transcript
 * line very often *starts* with a name, so "Maria will be at the recital" came through untouched.
 *
 * A privacy scrubber has to fail closed. Missing a name is a leak into a committed fixture
 * (`08` §3.16); replacing a capitalised common word is cosmetic damage to a test input. So this
 * matches every capitalised run and accepts that some sentence openers become personas — the text
 * still has the length, punctuation and rhythm that make it a useful fixture.
 */
const NAME_LIKE = /\p{Lu}\p{Ll}{2,}/gu;
/** `@ana`, the dominant form a member is named in a prompt. Before `EMAIL`, which also has an `@`. */
const HANDLE = /(?<![\w.])@[\p{L}\p{N}_.]{2,32}\b/gu;
/** `MARIA`, which `NAME_LIKE` cannot see — it requires a lower-case tail. */
const SHOUTED_NAME = /\b\p{Lu}{3,}\b/gu;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/**
 * A URL path or query segment long enough to be an id.
 *
 * `https://drive.google.com/file/d/1AbCdEf/view` names a household's files as surely as a surname
 * does, and nothing here touched it.
 */
const URL_ID = /(?<=[/?=&])[\w-]{8,}/g;
const DIGIT_RUN = /\d{2,}/g;
/** Token shapes `08` §3.7.11 names, plus a generic bearer. */
const TOKEN_LIKE = /\b(?:sk-[\w-]{8,}|vs1_[\w-]+|vmcp_[\w-]+|Bearer\s+[\w.-]{8,})/g;

/** A small deterministic hash, so the same input maps to the same persona on every pass. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Scrub one string: tokens first, then emails, then names, then digit runs.
 *
 * The order is the point. A token can contain something that looks like a name, and an email
 * contains both — so the most specific pattern has to win, or a scrubbed email leaves its local
 * part behind looking like a persona.
 */
export function scrubText(
  text: string,
  personas: readonly string[] = DEFAULT_PERSONAS,
  identities: readonly string[] = [],
): string {
  const persona = (seed: string): string => personas[fnv1a(seed) % personas.length] ?? 'Avery';
  // The exact list first, longest first so "ana lopez" wins over "ana", and case-insensitively —
  // which is what catches `MARIA`, `ana` and `Ana` with one entry.
  let out = text;
  for (const identity of [...identities].toSorted((a, b) => b.length - a.length)) {
    if (identity.trim().length < 2) continue;
    out = out.replaceAll(
      new RegExp(identity.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), 'giu'),
      persona(identity.toLowerCase()),
    );
  }
  return (
    out
      .replace(TOKEN_LIKE, '<token>')
      .replace(EMAIL, (match) => `${persona(match).toLowerCase()}@example.invalid`)
      .replace(URL_ID, (match) => persona(match).toLowerCase().padEnd(match.length, '0'))
      .replace(HANDLE, (match) => `@${persona(match).toLowerCase()}`)
      .replace(SHOUTED_NAME, (match) => persona(match).toUpperCase())
      .replace(NAME_LIKE, (match) => persona(match))
      // Digits are **shuffled**, not removed: a fixture needs a date that parses and a quantity
      // that reads as a quantity. The shuffle is seeded by the run itself, so it is stable.
      //
      // The **leading digit is kept**, which is what makes the result stay in range. Shuffling
      // every digit turned `t="17:55"` into `t="36:57"` — not a time, so a fixture carrying it
      // tests a parser against input the product cannot produce. `\d{2,}` matches each run
      // separately, so an hour and a minute are shuffled independently and neither knew its own
      // bounds. Keeping the first digit bounds every run by its own magnitude: an hour stays
      // within its decade, a year stays a year, a quantity stays the size it was. Found at the M2
      // second-pass review.
      .replace(DIGIT_RUN, (match) => {
        const seed = fnv1a(match);
        // An index loop rather than a spread: digits are ASCII, but `no-misused-spread` is right
        // in general and the loop is no harder to read.
        let shuffled = match.slice(0, 1);
        for (let index = 1; index < match.length; index += 1) {
          // `>>>`, not `>>`: `fnv1a` returns a uint32, and a signed shift of a value with the
          // high bit set is negative — which produced `-6-3-7` instead of `637` and left the
          // fixture with a phone number that no longer parses as one.
          shuffled += String((seed >>> (index % 24)) % 10);
        }
        return shuffled;
      })
  );
}

/** Scrub every string inside a JSON-shaped value, leaving the structure intact. */
export function scrubDeep(
  value: unknown,
  personas?: readonly string[],
  identities?: readonly string[],
): unknown {
  if (typeof value === 'string') return scrubText(value, personas, identities);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, personas, identities));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubDeep(item, personas, identities)]),
    );
  }
  return value;
}

/**
 * Every listed identity that survived a scrub, as a fail-closed check.
 *
 * `RecordingGateway` calls this and **throws** rather than writing. The alternative is a fixture
 * that reaches the repository with a real name in it, and `08` §3.16's promise is not the kind
 * that can be made on a best-effort basis: once a fixture is committed it is public.
 */
export function survivingIdentities(
  scrubbed: unknown,
  identities: readonly string[],
): readonly string[] {
  // `JSON.stringify` is typed as possibly `undefined` only for inputs this never receives (a bare
  // `undefined`, a function); the exchange is always an object.
  const haystack = JSON.stringify(scrubbed).toLowerCase();
  return identities.filter(
    (identity) => identity.trim().length >= 2 && haystack.includes(identity.toLowerCase()),
  );
}

/** What a fixture file holds. One exchange, scrubbed, keyed by the request hash. */
export interface RecordedExchange {
  readonly hash: string;
  readonly provider: string;
  readonly route: ModelRoute;
  readonly purpose: string;
  readonly request: unknown;
  readonly response: {
    readonly text: string;
    readonly stop: string;
    readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
    readonly servedModel: string;
  };
}

/**
 * Wrap a gateway and record what it says.
 *
 * Every call is delegated unchanged — a recorder that altered the request would record a fixture
 * for a request that never happened. Only the *written copy* is scrubbed.
 */
export class RecordingGateway implements ModelGateway {
  readonly #options: RecordingGatewayOptions;
  readonly #recorded: RecordedExchange[] = [];

  constructor(options: RecordingGatewayOptions) {
    this.#options = options;
  }

  /** Everything recorded this run, scrubbed, in order. */
  recorded(): readonly RecordedExchange[] {
    return [...this.#recorded];
  }

  routeInfo(route: ModelRoute, variant?: RouteVariant): RouteInfo {
    return this.#options.inner.routeInfo(route, variant);
  }

  /**
   * Refuse to record an exchange a listed identity survived.
   *
   * Throwing loses the recording, which is the right trade: a live eval can be re-run, and a
   * fixture with a real name in it cannot be un-committed.
   */
  #assertScrubbed(exchange: RecordedExchange): void {
    const identities = this.#options.identities ?? [];
    const survivors = survivingIdentities(exchange, identities);
    if (survivors.length === 0) return;
    throw new Error(
      `the scrub left ${String(survivors.length)} member identit(y|ies) in the fixture for ` +
        `${exchange.route}/${exchange.purpose}, so it was not written. ` +
        'Add the forms they appear in to `identities` — a nickname or a surname the list does not ' +
        'carry is exactly what the patterns cannot catch.',
    );
  }

  async run(req: ModelTurnRequest, signal: AbortSignal): Promise<ModelTurnResult> {
    const result = await this.#options.inner.run(req, signal);
    const hash = await hashTurnRequest(req);
    const identities = this.#options.identities;
    const exchange: RecordedExchange = {
      hash,
      provider: this.#options.provider,
      route: req.route,
      purpose: req.purpose,
      request: scrubDeep(canonicalTurnRequest(req), this.#options.personas, identities),
      response: {
        text: scrubText(result.text, this.#options.personas, identities),
        stop: result.stop.reason,
        toolCalls: result.toolCalls.map((call) => ({
          name: call.name,
          input: scrubDeep(call.input, this.#options.personas, identities),
        })),
        servedModel: result.model.served,
      },
    };
    this.#assertScrubbed(exchange);
    this.#recorded.push(exchange);
    await this.#options.write(
      `${this.#options.provider}/${req.route}/${hash}.json`,
      `${canonicalJson(exchange as never)}\n`,
    );
    return result;
  }

  structured<T>(req: StructuredRequest<T>, signal: AbortSignal): Promise<StructuredResult<T>> {
    // Structured fixtures land with `M2-T8`, which owns the structured path end to end. Delegated
    // unchanged rather than recorded half-way: a fixture missing its response is worse than none.
    return this.#options.inner.structured(req, signal);
  }

  embed(texts: readonly string[], purpose: 'query' | 'document'): Promise<readonly Float32Array[]> {
    return this.#options.inner.embed(texts, purpose);
  }
}
