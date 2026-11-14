/**
 * The shared adapter contract suite (`11` §3.1.9; `01` §2.1; `M2-T14`).
 *
 * ## Why this is one suite and not four
 *
 * Each adapter already has a contract test that drives it over a real socket and asserts what is
 * specific to that provider. This file asserts what `01` §2.1 says about **every** provider, and
 * it is shared for one reason: four copies of nine rules is thirty-six assertions that can drift,
 * and the way they drift is silent. A rule asserted for Anthropic and quietly missing for Google
 * reads exactly like a rule that holds everywhere.
 *
 * So the rules live here once, and each adapter registers a **subject**. Adding a fifth provider
 * cannot skip a rule — it cannot compile without supplying the subject — and a rule added here
 * applies to all four at once.
 *
 * ## The lens, and why it needs a positive control
 *
 * The four wire formats put the same things in different places: Anthropic's tools are
 * `tools[].input_schema`, OpenAI's are `tools[].parameters`, Google's are
 * `tools[0].functionDeclarations[].parametersJsonSchema`, and Chat Completions' are
 * `tools[].function.parameters`. A shared assertion over four shapes therefore needs a per-provider
 * **lens** — small, declarative functions that find the thing in a captured body.
 *
 * A wrong lens is the failure mode that matters: `toolsOf` returning `[]` would make the
 * strict-tools assertion pass for an adapter that sent no `strict` at all. So the suite opens with
 * **two `it` blocks of its own** — "has an honest lens: it finds the tools a request demonstrably
 * carried" and the same for a replayed assistant turn and a tool result — which run a request that
 * provably contains the thing and fail if the lens comes back empty. The rules are only as good as
 * the lens, and the lens is checked before the rules run.
 *
 * (An earlier version of this paragraph described a function called `assertLensIsHonest`. There has
 * never been one; the guards are the two `it` blocks below. Corrected at the M2 review, which found
 * it while looking for the function.)
 *
 * ## One rule that cannot be literal on all four
 *
 * `01` §2.1 says "return all parallel `tool_result` blocks in a **single user message**". That is
 * Anthropic's shape and Google's; on Chat Completions each tool result **must** be its own
 * `role: 'tool'` message, and on the Responses API each is its own top-level
 * `function_call_output` item. The rule's intent is that results are not split across turns or
 * interleaved with new member content, so the provider-independent form asserted here is
 * **contiguity**: every tool result for a step appears in one unbroken run, with nothing else
 * between them. Logged as a plan change — the literal wording is Anthropic-specific and the intent
 * is not.
 */
import type { ModelTurnRequest, ModelTurnResult, ToolSpec, UsageIteration } from '@comvivo/core';
import { expect, it } from 'vitest';
import type { CapturedRequest } from './fake-provider-server.js';

/** Where a tool's schema and strictness live in one provider's wire format. */
export interface WireTool {
  readonly name: string;
  /** The JSON Schema as sent. `undefined` when the provider was sent none. */
  readonly schema: Readonly<Record<string, unknown>> | undefined;
  /**
   * Whether the provider was told the schema is strict.
   *
   * `undefined` means the format has no such field — Google's `functionDeclarations` does not, and
   * claiming `false` there would fail a rule the provider cannot express. The assertion treats
   * `undefined` as "not applicable" and still requires `additionalProperties: false`, which is the
   * half of strictness every format *can* carry.
   */
  readonly strict: boolean | undefined;
}

/** A contiguous run of tool results in one request, as the lens found them. */
export interface ToolResultRun {
  /** How many results are in this run. */
  readonly count: number;
  /** The ids they answer, in order. */
  readonly callIds: readonly string[];
}

/**
 * One provider's lens over a captured request body.
 *
 * Every function takes the **parsed body of a request that really travelled over TCP**, which is
 * what makes these assertions about the wire rather than about an adapter's internals.
 */
