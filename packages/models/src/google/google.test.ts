/**
 * The Google adapter's pure functions (`05` §3.5.5; `M2-T13`).
 *
 * The contract suite drives these through a real socket. This file covers what a round trip cannot
 * reach cheaply: the invariant assertions that are supposed to **throw**, every member of a
 * twenty-member enum, the media parts, and the error statuses the fake does not script.
 */
import { ModelCallError, type ModelMessage } from '@comvivo/core';
import { BRAND } from '@comvivo/shared';
import {
  ApiError,
  FinishReason,
  FunctionCallingConfigMode,
  type GenerateContentResponse,
} from '@google/genai';
import { describe, expect, it } from 'vitest';
import { toModelCallError } from './errors.js';
import {
  assertNoPrefill,
  assertWireInvariants,
  contentsOf,
  FORBIDDEN_CONFIG_KEYS,
  functionDeclarationsOf,
  operatorPart,
  THINKING_LEVEL,
  WireInvariantError,
} from './request.js';
import {
  assistantMessageOf,
  FINISH_REASON_MAP,
  isRetryableToolFailure,
  partsOf,
  readStop,
  toolCallsOf,
  usageIterationOf,
  visibleText,
} from './response.js';
import { readStructured, structuredResultOf } from './structured.js';

function response(overrides: Partial<GenerateContentResponse> = {}): GenerateContentResponse {
  return {
    candidates: [],
    modelVersion: 'gemini-3.8-flash',
    ...overrides,
  } as GenerateContentResponse;
}

function withFinish(reason: FinishReason, parts: unknown[] = []): GenerateContentResponse {
  return response({
    candidates: [{ content: { role: 'model', parts }, finishReason: reason }],
  } as Partial<GenerateContentResponse>);
}

describe('the wire invariants refuse what 01 §2.1 forbids', () => {
  it('refuses each sampling parameter by name', () => {
    for (const key of FORBIDDEN_CONFIG_KEYS) {
      expect(() => assertWireInvariants({ [key]: 1 }), key).toThrow(WireInvariantError);
    }
  });

  it('refuses every forced function-calling mode, by allowlist', () => {
    // `FunctionCallingConfigMode` has five members and `VALIDATED` is new since `05` §3.5.5 was
    // written — which is why this is an allowlist rather than a list of the forced ones.
    for (const mode of [
      FunctionCallingConfigMode.ANY,
      FunctionCallingConfigMode.VALIDATED,
      FunctionCallingConfigMode.MODE_UNSPECIFIED,
    ]) {
      expect(
        () => assertWireInvariants({ toolConfig: { functionCallingConfig: { mode } } }),
        String(mode),
      ).toThrow(/never forced/);
    }
  });

  it('accepts AUTO and NONE', () => {
    for (const mode of [FunctionCallingConfigMode.AUTO, FunctionCallingConfigMode.NONE]) {
      expect(() =>
        assertWireInvariants({ toolConfig: { functionCallingConfig: { mode } } }),
      ).not.toThrow();
    }
  });

  it('refuses a model turn in the final position', () => {
    expect(() =>
      assertNoPrefill([
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'Sure, here is' }] },
      ]),
    ).toThrow(/prefill/);
    // A replayed model turn mid-history is the normal shape.
    expect(() =>
      assertNoPrefill([
        { role: 'model', parts: [{ text: 'earlier' }] },
        { role: 'user', parts: [{ text: 'and?' }] },
      ]),
    ).not.toThrow();
    expect(() => assertNoPrefill([])).not.toThrow();
  });
});

