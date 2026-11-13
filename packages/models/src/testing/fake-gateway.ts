/**
 * `FakeModelGateway` (`05` §3.5.7, `11` §3.2.4; `M2-T7`).
 *
 * A deterministic implementation of the whole `ModelGateway` port, used by every engine test, every
 * simulator scenario and the CI evals. It is the single most-depended-on test double in this
 * repository, which decides two things about its design.
 *
 * **It fails loudly.** An unmatched call throws `FakeScriptExhausted` rather than returning a
 * plausible empty reply. A fake that invents an answer turns a test for one behaviour into a test
 * that the fake exists, and `11` §3.2.4 says the same thing about `ScriptedModel` and
 * `CassetteModel`.
 *
 * **It is the prompt's inspection point.** `fake.calls` keeps every canonical `ModelTurnRequest`,
 * `meta.manifest` included — the field that is never sent to a provider. That is where the I1
 * property test looks: `expectNoReadUp(audience)` asserts that every label the context builder
 * chose to include passes `canRead` for that audience, which is the invariant no unit test of the
 * builder alone can establish.
 *
 * ## The script DSL
 *
 * ```ts
 * fake.when({ route: 'chat', purpose: 'turn.step', match: (req) => text(req).includes('recital') })
 *     .respond((r) => r.thinking().toolCall('calendar_search_events', { query: 'recital' }))
 *     .andThen((r) => r.text('Fri 14 Nov, 6 pm at Teatro Real.'));
 * fake.when({ route: 'chat' }).refuse('cyber');
 * fake.when({ route: 'route' }).structured({ candidates: [], dominantLanguage: 'es' });
 * fake.when({ route: 'chat' }).error('overloaded').times(2);
 * fake.when({ route: 'chat' }).delay(70_000);
 * fake.when({ route: 'chat' }).pauseTurn().andThen((r) => r.text('done'));
 * fake.when({ route: 'chat' }).fallbackMidStream('claude-opus-4-8', (r) => r.text('rescued'));
 * ```
 *
 * A rule is a matcher plus a **queue** of outcomes, consumed in order: that is what makes a
 * multi-step tool loop expressible as one rule, and it means the script reads in the order the
 * turn happens. Rules are tried in declaration order and the first match wins, so a specific rule
 * written before a general one shadows it — which is the order a reader expects.
 *
 * Tool-call ids are deterministic (`toolu_fake_0001`), because a golden transcript that changed on
 * every run would be worthless.
 */
import {
  type AssistantMessage,
  type AssistantPart,
  type BatchHandle,
  type BatchStatus,
  type Effort,
  ModelCallError,
  type ModelCallErrorKind,
  type ModelGateway,
  type ModelRoute,
  type ModelTurnRequest,
  type ModelTurnResult,
  type RouteInfo,
  type RouteVariant,
  type StopInfo,
  type StructuredRequest,
  type StructuredResult,
  type UsageIteration,
} from '@comvivo/core';
import type { Clock } from '@comvivo/shared';
import { buildChatRequest } from '../anthropic/request.js';
import type { RouteBinding } from '../registry/resolve.js';
import type { CacheSimUsage, CacheSimulator } from './cache-sim.js';

/** Thrown when a call matches no rule, or a matching rule has nothing left to say. */
export class FakeScriptExhausted extends Error {
  readonly route: ModelRoute;
  readonly purpose: string;

  constructor(route: ModelRoute, purpose: string, detail: string) {
    super(
      `FakeModelGateway has nothing scripted for route "${route}" purpose "${purpose}": ${detail}. ` +
        'Add a `fake.when({...})` rule, or assert on `fake.calls` to see what arrived.',
    );
    this.name = 'FakeScriptExhausted';
    this.route = route;
    this.purpose = purpose;
  }
}

/** One part of a scripted assistant turn. */
type ReplyPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking' }
  | { readonly type: 'tool_call'; readonly name: string; readonly input: unknown };

/**
 * The response builder handed to `respond` and `then`.
 *
 * Chainable and immutable-by-append: each call returns `this` so a reply reads as the sequence of
 * blocks the model produced, in order.
 */
export class ReplyBuilder {
  readonly #parts: ReplyPart[] = [];

  /** A thinking block. Opaque by construction: the engine's view never carries reasoning text. */
  thinking(): this {
    this.#parts.push({ type: 'thinking' });
    return this;
  }

  text(text: string): this {
    this.#parts.push({ type: 'text', text });
    return this;
  }