export interface WireLens {
  /** Keys present in the body that `01` §2.1 forbids. Return the ones actually found. */
  readonly forbiddenKeysPresent: (body: Readonly<Record<string, unknown>>) => readonly string[];
  /** Every tool as sent. Empty when the request carried none. */
  readonly toolsOf: (body: Readonly<Record<string, unknown>>) => readonly WireTool[];
  /** The tool-choice value as sent, or `undefined` when the format omits it. */
  readonly toolChoiceOf: (body: Readonly<Record<string, unknown>>) => string | undefined;
  /** The role of the final conversational entry — `'assistant'` is prefill. */
  readonly lastRoleOf: (body: Readonly<Record<string, unknown>>) => string | undefined;
  /** Contiguous runs of tool results. More than one run means they were split. */
  readonly toolResultRunsOf: (body: Readonly<Record<string, unknown>>) => readonly ToolResultRun[];
  /** The assistant content this request replayed back, for the append-unchanged rule. */
  readonly replayedAssistantOf: (body: Readonly<Record<string, unknown>>) => readonly unknown[];
}

/** What a subject must be able to drive, so the shared suite can exercise it. */
export interface ContractSubject {
  readonly provider: string;
  readonly lens: WireLens;
  /**
   * Run one turn against a scripted fake and return every request it sent.
   *
   * The subject owns the harness — each adapter's client, base URL and binding differ — and this
   * suite owns what is asserted about the result.
   */
  readonly run: (options: {
    readonly request: Partial<ModelTurnRequest>;
    /** Scripted replies, in order. A turn may send more than one request. */
    readonly replies: readonly ContractReply[];
  }) => Promise<{
    readonly result: ModelTurnResult;
    readonly captured: readonly CapturedRequest[];
  }>;
  /** Run one turn expecting a fault, and return the rejection. */
  readonly runFaulty: (fault: ContractFault) => Promise<unknown>;
  /**
   * Run one turn against a **stored body**, served back verbatim through a `raw` turn.
   *
   * Deliberately separate from `run`: that renders a neutral reply, which is the path
   * `fixtures.contract.test.ts` exists to bypass. A renderer and an adapter can drift together and
   * still agree with each other; a frozen body breaks that symmetry (`11` §3.1.9).
   */
  readonly rawRun: (body: unknown) => Promise<ModelTurnResult>;
  /** A tool spec this provider accepts, for the strict-tools and parallel-results rules. */
  readonly tool: (name?: string) => ToolSpec;
  /**
   * Whether this provider's format carries a `tool_choice`-shaped field at all.
   *
   * `false` for the local adapter: `05` §3.5.6 omits it because Ollama does not support it, so
   * "must be auto or none" becomes "must be absent" — a different assertion for the same rule.
   */
  readonly hasToolChoice: boolean;
  /** Whether a usage block carries per-TTL cache-write counts (Anthropic and OpenAI do). */
  readonly hasCacheWriteTtls: boolean;
}

/** A scripted reply, in the neutral shape every provider's renderer understands. */
export interface ContractReply {
  readonly text?: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
  }[];
  readonly stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn';
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheWrite5mInputTokens?: number;
    readonly cacheWrite1hInputTokens?: number;
    readonly reasoningTokens?: number;
  };
}

export type ContractFault =
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly kind: 'server_error'; readonly status: number }
  | { readonly kind: 'socket_reset' };

/** `01` §2.1's first rule, as the set of key names no provider may be sent. */
export const FORBIDDEN_SAMPLING_KEYS: readonly string[] = [
  'temperature',
  'top_p',
  'topP',
  'top_k',
  'topK',
];