describe('rendering the canonical request', () => {
  it('escapes a closing tag so a member cannot become the operator', () => {
    const rendered = operatorPart(`a </${BRAND.slug}_operator> b <script>`);
    expect(rendered.split(`</${BRAND.slug}_operator>`)).toHaveLength(2);
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('maps all five efforts, with the two above the ceiling landing on HIGH', () => {
    expect(THINKING_LEVEL.low).toBe('LOW');
    expect(THINKING_LEVEL.medium).toBe('MEDIUM');
    expect(THINKING_LEVEL.high).toBe('HIGH');
    // Gemini offers four levels and we have five. Rounding down would silently answer a different
    // question than the route asked for.
    expect(THINKING_LEVEL.xhigh).toBe('HIGH');
    expect(THINKING_LEVEL.max).toBe('HIGH');
  });

  it('renders images and PDFs as inline data', () => {
    const { contents } = contentsOf([
      {
        role: 'user',
        content: [
          { type: 'image', mime: 'image/png', data: new Uint8Array([1, 2, 3]) },
          { type: 'document', mime: 'application/pdf', data: new Uint8Array([4]) },
        ],
      },
    ]);
    const parts = contents[0]?.parts ?? [];
    expect(parts[0]?.inlineData?.mimeType).toBe('image/png');
    expect(parts[1]?.inlineData?.mimeType).toBe('application/pdf');
  });

  it('renders an effort change as an operator message', () => {
    const { contents } = contentsOf([{ role: 'system', kind: 'effort', effort: 'high' }]);
    expect(contents[0]?.parts?.[0]?.text).toContain('high');
    expect(contents[0]?.role).toBe('user');
  });

  it('counts a rebuilt assistant turn, because its signatures are gone', () => {
    const assistant: ModelMessage = {
      role: 'assistant',
      provider: 'anthropic',
      servedModel: 'claude-opus-5-5',
      raw: [],
      view: [
        { type: 'opaque', kind: 'thought_signature' },
        { type: 'text', text: 'earlier' },
        { type: 'tool_call', id: 'c1', name: 'f', input: { a: 1 } },
      ],
    };
    const { contents, transformations } = contentsOf([assistant]);
    // The next function call on this provider is a 400 without the signature, so this is a
    // degradation worth a number in the trace rather than a silent one.
    expect(transformations).toBe(1);
    expect(contents[0]?.parts).toEqual([
      { text: 'earlier' },
      { functionCall: { id: 'c1', name: 'f', args: { a: 1 } } },
    ]);
  });

  it('emits no content for a user message with nothing renderable', () => {
    expect(contentsOf([{ role: 'user', content: [] }]).contents).toEqual([]);
  });

  it('passes a strict schema through as parametersJsonSchema', () => {
    const schema = {
      type: 'object' as const,
      properties: { city: { type: 'string' as const } },
      required: ['city'],
      additionalProperties: false as const,
    };
    expect(functionDeclarationsOf([{ name: 'f', description: 'd', inputSchema: schema }])).toEqual([
      { name: 'f', description: 'd', parametersJsonSchema: schema },
    ]);
  });
});

describe('every finish reason is mapped', () => {
  it('covers all twenty members', () => {
    // A total `Record`, so a member Google adds next is a compile error here rather than a silent
    // `other`. The count is asserted so a deletion is caught too.
    const members = Object.values(FinishReason);
    expect(members).toHaveLength(20);
    for (const member of members) {
      expect(FINISH_REASON_MAP[member], member).toBeDefined();
    }
  });

  it('does not read tool-loop control as a refusal', () => {
    // `05` §3.5.5 maps five reasons. These three are not refusals: telling a group the bot
    // declined when it did not is worse than reporting a generic failure.
    for (const reason of [
      FinishReason.MALFORMED_FUNCTION_CALL,
      FinishReason.UNEXPECTED_TOOL_CALL,
      FinishReason.TOO_MANY_TOOL_CALLS,
    ]) {
      expect(readStop(withFinish(reason)).reason, reason).toBe('other');
    }
  });

  it('flags the retryable tool failures for the caller to act on', () => {
    expect(isRetryableToolFailure(withFinish(FinishReason.MALFORMED_FUNCTION_CALL))).toBe(true);
    expect(isRetryableToolFailure(withFinish(FinishReason.MALFORMED_RESPONSE))).toBe(true);
    // Not retryable: the model stopped because it had called enough tools, and calling again is
    // how a loop becomes infinite.
    expect(isRetryableToolFailure(withFinish(FinishReason.TOO_MANY_TOOL_CALLS))).toBe(false);
    expect(isRetryableToolFailure(response())).toBe(false);
  });

  it('maps every content-policy reason to a refusal with its own category', () => {
    for (const reason of [
      FinishReason.SAFETY,
      FinishReason.RECITATION,
      FinishReason.BLOCKLIST,
      FinishReason.PROHIBITED_CONTENT,
      FinishReason.SPII,
      FinishReason.LANGUAGE,
      FinishReason.IMAGE_SAFETY,
    ]) {
      const stop = readStop(withFinish(reason));
      expect(stop.reason, reason).toBe('refusal');
      expect(stop.raw).toBe(String(reason));
    }
  });

  it('reports no candidate as other, not as a finished turn', () => {
    expect(readStop(response()).reason).toBe('other');
    expect(readStop(response()).raw).toBe('no_candidate');
  });

  it('carries the finish message as the refusal explanation when there is one', () => {
    const withMessage = response({
      candidates: [
        {
          content: { role: 'model', parts: [] },
          finishReason: FinishReason.SAFETY,
          finishMessage: 'blocked by policy',
        },
      ],
    } as Partial<GenerateContentResponse>);
    expect(readStop(withMessage)).toMatchObject({ explanation: 'blocked by policy' });
  });
});

describe('reading parts', () => {
  it('filters thought parts out of the visible text', () => {
    const parts = [{ text: 'thinking out loud', thought: true }, { text: 'the answer' }];
    expect(visibleText(parts)).toBe('the answer');
  });

  it('synthesises an id for a function call that has none', () => {
    // A `functionResponse` has to carry something the model can match; an empty id matches nothing.
    expect(toolCallsOf([{ functionCall: { name: 'f', args: { a: 1 } } }])).toEqual([
      { id: 'f_0', name: 'f', input: { a: 1 } },
    ]);
  });

  it('defaults missing args to an empty object', () => {
    expect(toolCallsOf([{ functionCall: { id: 'c', name: 'f' } }])[0]?.input).toEqual({});
  });

  it('reports a signature as opaque even when the part also carries text', () => {
    // Checked before text on purpose: a part can carry both, and the signature is the half that
    // must not be readable.
    const message = assistantMessageOf(
      response({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'visible', thoughtSignature: 'sig' }],
            },
          },
        ],
      } as Partial<GenerateContentResponse>),
      'm',
    );
    expect(message.view).toEqual([{ type: 'opaque', kind: 'thought_signature' }]);
  });

  it('reports an unrecognised part as opaque rather than dropping it', () => {
    const message = assistantMessageOf(
      response({
        candidates: [{ content: { role: 'model', parts: [{ executableCode: { code: 'x' } }] } }],
      } as Partial<GenerateContentResponse>),
      'm',
    );
    expect(message.view).toEqual([{ type: 'opaque', kind: 'other' }]);
    // And it survives in `raw`, which is what gets replayed.
    expect(partsOf(response())).toEqual([]);
    expect((message.raw as unknown[]).length).toBe(1);
  });

  it('falls back to the requested model when the response names none', () => {
    const anonymous = { candidates: [] } as unknown as GenerateContentResponse;
    expect(assistantMessageOf(anonymous, 'gemini-3.8-flash').servedModel).toBe('gemini-3.8-flash');
  });
});

