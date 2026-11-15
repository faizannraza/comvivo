/**
 * `CassetteModel` (`11` §3.2.4; `M2-T7`).
 *
 * Replays recorded live responses keyed by `sha256(canonical(request))`, with ids and times
 * normalised by `canonical-hash.ts`. **A miss is a failure**, which is `11` §3.2.4's "strict mode"
 * and the only safe default: the alternative is a suite that silently stops testing what it claims
 * to, because a cassette invalidated by a charter edit would pass by inventing answers.
 *
 * Charter and prompt edits invalidate cassettes **by design** — the hash covers the system prompt,
 * so a prompt change means a re-record. That is exactly why the deterministic PR suites rely on
 * `ScriptedModel` and the worst-case doubles instead, which are independent of prompt text.
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
import { hashStructuredRequest, hashTurnRequest } from '../request-hash.js';
import {
  FakeModelGateway,
  type FakeModelGatewayOptions,
  type ReplyBuilder,
  type ReplyScript,
} from './fake-gateway.js';

/** One recorded exchange. The hash is the key; the reply is what to play back. */
export interface CassetteEntry {
  readonly hash: string;
  /** For a human reading the file: the route and purpose it was recorded for. */
  readonly note?: string;
  /**
   * What to replay for a **turn** (`run`). Omitted for an entry recorded from a structured call.
   */
  readonly reply?: ReplyScript;
  /**
   * What to replay for a **structured** call, as the value itself.
   *
   * A second field rather than a union, because `ReplyScript` genuinely cannot express one:
   * `ReplyBuilder` builds message parts and `structured()` lives on `FakeRule`, one level up. The
   * M2 second-pass review found `structured()` checking the hash and then delegating **without
   * installing anything**, so a cassette *hit* threw `FakeScriptExhausted` — and noted that the
   * fix was more than one line for exactly this reason.
   *
   * The value is still validated against the request's own schema on the way out, so a cassette
   * recorded before a schema change fails loudly rather than replaying a shape that no longer
   * parses.
   */
  readonly structured?: unknown;
}

export interface CassetteModelOptions extends FakeModelGatewayOptions {
  readonly entries: readonly CassetteEntry[];
  /**
   * Strict (the default): a miss throws. `11` §3.2.4 says so, and the reason is that the
   * alternative is a suite that silently stops testing what it claims to: a cassette invalidated
   * by a charter edit would otherwise pass by inventing answers.
   */
  readonly strict?: boolean;
}

/**
 * Replays recorded responses, keyed by the canonical request hash.
 *
 * Charter and prompt edits invalidate cassettes **by design** (`11` §3.2.4): the hash covers the
 * system prompt, so a prompt change is a re-record. That is why the deterministic PR suites rely
 * on `ScriptedModel` and the worst-case doubles instead, which are independent of prompt text.
 */
export class CassetteModel implements ModelGateway {
  readonly #fake: FakeModelGateway;
  readonly #entries: ReadonlyMap<string, CassetteEntry>;
  readonly #strict: boolean;
  readonly #misses: string[] = [];

  constructor(options: CassetteModelOptions) {
    this.#fake = new FakeModelGateway(options);
    this.#entries = new Map(options.entries.map((entry) => [entry.hash, entry]));
    this.#strict = options.strict ?? true;
  }

  get calls(): readonly (ModelTurnRequest | StructuredRequest<unknown>)[] {
    return this.#fake.calls;
  }

  /** The hashes that were asked for and not found, for the message a re-record needs. */
  misses(): readonly string[] {
    return [...this.#misses];
  }

  routeInfo(route: ModelRoute, variant?: RouteVariant): RouteInfo {
    return this.#fake.routeInfo(route, variant);
  }

  async run(req: ModelTurnRequest, signal: AbortSignal): Promise<ModelTurnResult> {
    const hash = await hashTurnRequest(req);
    const entry = this.#entries.get(hash);
    if (entry === undefined) {
      this.#misses.push(hash);
      if (this.#strict) throw new CassetteMiss(hash, req.route, req.purpose);
      // Non-strict: an empty reply, which is still a *visible* degradation because `misses()`
      // records it. Used by the recorder's first pass, where a miss is expected.
      this.#fake.when({ match: (candidate) => candidate === req }).respond((r) => r.text(''));
      return this.#fake.run(req, signal);
    }
    const reply = entry.reply;
    if (reply === undefined) {
      throw new CassetteMiss(
        hash,
        req.route,
        `${req.purpose} — the entry for this hash has no \`reply\`. It was recorded from a ` +
          'structured call, not a turn; re-record it.',
      );
    }
    this.#fake.when({ match: (candidate) => candidate === req }).respond(reply);
    return this.#fake.run(req, signal);
  }

  async structured<T>(
    req: StructuredRequest<T>,
    signal: AbortSignal,
  ): Promise<StructuredResult<T>> {
    const hash = await hashStructuredRequest(req);
    const entry = this.#entries.get(hash);
    if (entry === undefined) {
      this.#misses.push(hash);
      if (this.#strict) throw new CassetteMiss(hash, req.route, req.purpose);
      // Non-strict, and there is nothing to invent. `run`'s equivalent scripts an empty reply,
      // which is a visible degradation because `misses()` records it; a structured call has no
      // empty value that is not a lie — an empty extraction reads as "nothing happened today" and
      // an empty declassification as "no constraints", both the unsafe direction (`05` §3.5.6
      // makes the same argument about L4). So this throws even when `strict` is false, and says
      // which of the two it is.
      throw new CassetteMiss(hash, req.route, req.purpose);
    }
    // **Install the entry before delegating**, exactly as `run` does. This line was missing, so a
    // cassette *hit* on a structured route reached the fake with no rule for the request and threw
    // `FakeScriptExhausted` — reported as "nothing scripted", which reads like a test-authoring
    // mistake rather than a bug here. The M2 second-pass review reproduced it; the structured path
    // had no test at all, so the `M2-T7` AC's "cassette strict miss fails" held for `run` only.
    if (!('structured' in entry)) {
      throw new CassetteMiss(
        hash,
        req.route,
        `${req.purpose} — the entry for this hash has no \`structured\` value. It was recorded from ` +
          'a turn, not a structured call; re-record it.',
      );
    }
    this.#fake.when({ match: (candidate) => candidate === req }).structured(entry.structured);
    return this.#fake.structured(req, signal);
  }

  embed(texts: readonly string[], purpose: 'query' | 'document'): Promise<readonly Float32Array[]> {
    return this.#fake.embed(texts, purpose);
  }
}

/** A strict cassette miss. The message names the hash, which is what a re-record needs. */
export class CassetteMiss extends Error {
  readonly hash: string;

  constructor(hash: string, route: ModelRoute, purpose: string) {
    super(
      `cassette miss for route "${route}" purpose "${purpose}" (hash ${hash}). ` +
        'A prompt, charter or tool-catalog change invalidates cassettes by design — re-record with ' +
        '`pnpm evals:record <scenario>`, and review the fixture like code.',
    );
    this.name = 'CassetteMiss';
    this.hash = hash;
  }
}

/** Build a `ReplyScript` from plain text, for a cassette fixture written as data. */
export function replyText(text: string): ReplyScript {
  return (builder: ReplyBuilder) => builder.text(text);
}
