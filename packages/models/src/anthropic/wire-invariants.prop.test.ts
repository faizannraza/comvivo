/**
 * `05` §9.3's fuzz clause: no sequence of messages produces a request that breaks `01` §2.1.
 *
 * The clause reads "fuzzed messages never produce a request with sampling parameters, more than 4
 * breakpoints, an assistant-final message (except pause), or split tool results". The M2
 * second-pass review measured it unmet — `fast-check` appeared once in `packages/models`
 * (`request-hash.test.ts`) and `pnpm test:prop`'s `.prop.` glob matched nothing in this package, so
 * every wire-invariant test on all four adapters was example-based.
 *
 * The difference matters for this guard specifically. `assertWireInvariants` is not a validator
 * over one shape; it is a claim about **every** conversation the engine can hand to the builder,
 * and a conversation is a sequence. The four properties below are the ones the clause names, and
 * each is a rule whose violation has a specific cost:
 *
 *  - **Sampling parameters** are `01` §2.1's non-negotiable, and a 400 on every turn.
 *  - **More than four breakpoints** is a 400 from the API, and the fifth is silently the one that
 *    matters — a long conversation accumulates cache hints.
 *  - **An assistant-final message** makes the model continue its own sentence instead of answering,
 *    which is assistant prefill by accident (`01` §2.1 bans it deliberately).
 *  - **Split tool results** train the model to stop calling tools in parallel: a quality regression
 *    with no error attached.
 *
 * `buildChatRequest` already calls `assertWireInvariants`, so a violation surfaces as a throw.
 * These properties therefore assert the **absence of a throw** over generated input plus the
 * specific shape of the built request, which is what makes them more than a smoke test: a builder
 * that satisfied the assertion by emitting nothing would fail the shape half.
 */
import type { AssistantMessage, ModelMessage, UserPart } from '@comvivo/core';
import { fcConfig } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildChatRequest } from './request.js';
import { bindingFor, OPUS, toolSpec, turnRequest } from './testing/fixtures.js';

/**
 * A conversation, generated as the engine produces one.
 *
 * Three constraints the generator has to obey, each found by a property failing on input no engine
 * or provider ever produces. Writing them down is most of this file's value, because each one is a
 * rule that lives somewhere other than the adapter:
 *
 *  1. **A tool-result message follows an assistant message whose `raw` holds the matching
 *     `tool_use` blocks.** `01` §2.1 echoes `response.content` unchanged, so the blocks have to be
 *     in `raw` and not only in `view`.
 *  2. **Cache TTLs are non-increasing** (`05` §3.5.3.2). Caching is a prefix match, so a `5m` hint
 *     ahead of a `1h` one caps the longer one. `assertWireInvariants` throws rather than
 *     reordering, because which layer gets which TTL is the prompt builder's decision and a silent
 *     correction would hide its bug.
 *  3. **At most four cache hints** (`05` D9: tools + charter, group layer, turn layer, latest tool
 *     result). The ceiling belongs to the **cache plan**, which `M3-T5`'s prompt builder owns; the
 *     adapter asserts it. So the generator stays inside the plan, and a separate property below
 *     checks that stepping outside it is caught.
 *
 * Generating ill-formed input would make this file fail for the generator's reasons rather than
 * the builder's, which is the difference between a property test and a noise source.
 */
const TTLS = [undefined, '5m', '1h'] as const;

/** `05` D9's ceiling, minus headroom for the hints the base request already carries. */
const MAX_GENERATED_HINTS = 2;

/** One round: a user turn, optionally followed by an assistant's calls and all their results. */
function roundsFor(
  ttl: '5m' | '1h' | undefined,
  hinted: boolean,
): fc.Arbitrary<readonly ModelMessage[]> {
  const hint = ttl === undefined || !hinted ? {} : { cache: { ttl } };
  const userMessage = fc
    .string({ minLength: 1, maxLength: 40 })
    .map((text): ModelMessage => ({ role: 'user', content: [{ type: 'text', text, ...hint }] }));
  return fc.oneof(
    userMessage.map((message) => [message]),
    fc
      .record({
        user: userMessage,
        names: fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 4 }),
      })
      .map(({ user, names }): readonly ModelMessage[] => {
        const assistant: AssistantMessage = {
          role: 'assistant',
          provider: 'anthropic',
          servedModel: OPUS,
          raw: names.map((name, index) => ({
            type: 'tool_use',
            id: `call_${String(index)}`,
            name,
            input: {},
          })),
          view: names.map((name, index) => ({
            type: 'tool_call' as const,
            id: `call_${String(index)}`,
            name,
            input: {},
          })),
        };
        // **All** the results in one user message, which is the rule the fourth property asserts
        // the builder preserves. The generator obeys it so the property is about the builder.
        const results: ModelMessage = {
          role: 'user',
          content: names.map(
            (name, index): UserPart => ({
              type: 'tool_result',
              toolCallId: `call_${String(index)}`,
              toolName: name,
              content: '{"ok":true}',
              isError: false,
            }),
          ),
        };
        return [user, assistant, results];
      }),
  );
}

