/**
 * `ScriptedModel` (`11` §3.2.4; `M2-T7`).
 *
 * Responses keyed by `(route, turnOrdinal, callOrdinal)` or by a matcher, failing **loudly** when
 * the script runs out. `CassetteModel` is its sibling in `cassette-model.ts`, keyed by the
 * canonical request hash instead.
 *
 * ## Why ordinals and not just a matcher
 *
 * `FakeModelGateway`'s DSL matches on the *content* of a request, which is what a behavioural test
 * wants. A golden journey wants the opposite: "the third model call of the second turn said this",
 * regardless of what the prompt happened to contain. Keying by position makes the script a
 * transcript, and a transcript is reviewable — a reader can see the conversation.
 *
 * Thin by construction: every shape question goes to `FakeModelGateway`, so there is one place
 * that knows how to turn a scripted reply into a `ModelTurnResult`.
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
import {
  FakeModelGateway,
  type FakeModelGatewayOptions,
  FakeScriptExhausted,
  type ReplyScript,
} from './fake-gateway.js';

/** Where a scripted entry sits in the conversation. */
export interface ScriptPosition {
  readonly route: ModelRoute;
  /** 1-based, per route: the turn this call belongs to. */
  readonly turn: number;
  /** 1-based, per turn: which model call within it. */
  readonly call: number;
}

export interface ScriptedEntry {
  readonly at: ScriptPosition | ((req: ModelTurnRequest, position: ScriptPosition) => boolean);
  readonly reply: ReplyScript;
}

export interface ScriptedModelOptions extends FakeModelGatewayOptions {
  readonly script: readonly ScriptedEntry[];
  /**
   * How a new turn is recognised.
   *
   * Default: a request whose last message is a `user` turn carrying no `tool_result` starts a new
   * turn. A tool round trip continues the one in progress, which is what makes
   * `(turn, call)` mean what a reader expects.
   */
  readonly startsTurn?: (req: ModelTurnRequest) => boolean;
}

function defaultStartsTurn(req: ModelTurnRequest): boolean {
  const last = req.messages.at(-1);
  if (last === undefined || last.role !== 'user') return false;
  return !last.content.some((part) => part.type === 'tool_result');
}

/**
 * Responses keyed by position, failing loudly when the script runs out.
 *
 * Implemented over `FakeModelGateway` rather than beside it: the position is resolved first, and
 * the matching entry is then installed as a one-shot rule. One implementation of "a scripted reply
 * becomes a `ModelTurnResult`".
 */
export class ScriptedModel implements ModelGateway {
  readonly #fake: FakeModelGateway;
  readonly #script: readonly ScriptedEntry[];
  readonly #startsTurn: (req: ModelTurnRequest) => boolean;
  readonly #turns = new Map<ModelRoute, number>();
  readonly #callsInTurn = new Map<ModelRoute, number>();
  readonly #used = new Set<number>();

  constructor(options: ScriptedModelOptions) {
    this.#fake = new FakeModelGateway(options);
    this.#script = options.script;
    this.#startsTurn = options.startsTurn ?? defaultStartsTurn;
  }

  /** Every request that arrived, for the same assertions `FakeModelGateway` supports. */
  get calls(): readonly (ModelTurnRequest | StructuredRequest<unknown>)[] {
    return this.#fake.calls;
  }

  /** Entries the script never used. A non-zero count means the conversation did not go as written. */
  unusedEntries(): readonly ScriptPosition[] {
    return this.#script.flatMap((entry, index) =>
      this.#used.has(index) || typeof entry.at === 'function' ? [] : [entry.at],
    );
  }

  routeInfo(route: ModelRoute, variant?: RouteVariant): RouteInfo {
    return this.#fake.routeInfo(route, variant);
  }

  async run(req: ModelTurnRequest, signal: AbortSignal): Promise<ModelTurnResult> {
    const position = this.#advance(req);
    const index = this.#script.findIndex((entry, at) => {
      if (this.#used.has(at)) return false;
      if (typeof entry.at === 'function') return entry.at(req, position);
      return (
        entry.at.route === position.route &&
        entry.at.turn === position.turn &&
        entry.at.call === position.call
      );
    });
    const entry = this.#script[index];
    if (entry === undefined) {
      throw new FakeScriptExhausted(
        req.route,
        req.purpose,
        `nothing scripted at turn ${String(position.turn)} call ${String(position.call)}`,
      );
    }
    this.#used.add(index);
    this.#fake.when({ match: (candidate) => candidate === req }).respond(entry.reply);
    return this.#fake.run(req, signal);
  }

  structured<T>(req: StructuredRequest<T>, signal: AbortSignal): Promise<StructuredResult<T>> {
    return this.#fake.structured(req, signal);
  }

  embed(texts: readonly string[], purpose: 'query' | 'document'): Promise<readonly Float32Array[]> {
    return this.#fake.embed(texts, purpose);
  }

  /** Move the position counters and return where this call sits. */
  #advance(req: ModelTurnRequest): ScriptPosition {
    if (this.#startsTurn(req)) {
      this.#turns.set(req.route, (this.#turns.get(req.route) ?? 0) + 1);
      this.#callsInTurn.set(req.route, 1);
    } else {
      this.#turns.set(req.route, this.#turns.get(req.route) ?? 1);
      this.#callsInTurn.set(req.route, (this.#callsInTurn.get(req.route) ?? 0) + 1);
    }
    return {
      route: req.route,
      turn: this.#turns.get(req.route) ?? 1,
      call: this.#callsInTurn.get(req.route) ?? 1,
    };
  }
}
