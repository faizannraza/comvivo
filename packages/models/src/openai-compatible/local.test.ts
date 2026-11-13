/**
 * The local adapter's pure logic (`05` §3.5.6; `M2-T12`).
 *
 * The ladder, the envelope and the request shaping, tested without a socket. The socket half — the
 * identification sweep, the probes, and a turn at each level — is `adapter.contract.test.ts`.
 *
 * The envelope is where the attention goes. It is the only place in this product where a **text
 * protocol** decides which tool runs, and the three rules that make that safe rather than merely
 * clever each get a test: the enum of names, the per-tool zod validation, and the refusal to guess
 * at a malformed shape.
 */
import { ModelCallError, type SchemaLike } from '@comvivo/core';
import { BRAND } from '@comvivo/shared';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import {
  envelopeCallId,
  envelopeInstruction,
  envelopeSchema,
  MAX_RENDERED_DESCRIPTION_CHARS,
  parseEnvelope,
  renderCatalogue,
  validateCalls,
} from './envelope.js';
import { contextAdviceFor, contextLengthFromModelInfo, toolFlagAdviceFor } from './hints.js';
import { hostPortOf, LOCAL_SERVER_KINDS, rootOf, spanFlavourOf } from './identify.js';
import { LADDER_LEVELS, LEVEL_BEHAVIOUR, levelFor, levelSummary } from './ladder.js';
import {
  isProbeFresh,
  type LocalProbeResult,
  NEEDLE_TOKENS,
  needlePrompt,
  probeCacheKey,
} from './probe.js';
import { buildLocalRequest, messagesOf, operatorBlock, WireInvariantError } from './request.js';
import { readEnvelope, readStop, rejectionResults, usageIterationOf } from './response.js';
import { buildLocalStructuredRequest, readLocalStructured, unfence } from './structured.js';
import {
  localBinding,
  localToolSpec,
  localTurnRequest,
  visionBinding,
} from './testing/fixtures.js';

const OK_SCHEMA: SchemaLike<unknown> = {
  safeParse: (input: unknown) =>
    typeof input === 'object' && input !== null && 'text' in input && 'at' in input
      ? { success: true as const, data: input }
      : { success: false as const },
};

function completion(overrides: Partial<OpenAI.Chat.Completions.ChatCompletion> = {}) {
  return {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    created: 0,
    model: 'gemma4:12b',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '', refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    ...overrides,
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function answering(text: string, finish = 'stop') {
  return completion({
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text, refusal: null },
        finish_reason: finish,
        logprobs: null,
      },
    ],
  } as Partial<OpenAI.Chat.Completions.ChatCompletion>);
}

describe('the ladder (05 §3.5.6)', () => {
  it('picks the level from the worse of the two axes', () => {
    expect(
      levelFor({
        nativeTools: true,
        parallelTools: true,
        jsonSchema: true,
        jsonObject: true,
        reasoningEffort: true,
      }),
    ).toBe('L1');
    // Native tools but no schema support is **not** L1: the structured routes would be on
    // `json_object`, and the level is the worse axis. That is what makes it a ladder.
    expect(
      levelFor({
        nativeTools: true,
        parallelTools: true,
        jsonSchema: false,
        jsonObject: true,
        reasoningEffort: false,
      }),
    ).toBe('L3');
    expect(
      levelFor({
        nativeTools: false,
        parallelTools: false,
        jsonSchema: true,
        jsonObject: true,
        reasoningEffort: false,
      }),
    ).toBe('L2');
    expect(
      levelFor({
        nativeTools: false,
        parallelTools: false,
        jsonSchema: false,
        jsonObject: true,
        reasoningEffort: false,
      }),
    ).toBe('L3');
    expect(
      levelFor({
        nativeTools: false,
        parallelTools: false,
        jsonSchema: false,
        jsonObject: false,
        reasoningEffort: false,
      }),
    ).toBe('L4');
  });

  it('describes every level, with no gaps', () => {
    for (const level of LADDER_LEVELS) {
      expect(LEVEL_BEHAVIOUR[level], level).toBeDefined();
      expect(levelSummary(level), level).not.toBe('');
    }
  });

  it('turns off the structured routes only at L4, and requires force only there', () => {
    expect(LADDER_LEVELS.filter((l) => !LEVEL_BEHAVIOUR[l].structuredRoutes)).toEqual(['L4']);
    expect(LADDER_LEVELS.filter((l) => LEVEL_BEHAVIOUR[l].requiresForceForChat)).toEqual(['L4']);
  });

  it('guarantees parallel tool calls only at L1', () => {
    // `05` §3.5.6: the envelope gives no parallel guarantee. The engine reads this flag rather
    // than assuming, because a 12B model's second envelope entry is not something to promise.
    expect(LADDER_LEVELS.filter((l) => LEVEL_BEHAVIOUR[l].parallelToolsGuaranteed)).toEqual(['L1']);
  });

  it('repairs the envelope only where the shape can come back wrong', () => {
    // L2's schema already constrains the envelope, so a failure there is semantic and a repair
    // would not fix it. L3's `json_object` lets the shape itself be wrong.
    expect(LADDER_LEVELS.filter((l) => LEVEL_BEHAVIOUR[l].repairEnvelope)).toEqual(['L3']);
  });

  it('tells a host what L4 costs them, in plain words', () => {
    const summary = levelSummary('L4');
    expect(summary).toContain('Chat only');
    // The sentence has to name the consequence a host would not guess: constraints stop applying.
    expect(summary).toContain('privacy constraints');
  });
});