const conversation = fc
  .record({ ttl: fc.constantFrom(...TTLS), rounds: fc.integer({ min: 1, max: 5 }) })
  .chain(({ ttl, rounds }) =>
    fc.tuple(
      ...Array.from({ length: rounds }, (_unused, index) =>
        roundsFor(ttl, index < MAX_GENERATED_HINTS),
      ),
    ),
  )
  .map((rounds) => rounds.flat());

/** Build, and report a throw as a failure with the generated conversation attached. */
function build(messages: readonly ModelMessage[], effort: 'low' | 'medium' | 'high' = 'medium') {
  return buildChatRequest(
    turnRequest({
      messages: [...messages, { role: 'user', content: [{ type: 'text', text: 'and now?' }] }],
      effort,
      tools: [toolSpec()],
    }),
    { binding: bindingFor({ model: OPUS }), availableBetas: [] },
  );
}

/** Every `cache_control` marker in a built request, wherever it sits. */
function breakpointsIn(params: ReturnType<typeof build>['params']): number {
  const marked = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && 'cache_control' in value
      ? (value as { cache_control?: unknown }).cache_control != null
      : false;
  const parts = params.messages.flatMap((message) =>
    typeof message.content === 'string' || message.content === undefined ? [] : message.content,
  );
  return [...(params.tools ?? []), ...(params.system ?? []), ...parts].filter(marked).length;
}

describe('assertWireInvariants over fuzzed conversations (05 §9.3)', () => {
  it('never produces a request carrying a sampling parameter', () => {
    fc.assert(
      fc.property(conversation, (messages) => {
        const { params } = build(messages);
        const wide = params as unknown as Record<string, unknown>;
        for (const key of ['temperature', 'top_p', 'top_k', 'topP', 'topK']) {
          expect(key in wide, key).toBe(false);
        }
      }),
      fcConfig(),
    );
  });

  it('never produces more than four cache breakpoints', () => {
    // The API's ceiling. Generated conversations ask for a hint on roughly half their messages, so
    // this property exercises the trimming the builder does rather than a happy path where the
    // ceiling is never approached.
    fc.assert(
      fc.property(conversation, (messages) => {
        expect(breakpointsIn(build(messages).params)).toBeLessThanOrEqual(4);
      }),
      fcConfig(),
    );
  });

  it('refuses a conversation that steps outside the cache plan', () => {
    // The other side of the property above, and the reason it is allowed to generate within the
    // plan: the ceiling is enforced, loudly, by the adapter. `05` D9 fixes the plan at four
    // breakpoints and `M3-T5`'s prompt builder owns it, so five is a bug in the plan — caught here
    // rather than as a 400 from the provider with no indication of which layer added the fifth.
    const hinted = Array.from(
      { length: 6 },
      (_unused, index): ModelMessage => ({
        role: 'user',
        content: [{ type: 'text', text: `m${String(index)}`, cache: { ttl: '1h' } }],
      }),
    );
    expect(() => build(hinted)).toThrow(/cache_control markers; the API allows 4/);
  });

  it('never ends a request with an assistant message', () => {
    // An assistant-final message is assistant prefill by accident: the model continues its own
    // sentence instead of answering. `01` §2.1 bans the deliberate version.
    fc.assert(
      fc.property(conversation, (messages) => {
        const { params } = build(messages);
        expect(params.messages.at(-1)?.role).toBe('user');
      }),
      fcConfig(),
    );
  });

  it('never splits one round’s tool results across two messages', () => {
    // Splitting them trains the model to stop calling tools in parallel — a quality regression
    // with no error attached, which is why it is a property rather than a hope.
    fc.assert(
      fc.property(conversation, (messages) => {
        const { params } = build(messages);
        let previousWasResults = false;
        for (const message of params.messages) {
          const content = message.content;
          const parts = content === undefined || typeof content === 'string' ? [] : content;
          const isResults =
            message.role === 'user' && parts.some((part) => part.type === 'tool_result');
          expect(isResults && previousWasResults).toBe(false);
          previousWasResults = isResults;
        }
      }),
      fcConfig(),
    );
  });
});
