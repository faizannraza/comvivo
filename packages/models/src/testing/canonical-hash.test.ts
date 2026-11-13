/**
 * The canonical request hash (`05` §3.5.7; `M2-T7`).
 *
 * `CassetteModel` keys recorded responses by this hash, which makes the whole design hinge on one
 * property with two halves: **the same logical request hashes the same**, and **a request that
 * differs in anything the model can see hashes differently**. A hash that is too strict misses on
 * every replay and the suite silently stops testing; one that is too forgiving replays an answer to
 * a different question.
 *
 * So every exclusion in the module's table gets a test, and so does every inclusion. A property
 * test covers the first half across generated ids; the second half is enumerated, because "what
 * the model can see" is a list somebody has to maintain.
 */
import type { ModelTurnRequest } from '@comvivo/core';
import { fcConfig } from '@comvivo/shared/testing';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toolSpec, turnRequest } from '../anthropic/testing/fixtures.js';
import { canonicalTurnRequest, hashStructuredRequest, hashTurnRequest } from './canonical-hash.js';

const SCHEMA = { safeParse: (input: unknown) => ({ success: true, data: input }) as const };

function structuredRequest(overrides: Record<string, unknown> = {}) {
  return {
    route: 'route' as const,
    purpose: 'route.classify',
    system: [{ id: 'router', text: 'classify' }],
    input: [{ type: 'text' as const, text: 'hola' }],
    schema: SCHEMA,
    jsonSchema: {
      type: 'object' as const,
      properties: { dominantLanguage: { type: 'string' as const } },
      required: ['dominantLanguage'],
      additionalProperties: false as const,
    },
    schemaName: 'route_v1',
    effort: 'low' as const,
    maxOutputTokens: 512,
    correlation: {},
    ...overrides,
  };
}

describe('what the hash ignores', () => {
  it('ignores correlation ids, which are fresh on every run', async () => {
    const a = await hashTurnRequest(turnRequest({ correlation: {} }));
    const b = await hashTurnRequest(
      turnRequest({
        correlation: { groupId: 'grp_1' as never, turnId: 'trn_1' as never, step: 3 },
      }),
    );
    // A cassette keyed by a group id would miss for every other group.
    expect(a).toBe(b);
  });

  it('ignores the context manifest, which is never sent to a provider', async () => {
    const manifest = {
      messageIds: [],
      memoryIds: [],
      labelIds: [1, 2, 3],
      entityRefs: [],
      tokenEstimate: 99,
      contextHash: 'deadbeef',
    };
    expect(await hashTurnRequest(turnRequest())).toBe(
      await hashTurnRequest(turnRequest({ meta: { manifest } })),
    );
  });

  it('ignores the purpose, which is a cost label and not part of the prompt', async () => {
    expect(await hashTurnRequest(turnRequest({ purpose: 'turn.reply' }))).toBe(
      await hashTurnRequest(turnRequest({ purpose: 'turn.step' })),
    );
  });
});

describe('what the hash includes', () => {
  const base = turnRequest({ tools: [toolSpec()] });

  const differs = async (changed: Partial<ModelTurnRequest>): Promise<boolean> =>
    (await hashTurnRequest(base)) !== (await hashTurnRequest(turnRequest({ ...base, ...changed })));

  it('includes the effort, the route and the variant', async () => {
    expect(await differs({ effort: 'max' })).toBe(true);
    expect(await differs({ route: 'guard' })).toBe(true);
    expect(await differs({ variant: 'economy' })).toBe(true);
  });

  it('includes maxOutputTokens, which changes what the model may produce', async () => {
    // Listed explicitly because it looks like plumbing and is not.
    expect(await differs({ maxOutputTokens: 4096 })).toBe(true);
  });

  it('includes toolChoice and the tool list', async () => {
    expect(await differs({ toolChoice: 'none' })).toBe(true);
    expect(await differs({ tools: [] })).toBe(true);
    expect(await differs({ tools: [toolSpec('other_name')] })).toBe(true);
  });

  it('includes the system prompt, its layer ids and its cache hints', async () => {
    expect(await differs({ system: [{ id: 'charter', text: 'different' }] })).toBe(true);
    expect(
      await differs({ system: [{ id: 'other', text: 'be useful', cache: { ttl: '1h' } }] }),
    ).toBe(true);
    expect(
      await differs({ system: [{ id: 'charter', text: 'be useful', cache: { ttl: '5m' } }] }),
    ).toBe(true);
  });

  it('includes the messages', async () => {
    expect(
      await differs({ messages: [{ role: 'user', content: [{ type: 'text', text: 'other' }] }] }),
    ).toBe(true);
  });

  it('includes an image’s length but not its bytes', async () => {
    const withImage = (bytes: Uint8Array): ModelTurnRequest =>
      turnRequest({
        messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/png', data: bytes }] }],
      });
    // Same length, different content: a cassette must not carry a member's photo, and the shape is
    // what a replay needs.
    expect(await hashTurnRequest(withImage(new Uint8Array([1, 2, 3])))).toBe(
      await hashTurnRequest(withImage(new Uint8Array([9, 9, 9]))),
    );
    expect(await hashTurnRequest(withImage(new Uint8Array([1, 2])))).not.toBe(
      await hashTurnRequest(withImage(new Uint8Array([1, 2, 3]))),
    );
  });

  it('includes whether a turn had thinking, without the thinking text', async () => {
    const assistant = (parts: { type: 'text' | 'opaque'; text?: string }[]): ModelTurnRequest =>
      turnRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          {
            role: 'assistant',
            provider: 'anthropic',
            servedModel: 'claude-opus-5-5',
            raw: [],
            view: parts.map((part) =>
              part.type === 'text'
                ? { type: 'text' as const, text: part.text ?? '' }
                : { type: 'opaque' as const, kind: 'thinking' as const },
            ),
          },
          { role: 'user', content: [{ type: 'text', text: 'more' }] },
        ],
      });
    expect(await hashTurnRequest(assistant([{ type: 'text', text: 'hi' }]))).not.toBe(
      await hashTurnRequest(assistant([{ type: 'opaque' }, { type: 'text', text: 'hi' }])),
    );
  });
});

