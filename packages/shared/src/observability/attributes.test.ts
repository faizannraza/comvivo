import { describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import { BugError } from '../errors.js';
import {
  type Attributes,
  FORBIDDEN_ATTRIBUTE_FAMILIES,
  FORBIDDEN_ATTRIBUTE_NAMES,
  isForbiddenAttribute,
  MAX_ATTRIBUTE_LENGTH,
  mergeAttributes,
  sanitizeAttributes,
} from './attributes.js';
import { ATTR, GENAI } from './semconv-genai.js';

/**
 * Layer 1 — the type.
 *
 * These assertions are the strongest layer, because they fail in the editor before anyone runs a
 * test. A `@ts-expect-error` that stops being an error fails `pnpm typecheck`, so this block
 * cannot rot into decoration.
 */
describe('the Attributes type', () => {
  it('accepts ordinary attributes', () => {
    const ok: Attributes = {
      [GENAI.REQUEST_MODEL]: 'claude-opus-5-5',
      [GENAI.USAGE_INPUT_TOKENS]: 19_000,
      [GENAI.REQUEST_STREAM]: true,
      [GENAI.RESPONSE_FINISH_REASONS]: ['end_turn'],
    };
    expect(Object.keys(ok)).toHaveLength(4);
  });

  it('refuses every GenAI content family at compile time', () => {
    const attempts: Attributes[] = [
      // @ts-expect-error gen_ai.input.* carries the prompt
      { 'gen_ai.input.messages': 'what did mum say about the house' },
      // @ts-expect-error a reference to the prompt is the prompt
      { 'gen_ai.input.messages_ref': 'https://store.example/abc' },
      // @ts-expect-error gen_ai.output.messages carries the completion
      { 'gen_ai.output.messages': 'she said...' },
      // @ts-expect-error system instructions are the behaviour charter plus group context
      { 'gen_ai.system_instructions': 'You are a careful assistant.' },
      // @ts-expect-error tool definitions describe the group's own data shape
      { 'gen_ai.tool.definitions': '[]' },
      // @ts-expect-error tool arguments are user input
      { 'gen_ai.tool.call.arguments': '{"to":"dad"}' },
      // @ts-expect-error tool results are group data
      { 'gen_ai.tool.call.result': 'ok' },
      // @ts-expect-error a memory query is what somebody asked about whom
      { 'gen_ai.memory.query.text': 'dad allergies' },
      // @ts-expect-error memory records are the memories themselves
      { 'gen_ai.memory.records': ['...'] },
      // @ts-expect-error retrieval queries and documents are content
      { 'gen_ai.retrieval.query.text': 'school run' },
      // @ts-expect-error retrieved documents are content
      { 'gen_ai.retrieval.documents': ['...'] },
      // @ts-expect-error template variables carry member names
      { 'gen_ai.prompt.variable.user_name': 'Priya' },
    ];
    expect(attempts).toHaveLength(12);
  });

  it('refuses an attribute the registry has not invented yet', () => {
    // The families are prefixes, so this is rejected without anyone updating a list. That is the
    // whole argument for prefix families: `gen_ai.input.messages_ref` did not exist when the plan
    // was written and would have slipped through an exact-match denylist.
    const attempts: Attributes[] = [
      // @ts-expect-error a hypothetical future content attribute under a known family
      { 'gen_ai.input.attachments_v2': 'x' },
      // @ts-expect-error likewise
      { 'gen_ai.memory.query.embedding': 'x' },
    ];
    expect(attempts).toHaveLength(2);
  });

  it("refuses the logger's forbidden bare names too", () => {
    const attempts: Attributes[] = [
      // @ts-expect-error the single most likely attribute name for a leak
      { text: 'hello' },
      // @ts-expect-error
      { body: 'hello' },
      // @ts-expect-error
      { memberName: 'Priya' },
      // @ts-expect-error a secret is not an attribute
      { token: 'abc' },
      // @ts-expect-error
      { authorization: 'Bearer abc' },
    ];
    expect(attempts).toHaveLength(5);
  });
});

/** Layer 2 — the runtime filter, for attributes assembled from data that lost its type. */
describe('isForbiddenAttribute', () => {
  it('matches the declared families', () => {
    for (const family of FORBIDDEN_ATTRIBUTE_FAMILIES) {
      expect(isForbiddenAttribute(`${family}anything`), family).toBe(true);
    }
  });

  it('matches the bare names, case-insensitively', () => {
    for (const name of FORBIDDEN_ATTRIBUTE_NAMES) {
      expect(isForbiddenAttribute(name), name).toBe(true);
      expect(isForbiddenAttribute(name.toUpperCase()), name.toUpperCase()).toBe(true);
    }
  });

  it('allows the attributes we actually emit', () => {
    for (const value of Object.values(GENAI)) {
      expect(isForbiddenAttribute(value), value).toBe(false);
    }
    for (const value of ['error.type', 'server.address', 'server.port', 'service.name']) {
      expect(isForbiddenAttribute(value), value).toBe(false);
    }
  });

  it('does not match a name that merely contains a forbidden word', () => {
    // `textLength` is a number about content, not content. Over-matching here would push people
    // toward disabling the check, which is how a guard stops guarding.
    for (const name of ['textLength', 'bodyBytes', 'messagesCount', 'tokenCount', 'resultCode']) {
      expect(isForbiddenAttribute(name), name).toBe(false);
    }
  });
});

describe('sanitizeAttributes', () => {
  // Every test here runs with COMVIVO_TEST_MODE=1, so a forbidden key throws. The dropping
  // behaviour is asserted separately below with the flag cleared.
  it('passes clean attributes through', () => {
    const out = sanitizeAttributes({
      [GENAI.REQUEST_MODEL]: 'claude-opus-5-5',
      [GENAI.USAGE_INPUT_TOKENS]: 175,
      [GENAI.REQUEST_STREAM]: false,
    });
    expect(out).toEqual({
      'gen_ai.request.model': 'claude-opus-5-5',
      'gen_ai.usage.input_tokens': 175,
      'gen_ai.request.stream': false,
    });
  });

  it('throws in test mode, naming the attribute and the alternative', () => {
    expect(() => sanitizeAttributes({ 'gen_ai.input.messages': 'secret family talk' })).toThrow(
      BugError,
    );
    try {
      sanitizeAttributes({ text: 'hello' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('text');
      expect(message).toContain('01 §11.7');
      // The message must say what to do instead, not only that it refused.
      expect(message).toContain(`${BRAND.slug}.turn.id`);
    }
  });

  it('drops rather than throws outside test mode', () => {
    // A telemetry mistake must never take down a family's bot. In production the attribute is
    // dropped and the span is still emitted; in a test it throws, because there it is a bug that
    // would otherwise pass CI.
    const flag = `${BRAND.envPrefix}TEST_MODE`;
    const previous = process.env[flag];
    delete process.env[flag];
    try {
      const out = sanitizeAttributes({
        'gen_ai.input.messages': 'secret',
        [GENAI.REQUEST_MODEL]: 'claude-haiku-5-5',
      });
      expect(out).toEqual({ 'gen_ai.request.model': 'claude-haiku-5-5' });
      expect(out['gen_ai.input.messages']).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env[flag] = previous;
    }
  });

  it('scrubs secret shapes out of attribute values', () => {
    // The one place a token genuinely appears is in somebody else's error string. Assembled at
    // runtime so no secret-shaped literal sits in this file (`pnpm secrets:check`).
    const token = `${'123456789'}:${'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'}`;
    const out = sanitizeAttributes({ 'error.type': `401 from /bot${token}/sendMessage` });
    expect(out['error.type']).not.toContain(token);
  });

  it('truncates long strings', () => {
    const out = sanitizeAttributes({ 'error.type': 'x'.repeat(5000) });
    expect(String(out['error.type'])).toHaveLength(MAX_ATTRIBUTE_LENGTH);
    expect(String(out['error.type']).endsWith('…')).toBe(true);
  });

  it('caps arrays and stringifies their items', () => {
    const out = sanitizeAttributes({ 'x.list': Array.from({ length: 100 }, (_, i) => `v${i}`) });
    expect(out['x.list']).toHaveLength(32);
  });

  it('keeps numeric arrays numeric', () => {
    const out = sanitizeAttributes({ 'x.nums': [1, 2, 3] });
    expect(out['x.nums']).toEqual([1, 2, 3]);
  });

  it('drops values that are not attribute values', () => {
    const out = sanitizeAttributes({
      'x.obj': { nested: 'value' },
      'x.fn': () => 'no',
      'x.null': null,
      'x.undef': undefined,
      'x.nan': Number.NaN,
      'x.inf': Number.POSITIVE_INFINITY,
      'x.sym': Symbol('s'),
    });
    expect(out).toEqual({});
  });

  it('converts a bigint, because a token count can arrive as one', () => {
    expect(sanitizeAttributes({ 'x.n': 42n })).toEqual({ 'x.n': 42 });
  });

  it('reports every forbidden attribute at once, not just the first', () => {
    try {
      sanitizeAttributes({ text: 'a', body: 'b', 'gen_ai.input.messages': 'c' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('text');
      expect(message).toContain('body');
      expect(message).toContain('gen_ai.input.messages');
    }
  });
});

describe('mergeAttributes (M2-T15)', () => {
  it('merges two bags, with the later one winning a collision', () => {
    expect(mergeAttributes({ 'a.x': 1, 'a.y': 2 }, { 'a.y': 3, 'a.z': 4 })).toEqual({
      'a.x': 1,
      'a.y': 3,
      'a.z': 4,
    });
  });

  it('accepts a bag whose keys are computed from brand-namespaced constants', () => {
    // The reason this function exists. `Attributes` is an open index signature intersected with
    // `Partial<Record<Forbidden, never>>`, and the two halves fight when you compose: spreading one
    // bag into a literal gives the literal a `string` index signature, which is not assignable to
    // `never`. Every span is assembled from a request half and a response half, so without a
    // sanctioned merge nothing could emit `ATTR.*` at all (found at `M2-T15`).
    expect(
      mergeAttributes({ [ATTR.MODEL_ROUTE]: 'chat' }, { [ATTR.MODEL_EFFORT]: 'medium' }),
    ).toEqual({ [ATTR.MODEL_ROUTE]: 'chat', [ATTR.MODEL_EFFORT]: 'medium' });
  });

  it('is a no-op on no bags, and on one', () => {
    expect(mergeAttributes()).toEqual({});
    expect(mergeAttributes({ 'a.x': 1 })).toEqual({ 'a.x': 1 });
  });

  it('re-applies the denylist, which is what makes the cast inside it safe', () => {
    // A bag assembled from `unknown` data loses the type on the way in, so the merge has to check
    // again rather than trust that every caller came through the compile-time layer.
    expect(() =>
      mergeAttributes({ 'a.x': 1 }, JSON.parse('{"gen_ai.input.messages":"the recital"}')),
    ).toThrow(/forbidden/i);
  });

  it('bounds and scrubs values exactly as sanitizeAttributes does', () => {
    const merged = mergeAttributes({ 'a.long': 'x'.repeat(MAX_ATTRIBUTE_LENGTH + 50) });
    expect((merged['a.long'] as string).length).toBe(MAX_ATTRIBUTE_LENGTH);
  });

  it('refuses a content attribute at compile time', () => {
    // @ts-expect-error -- `gen_ai.output.messages` is an opt-in content attribute.
    expect(() => mergeAttributes({ 'gen_ai.output.messages': 'hi' })).toThrow();
  });
});
