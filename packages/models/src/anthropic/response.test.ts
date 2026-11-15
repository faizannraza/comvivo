/**
 * Reading a response (`05` §3.5.3.4–§3.5.3.6, §9.3; `M2-T6`).
 *
 * `05` §9.3 names the cases: "end_turn, tool_use (parallel), max_tokens with a truncated tool_use,
 * refusal (category `null` and set), pause_turn, fallback blocks plus `usage.iterations`, empty
 * thinking blocks preserved". Each one is below, and the fallback cases are the ones that would be
 * silently wrong: a reader that concatenated every text block would show a member the text of the
 * model that *declined*.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  assistantMessageOf,
  assistantPartsOf,
  lastFallbackIndex,
  normalizeForEcho,
  readStop,
  servedByFallback,
  toolCallsAfterLastFallback,
  usageIterations,
  visibleTextAfterLastFallback,
} from './response.js';
import { OPUS } from './testing/fixtures.js';

type Message = Anthropic.Beta.Messages.BetaMessage;
type Content = Anthropic.Beta.Messages.BetaContentBlock;
type Usage = Anthropic.Beta.Messages.BetaUsage;

const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  fallback_credit: null,
  inference_geo: null,
  iterations: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
};

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: OPUS,
    content: [{ type: 'text', text: 'hello', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    input_transformations: null,
    diagnostics: null,
    parsed_output: null,
    usage: EMPTY_USAGE,
    ...overrides,
  } as Message;
}

const text = (value: string): Content => ({ type: 'text', text: value, citations: null });
const toolUse = (id: string, name = 't'): Content => ({ type: 'tool_use', id, name, input: {} });
const thinking = (value: string): Content => ({
  type: 'thinking',
  thinking: value,
  signature: 'sig',
});
const fallback = (): Content =>
  ({
    type: 'fallback',
    from: { model: OPUS },
    to: { model: 'claude-opus-4-8' },
    trigger: { type: 'refusal', category: 'cyber' },
  }) as Content;

describe('readStop (05 §3.5.3.4)', () => {
  it('maps the four straightforward reasons', () => {
    const cases = [
      ['end_turn', 'end_turn'],
      ['tool_use', 'tool_use'],
      ['max_tokens', 'max_tokens'],
      ['pause_turn', 'pause_turn'],
    ] as const;
    for (const [wire, expected] of cases) {
      expect(readStop(message({ stop_reason: wire }))).toEqual({ reason: expected, raw: wire });
    }
  });

  it('maps model_context_window_exceeded to our own context_overflow', () => {
    expect(readStop(message({ stop_reason: 'model_context_window_exceeded' }))).toEqual({
      reason: 'context_overflow',
      raw: 'model_context_window_exceeded',
    });
  });

  it('reads a refusal with a category set', () => {
    expect(
      readStop(
        message({
          stop_reason: 'refusal',
          stop_details: {
            type: 'refusal',
            category: 'cyber',
            explanation: 'no',
            fallback_credit_token: null,
            fallback_has_prefill_claim: null,
            recommended_model: null,
          },
        }),
      ),
    ).toEqual({
      reason: 'refusal',
      raw: 'refusal',
      category: 'cyber',
      explanation: 'no',
      servedByFallback: false,
    });
  });

  it('reads a refusal whose category is null, which the API allows', () => {
    const stop = readStop(
      message({
        stop_reason: 'refusal',
        stop_details: {
          type: 'refusal',
          category: null,
          explanation: null,
          fallback_credit_token: null,
          fallback_has_prefill_claim: null,
          recommended_model: null,
        },
      }),
    );
    expect(stop).toEqual({
      reason: 'refusal',
      raw: 'refusal',
      category: null,
      servedByFallback: false,
    });
    // Absent, not `undefined`: `exactOptionalPropertyTypes` makes those different, and a trace
    // serialises the key list.
    expect('explanation' in stop).toBe(false);
  });

  it('reports servedByFallback from usage.iterations, which survives sticky routing', () => {
    const stop = readStop(
      message({
        stop_reason: 'refusal',
        stop_details: {
          type: 'refusal',
          category: 'bio',
          explanation: null,
          fallback_credit_token: null,
          fallback_has_prefill_claim: null,
          recommended_model: null,
        },
        usage: {
          ...EMPTY_USAGE,
          iterations: [
            {
              type: 'message',
              input_tokens: 1,
              output_tokens: 1,
              cache_creation: null,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              model: OPUS,
            },
            {
              type: 'fallback_message',
              input_tokens: 1,
              output_tokens: 1,
              cache_creation: null,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              model: 'claude-opus-4-8',
            },
          ],
        },
      }),
    );
    expect(stop).toMatchObject({ reason: 'refusal', servedByFallback: true });
  });

  it('maps stop_sequence by whether there is text, never silently to end_turn', () => {
    expect(readStop(message({ stop_reason: 'stop_sequence' })).reason).toBe('end_turn');
    expect(readStop(message({ stop_reason: 'stop_sequence', content: [] })).reason).toBe('other');
  });

  it('maps compaction and a null reason to other, preserving the raw value', () => {
    expect(readStop(message({ stop_reason: 'compaction' }))).toEqual({
      reason: 'other',
      raw: 'compaction',
    });
    expect(readStop(message({ stop_reason: null }))).toEqual({ reason: 'other', raw: 'null' });
  });
});

describe('the fallback boundary (05 §3.5.3.5)', () => {
  it('finds the last boundary, not the first', () => {
    expect(lastFallbackIndex([text('a'), fallback(), text('b'), fallback(), text('c')])).toBe(3);
    expect(lastFallbackIndex([text('a')])).toBe(-1);
  });

  it('returns only the text after the last boundary', () => {
    // The declining model's partial text is in `content` and must never reach a member.
    expect(
      visibleTextAfterLastFallback([text('declined partial'), fallback(), text('the answer')]),
    ).toBe('the answer');
  });

  it('concatenates every text block when there was no fallback', () => {
    expect(visibleTextAfterLastFallback([text('a'), text('b')])).toBe('ab');
  });

  it('returns only the tool calls after the last boundary', () => {
    expect(
      toolCallsAfterLastFallback([toolUse('pre'), fallback(), toolUse('post')]).map((c) => c.id),
    ).toEqual(['post']);
  });

  it('returns parallel tool calls in order', () => {
    expect(toolCallsAfterLastFallback([toolUse('a'), toolUse('b')]).map((c) => c.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('reads servedByFallback from iterations alone', () => {
    expect(servedByFallback(message())).toBe(false);
  });
});

describe('normalizeForEcho (05 §3.5.3.5)', () => {
  it('changes nothing when there was no fallback', () => {
    const content = [thinking(''), text('hi'), toolUse('toolu_1')];
    expect(normalizeForEcho(content)).toEqual(content);
  });

  it('keeps an empty thinking block, which is what omitted display produces', () => {
    const content = [thinking('')];
    expect(normalizeForEcho(content)).toEqual(content);
  });

  it('drops pre-boundary thinking and tool_use, and keeps everything after', () => {
    const content = [
      thinking('declined reasoning'),
      text('declined partial'),
      toolUse('toolu_pre'),
      fallback(),
      thinking('rescued reasoning'),
      text('the answer'),
      toolUse('toolu_post'),
    ];
    expect(normalizeForEcho(content)).toEqual([
      // The pre-boundary *text* is kept: it is part of the documented echo shape, and only the
      // model-bound reasoning and the unexecuted calls are invalid continuation state.
      text('declined partial'),
      fallback(),
      thinking('rescued reasoning'),
      text('the answer'),
      toolUse('toolu_post'),
    ]);
  });

  it('is idempotent, so re-echoing a normalised turn is a no-op', () => {
    const content = [thinking('x'), toolUse('a'), fallback(), text('y')];
    const once = normalizeForEcho(content);
    expect(normalizeForEcho(once as never)).toEqual(once);
  });
});

describe('assistantPartsOf', () => {
  it('maps text and tool calls, and every private block to opaque', () => {
    expect(
      assistantPartsOf([
        text('hi'),
        toolUse('toolu_1', 'get_forecast'),
        thinking('secret'),
        { type: 'redacted_thinking', data: 'x' } as Content,
        fallback(),
      ]),
    ).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_call', id: 'toolu_1', name: 'get_forecast', input: {} },
      // No thinking text anywhere in the engine's view (`08` §3.16).
      { type: 'opaque', kind: 'thinking' },
      { type: 'opaque', kind: 'redacted_thinking' },
      { type: 'opaque', kind: 'fallback' },
    ]);
  });

  it('maps every server-tool and container block to a coarse opaque kind', () => {
    const blocks = [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
      { type: 'mcp_tool_use', id: 'm1', name: 'x', input: {}, server_name: 's' },
      { type: 'mcp_tool_result', tool_use_id: 'm1', content: [], is_error: false },
      { type: 'mcp_tool_listing', server_name: 's', tools: [] },
      { type: 'code_execution_tool_result', tool_use_id: 'c1', content: {} },
      { type: 'bash_code_execution_tool_result', tool_use_id: 'c2', content: {} },
      { type: 'text_editor_code_execution_tool_result', tool_use_id: 'c3', content: {} },
      { type: 'tool_search_tool_result', tool_use_id: 'c4', content: [] },
      { type: 'advisor_tool_result', tool_use_id: 'c5', content: {} },
      { type: 'web_fetch_tool_result', tool_use_id: 'c6', content: {} },
    ] as unknown as Content[];
    expect(assistantPartsOf(blocks)).toEqual(
      blocks.map(() => ({ type: 'opaque', kind: 'server_tool' })),
    );
  });

  it('maps the two features v1 does not enable to opaque/other', () => {
    const blocks = [
      { type: 'compaction', signature: 'sig', content: 'summary' },
      { type: 'container_upload', file_id: 'f1' },
    ] as unknown as Content[];
    expect(assistantPartsOf(blocks)).toEqual([
      { type: 'opaque', kind: 'other' },
      { type: 'opaque', kind: 'other' },
    ]);
  });

  it('never exposes reasoning text in the view', () => {
    expect(JSON.stringify(assistantPartsOf([thinking('secret reasoning')]))).not.toContain(
      'secret',
    );
  });
});

describe('usageIterations (05 §3.5.3.6)', () => {
  it('uses the top-level usage when there are no iterations', () => {
    expect(
      usageIterations(
        message({
          usage: {
            ...EMPTY_USAGE,
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 512,
            cache_creation_input_tokens: 140,
            cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 40 },
            output_tokens_details: { thinking_tokens: 3 },
          },
        }),
        OPUS,
      ),
    ).toEqual([
      {
        model: OPUS,
        kind: 'message',
        input: 10,
        cacheRead: 512,
        cacheWrite5m: 100,
        cacheWrite1h: 40,
        output: 4,
        reasoning: 3,
        batch: false,
      },
    ]);
  });

  it('attributes a fallback iteration to the model that served it', () => {
    const iterations = usageIterations(
      message({
        usage: {
          ...EMPTY_USAGE,
          iterations: [
            {
              type: 'message',
              input_tokens: 10,
              output_tokens: 0,
              cache_creation: null,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              model: OPUS,
            },
            {
              type: 'fallback_message',
              input_tokens: 10,
              output_tokens: 7,
              cache_creation: null,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              model: 'claude-opus-4-8',
            },
          ],
        },
      }),
      OPUS,
    );
    // Two iterations at two prices, which one `usage` object cannot express.
    expect(iterations.map((i) => [i.kind, i.model])).toEqual([
      ['message', OPUS],
      ['fallback_message', 'claude-opus-4-8'],
    ]);
  });

  it('records a compaction iteration rather than dropping it', () => {
    const iterations = usageIterations(
      message({
        usage: {
          ...EMPTY_USAGE,
          iterations: [
            {
              type: 'compaction',
              input_tokens: 200,
              output_tokens: 20,
              cache_creation: null,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          ],
        },
      }),
      OPUS,
    );
    // A `compaction` entry carries no model and real tokens. Dropping it would be spend that never
    // reaches the budget — which is why `UsageIterationKind` has four members.
    expect(iterations).toEqual([
      {
        model: OPUS,
        kind: 'compaction',
        input: 200,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 20,
        batch: false,
      },
    ]);
  });

  it('tolerates the usage fields a streamed message leaves undefined', () => {
    // The regression the contract test found: a message assembled by the SDK's stream accumulator
    // carries only the fields the stream sent, so `iterations` is **`undefined`** — which the
    // non-streaming type (`BetaIterationsUsage | null`) does not admit. A `=== null` check threw
    // `Cannot read properties of undefined (reading 'length')` on every successful streamed turn,
    // and the adapter reported it as a provider error of kind `unknown`.
    const streamed = {
      ...message(),
      usage: { input_tokens: 3, output_tokens: 2 },
    } as unknown as Message;
    expect(usageIterations(streamed, OPUS)).toEqual([
      {
        model: OPUS,
        kind: 'message',
        input: 3,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 2,
        batch: false,
      },
    ]);
  });

  it('attributes an undifferentiated cache write to the 5m TTL, which is the API default', () => {
    const [only] = usageIterations(
      message({
        usage: { ...EMPTY_USAGE, cache_creation: null, cache_creation_input_tokens: 90 },
      }),
      OPUS,
    );
    expect(only).toMatchObject({ cacheWrite5m: 90, cacheWrite1h: 0 });
  });
});

describe('assistantMessageOf', () => {
  it('carries the served model and the normalised raw', () => {
    const assistant = assistantMessageOf(
      message({ model: 'claude-opus-4-8', content: [text('hi')] }),
    );
    expect(assistant).toEqual({
      role: 'assistant',
      provider: 'anthropic',
      servedModel: 'claude-opus-4-8',
      raw: [text('hi')],
      view: [{ type: 'text', text: 'hi' }],
    });
  });
});