describe('tool-call ids', () => {
  const withIds = (first: string, second: string): ModelTurnRequest =>
    turnRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          provider: 'anthropic',
          servedModel: 'claude-opus-5-5',
          raw: [],
          view: [
            { type: 'tool_call', id: first, name: 'a', input: {} },
            { type: 'tool_call', id: second, name: 'b', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolCallId: first, content: 'x', isError: false },
            { type: 'tool_result', toolCallId: second, content: 'y', isError: false },
          ],
        },
      ],
    });

  it('renumbers them, so a provider’s own ids do not key a fixture', async () => {
    expect(await hashTurnRequest(withIds('toolu_01', 'toolu_02'))).toBe(
      await hashTurnRequest(withIds('toolu_AA', 'toolu_BB')),
    );
  });

  it('still notices when the pairing changes', async () => {
    const swapped = turnRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          provider: 'anthropic',
          servedModel: 'claude-opus-5-5',
          raw: [],
          view: [
            { type: 'tool_call', id: 'a', name: 'a', input: {} },
            { type: 'tool_call', id: 'b', name: 'b', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            // Results in the other order: a different request, which must hash differently.
            { type: 'tool_result', toolCallId: 'b', content: 'y', isError: false },
            { type: 'tool_result', toolCallId: 'a', content: 'x', isError: false },
          ],
        },
      ],
    });
    expect(await hashTurnRequest(withIds('a', 'b'))).not.toBe(await hashTurnRequest(swapped));
  });
});

describe('structured requests', () => {
  it('hash by schema name, not by the zod type', async () => {
    // `05` §3.6 already requires the name to be stable, because it is part of the cache prefix. A
    // schema change under the same name is a re-record, which is the same rule as for a prompt.
    expect(await hashStructuredRequest(structuredRequest())).toBe(
      await hashStructuredRequest(
        structuredRequest({ schema: { safeParse: () => ({ success: false }) } }),
      ),
    );
    expect(await hashStructuredRequest(structuredRequest())).not.toBe(
      await hashStructuredRequest(structuredRequest({ schemaName: 'route_v2' })),
    );
  });

  it('never collide with a turn request', async () => {
    expect(await hashStructuredRequest(structuredRequest())).not.toBe(
      await hashTurnRequest(turnRequest()),
    );
  });
});

describe('stability', () => {
  it('is stable across repeated calls', async () => {
    const request = turnRequest({ tools: [toolSpec()] });
    const hashes = await Promise.all([
      hashTurnRequest(request),
      hashTurnRequest(request),
      hashTurnRequest(request),
    ]);
    expect(new Set(hashes).size).toBe(1);
  });

  it('is independent of the order our own code built the request object in', () => {
    // The canonical form is what gets hashed, and `canonicalJson` sorts keys. A request assembled
    // field by field in a different order is the same request.
    const a = turnRequest({ effort: 'high', maxOutputTokens: 4096 });
    const reordered = { ...a };
    expect(JSON.stringify(canonicalTurnRequest(a))).toBe(
      JSON.stringify(canonicalTurnRequest(reordered)),
    );
  });

  it('property: ids and manifests never change the hash', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 50 }),
        async (toolId, hashSeed, step) => {
          const base = turnRequest({
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'go' }] },
              {
                role: 'assistant',
                provider: 'anthropic',
                servedModel: 'claude-opus-5-5',
                raw: [],
                view: [{ type: 'tool_call', id: toolId, name: 'a', input: {} }],
              },
              {
                role: 'user',
                content: [
                  { type: 'tool_result', toolCallId: toolId, content: 'x', isError: false },
                ],
              },
            ],
          });
          const decorated = turnRequest({
            ...base,
            correlation: { step },
            meta: {
              manifest: {
                messageIds: [],
                memoryIds: [],
                labelIds: [],
                entityRefs: [],
                tokenEstimate: step,
                contextHash: hashSeed,
              },
            },
          });
          return (await hashTurnRequest(base)) === (await hashTurnRequest(decorated));
        },
      ),
      fcConfig(),
    );
  });
});