  toolCall(name: string, input: unknown): this {
    this.#parts.push({ type: 'tool_call', name, input });
    return this;
  }

  /** @internal */
  parts(): readonly ReplyPart[] {
    return [...this.#parts];
  }
}

export type ReplyScript = (builder: ReplyBuilder) => ReplyBuilder;

type Outcome =
  | { readonly kind: 'reply'; readonly parts: readonly ReplyPart[] }
  | { readonly kind: 'refuse'; readonly category: string | null }
  | { readonly kind: 'max_tokens'; readonly parts: readonly ReplyPart[] }
  | { readonly kind: 'pause'; readonly parts: readonly ReplyPart[] }
  | {
      readonly kind: 'fallback';
      readonly servedModel: string;
      readonly parts: readonly ReplyPart[];
    }
  | {
      readonly kind: 'error';
      readonly errorKind: ModelCallErrorKind;
      readonly retryAfterMs: number | undefined;
    }
  | { readonly kind: 'structured'; readonly value: unknown };

export interface RuleMatcher {
  readonly route?: ModelRoute;
  readonly purpose?: string;
  readonly variant?: RouteVariant;
  readonly match?: (req: ModelTurnRequest | StructuredRequest<unknown>) => boolean;
}

/** A rule under construction. Every method returns the rule so the script reads as one sentence. */
export class FakeRule {
  readonly #matcher: RuleMatcher;
  readonly #outcomes: Outcome[] = [];
  #delayMs = 0;
  #consumed = 0;

  constructor(matcher: RuleMatcher) {
    this.#matcher = matcher;
  }

  respond(script: ReplyScript): this {
    this.#outcomes.push({ kind: 'reply', parts: script(new ReplyBuilder()).parts() });
    return this;
  }

  /**
   * The next reply in the same rule, for a tool loop that takes more than one round trip.
   *
   * **`andThen`, not `then`** (amended at `M2-T7`). `05` §3.5.7's DSL sketch writes `.then(...)`,
   * and a class with a `then` member is a **thenable**: `await fake.when({…}).respond(…)` would
   * try to resolve the rule and hang or return something surprising. The hazard is not theoretical
   * in a file every test author copies from, and `.andThen(…)` reads almost identically.
   */
  andThen(script: ReplyScript): this {
    return this.respond(script);
  }

  refuse(category: string | null = null): this {
    this.#outcomes.push({ kind: 'refuse', category });
    return this;
  }

  /** A truncated turn. The parts are produced but the engine must not use them (`05` §3.5.3.4). */
  maxTokens(script: ReplyScript = (r) => r.text('half a sent')): this {
    this.#outcomes.push({ kind: 'max_tokens', parts: script(new ReplyBuilder()).parts() });
    return this;
  }

  pauseTurn(script: ReplyScript = (r) => r.text('')): this {
    this.#outcomes.push({ kind: 'pause', parts: script(new ReplyBuilder()).parts() });
    return this;
  }

