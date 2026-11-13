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
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
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
export function scrubText(text: string, personas: readonly string[] = DEFAULT_PERSONAS): string {
  const persona = (seed: string): string => personas[fnv1a(seed) % personas.length] ?? 'Avery';
  return (
    text
      .replace(TOKEN_LIKE, '<token>')
      .replace(EMAIL, (match) => `${persona(match).toLowerCase()}@example.invalid`)
      .replace(NAME_LIKE, (match) => persona(match))
      // Digits are **shuffled**, not removed: a fixture needs a date that parses and a quantity that
      // reads as a quantity. The shuffle is seeded by the run itself, so it is stable.
      .replace(DIGIT_RUN, (match) => {
        const seed = fnv1a(match);
        // An index loop rather than a spread: digits are ASCII, but `no-misused-spread` is right
        // in general and the loop is no harder to read.
        let shuffled = '';
        for (let index = 0; index < match.length; index += 1) {
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
export function scrubDeep(value: unknown, personas?: readonly string[]): unknown {
  if (typeof value === 'string') return scrubText(value, personas);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, personas));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubDeep(item, personas)]),
    );
  }
  return value;
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

  async run(req: ModelTurnRequest, signal: AbortSignal): Promise<ModelTurnResult> {
    const result = await this.#options.inner.run(req, signal);
    const hash = await hashTurnRequest(req);
    const exchange: RecordedExchange = {
      hash,
      provider: this.#options.provider,
      route: req.route,
      purpose: req.purpose,
      request: scrubDeep(canonicalTurnRequest(req), this.#options.personas),
      response: {
        text: scrubText(result.text, this.#options.personas),
        stop: result.stop.reason,
        toolCalls: result.toolCalls.map((call) => ({
          name: call.name,
          input: scrubDeep(call.input, this.#options.personas),
        })),
        servedModel: result.model.served,
      },
    };
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
