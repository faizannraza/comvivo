/**
 * The request mapping and `assertWireInvariants` (`05` §3.5.3.2, §9.3; `M2-T6`).
 *
 * `11` §3.1.9 asks for the `01` §2.1 rules to hold on **every captured request**, so the assertions
 * here are over the built object rather than over the arguments that produced it. Each invariant
 * gets a pair: a request that violates it and is refused, and one that does not and is built. A
 * refusal test on its own passes just as well against a function that refuses everything.
 */
import type { AssistantMessage, ModelMessage } from '@comvivo/core';
import { describe, expect, it } from 'vitest';
import {
  type AnthropicChatParams,
  assertWireInvariants,
  buildChatRequest,
  type InvariantContext,
  MAX_CACHE_BREAKPOINTS,
  OPTIONAL_BETAS,
  WireInvariantError,
} from './request.js';
import { bindingFor, OPUS, toolSpec, turnRequest } from './testing/fixtures.js';

const ALL_BETAS = Object.values(OPTIONAL_BETAS);

function build(
  overrides: Parameters<typeof turnRequest>[0] = {},
  options: { betas?: readonly string[]; resuming?: boolean } = {},
) {
  return buildChatRequest(turnRequest(overrides), {
    binding: bindingFor(),
    availableBetas: (options.betas ?? ALL_BETAS) as never,
    ...(options.resuming === undefined ? {} : { resumingPausedTurn: options.resuming }),
  });
}

/** An assistant turn as the adapter would have produced it. */
function assistant(raw: unknown[]): AssistantMessage {
  return { role: 'assistant', provider: 'anthropic', servedModel: OPUS, raw, view: [] };
}

describe('the top-level mapping (05 §3.5.3.2)', () => {
  it('maps model, max_tokens and effort', () => {
    const { params } = build();
    expect(params.model).toBe(OPUS);
    expect(params.max_tokens).toBe(8000);
    expect(params.output_config).toEqual({ effort: 'medium' });
  });

  it('renders each system layer as its own text block, with its cache hint', () => {
    const { params } = build({
      system: [
        { id: 'charter', text: 'a', cache: { ttl: '1h' } },
        { id: 'constitution', text: 'b' },
      ],
    });
    expect(params.system).toEqual([
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'b' },
    ]);
  });

  it('sends every tool with strict: true', () => {
    const { params } = build({ tools: [toolSpec()] });
    expect(params.tools).toEqual([
      {
        name: 'get_forecast',
        description: 'Return a short weather summary for one city.',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        strict: true,
      },
    ]);
    expect(params.tool_choice).toEqual({ type: 'auto' });
  });

  it('maps toolChoice none, and never any or tool', () => {
    expect(build({ tools: [toolSpec()], toolChoice: 'none' }).params.tool_choice).toEqual({
      type: 'none',
    });
  });

  it('omits tools and tool_choice together when there are none', () => {
    const { params } = build();
    // `tool_choice` with no tools is a 400, and an empty `tools` array says "call nothing" twice.
    expect('tools' in params).toBe(false);
    expect('tool_choice' in params).toBe(false);
  });

  it('asks for the refusal fallback on a model that offers it', () => {
    const { params, betas } = build();
    expect(params.fallbacks).toBe('default');
    // The scalar `'default'` form pairs with the `-07-01` header specifically; the array form takes
    // `-06-01`, and crossing them is a 400.
    expect(betas).toContain('server-side-fallback-2026-07-01');
  });

  it('omits the fallback when the model does not offer one', () => {
    const binding = bindingFor({
      capabilities: { ...bindingFor().capabilities, serverFallback: 'none' },
    });
    const { params, betas } = buildChatRequest(turnRequest(), {
      binding,
      availableBetas: ALL_BETAS as never,
    });
    expect('fallbacks' in params).toBe(false);
    expect(betas).not.toContain('server-side-fallback-2026-07-01');
  });

  it('omits the fallback when the beta is unavailable, rather than failing', () => {
    const { params } = build({}, { betas: [] });
    expect('fallbacks' in params).toBe(false);
  });

  it('sets adaptive thinking with explicit block binding when the beta is available', () => {
    expect(build().params.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'error' },
    });
  });

  it('omits thinking entirely without the binding beta, because adaptive is the default', () => {
    expect('thinking' in build({}, { betas: [] }).params).toBe(false);
  });

  it('never sets display, so no reasoning text is returned to hold', () => {
    const thinking = build().params.thinking;
    expect(thinking !== undefined && 'display' in thinking).toBe(false);
  });

  it('sends none of 01 §2.1’s forbidden fields', () => {
    const wide = build({ tools: [toolSpec()] }).params as unknown as Record<string, unknown>;
    for (const key of ['temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata']) {
      expect(key in wide).toBe(false);
    }
  });

  it('carries nothing derived from `meta`, which is ours and never sent', () => {
    const { params } = build({ meta: { manifest: { items: [] } as never } });
    expect(JSON.stringify(params)).not.toContain('manifest');
  });
});

