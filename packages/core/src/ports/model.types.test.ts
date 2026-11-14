/**
 * The model port's type-level contract (`M2-T1`'s AC: "`05` §4.1 compiles under strict +
 * `exactOptionalPropertyTypes`; exhaustive-switch helpers for `StopInfo`/`StructuredResult`").
 *
 * ## Why `.types.test.ts` and not `.test-d.ts`
 *
 * `14`'s AC row names `model.test-d.ts`. Nothing in this repository checks such a file: Vitest's
 * `typecheck` project is not configured, `tsconfig.test.json`'s include globs do not match
 * `*.test-d.ts`, and the 23 package tsconfigs each exclude `*.test.ts` and would compile a
 * `.test-d.ts` into `dist`. So the file would have been checked by nothing and shipped in the
 * package — the shape of defect this milestone's predecessor spent two rounds removing.
 *
 * A `.test.ts` is already excluded from every build, already in `tsconfig.test.json`, and already
 * run by `pnpm test`. The type assertions below are therefore checked by `pnpm typecheck` (which
 * runs `tsc -p tsconfig.test.json`) and the runtime ones by `pnpm test`. The AC's substance — that
 * the port compiles under the strict flags and that the helpers are total — is what is asserted;
 * only the filename moved, and `14`'s row says so now (`CLAUDE.md` §6).
 *
 * ## What a type test can and cannot prove
 *
 * `@ts-expect-error` is the load-bearing part: it fails the build when the error it names stops
 * happening, which is how "this field cannot be set" stays true. A positive assignment proves
 * only that a shape compiles, which is why each one below is paired with a negative.
 */
import { describe, expect, it } from 'vitest';
import {
  continuesToolLoop,
  EFFORT_LEVELS,
  type Effort,
  isIncomplete,
  isRefusal,
  isStructuredOk,
  isStructuredRetryable,
  ModelCallError,
  type ModelCallErrorKind,
  type ModelGateway,
  type ModelTurnRequest,
  type StopInfo,
  type StopReason,
  type StructuredKind,
  type StructuredResult,
  usageOf,
} from './model.js';