/** The usage totals a `UsageRecord` is built from, summed across a call's iterations. */
export function usageTotals(iterations: readonly UsageIteration[]): {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  for (const iteration of iterations) {
    input += iteration.input;
    output += iteration.output;
    cacheRead += iteration.cacheRead;
    cacheWrite5m += iteration.cacheWrite5m;
    cacheWrite1h += iteration.cacheWrite1h;
  }
  return { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
}

const bodyOf = (request: CapturedRequest): Readonly<Record<string, unknown>> =>
  (request.body ?? {}) as Readonly<Record<string, unknown>>;

/**
 * The suite.
 *
 * Called from each adapter's own `*.contract.test.ts` inside a `describe`, so a failure names the
 * provider. Returns nothing: every assertion is an `it`.
 */
export function runAdapterContract(subject: ContractSubject): void {
  // ---------------------------------------------------------------------------------------------
  // The lens is checked first. Every rule below reads the wire through it, so a lens that found
  // nothing would make the rules pass vacuously — which is the one failure this suite could have
  // that nobody would notice.
  // ---------------------------------------------------------------------------------------------
  it('has an honest lens: it finds the tools a request demonstrably carried', async () => {
    const { captured } = await subject.run({
      request: { tools: [subject.tool('alpha'), subject.tool('bravo')] },
      replies: [{ text: 'ok' }],
    });
    const body = bodyOf(captured[0] ?? ({} as CapturedRequest));
    const tools = subject.lens.toolsOf(body);
    // Two tools went out, so a lens that cannot see two is broken rather than the adapter being
    // compliant.
    expect(tools.map((tool) => tool.name)).toEqual(['alpha', 'bravo']);
    for (const tool of tools) {
      expect(tool.schema, tool.name).toBeDefined();
    }
  });

  it('has an honest lens: it finds a replayed assistant turn and a tool result', async () => {
    const first = await subject.run({
      request: { tools: [subject.tool()] },
      replies: [{ toolCalls: [{ id: 'call_1', name: subject.tool().name, input: { q: 'x' } }] }],
    });
    const { captured } = await subject.run({
      request: {
        tools: [subject.tool()],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          first.result.assistant,
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolCallId: 'call_1', content: '{"ok":true}', isError: false },
            ],
          },
        ],
      },
      replies: [{ text: 'done' }],
    });
    const body = bodyOf(captured[0] ?? ({} as CapturedRequest));
    // Both lenses must find something, or the two rules that use them are vacuous.
    expect(subject.lens.replayedAssistantOf(body).length).toBeGreaterThan(0);
    const runs = subject.lens.toolResultRunsOf(body);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.callIds).toEqual(['call_1']);
  });

  // ---------------------------------------------------------------------------------------------
  // `01` §2.1's nine non-negotiables, in `11` §3.1.9's order.
  // ---------------------------------------------------------------------------------------------
  it('sends no temperature, top_p or top_k on any request', async () => {
    // Rule 1. On Anthropic the fields are absent from the params type entirely; on the other
    // three they are real and settable, which is why this is asserted on the **wire** rather than
    // trusted to the type system.
    const { captured } = await subject.run({
      request: { tools: [subject.tool()] },
      replies: [{ toolCalls: [{ id: 'c1', name: subject.tool().name, input: { q: 'x' } }] }],
    });
    expect(captured.length).toBeGreaterThan(0);
    for (const request of captured) {
      expect(subject.lens.forbiddenKeysPresent(bodyOf(request)), request.path).toEqual([]);
    }
  });

  it('never ends a request with an assistant turn', async () => {
    // Rule 2: no prefill. A 400 on current models, and on the local servers it **works** — the
    // registry row says `prefill: true` — which is exactly why it has to be refused by us.
    const first = await subject.run({
      request: { tools: [subject.tool()] },
      replies: [{ toolCalls: [{ id: 'c1', name: subject.tool().name, input: { q: 'x' } }] }],
    });
    const { captured } = await subject.run({
      request: {
        tools: [subject.tool()],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          first.result.assistant,
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolCallId: 'c1', content: '{"ok":true}', isError: false },
            ],
          },
        ],
      },
      replies: [{ text: 'done' }],
    });
    for (const request of captured) {
      expect(subject.lens.lastRoleOf(bodyOf(request)), request.path).not.toBe('assistant');
    }
  });

  it('never forces a tool choice', async () => {
    // Rule 3. `auto` or `none` — or **absent**, which is the local adapter's answer because
    // `05` §3.5.6 omits the field for Ollama's sake. Same rule, different expression.
    const { captured } = await subject.run({
      request: { tools: [subject.tool()] },
      replies: [{ text: 'ok' }],
    });
    for (const request of captured) {
      const choice = subject.lens.toolChoiceOf(bodyOf(request));
      if (!subject.hasToolChoice) {
        expect(choice, request.path).toBeUndefined();
        continue;
      }
      expect(['auto', 'none', undefined], request.path).toContain(choice);
    }
  });

  it('declares every tool strict, with additionalProperties false', async () => {
    // Rule 4. `strict` is `undefined` on the formats that have no such field, and
    // `additionalProperties: false` is the half of strictness every format can carry — so that
    // half is required unconditionally.
    const { captured } = await subject.run({
      request: { tools: [subject.tool('alpha'), subject.tool('bravo')] },
      replies: [{ text: 'ok' }],
    });
    const tools = subject.lens.toolsOf(bodyOf(captured[0] ?? ({} as CapturedRequest)));
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      if (tool.strict !== undefined) expect(tool.strict, tool.name).toBe(true);
      expect(tool.schema?.['additionalProperties'], tool.name).toBe(false);
    }
  });

  it('keeps parallel tool results contiguous', async () => {
    // Rule 5, in its provider-independent form. `01` §2.1 says "a single user message", which is
    // Anthropic's and Google's shape; Chat Completions **requires** one `role: 'tool'` message per
    // result and the Responses API one top-level item per result. The intent is that results are
    // not split across turns or interleaved with new member content, so contiguity is what is
    // asserted. Logged as a plan change.
    const first = await subject.run({
      request: { tools: [subject.tool('alpha'), subject.tool('bravo')] },
      replies: [
        {
          toolCalls: [
            { id: 'c1', name: 'alpha', input: { q: 'x' } },
            { id: 'c2', name: 'bravo', input: { q: 'y' } },
          ],
        },
      ],
    });
    const { captured } = await subject.run({
      request: {
        tools: [subject.tool('alpha'), subject.tool('bravo')],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          first.result.assistant,
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolCallId: 'c1', content: '{"a":1}', isError: false },
              { type: 'tool_result', toolCallId: 'c2', content: '{"b":2}', isError: false },
            ],
          },
        ],
      },
      replies: [{ text: 'done' }],
    });
    const runs = subject.lens.toolResultRunsOf(bodyOf(captured[0] ?? ({} as CapturedRequest)));
    // One run holding both, not two runs of one.
    expect(runs).toHaveLength(1);
    expect(runs[0]?.count).toBe(2);
    expect(runs[0]?.callIds).toEqual(['c1', 'c2']);
  });

  it('appends the assistant turn back unchanged', async () => {
    // Rule 6. The thing that matters is that whatever opaque state the provider gave us — a
    // thinking block, an encrypted reasoning item, a thought signature — comes back byte for byte.
    // Village builds a fresh request per turn from memory, so history is never *edited*; this
    // asserts it is never *lossy* either.
    const first = await subject.run({
      request: { tools: [subject.tool()] },
      replies: [
        {
          thinking: 'weighing it up',
          toolCalls: [{ id: 'c1', name: subject.tool().name, input: { q: 'x' } }],
        },
      ],
    });
    const { captured } = await subject.run({
      request: {
        tools: [subject.tool()],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          first.result.assistant,
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolCallId: 'c1', content: '{"ok":true}', isError: false },
            ],
          },
        ],
      },
      replies: [{ text: 'done' }],
    });
    const replayed = subject.lens.replayedAssistantOf(
      bodyOf(captured[0] ?? ({} as CapturedRequest)),
    );
    const raw = first.result.assistant.raw;
    if (Array.isArray(raw)) {
      // Byte for byte where the provider gave us an array to replay.
      expect(replayed).toEqual(raw);
    } else {
      // Chat Completions has no opaque state, so the turn is rebuilt from the typed view — which
      // is lossless for it, because there is nothing opaque to lose.
      expect(replayed.length).toBeGreaterThan(0);
    }
    // And none of the model's reasoning text reached the typed view a guard could log.
    expect(JSON.stringify(first.result.assistant.view)).not.toContain('weighing it up');
  });

  it('reads the stop reason before the content, for each kind that blocks it', async () => {
    // Rule 7. `refusal` and `max_tokens` must discard the partial text **and** the partial tool
    // calls: a truncated tool call executed is a tool run on an input the model never finished.
    for (const stopReason of ['refusal', 'max_tokens'] as const) {
      const { result } = await subject.run({
        request: { tools: [subject.tool()] },
        replies: [
          {
            stopReason,
            text: 'I was about to say something',
            toolCalls: [{ id: 'c1', name: subject.tool().name, input: { q: 'x' } }],
          },
        ],
      });
      expect(result.text, stopReason).toBe('');
      expect(result.toolCalls, stopReason).toEqual([]);
      // The raw turn survives, because a caller may still need to show something happened.
      expect(result.assistant.raw, stopReason).toBeDefined();
    }
  });

  it('honours retry-after on a rate limit', async () => {
    // Rule 9's second half. A zero wait on a 429 is a hot loop against a provider that just
    // asked for two seconds.
    const error = await subject.runFaulty({ kind: 'rate_limited', retryAfterSeconds: 2 });
    expect(error).toMatchObject({ kind: 'rate_limited', provider: subject.provider });
    const detail = (error as { readonly detail?: { readonly retryAfterMs?: number } }).detail;
    if (detail?.retryAfterMs === undefined) {
      // Google's SDK exposes no headers at all, so the number is unreachable from the thrown
      // value (`05` §3.5.5, measured at `M2-T13`). Asserted as a known absence rather than
      // skipped, so a future SDK that adds headers makes this fail and get updated.
      expect(subject.provider).toBe('google');
    } else {
      expect(detail.retryAfterMs).toBe(2_000);
    }
  });

  it('maps typed errors to the canonical kinds', async () => {
    // Rule 9's first half. The breaker's behaviour depends on this: back-pressure must not be
    // counted as a server fault, and our own bad request must not be counted at all.
    expect(await subject.runFaulty({ kind: 'server_error', status: 500 })).toMatchObject({
      kind: 'server',
    });
    expect(await subject.runFaulty({ kind: 'server_error', status: 400 })).toMatchObject({
      kind: 'bad_request',
    });
    expect(await subject.runFaulty({ kind: 'socket_reset' })).toMatchObject({ kind: 'network' });
  });

  it('maps usage to a UsageRecord, cache tokens included', async () => {
    // The AC's last clause. `input` is the **uncached remainder** on every provider, which is the
    // convention that lets `02` §3.3.7 roll all four up in one table — and the three cloud
    // providers report their totals differently, so this is the assertion that keeps them agreeing.
    const { result } = await subject.run({
      request: {},
      replies: [
        {
          text: 'ok',
          usage: {
            inputTokens: 100,
            outputTokens: 40,
            cacheReadInputTokens: 900,
            cacheWrite5mInputTokens: 60,
            cacheWrite1hInputTokens: 20,
          },
        },
      ],
    });
    const totals = usageTotals(result.usage);
    expect(totals.output).toBe(40);
    expect(totals.cacheRead).toBe(900);
    if (subject.hasCacheWriteTtls) {
      // Anthropic and OpenAI both report a per-TTL split, and `UsageRecord` has a column for each.
      expect(totals.input).toBe(100);
      expect(totals.cacheWrite5m).toBe(60);
      expect(totals.cacheWrite1h).toBe(20);
    } else {
      // Google caches implicitly and bills no write; the local servers bill nothing at all. So
      // both write columns are zero — and the 80 tokens a write-reporting provider would have put
      // there are **indistinguishable from input** in these formats, which is why `input` is
      // asserted as the sum rather than as 100. Reporting them as a write we did not observe would
      // be inventing a number; folding them into input is the conservative truth.
      expect(totals.cacheWrite5m + totals.cacheWrite1h).toBe(0);
      expect(totals.input).toBe(100 + 60 + 20);
    }
    // A synchronous turn is never a batch; a `true` here would price the call at the discount.
    expect(result.usage.some((iteration) => iteration.batch)).toBe(false);
  });

  it('reports the provider and the served model on every result', async () => {
    const { result } = await subject.run({ request: {}, replies: [{ text: 'ok' }] });
    expect(result.model.provider).toBe(subject.provider);
    expect(result.model.served).not.toBe('');
    expect(result.model.requested).not.toBe('');
  });
}