  /**
   * A turn the server-side refusal fallback answered.
   *
   * `servedModel` is reported as `model.served` and in a `fallback_message` usage iteration, so a
   * cost test sees two iterations at two prices — which is the whole reason `UsageIteration` is a
   * list.
   */
  fallbackMidStream(servedModel: string, script: ReplyScript): this {
    this.#outcomes.push({
      kind: 'fallback',
      servedModel,
      parts: script(new ReplyBuilder()).parts(),
    });
    return this;
  }

  error(kind: ModelCallErrorKind, options: { readonly retryAfterMs?: number } = {}): this {
    this.#outcomes.push({ kind: 'error', errorKind: kind, retryAfterMs: options.retryAfterMs });
    return this;
  }

  /** A structured result. The value is validated against the request's schema before it is returned. */
  structured(value: unknown): this {
    this.#outcomes.push({ kind: 'structured', value });
    return this;
  }

  /**
   * Repeat the most recently added outcome `count` times in total.
   *
   * `error('overloaded').times(2)` is the shape a breaker test needs, and writing the outcome twice
   * would say the same thing less clearly.
   */
  times(count: number): this {
    const last = this.#outcomes.at(-1);
    if (last === undefined) throw new Error('times() needs an outcome to repeat');
    for (let i = 1; i < count; i += 1) this.#outcomes.push(last);
    return this;
  }

  /**
   * Report this many milliseconds of latency, and advance an advanceable clock by it.
   *
   * With a `VirtualClock` this is what makes a deadline test instant: the turn's `AbortSignal`
   * fires because time moved, not because the test waited.
   */
  delay(ms: number): this {
    this.#delayMs = ms;
    return this;
  }

  /** @internal */
  matches(req: ModelTurnRequest | StructuredRequest<unknown>): boolean {
    if (this.#matcher.route !== undefined && this.#matcher.route !== req.route) return false;
    if (this.#matcher.purpose !== undefined && this.#matcher.purpose !== req.purpose) return false;
    if (this.#matcher.variant !== undefined && this.#matcher.variant !== req.variant) return false;
    if (this.#matcher.match !== undefined && !this.#matcher.match(req)) return false;
    return this.#consumed < this.#outcomes.length;
  }

  /** @internal */
  take(): Outcome {
    const outcome = this.#outcomes[this.#consumed];
    if (outcome === undefined) throw new Error('FakeRule.take() called with nothing left');
    this.#consumed += 1;
    return outcome;
  }

  /** @internal */
  delayMs(): number {
    return this.#delayMs;
  }

  /** How many outcomes are still unconsumed. A non-zero count at the end is usually a bug. */
  remaining(): number {
    return this.#outcomes.length - this.#consumed;
  }
}

export interface FakeModelGatewayOptions {
  readonly clock: Clock;
  readonly bindingFor: (route: ModelRoute, variant?: RouteVariant) => RouteBinding;
  /**
   * Advance the clock by `ms`, for `delay()`.
   *
   * Injected rather than sniffed off the clock, because "is this clock advanceable" is a question
   * with a wrong answer available. Async, so `VirtualClock.advance` — which fires the timers that
   * came due — can be passed straight in: `advance: (ms) => clock.advance(\`PT\${ms / 1000}S\`)`.
   */
  readonly advance?: (ms: number) => Promise<void> | void;
  /** Simulate the prompt cache. Omit for tests that do not care about usage. */
  readonly cache?: CacheSimulator;
  /** Characters per token for the synthetic usage estimator. */
  readonly charsPerToken?: number;
}

const DEFAULT_CHARS_PER_TOKEN = 4;

/** The deterministic tool-call id for the `n`th call, 1-based. */
export function fakeToolCallId(ordinal: number): string {
  return `toolu_fake_${String(ordinal).padStart(4, '0')}`;
}

/** A deterministic, scriptable `ModelGateway`. */
export class FakeModelGateway implements ModelGateway {
  readonly #options: FakeModelGatewayOptions;
  readonly #rules: FakeRule[] = [];
  readonly #calls: (ModelTurnRequest | StructuredRequest<unknown>)[] = [];
  #toolCallOrdinal = 0;

  constructor(options: FakeModelGatewayOptions) {
    this.#options = options;
  }

  /** Add a rule. Rules are tried in declaration order and the first match wins. */
  when(matcher: RuleMatcher = {}): FakeRule {
    const rule = new FakeRule(matcher);
    this.#rules.push(rule);
    return rule;
  }

  /** Every request that arrived, in order, with `meta` intact. */
  get calls(): readonly (ModelTurnRequest | StructuredRequest<unknown>)[] {
    return [...this.#calls];
  }

  /** Just the turn requests, which is what most assertions want. */
  get turnCalls(): readonly ModelTurnRequest[] {
    return this.#calls.filter((call): call is ModelTurnRequest => 'messages' in call);
  }

  /** Outcomes scripted but never consumed. A non-zero total usually means a test did not run. */
  unconsumed(): number {
    return this.#rules.reduce((total, rule) => total + rule.remaining(), 0);
  }

  reset(): void {
    this.#rules.length = 0;
    this.#calls.length = 0;
    this.#toolCallOrdinal = 0;
  }

  routeInfo(route: ModelRoute, variant?: RouteVariant): RouteInfo {
    const binding = this.#options.bindingFor(route, variant);
    return { provider: binding.provider, model: binding.model, supports: binding.features };
  }

  async run(req: ModelTurnRequest, signal: AbortSignal): Promise<ModelTurnResult> {
    this.#calls.push(req);
    const rule = this.#rules.find((candidate) => candidate.matches(req));
    if (rule === undefined) {
      throw new FakeScriptExhausted(req.route, req.purpose, 'no rule matched');
    }
    await this.#applyDelay(rule.delayMs());
    // After the delay, because a deadline test's whole point is that the clock moved past it.
    signal.throwIfAborted();

    const outcome = rule.take();
    if (outcome.kind === 'error') {
      throw new ModelCallError(outcome.errorKind, 'fake', {
        ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
      });
    }
    if (outcome.kind === 'structured') {
      throw new FakeScriptExhausted(
        req.route,
        req.purpose,
        'the matching rule scripts a structured result, but this is a `run` call',
      );
    }
    return this.#turnResult(req, outcome, rule.delayMs());
  }

  async structured<T>(
    req: StructuredRequest<T>,
    signal: AbortSignal,
  ): Promise<StructuredResult<T>> {
    this.#calls.push(req);
    const rule = this.#rules.find((candidate) => candidate.matches(req));
    if (rule === undefined) {
      throw new FakeScriptExhausted(req.route, req.purpose, 'no rule matched');
    }
    await this.#applyDelay(rule.delayMs());
    signal.throwIfAborted();

    const binding = this.#options.bindingFor(req.route, req.variant);
    const usage = this.#syntheticUsage(binding.model, this.#structuredBytes(req), 32);
    const outcome = rule.take();

    if (outcome.kind === 'error') {
      throw new ModelCallError(outcome.errorKind, 'fake', {
        ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
      });
    }
    if (outcome.kind === 'refuse') {
      return { kind: 'refused', category: outcome.category, usage, model: binding.model };
    }
    if (outcome.kind === 'max_tokens') {
      return { kind: 'truncated', usage, model: binding.model };
    }
    if (outcome.kind !== 'structured') {
      throw new FakeScriptExhausted(
        req.route,
        req.purpose,
        'the matching rule scripts a turn reply, but this is a `structured` call',
      );
    }

    // Validated **before** it is returned (`05` §3.5.7). A scripted value that does not match the
    // schema is a broken test, and a fake that returned it anyway would let the test pass while
    // the production path would have rejected the same bytes.
    const parsed = req.schema.safeParse(outcome.value);
    if (!parsed.success) {
      throw new Error(
        `FakeModelGateway: the value scripted for route "${req.route}" does not match its own ` +
          `schema "${req.schemaName}". Fix the script, not the schema.`,
      );
    }
    return { kind: 'ok', value: parsed.data, usage, model: binding.model };
  }

  embed(
    texts: readonly string[],
    _purpose: 'query' | 'document',
  ): Promise<readonly Float32Array[]> {
    // Deterministic, not random: a KNN test needs the same vectors on every run. Each dimension is
    // derived from the text's own bytes, so two different texts are two different vectors and the
    // same text is always the same one.
    return Promise.resolve(
      texts.map((text) => {
        const vector = new Float32Array(8);
        // `charCodeAt` over the UTF-16 units rather than a spread: `no-misused-spread` is right
        // that spreading a string decomposes emoji, and a *stable* mapping is all this needs.
        for (let index = 0; index < text.length; index += 1) {
          const slot = index % vector.length;
          vector[slot] = ((vector[slot] ?? 0) + text.charCodeAt(index)) % 1000;
        }
        return vector;
      }),
    );
  }

  async #applyDelay(ms: number): Promise<void> {
    if (ms <= 0) return;
    await this.#options.advance?.(ms);
  }

  #turnResult(
    req: ModelTurnRequest,
    outcome: Extract<Outcome, { kind: 'reply' | 'refuse' | 'max_tokens' | 'pause' | 'fallback' }>,
    delayMs: number,
  ): ModelTurnResult {
    const binding = this.#options.bindingFor(req.route, req.variant);
    const served = outcome.kind === 'fallback' ? outcome.servedModel : binding.model;
    const parts = outcome.kind === 'refuse' ? [] : outcome.parts;
    const view = this.#viewOf(parts);
    const stop = this.#stopOf(outcome);
    const blocked = stop.reason === 'refusal' || stop.reason === 'max_tokens';

    const assistant: AssistantMessage = {
      role: 'assistant',
      provider: 'fake',
      servedModel: served,
      // `raw` is the view: this fake has no provider-private state to round-trip, and the port
      // requires `raw` and `view` to describe the same turn.
      raw: view,
      view,
    };

    const outputChars = view.reduce(
      (total, part) => total + (part.type === 'text' ? part.text.length : 0),
      0,
    );
    const usage = this.#usageFor(req, binding, served, outcome.kind === 'fallback', outputChars);

    return {
      assistant,
      stop,
      text: blocked ? '' : view.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(''),
      toolCalls: blocked
        ? []
        : view.flatMap((part) =>
            part.type === 'tool_call' ? [{ id: part.id, name: part.name, input: part.input }] : [],
          ),
      usage,
      model: { provider: 'fake', requested: binding.model, served },
      latency: { totalMs: delayMs, ...(outputChars > 0 ? { ttftMs: delayMs } : {}) },
      diagnostics: { inputTransformations: 0, betas: [] },
    };
  }

  #stopOf(outcome: Outcome): StopInfo {
    switch (outcome.kind) {
      case 'refuse':
        return {
          reason: 'refusal',
          raw: 'refusal',
          category: outcome.category,
          servedByFallback: false,
        };
      case 'max_tokens':
        return { reason: 'max_tokens', raw: 'max_tokens' };
      case 'pause':
        return { reason: 'pause_turn', raw: 'pause_turn' };
      case 'reply':
      case 'fallback': {
        const hasToolCall = outcome.parts.some((part) => part.type === 'tool_call');
        return hasToolCall
          ? { reason: 'tool_use', raw: 'tool_use' }
          : { reason: 'end_turn', raw: 'end_turn' };
      }
      case 'error':
      case 'structured':
        throw new Error('FakeModelGateway: these outcomes do not produce a stop reason');
    }
  }

  #viewOf(parts: readonly ReplyPart[]): readonly AssistantPart[] {
    return parts.map((part): AssistantPart => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'thinking') return { type: 'opaque', kind: 'thinking' };
      this.#toolCallOrdinal += 1;
      return {
        type: 'tool_call',
        id: fakeToolCallId(this.#toolCallOrdinal),
        name: part.name,
        input: part.input,
      };
    });
  }

  /**
   * Synthetic usage, through the cache simulator when one is injected.
   *
   * With a simulator the numbers come from rendering the request through the **real**
   * `buildChatRequest` and accounting its prefix, which is what makes the M2 gate's
   * "`cache_read_input_tokens > 0` on the second identical request" mean something.
   */
  #usageFor(
    req: ModelTurnRequest,
    binding: RouteBinding,
    served: string,
    viaFallback: boolean,
    outputChars: number,
  ): readonly UsageIteration[] {
    const output = this.#tokens(outputChars);
    const cache = this.#accountCache(req, binding);
    const first: UsageIteration = {
      model: binding.model,
      kind: 'message',
      input: cache.input,
      cacheRead: cache.cacheRead,
      cacheWrite5m: cache.cacheWrite5m,
      cacheWrite1h: cache.cacheWrite1h,
      output: viaFallback ? 0 : output,
      batch: false,
    };
    if (!viaFallback) return [first];
    // Two iterations at two prices, which is the shape a fallback turn really has.
    return [
      first,
      {
        model: served,
        kind: 'fallback_message',
        input: cache.input,
        cacheRead: cache.cacheRead,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output,
        batch: false,
      },
    ];
  }

  #accountCache(req: ModelTurnRequest, binding: RouteBinding): CacheSimUsage {
    const cache = this.#options.cache;
    if (cache === undefined) {
      const promptTokens = this.#tokens(this.#turnBytes(req));
      return {
        input: promptTokens,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        promptTokens,
      };
    }
    // The real builder, so the simulated prefix is the one the provider would see.
    const built = buildChatRequest(req, { binding, availableBetas: [] });
    return cache.account(built.params);
  }

  #tokens(chars: number): number {
    const per = this.#options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
    return Math.max(0, Math.round(chars / per));
  }

  #turnBytes(req: ModelTurnRequest): number {
    const system = req.system.reduce((total, block) => total + block.text.length, 0);
    const messages = JSON.stringify(req.messages).length;
    const tools = JSON.stringify(req.tools).length;
    return system + messages + tools;
  }

  #structuredBytes(req: StructuredRequest<unknown>): number {
    const system = req.system.reduce((total, block) => total + block.text.length, 0);
    return system + JSON.stringify(req.input).length;
  }

  #syntheticUsage(model: string, promptChars: number, outputTokens: number): UsageIteration[] {
    return [
      {
        model,
        kind: 'message',
        input: this.#tokens(promptChars),
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: outputTokens,
        batch: false,
      },
    ];
  }
}

/** The effort levels, for a test that sweeps them. */
export const FAKE_EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Batches are `M2-T8`'s; named here so a caller sees which task adds them. */
export type FakeBatch = { readonly handle: BatchHandle; readonly status: BatchStatus };