describe('identification helpers', () => {
  it('strips only a /v1 suffix from the base URL', () => {
    expect(rootOf('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(rootOf('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434');
    expect(rootOf('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    // A reverse-proxy prefix is a host's decision and dropping it would probe the wrong place.
    expect(rootOf('http://nas.lan/ollama/v1')).toBe('http://nas.lan/ollama');
  });

  it('spells host:port the way the egress allowlist does', () => {
    expect(hostPortOf('http://127.0.0.1:11434/v1')).toBe('127.0.0.1:11434');
    expect(hostPortOf('http://localhost')).toBe('localhost:80');
    expect(hostPortOf('https://gpu.lan')).toBe('gpu.lan:443');
  });

  it('gives a span flavour for every named server and none for generic', () => {
    for (const kind of LOCAL_SERVER_KINDS) {
      const flavour = spanFlavourOf(kind);
      if (kind === 'generic') {
        // Inventing a name would put "we did not know" into a dashboard filter.
        expect(flavour).toBeUndefined();
      } else {
        expect(flavour, kind).toBe(kind);
      }
    }
  });

  it('finds the context length whatever the GGUF architecture is called', () => {
    // The key is `<architecture>.context_length` and the architecture is whatever the model says,
    // so the lookup is by suffix rather than a list we would have to keep current.
    expect(contextLengthFromModelInfo({ 'gemma4.context_length': 131_072 })).toBe(131_072);
    expect(contextLengthFromModelInfo({ 'qwen3moe.context_length': 262_144 })).toBe(262_144);
    expect(contextLengthFromModelInfo({ 'general.architecture': 'llama' })).toBeUndefined();
    expect(contextLengthFromModelInfo(null)).toBeUndefined();
    expect(contextLengthFromModelInfo({ 'x.context_length': 0 })).toBeUndefined();
  });

  it('names the actual knob for every server', () => {
    // "Raise the server context" is not actionable: a llama.cpp host cannot set
    // OLLAMA_CONTEXT_LENGTH, and telling them to is worse than saying nothing.
    expect(contextAdviceFor('ollama')).toContain('OLLAMA_CONTEXT_LENGTH');
    expect(contextAdviceFor('llama_cpp')).toContain('--ctx-size');
    expect(contextAdviceFor('vllm')).toContain('--max-model-len');
    expect(contextAdviceFor('lmstudio')).toContain('LM Studio');
    expect(contextAdviceFor('generic')).not.toBe('');
  });

  it('names the flags that make tools work, and stays quiet where none would help', () => {
    expect(toolFlagAdviceFor('llama_cpp')).toContain('--jinja');
    expect(toolFlagAdviceFor('vllm')).toContain('--enable-auto-tool-choice');
    // On these three a failed tool probe means the model or its template does not do tool calling,
    // which no flag fixes — so inventing advice would send a host chasing a setting.
    expect(toolFlagAdviceFor('ollama')).toBeUndefined();
    expect(toolFlagAdviceFor('lmstudio')).toBeUndefined();
    expect(toolFlagAdviceFor('generic')).toBeUndefined();
  });
});

describe('the envelope protocol', () => {
  const tools = [localToolSpec('reminder_create'), localToolSpec('list_add_items')];

  it('constrains the tool name to an enum of the actual names', () => {
    // Rule 1, and the difference between a text protocol and a text injection: a model that
    // invents `delete_everything` fails the schema instead of reaching the policy engine.
    const schema = envelopeSchema(tools) as unknown as Record<string, never>;
    const dumped = JSON.stringify(schema);
    expect(dumped).toContain('"enum"');
    expect(dumped).toContain('reminder_create');
    expect(dumped).toContain('list_add_items');
  });

  it('constrains the array to empty when there are no tools', () => {
    // A local server handed an unconstrained array will eventually fill it.
    const dumped = JSON.stringify(envelopeSchema([]));
    expect(dumped).toContain('"maxItems":0');
  });

  it('renders a bounded catalogue', () => {
    const long = { ...localToolSpec('x'), description: 'y'.repeat(400) };
    const rendered = renderCatalogue([long]);
    // Every token of catalogue is a token not available for the conversation on an 8 GB host.
    expect(rendered.length).toBeLessThan(400 + 200);
    expect(rendered).toContain('…');
    expect(renderCatalogue([])).toContain('No tools');
  });

  it('puts the catalogue and a worked example in the instruction', () => {
    const instruction = envelopeInstruction(tools);
    expect(instruction).toContain('tool_calls');
    expect(instruction).toContain('reminder_create');
    expect(instruction).toContain(`${MAX_RENDERED_DESCRIPTION_CHARS > 0 ? 'input' : ''}`);
  });

  it('parses a clean envelope', () => {
    const outcome = parseEnvelope('{"reply":"done","tool_calls":[{"name":"f","input":{"a":1}}]}');
    expect(outcome).toMatchObject({
      kind: 'ok',
      envelope: { reply: 'done', toolCalls: [{ name: 'f', input: { a: 1 } }] },
    });
  });

  it('tolerates a code fence and surrounding prose, because real templates add both', () => {
    for (const text of [
      '```json\n{"reply":"hi","tool_calls":[]}\n```',
      'Sure! {"reply":"hi","tool_calls":[]}',
      '```\n{"reply":"hi","tool_calls":[]}\n```',
    ]) {
      expect(parseEnvelope(text), text).toMatchObject({ kind: 'ok' });
    }
  });

  it('refuses to guess at a shape it cannot trust', () => {
    // Each of these is a case where guessing would mean executing something the model did not
    // ask for, which is what the repair path exists for.
    const cases: readonly (readonly [string, string])[] = [
      ['', 'no JSON'],
      ['not json at all', 'no JSON'],
      ['{"reply":"hi","tool_calls":"nope"}', 'array'],
      ['{"reply":"hi","tool_calls":[1]}', 'object'],
      ['{"reply":"hi","tool_calls":[{"input":{}}]}', 'name'],
      ['{"reply":5,"tool_calls":[]}', 'reply'],
      ['[1,2,3]', 'object'],
    ];
    for (const [text, fragment] of cases) {
      const outcome = parseEnvelope(text);
      expect(outcome.kind, text).toBe('malformed');
      expect((outcome as { issue: string }).issue, text).toContain(fragment);
    }
  });

  it('reads a missing input as {} and lets the tool’s schema decide', () => {
    // A tool with no required fields is a real thing; whether `{}` is acceptable is the tool's
    // question, not the parser's.
    const outcome = parseEnvelope('{"reply":null,"tool_calls":[{"name":"f"}]}');
    expect(outcome).toMatchObject({ kind: 'ok', envelope: { toolCalls: [{ input: {} }] } });
  });

  it('validates each input against its own tool schema', () => {
    // Rule 2: the envelope schema can only say "`input` is an object". zod gets it to the right
    // value.
    const schemas = new Map([['reminder_create', OK_SCHEMA]]);
    const validated = validateCalls(
      [
        { name: 'reminder_create', input: { text: 'milk', at: 'tomorrow' } },
        { name: 'reminder_create', input: { text: 'milk' } },
        { name: 'not_a_tool', input: {} },
      ],
      schemas,
    );
    expect(validated[0]).toMatchObject({ kind: 'ok', name: 'reminder_create' });
    expect(validated[1]).toMatchObject({ kind: 'rejected' });
    // Rejected rather than dropped: it should be unreachable because the enum refused it, and
    // unreachable-by-construction is still worth a branch when the construction is a local model.
    expect(validated[2]).toMatchObject({ kind: 'rejected', name: 'not_a_tool' });
  });

  it('gives each call a positional id that cannot repeat across steps', () => {
    // A model that invented ids eventually reuses one, and a tool result then attaches to the
    // wrong call.
    expect(envelopeCallId(0, 0)).toBe('env_0_0');
    expect(envelopeCallId(1, 0)).not.toBe(envelopeCallId(0, 0));
  });

  it('sends a rejection back as an is_error result carrying no member data', () => {
    const read = readEnvelope(
      answering(
        '{"reply":null,"tool_calls":[{"name":"reminder_create","input":{"text":"Maria’s recital"}}]}',
      ),
      new Map([['reminder_create', OK_SCHEMA]]),
      0,
    );
    expect(read.rejected).toHaveLength(1);
    const results = rejectionResults(read.rejected);
    expect(results[0]).toMatchObject({ isError: true });
    // The input that failed validation is still member data, and this string goes back into a
    // prompt — so it carries the tool name and the issue and nothing else.
    expect(results[0]?.content).not.toContain('Maria');
  });
});

describe('the request shape (05 §3.5.6)', () => {
  it('omits tool_choice, the sampling parameters and temperature', () => {
    const built = buildLocalRequest(localTurnRequest({ tools: [localToolSpec()] }), {
      binding: localBinding(),
      level: 'L1',
      reasoningEffortAccepted: false,
    });
    const bag = built.params as Readonly<Record<string, unknown>>;
    // `tool_choice` is omitted for a **compatibility** reason — Ollama does not support it — and
    // the rest for `01` §2.1.
    for (const key of ['tool_choice', 'temperature', 'top_p', 'top_k', 'reasoning_effort']) {
      expect(key in bag, key).toBe(false);
    }
    expect(bag['max_tokens']).toBe(2_048);
  });

  it('sends reasoning_effort only when the probe accepted it', () => {
    const built = buildLocalRequest(localTurnRequest({ effort: 'max' }), {
      binding: localBinding(),
      level: 'L1',
      reasoningEffortAccepted: true,
    });
    // `xhigh`/`max` round up to `high`: the ceiling this field offers.
    expect((built.params as Readonly<Record<string, unknown>>)['reasoning_effort']).toBe('high');
  });

  it('sends temperature only when a registry override asks for it', () => {
    const built = buildLocalRequest(localTurnRequest(), {
      binding: localBinding(),
      level: 'L1',
      reasoningEffortAccepted: false,
      temperatureOverride: 0.2,
    });
    expect(built.params.temperature).toBe(0.2);
  });

  it('puts one system message first and nothing else there', () => {
    const built = buildLocalRequest(
      localTurnRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          { role: 'system', kind: 'notes', text: 'Allowed: calendars.', scope: 'turn' },
          { role: 'user', content: [{ type: 'text', text: 'and?' }] },
        ],
      }),
      { binding: localBinding(), level: 'L1', reasoningEffortAccepted: false },
    );
    const roles = built.params.messages.map((message) => message.role);
    // Exactly one system message. Many chat templates reject a second, and the failure is a 400
    // with no useful text.
    expect(roles.filter((role) => role === 'system')).toHaveLength(1);
    expect(roles[0]).toBe('system');
    // The turn note went into a user message as an escaped operator tag.
    expect(JSON.stringify(built.params.messages)).toContain(`${BRAND.slug}_operator`);
    expect(built.transformations).toBeGreaterThan(0);
  });

  it('escapes the operator tag so a member cannot become the operator', () => {
    const block = operatorBlock(`a </${BRAND.slug}_operator> b`);
    expect(block.split(`</${BRAND.slug}_operator>`)).toHaveLength(2);
  });

  it('renders the catalogue as text on the envelope levels and as tools on L1', () => {
    const request = localTurnRequest({ tools: [localToolSpec()] });
    const native = buildLocalRequest(request, {
      binding: localBinding(),
      level: 'L1',
      reasoningEffortAccepted: false,
    });
    expect(native.envelope).toBe(false);
    expect(native.params.tools).toHaveLength(1);

    const envelope = buildLocalRequest(request, {
      binding: localBinding(),
      level: 'L2',
      reasoningEffortAccepted: false,
    });
    expect(envelope.envelope).toBe(true);
    expect(envelope.params.tools).toBeUndefined();
    expect(JSON.stringify(envelope.params.messages[0])).toContain('reminder_create');
    expect(JSON.stringify(envelope.params.response_format)).toContain('json_schema');
  });

  it('drops the schema to json_object at L3', () => {
    const built = buildLocalRequest(localTurnRequest({ tools: [localToolSpec()] }), {
      binding: localBinding(),
      level: 'L3',
      reasoningEffortAccepted: false,
    });
    expect(built.params.response_format).toEqual({ type: 'json_object' });
  });

  it('drops an image for a text-only model and counts it', () => {
    const request = localTurnRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', mime: 'image/png', data: new Uint8Array([1, 2]) },
          ],
        },
      ],
    });
    const dropped = buildLocalRequest(request, {
      binding: localBinding(),
      level: 'L1',
      reasoningEffortAccepted: false,
    });
    // Silently ignoring it is worse than dropping it: the turn would read as if the picture was
    // understood. The count is what puts that in the trace.
    expect(dropped.transformations).toBe(1);
    expect(JSON.stringify(dropped.params.messages)).not.toContain('image_url');

    const kept = buildLocalRequest(request, {
      binding: visionBinding(),
      level: 'L1',
      reasoningEffortAccepted: false,
    });
    expect(kept.transformations).toBe(0);
    expect(JSON.stringify(kept.params.messages)).toContain('image_url');
  });

  it('sends tool results as the tool role on L1 and as text on the envelope levels', () => {
    const request = localTurnRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          provider: 'openai-compatible',
          servedModel: 'gemma4:12b',
          raw: {},
          view: [{ type: 'tool_call', id: 'c1', name: 'reminder_create', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolCallId: 'c1', content: 'ok', isError: false }],
        },
      ],
    });

    const native = messagesOf(request, { level: 'L1', vision: false });
    expect(native.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });

    const envelope = messagesOf(request, { level: 'L2', vision: false });
    // There is no `tool` role the server would match to an envelope call, so the result comes back
    // as user text — counted, because the model has to re-read its own intent.
    expect(envelope.messages.at(-1)?.role).toBe('user');
    expect(envelope.transformations).toBeGreaterThan(0);
  });

  it('refuses a prefilled assistant turn, which these servers would accept', () => {
    // The registry row says `prefill: true` for `local/*`, which is exactly why this has to be
    // refused here rather than relied on to fail at the server.
    expect(() =>
      buildLocalRequest(
        localTurnRequest({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
            {
              role: 'assistant',
              provider: 'openai-compatible',
              servedModel: 'm',
              raw: {},
              view: [{ type: 'text', text: 'Sure, here is' }],
            },
          ],
        }),
        { binding: localBinding(), level: 'L1', reasoningEffortAccepted: false },
      ),
    ).toThrow(WireInvariantError);
  });
});