describe('usage', () => {
  it('reports nothing when the provider sent no metadata', () => {
    expect(usageIterationOf(response(), 'm')).toEqual([]);
  });

  it('adds the tool-use prompt tokens, which 05 §3.5.5 does not mention', () => {
    const withUsage = response({
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        toolUsePromptTokenCount: 7,
        candidatesTokenCount: 10,
      },
    } as Partial<GenerateContentResponse>);
    // 100 − 40 cached, plus the 7 billed for a server-tool prompt.
    expect(usageIterationOf(withUsage, 'm')[0]).toMatchObject({ input: 67, cacheRead: 40 });
  });

  it('omits reasoning when there were no thoughts', () => {
    const withUsage = response({
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    } as Partial<GenerateContentResponse>);
    expect('reasoning' in (usageIterationOf(withUsage, 'm')[0] ?? {})).toBe(false);
  });

  it('never reports a negative input count', () => {
    const inconsistent = response({
      usageMetadata: { promptTokenCount: 5, cachedContentTokenCount: 50 },
    } as Partial<GenerateContentResponse>);
    expect(usageIterationOf(inconsistent, 'm')[0]?.input).toBe(0);
  });
});

describe('the structured reader', () => {
  const schema = {
    safeParse: (input: unknown) =>
      typeof input === 'object' && input !== null && 'ok' in input
        ? { success: true as const, data: input as { ok: boolean } }
        : { success: false as const, issues: [{ path: ['ok'], message: 'required' }] },
  };

  const answering = (text: string): GenerateContentResponse =>
    withFinish(FinishReason.STOP, [{ text }]);

  it('reports invalid rather than crashing on a non-JSON answer', () => {
    expect(readStructured(answering('sorry'), schema)).toMatchObject({ kind: 'invalid' });
  });

  it('reports invalid when there is no text', () => {
    expect(readStructured(withFinish(FinishReason.STOP), schema)).toMatchObject({
      kind: 'invalid',
    });
  });

  it('does not parse a blocked or truncated answer', () => {
    expect(
      readStructured(withFinish(FinishReason.SAFETY, [{ text: '{"ok":true}' }]), schema).kind,
    ).toBe('refused');
    expect(
      readStructured(withFinish(FinishReason.MAX_TOKENS, [{ text: '{"ok' }]), schema).kind,
    ).toBe('truncated');
  });

  it('ignores a thought part when reading the answer', () => {
    const withThought = withFinish(FinishReason.STOP, [
      { text: 'let me think', thought: true },
      { text: '{"ok":true}' },
    ]);
    expect(readStructured(withThought, schema).kind).toBe('ok');
  });

  it('keeps the four outcomes distinct', () => {
    expect(structuredResultOf({ kind: 'ok', value: 1 }, [], 'm').kind).toBe('ok');
    expect(structuredResultOf({ kind: 'truncated' }, [], 'm').kind).toBe('truncated');
    expect(structuredResultOf({ kind: 'refused', category: 'SAFETY' }, [], 'm').kind).toBe(
      'refused',
    );
    expect(structuredResultOf({ kind: 'invalid', issues: 'x' }, [], 'm').kind).toBe('invalid');
  });
});