describe('user parts', () => {
  it('maps text, images, PDFs and tool results', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { params } = build({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look', cache: { ttl: '5m' } },
            { type: 'image', mime: 'image/png', data: bytes },
            { type: 'document', mime: 'application/pdf', data: bytes },
          ],
        },
      ],
    });
    expect(params.messages[0]?.content).toEqual([
      { type: 'text', text: 'look', cache_control: { type: 'ephemeral', ttl: '5m' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'AQID' },
      },
    ]);
  });

  it('maps a tool result, with is_error only when it failed', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'get_forecast', input: {} }]),
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'toolu_1', content: 'sunny', isError: false }],
      },
    ];
    const { params } = build({ messages });
    expect(params.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' },
    ]);

    const failed: ModelMessage[] = [
      messages[0] as ModelMessage,
      messages[1] as ModelMessage,
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'toolu_1', content: 'down', isError: true }],
      },
    ];
    expect(build({ messages: failed }).params.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'down', is_error: true },
    ]);
  });

  it('echoes an assistant turn verbatim', () => {
    const raw = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'hi' },
    ];
    const { params } = build({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        assistant(raw),
        { role: 'user', content: [{ type: 'text', text: 'more' }] },
      ],
    });
    // Unchanged, including the **empty** thinking block: `display: 'omitted'` is the default on
    // these models and an empty `thinking` with a signature is what a valid continuation is.
    expect(params.messages[1]).toEqual({ role: 'assistant', content: raw });
  });

  it('refuses an assistant turn whose raw did not come from this adapter', () => {
    const forged: AssistantMessage = {
      role: 'assistant',
      provider: 'anthropic',
      servedModel: OPUS,
      raw: 'just a string',
      view: [],
    };
    expect(() =>
      build({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }, forged] }),
    ).toThrow(WireInvariantError);
  });
});

describe('mid-conversation system messages', () => {
  const withSystem = (message: ModelMessage, betas?: readonly string[]) =>
    build(
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }, message],
      },
      betas === undefined ? {} : { betas },
    );

  it('renders a persistent notice as a role:system message', () => {
    const { params, transformations } = withSystem({
      role: 'system',
      kind: 'notice',
      text: 'quiet hours',
      scope: 'persistent',
    });
    expect(params.messages[1]).toEqual({ role: 'system', content: 'quiet hours' });
    expect(transformations).toBe(0);
  });

  it('renders a turn-scoped notice with clear_at when the beta is available', () => {
    const { params, transformations } = withSystem({
      role: 'system',
      kind: 'notes',
      text: 'one turn only',
      scope: 'turn',
    });
    expect(params.messages[1]).toEqual({
      role: 'system',
      content: 'one turn only',
      clear_at: 'next_user_message',
    });
    expect(transformations).toBe(0);
  });

  it('degrades a turn-scoped notice to a text block, and counts the transformation', () => {
    const { params, transformations } = withSystem(
      { role: 'system', kind: 'notes', text: 'one turn only', scope: 'turn' },
      [],
    );
    // Appended to the preceding user message: permanent rather than one-turn, which is worse but
    // visible — and the count is what makes it visible.
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]?.content).toEqual([
      { type: 'text', text: 'go' },
      { type: 'text', text: 'one turn only' },
    ]);
    expect(transformations).toBe(1);
  });

  it('renders an effort change as an effort-only system message', () => {
    const { params, transformations } = withSystem({
      role: 'system',
      kind: 'effort',
      effort: 'max',
    });
    expect(params.messages[1]).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'max' },
    });
    expect(transformations).toBe(0);
  });

  it('drops an effort change without the beta, and counts it', () => {
    const { params, transformations } = withSystem(
      { role: 'system', kind: 'effort', effort: 'max' },
      [],
    );
    expect(params.messages).toHaveLength(1);
    expect(transformations).toBe(1);
  });
});

/** A built request, for the invariant tests to corrupt. */
function baseParams(): AnthropicChatParams {
  return build().params;
}

const CONTEXT: InvariantContext = {
  capabilities: bindingFor().capabilities,
  effort: 'medium',
  resumingPausedTurn: false,
};

function violationsOf(
  params: AnthropicChatParams,
  context: InvariantContext = CONTEXT,
): readonly string[] {
  try {
    assertWireInvariants(params, context);
    return [];
  } catch (error) {
    if (error instanceof WireInvariantError) return error.violations;
    throw error;
  }
}