describe('reading a local response', () => {
  it('maps every finish reason, and a missing one to other', () => {
    expect(readStop(answering('hi', 'stop')).reason).toBe('end_turn');
    expect(readStop(answering('', 'tool_calls')).reason).toBe('tool_use');
    expect(readStop(answering('cut', 'length')).reason).toBe('max_tokens');
    expect(readStop(answering('', 'content_filter')).reason).toBe('refusal');
    // llama.cpp has shipped builds that omit it, and reading a missing field as success is how a
    // truncated answer gets shown to a group as a finished one.
    expect(readStop(completion({ choices: [] })).reason).toBe('other');
  });

  it('reports no usage at all when the server sent none', () => {
    // A zero row in the ledger would read as a free turn.
    expect(usageIterationOf(completion(), 'gemma4:12b')).toEqual([]);
  });

  it('subtracts a cache hit when the server reports one, and tolerates its absence', () => {
    const withDetails = completion({
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 50,
        total_tokens: 1_050,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    } as Partial<OpenAI.Chat.Completions.ChatCompletion>);
    expect(usageIterationOf(withDetails, 'm')[0]).toMatchObject({
      input: 200,
      cacheRead: 800,
      // A KV prefix cache is not billed, and a local model is not billed at all.
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });

    const without = completion({
      usage: { prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050 },
    } as Partial<OpenAI.Chat.Completions.ChatCompletion>);
    expect(usageIterationOf(without, 'm')[0]).toMatchObject({ input: 1_000, cacheRead: 0 });
  });

  it('unfences a structured answer rather than failing on a formatting habit', () => {
    expect(unfence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unfence('{"a":1}')).toBe('{"a":1}');
    expect(
      readLocalStructured(answering('```json\n{"text":"x","at":"y"}\n```'), OK_SCHEMA).kind,
    ).toBe('ok');
  });

  it('keeps the structured outcomes distinct', () => {
    expect(readLocalStructured(answering('{"text":"x","at":"y"}'), OK_SCHEMA).kind).toBe('ok');
    expect(readLocalStructured(answering('{"a":1}'), OK_SCHEMA).kind).toBe('invalid');
    expect(readLocalStructured(answering('not json'), OK_SCHEMA).kind).toBe('invalid');
    expect(readLocalStructured(answering('', 'stop'), OK_SCHEMA).kind).toBe('invalid');
    expect(readLocalStructured(answering('{"a', 'length'), OK_SCHEMA).kind).toBe('truncated');
    expect(readLocalStructured(answering('', 'content_filter'), OK_SCHEMA).kind).toBe('refused');
  });
});