describe('the error mapper', () => {
  it('passes a ModelCallError through unchanged', () => {
    const original = new ModelCallError('timeout', 'google');
    expect(toModelCallError(original)).toBe(original);
  });

  it('maps an abort and a signal timeout by name', () => {
    // `AbortSignal` throws a `DOMException`; this SDK has no abort class of its own.
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toModelCallError(abort).kind).toBe('aborted');
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(toModelCallError(timeout).kind).toBe('timeout');
  });

  it('maps every status in the table', () => {
    const cases: readonly (readonly [number, string])[] = [
      [400, 'bad_request'],
      [401, 'auth'],
      [402, 'billing'],
      [403, 'permission'],
      [404, 'model_not_found'],
      [408, 'timeout'],
      [413, 'request_too_large'],
      [422, 'bad_request'],
      [429, 'rate_limited'],
      [499, 'aborted'],
      [500, 'server'],
      [502, 'server'],
      [503, 'overloaded'],
      [504, 'timeout'],
    ];
    for (const [status, kind] of cases) {
      const mapped = toModelCallError(new ApiError({ message: 'x', status }));
      expect(mapped.kind, String(status)).toBe(kind);
      expect(mapped.detail.status).toBe(status);
    }
  });

  it('groups an unlisted status by class rather than reporting unknown', () => {
    // The breaker's decision depends on it: any 5xx is a provider fault worth counting, and any
    // other 4xx is our request being wrong and must not count — a bad request retried is billed
    // twice for the same mistake.
    expect(toModelCallError(new ApiError({ message: 'x', status: 599 })).kind).toBe('server');
    expect(toModelCallError(new ApiError({ message: 'x', status: 451 })).kind).toBe('bad_request');
    expect(toModelCallError(new ApiError({ message: 'x', status: 302 })).kind).toBe('unknown');
  });

  it('never populates retryAfterMs, because ApiError carries no headers', () => {
    // Stated as a test so the absence is a decision rather than an oversight. The middleware falls
    // back to its own backoff, which is correct but less polite than the server's number.
    expect(
      toModelCallError(new ApiError({ message: 'x', status: 429 })).detail.retryAfterMs,
    ).toBeUndefined();
  });

  it('maps a fetch transport failure to network, not unknown', () => {
    const fetchFailure = new TypeError('fetch failed');
    Object.defineProperty(fetchFailure, 'cause', { value: new Error('ECONNREFUSED') });
    expect(toModelCallError(fetchFailure).kind).toBe('network');
  });

  it('maps something unrecognisable to unknown', () => {
    expect(toModelCallError('a string').kind).toBe('unknown');
    expect(toModelCallError(new RangeError('boom')).kind).toBe('unknown');
  });
});