describe('assertWireInvariants', () => {
  it('passes the request the builder produced', () => {
    expect(violationsOf(baseParams())).toEqual([]);
  });

  it('refuses each forbidden field', () => {
    for (const key of ['temperature', 'top_p', 'top_k', 'stop_sequences']) {
      const params = { ...baseParams(), [key]: 1 } as unknown as AnthropicChatParams;
      expect(violationsOf(params).join()).toContain(key);
    }
  });

  it('refuses a missing or mismatched effort', () => {
    const { output_config: _dropped, ...withoutEffort } = baseParams();
    expect(violationsOf(withoutEffort as AnthropicChatParams).join()).toContain(
      'effort` is missing',
    );
    expect(violationsOf({ ...baseParams(), output_config: { effort: 'low' } }).join()).toContain(
      'asked for medium',
    );
  });

  it('refuses a forced tool_choice', () => {
    for (const type of ['any', 'tool'] as const) {
      const params = {
        ...baseParams(),
        tools: [
          { name: 't', description: 'd', input_schema: { type: 'object' as const }, strict: true },
        ],
        tool_choice: { type } as never,
      };
      expect(violationsOf(params).join()).toContain('tool_choice');
    }
  });

  it('refuses a tool that is not strict or not closed', () => {
    const loose = {
      ...baseParams(),
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object' as const } }],
    };
    const found = violationsOf(loose).join();
    expect(found).toContain('strict: true');
    expect(found).toContain('additionalProperties: false');
  });

  it('refuses more than four cache breakpoints', () => {
    const params: AnthropicChatParams = {
      ...baseParams(),
      system: Array.from({ length: MAX_CACHE_BREAKPOINTS + 1 }, (_, index) => ({
        type: 'text' as const,
        text: String(index),
        cache_control: { type: 'ephemeral' as const, ttl: '5m' as const },
      })),
    };
    expect(violationsOf(params).join()).toContain('5 cache_control markers');
  });

  it('refuses cache TTLs that increase through the prompt', () => {
    const params: AnthropicChatParams = {
      ...baseParams(),
      system: [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
    };
    expect(violationsOf(params).join()).toContain('cache TTLs increase');
  });

  it('accepts non-increasing TTLs', () => {
    const params: AnthropicChatParams = {
      ...baseParams(),
      system: [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
    };
    expect(violationsOf(params)).toEqual([]);
  });

  it('refuses an assistant-final message, unless a paused turn is being resumed', () => {
    const params: AnthropicChatParams = {
      ...baseParams(),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      ],
    };
    expect(violationsOf(params).join()).toContain('assistant prefill');
    expect(violationsOf(params, { ...CONTEXT, resumingPausedTurn: true })).toEqual([]);
  });

  it('refuses a non-effort system message at index 0', () => {
    const params: AnthropicChatParams = {
      ...baseParams(),
      messages: [
        { role: 'system', content: 'first' },
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
      ],
    };
    expect(violationsOf(params).join()).toContain('is first');
  });

  it('allows an effort-only system message at index 0, which the API exempts', () => {
    const params: AnthropicChatParams = {
      ...baseParams(),
      messages: [
        { role: 'system', content: [], output_config: { effort: 'low' } },
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
      ],
    };
    expect(violationsOf(params)).toEqual([]);
  });

  it('refuses an unpaired tool_result', () => {
    const params: AnthropicChatParams = {
      ...baseParams(),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_OTHER' }] },
      ],
    };
    expect(violationsOf(params).join()).toContain('no matching tool_use');
  });

  it('refuses tool results split across two user messages', () => {
    const params: AnthropicChatParams = {
      ...baseParams(),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 't', input: {} },
            { type: 'tool_use', id: 'toolu_2', name: 't', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2' }] },
      ],
    };
    expect(violationsOf(params).join()).toContain('split across more than one user message');
  });

  it('accepts two parallel results in one message', () => {
    const params: AnthropicChatParams = {
      ...baseParams(),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 't', input: {} },
            { type: 'tool_use', id: 'toolu_2', name: 't', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1' },
            { type: 'tool_result', tool_use_id: 'toolu_2' },
          ],
        },
      ],
    };
    expect(violationsOf(params)).toEqual([]);
  });

  it('reports every violation at once', () => {
    const params = {
      ...baseParams(),
      temperature: 0.7,
      top_p: 1,
    } as unknown as AnthropicChatParams;
    expect(violationsOf(params)).toHaveLength(2);
  });
});

describe('a non-object tool schema', () => {
  it('is refused at build time, because strict is defined over properties', () => {
    expect(() =>
      build({ tools: [{ ...toolSpec(), inputSchema: { type: 'array' } as never }] }),
    ).toThrow(/non-object input schema/);
  });
});