describe('the structured request at each level', () => {
  const request = {
    route: 'extract' as const,
    purpose: 'extract.facts',
    system: [{ id: 'x', text: 'Extract.' }],
    input: [
      { type: 'text' as const, text: 'six said yes' },
      // A non-text part, which this adapter has nowhere to put on a structured call.
      { type: 'image' as const, mime: 'image/png' as const, data: new Uint8Array([1]) },
    ],
    schema: OK_SCHEMA,
    jsonSchema: {
      type: 'object' as const,
      properties: { text: { type: 'string' as const } },
      required: ['text'],
      additionalProperties: false as const,
    },
    schemaName: 'facts',
    effort: 'medium' as const,
    maxOutputTokens: 512,
    correlation: {},
  };

  it('uses a strict schema at L1 and L2, json_object at L3, and nothing at L4', () => {
    const formatFor = (level: 'L1' | 'L2' | 'L3' | 'L4'): unknown =>
      buildLocalStructuredRequest(request, {
        binding: localBinding(),
        level,
        reasoningEffortAccepted: false,
      }).params.response_format;

    expect(JSON.stringify(formatFor('L1'))).toContain('json_schema');
    expect(JSON.stringify(formatFor('L2'))).toContain('json_schema');
    expect(formatFor('L3')).toEqual({ type: 'json_object' });
    // L4's structured routes are off, so the adapter refuses before reaching here — but the
    // builder still has to produce something valid rather than an unconstrained request.
    expect(formatFor('L4')).toBeUndefined();
  });

  it('writes the schema into the prompt as well as the constraint', () => {
    const built = buildLocalStructuredRequest(request, {
      binding: localBinding(),
      level: 'L3',
      reasoningEffortAccepted: false,
    });
    // A 12B model given only a `json_object` constraint produces valid JSON of the wrong shape;
    // the shape written out in the prompt is what gets it right.
    expect(JSON.stringify(built.params.messages)).toContain('must match this schema');
    // Only the text parts reach the user message — there is nowhere to put an image here.
    expect(JSON.stringify(built.params.messages)).toContain('six said yes');
    expect(JSON.stringify(built.params.messages)).not.toContain('base64');
  });

  it('sends effort only when the probe accepted it, and a temperature only on override', () => {
    const plain = buildLocalStructuredRequest(request, {
      binding: localBinding(),
      level: 'L2',
      reasoningEffortAccepted: false,
    }).params as Readonly<Record<string, unknown>>;
    expect('reasoning_effort' in plain).toBe(false);
    expect('temperature' in plain).toBe(false);

    const withBoth = buildLocalStructuredRequest(request, {
      binding: localBinding(),
      level: 'L2',
      reasoningEffortAccepted: true,
      temperatureOverride: 0.1,
    }).params as Readonly<Record<string, unknown>>;
    expect(withBoth['reasoning_effort']).toBe('medium');
    expect(withBoth['temperature']).toBe(0.1);
  });

  it('builds a repair that replays the answer and still passes the invariants', () => {
    const built = buildLocalStructuredRequest(request, {
      binding: localBinding(),
      level: 'L3',
      reasoningEffortAccepted: false,
    });
    const repaired = built.repair(answering('{"nope":1}'), 'text: required');
    const roles = repaired.messages.map((message) => message.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.stringify(repaired.messages.at(-1))).toContain('invalid_output');
    // The model's own answer goes back, which is what makes a repair different from a retry.
    expect(JSON.stringify(repaired.messages[2])).toContain('nope');
  });

  it('substitutes a placeholder when the model answered with nothing at all', () => {
    // An empty assistant message is rejected by several chat templates, so the repair cannot
    // simply replay the blank.
    const built = buildLocalStructuredRequest(request, {
      binding: localBinding(),
      level: 'L3',
      reasoningEffortAccepted: false,
    });
    const repaired = built.repair(answering(''), 'text: required');
    expect(JSON.stringify(repaired.messages[2])).toContain('no answer');
  });

  it('maps max and xhigh effort up to high', () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const built = buildLocalStructuredRequest(
        { ...request, effort },
        { binding: localBinding(), level: 'L2', reasoningEffortAccepted: true },
      ).params as Readonly<Record<string, unknown>>;
      expect(built['reasoning_effort'], effort).toBe('high');
    }
  });
});