/** A minimal valid request, reused by the negatives below. */
const BASE: ModelTurnRequest = {
  route: 'chat',
  purpose: 'turn.reply',
  system: [{ id: 'charter', text: 'be useful', cache: { ttl: '1h' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [],
  toolChoice: 'auto',
  effort: 'medium',
  maxOutputTokens: 4096,
  correlation: {},
};

describe('the request type refuses what 01 §2.1 forbids', () => {
  it('has no sampling parameters', () => {
    // The first guard on §2.1: the field does not exist, so a caller who wanted one has to change
    // the port and a reviewer sees it. `M2-T6`'s wire assertions are the second guard, over the
    // request an adapter actually builds.
    // @ts-expect-error -- `temperature` is not a field of ModelTurnRequest (01 §2.1)
    const withTemperature: ModelTurnRequest = { ...BASE, temperature: 0.7 };
    // @ts-expect-error -- `top_p` is not a field of ModelTurnRequest (01 §2.1)
    const withTopP: ModelTurnRequest = { ...BASE, top_p: 0.9 };
    // @ts-expect-error -- `top_k` is not a field of ModelTurnRequest (01 §2.1)
    const withTopK: ModelTurnRequest = { ...BASE, top_k: 40 };
    expect([withTemperature, withTopP, withTopK]).toHaveLength(3);
  });

  it('cannot force a tool choice', () => {
    // @ts-expect-error -- 'any' is not assignable: forced tool choice is banned (01 §2.1), and
    // current models reject it with a 400.
    const forced: ModelTurnRequest = { ...BASE, toolChoice: 'any' };
    // @ts-expect-error -- nor the object form naming one tool
    const named: ModelTurnRequest = { ...BASE, toolChoice: { type: 'tool', name: 'x' } };
    expect([forced, named]).toHaveLength(2);
  });

  it('requires an explicit effort', () => {
    const { effort: _dropped, ...withoutEffort } = BASE;
    // @ts-expect-error -- `effort` is required: the API default differs per model (medium on Opus
    // 5.5 and Haiku 5.5, high on Sonnet 5.5), so an omitted value changes cost when a route's
    // model changes. CLAUDE.md §3 requires it set explicitly.
    const incomplete: ModelTurnRequest = withoutEffort;
    expect(incomplete).toBeDefined();
  });

  it('has no thinking field, because there is nothing to choose', () => {
    // Adaptive thinking is always on for Opus 5.5 and `{type:'disabled'}` is a 400 at every effort
    // level (verified 2026-11-12). Where a model does allow it, the adapter reads the capability
    // registry — it is not a per-call decision.
    // @ts-expect-error -- `thinking` is not a field of ModelTurnRequest
    const withThinking: ModelTurnRequest = { ...BASE, thinking: { type: 'adaptive' } };
    expect(withThinking).toBeDefined();
  });

  it('refuses an effort level the API does not have', () => {
    // @ts-expect-error -- 'adaptive' is a thinking mode, not an effort level. The live docs say so
    // in those words, and it is the mistake the three-level type in `05` §4.1 invited.
    const adaptive: Effort = 'adaptive';
    // @ts-expect-error -- nor 'none'
    const none: Effort = 'none';
    expect([adaptive, none]).toHaveLength(2);
  });

  it('accepts all five levels the current models support', () => {
    const all: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect([...EFFORT_LEVELS]).toEqual(all);
    // Lowest first, because a config validator compares levels and a doctor listing prints them.
    expect(EFFORT_LEVELS[0]).toBe('low');
    expect(EFFORT_LEVELS.at(-1)).toBe('max');
  });
});

describe('exactOptionalPropertyTypes is load-bearing here', () => {
  it('refuses an explicit undefined where the field is optional', () => {
    // Under `exactOptionalPropertyTypes`, `{cache: undefined}` is not the same as omitting it.
    // That matters for a cache hint: a block that *says* `undefined` is a block an adapter could
    // render as "no breakpoint" or as "the default", and the prefix hash differs either way.
    // @ts-expect-error -- `cache?: CacheHint` does not admit `undefined` explicitly
    const block = { id: 'x', text: 'y', cache: undefined } as const satisfies {
      id: string;
      text: string;
      cache?: { ttl: '5m' | '1h' };
    };
    expect(block.id).toBe('x');
  });
});

describe('the stop-reason helpers are total', () => {
  const reasons: StopReason[] = [
    'end_turn',
    'tool_use',
    'max_tokens',
    'pause_turn',
    'context_overflow',
    'other',
    'refusal',
  ];

  /** Build a `StopInfo` for any reason, so the helpers can be exercised over the whole union. */
  const stopFor = (reason: StopReason): StopInfo =>
    reason === 'refusal'
      ? { reason, raw: 'refusal', category: 'cyber', servedByFallback: false }
      : { reason, raw: reason };

  it('answers for every reason without throwing', () => {
    // The point of a total `Record` over a `switch`: a new reason is a compile error at the
    // mapping. This asserts the runtime half — that every current reason has an answer.
    for (const reason of reasons) {
      expect(typeof continuesToolLoop(stopFor(reason))).toBe('boolean');
      expect(typeof isIncomplete(stopFor(reason))).toBe('boolean');
    }
  });

  it('continues the loop only for tool_use and pause_turn', () => {
    const continuing = reasons.filter((reason) => continuesToolLoop(stopFor(reason)));
    // `pause_turn` is the provider asking to be called again with the same messages — the same
    // control flow as a tool round trip, with no tool having run.
    expect(continuing.toSorted()).toEqual(['pause_turn', 'tool_use']);
  });

  it('calls a turn incomplete when its output is unusable', () => {
    const incomplete = reasons.filter((reason) => isIncomplete(stopFor(reason)));
    expect(incomplete.toSorted()).toEqual(['context_overflow', 'max_tokens', 'other', 'refusal']);
    // And not for the three that finished: a false positive here turns a good reply into an error.
    expect(isIncomplete(stopFor('end_turn'))).toBe(false);
    expect(isIncomplete(stopFor('tool_use'))).toBe(false);
  });

  it('narrows a refusal to the only variant with a category', () => {
    const refusal = stopFor('refusal');
    expect(isRefusal(refusal)).toBe(true);
    if (!isRefusal(refusal)) throw new Error('unreachable: the guard just said it is a refusal');
    // Reachable only through the guard, which is the point: `stop_details` is populated **only**
    // for a refusal and is `null` otherwise, so reading `category` unguarded is reading null.
    expect(refusal.category).toBe('cyber');
    expect(refusal.servedByFallback).toBe(false);

    const ended = stopFor('end_turn');
    expect(isRefusal(ended)).toBe(false);
    // @ts-expect-error -- `category` is not on the non-refusal variant
    expect(ended.category).toBeUndefined();
  });
});

describe('the structured-result helpers are total', () => {
  const kinds: StructuredKind[] = ['ok', 'refused', 'invalid', 'truncated'];

  const resultFor = (kind: StructuredKind): StructuredResult<{ a: number }> => {
    const common = { usage: [], model: 'claude-haiku-5-5' } as const;
    switch (kind) {
      case 'ok':
        return { kind, value: { a: 1 }, ...common };
      case 'refused':
        return { kind, category: null, ...common };
      case 'invalid':
        return { kind, issues: 'a: expected number', ...common };
      case 'truncated':
        return { kind, ...common };
    }
  };

  it('answers for every kind', () => {
    for (const kind of kinds) {
      expect(typeof isStructuredRetryable(resultFor(kind))).toBe('boolean');
      expect(usageOf(resultFor(kind))).toEqual([]);
    }
  });

  it('retries only what a second attempt could change', () => {
    const retryable = kinds.filter((kind) => isStructuredRetryable(resultFor(kind)));
    // `refused` is deliberately absent: a policy decline is a decision, and a retry loop around it
    // is both a cost leak and a way to launder a refusal into an answer.
    expect(retryable.toSorted()).toEqual(['invalid', 'truncated']);
  });

  it('narrows the success variant so `value` is reachable only when it exists', () => {
    const ok = resultFor('ok');
    expect(isStructuredOk(ok)).toBe(true);
    if (!isStructuredOk(ok)) throw new Error('unreachable');
    expect(ok.value.a).toBe(1);

    const truncated = resultFor('truncated');
    expect(isStructuredOk(truncated)).toBe(false);
    // @ts-expect-error -- `value` exists only on the ok variant
    expect(truncated.value).toBeUndefined();
  });

  it('keeps usage on every outcome, because a failed call is a billed call', () => {
    // `02` §3.3.7's ledger must not lose a refused or truncated call's tokens — they were spent.
    for (const kind of kinds) {
      const result = resultFor(kind);
      expect(Array.isArray(result.usage)).toBe(true);
    }
  });
});

describe('ModelCallError', () => {
  it('classifies every kind as retryable or not', () => {
    const kinds: ModelCallErrorKind[] = [
      'aborted',
      'timeout',
      'network',
      'rate_limited',
      'overloaded',
      'server',
      'auth',
      'permission',
      'billing',
      'model_not_found',
      'bad_request',
      'request_too_large',
      'unknown',
    ];
    for (const kind of kinds) {
      expect(typeof new ModelCallError(kind, 'anthropic').retryable).toBe('boolean');
    }
  });

  it('retries the transport failures and not the request ones', () => {
    expect(new ModelCallError('rate_limited', 'anthropic').retryable).toBe(true);
    expect(new ModelCallError('overloaded', 'anthropic').retryable).toBe(true);
    expect(new ModelCallError('network', 'openai').retryable).toBe(true);
    // A caller's own abort is not a failure to retry, and nor is a 400.
    expect(new ModelCallError('aborted', 'anthropic').retryable).toBe(false);
    expect(new ModelCallError('bad_request', 'google').retryable).toBe(false);
    expect(new ModelCallError('auth', 'anthropic').retryable).toBe(false);
  });

  it('carries the provider and the retry-after the provider sent', () => {
    const error = new ModelCallError('rate_limited', 'anthropic', {
      status: 429,
      retryAfterMs: 2_000,
      requestId: 'req_1',
    });
    expect(error.provider).toBe('anthropic');
    expect(error.detail.retryAfterMs).toBe(2_000);
    // The message is the kind, so a log line is useful without the structured fields — and the
    // provider's own message is deliberately not interpolated, because those have carried prompt
    // fragments.
    expect(error.message).toBe('rate_limited');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ModelCallError');
  });
});

describe('the gateway interface', () => {
  it('is implementable with only the required members', () => {
    // The optional members are optional because not every provider has them: `countTokens` needs a
    // provider endpoint and Batches is Anthropic-only in 1.0. A caller asks `routeInfo` first.
    const minimal: ModelGateway = {
      run: () => Promise.reject(new ModelCallError('unknown', 'fake')),
      structured: () => Promise.reject(new ModelCallError('unknown', 'fake')),
      embed: () => Promise.resolve([]),
      routeInfo: () => ({
        provider: 'fake',
        providerId: 'fake',
        model: 'fake-1',
        priceId: 'fake/fake-1',
        supports: {
          contextWindow: 1_000_000,
          maxOutput: 128_000,
          effort: [...EFFORT_LEVELS],
          defaultEffort: 'medium',
          tools: 'native_strict',
          structured: 'native',
          parallelTools: true,
          midConversationSystem: true,
          perMessageEffort: true,
          promptCaching: 'explicit',
          minCacheableTokens: 512,
          maxBreakpoints: 4,
          vision: true,
          pdf: true,
          batches: true,
          countTokens: true,
        },
      }),
    };
    expect(minimal.routeInfo('chat').supports.effort).toHaveLength(5);
    expect(minimal.countTokens).toBeUndefined();
  });
});