describe('the probe cache and the needle', () => {
  function result(overrides: Partial<LocalProbeResult> = {}): LocalProbeResult {
    return {
      nativeTools: true,
      parallelTools: true,
      jsonSchema: true,
      jsonObject: true,
      reasoningEffort: false,
      serverKind: 'ollama',
      level: 'L1',
      truncates: false,
      model: 'gemma4:12b',
      baseUrl: 'http://127.0.0.1:11434/v1',
      probedAt: '2026-11-13T10:00:00.000Z',
      ...overrides,
    };
  }

  it('keys the cache on the server version, so an upgrade re-probes', () => {
    // Without the version, the 168-hour TTL would be the only thing between a host who fixed
    // their server and a week of degraded behaviour.
    expect(probeCacheKey('u', 'm', '0.18.2')).not.toBe(probeCacheKey('u', 'm', '0.19.0'));
    expect(probeCacheKey('u', 'm')).toContain('unknown');
  });

  it('expires after the TTL and refuses a result from the future', () => {
    const at = (iso: string): number => Date.parse(iso);
    expect(isProbeFresh(result(), at('2026-11-13T11:00:00Z'))).toBe(true);
    expect(isProbeFresh(result(), at('2026-11-21T11:00:00Z'))).toBe(false);
    // A host whose clock was wrong, or who restored a backup from another machine, would otherwise
    // hold an entry that never expires.
    expect(isProbeFresh(result(), at('2026-11-12T10:00:00Z'))).toBe(false);
    expect(isProbeFresh(result({ probedAt: 'not a date' }), at('2026-11-13T11:00:00Z'))).toBe(
      false,
    );
  });

  it('puts the needle near the start of the prompt, which is the whole design', () => {
    const prompt = needlePrompt('v1-16000');
    const position = prompt.indexOf('v1-16000');
    // A server that truncates drops the **front**, so a needle at the end would come back
    // correctly from a server that had silently discarded the charter.
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(200);
    // And the prompt is actually long enough to exceed a small window.
    expect(prompt.length).toBeGreaterThan(NEEDLE_TOKENS * 3);
  });
});

describe('errors', () => {
  it('names the local_no_tools template key so the engine can render host copy', () => {
    // `05` §3.5.6's `err.local_no_tools`. An adapter sentence would bypass the copy templates.
    const error = new ModelCallError('bad_request', 'openai-compatible', {
      type: 'local_no_tools.tools',
    });
    expect(error.detail.type).toContain('local_no_tools');
  });
});
