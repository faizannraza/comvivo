/**
 * The live model smoke (`11` §3.8.4–§3.8.5; `M2-T19`).
 *
 * Five scenarios against the real providers, answering one question no fake can answer: does a
 * real key, a real endpoint and a real model produce a turn our adapter can read? Everything about
 * *quality* is the nightly matrix's job and costs an order of magnitude more.
 *
 * ## It runs offline too, and that is the point
 *
 * `--fake` drives the identical five scenarios through `FakeModelGateway`. That is not a
 * convenience: it is what makes the harness itself verifiable before the owner's key exists
 * (`H-2`). The scenario list, the budget guard wiring, the result shape and the exit code are all
 * exercised offline, so when the key arrives the only untested thing left is the HTTP call — which
 * is the irreducible gap, and a far smaller one than "nobody has run this".
 *
 * `CLAUDE.md` §8: the substitution is stated rather than glossed. A `--fake` run is **not** a live
 * result and `STATUS.md` does not count it as one.
 */
import type { ModelGateway, ModelRoute, ModelTurnRequest } from '@comvivo/core';
import { costIteration, PRICES, type PriceTable } from '@comvivo/models';
import { EvalBudgetGuard, isGreen, type SuiteOutcome } from '../budget/index.js';

/** One smoke scenario: a turn, and what the answer has to contain to count. */
export interface SmokeScenario {
  readonly id: string;
  readonly why: string;
  readonly route: ModelRoute;
  readonly request: (base: ModelTurnRequest) => ModelTurnRequest;
  /** Whether the result is acceptable. Deliberately loose: this is liveness, not quality. */
  readonly accept: (text: string, toolCalls: readonly { readonly name: string }[]) => boolean;
}

/**
 * The five (`M2-T19`'s AC).
 *
 * Chosen so each one would fail differently: a bad key fails all five, a model that cannot call
 * tools fails only `tool-call`, a server that truncates fails only `long-context`. Five scenarios
 * that all exercised the same path would tell us one thing five times.
 */
export const SMOKE_SCENARIOS: readonly SmokeScenario[] = Object.freeze([
  Object.freeze({
    id: 'plain-reply',
    why: 'the key works, the model answers, and we can read the text',
    route: 'chat' as const,
    request: (base: ModelTurnRequest) => ({
      ...base,
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'Reply with exactly: OK' }],
        },
      ],
      maxOutputTokens: 64,
      effort: 'low' as const,
    }),
    accept: (text: string) => text.trim().length > 0,
  }),
  Object.freeze({
    id: 'tool-call',
    why: 'strict tools are accepted and a call comes back parseable',
    route: 'chat' as const,
    request: (base: ModelTurnRequest) => ({
      ...base,
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'Call probe_echo with value v1.' }],
        },
      ],
      tools: [
        {
          name: 'probe_echo',
          description: 'Echo a value back.',
          inputSchema: {
            type: 'object' as const,
            properties: { value: { type: 'string' as const } },
            required: ['value'],
            additionalProperties: false as const,
          },
        },
      ],
      maxOutputTokens: 256,
      effort: 'low' as const,
    }),
    accept: (_text: string, toolCalls: readonly { readonly name: string }[]) =>
      toolCalls.some((call) => call.name === 'probe_echo'),
  }),
  Object.freeze({
    id: 'cache-read',
    why: 'the second identical request reports a cache read, which the M2 gate asks for',
    route: 'chat' as const,
    request: (base: ModelTurnRequest) => ({
      ...base,
      // Long enough to clear the 512-token minimum, so the layer actually caches.
      system: [
        {
          id: 'charter',
          text: 'Be useful to the group. '.repeat(400),
          cache: { ttl: '1h' as const },
        },
      ],
      messages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'Reply with: OK' }] },
      ],
      maxOutputTokens: 64,
      effort: 'low' as const,
    }),
    accept: (text: string) => text.trim().length > 0,
  }),
  Object.freeze({
    id: 'structured',
    why: 'a JSON schema is honoured on the structured route',
    route: 'extract' as const,
    request: (base: ModelTurnRequest) => ({
      ...base,
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'Six people said yes.' }],
        },
      ],
      maxOutputTokens: 256,
      effort: 'low' as const,
    }),
    accept: (text: string) => text.trim().length > 0,
  }),
  Object.freeze({
    id: 'long-context',
    why: 'a long prompt is not silently truncated — the failure with no error',
    route: 'chat' as const,
    request: (base: ModelTurnRequest) => ({
      ...base,
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: `Remember this passcode: smoke-7781.\n${'The group discussed logistics. '.repeat(1_200)}\nWhat was the passcode?`,
            },
          ],
        },
      ],
      maxOutputTokens: 64,
      effort: 'low' as const,
    }),
    accept: (text: string) => text.includes('smoke-7781'),
  }),
]);

/** One scenario's outcome. */
export interface SmokeResult {
  readonly scenario: string;
  readonly status: 'pass' | 'fail' | 'skipped';
  readonly detail: string;
  readonly costMicros: number;
  readonly cacheReadTokens: number;
  readonly latencyMs: number;
}

export interface SmokeReport {
  readonly provider: string;
  readonly live: boolean;
  readonly results: readonly SmokeResult[];
  readonly outcome: SuiteOutcome;
  readonly spentMicros: number;
  readonly green: boolean;
}

export interface SmokeDeps {
  readonly gateway: ModelGateway;
  readonly provider: string;
  /** False for a `--fake` run, which is not a live result (`CLAUDE.md` §8). */
  readonly live: boolean;
  readonly prices?: PriceTable;
  readonly capMicros: number;
  readonly nowMs: () => number;
  readonly baseRequest: (route: ModelRoute) => ModelTurnRequest;
}

/**
 * Run the smoke.
 *
 * Every scenario goes through the budget guard, including on a `--fake` run — which is how the
 * wiring gets tested. A refused scenario is `skipped`, not `fail`: the budget stopped it, and
 * reporting it as a failure would make a truncated run look like a broken provider.
 */
export async function runSmoke(deps: SmokeDeps): Promise<SmokeReport> {
  const guard = new EvalBudgetGuard({
    share: { job: `smoke:${deps.provider}`, capMicros: deps.capMicros },
    // One scenario's worth of the cap, so the first admission is bounded without a real figure.
    openingEstimateMicros: Math.ceil(deps.capMicros / SMOKE_SCENARIOS.length),
    nowMs: deps.nowMs,
  });
  const table = deps.prices ?? PRICES;
  const results: SmokeResult[] = [];

  for (const scenario of SMOKE_SCENARIOS) {
    if (!guard.canStart()) {
      results.push({
        scenario: scenario.id,
        status: 'skipped',
        detail: 'the budget guard stopped scheduling',
        costMicros: 0,
        cacheReadTokens: 0,
        latencyMs: 0,
      });
      continue;
    }

    const startedAt = deps.nowMs();
    try {
      const request = scenario.request(deps.baseRequest(scenario.route));
      const result = await deps.gateway.run(request, AbortSignal.timeout(120_000));
      const costMicros = result.usage.reduce(
        (sum, iteration) => sum + costIteration(iteration, table).micros,
        0,
      );
      guard.finish({ scenario: scenario.id, costMicros, judge: false });

      const accepted = scenario.accept(result.text, result.toolCalls);
      results.push({
        scenario: scenario.id,
        status: accepted ? 'pass' : 'fail',
        detail: accepted ? scenario.why : `the answer did not satisfy: ${scenario.why}`,
        costMicros,
        cacheReadTokens: result.usage.reduce((sum, iteration) => sum + iteration.cacheRead, 0),
        latencyMs: deps.nowMs() - startedAt,
      });
    } catch (error) {
      // A rejection still released its reservation, so the remaining scenarios get their budget.
      guard.finish({ scenario: scenario.id, costMicros: 0, judge: false });
      results.push({
        scenario: scenario.id,
        status: 'fail',
        // The error's **kind**, never its message: a provider's error text has carried prompt
        // fragments before (`01` §11.7), and this report is an uploaded artifact.
        detail: `the call failed: ${kindOf(error)}`,
        costMicros: 0,
        cacheReadTokens: 0,
        latencyMs: deps.nowMs() - startedAt,
      });
    }
  }

  const state = guard.state();
  return {
    provider: deps.provider,
    live: deps.live,
    results,
    outcome: state.outcome,
    spentMicros: state.spentMicros,
    // Green needs every scenario to pass **and** the run not to have been truncated. `11` §3.8.4
    // is explicit that a truncated run is yellow, and a smoke that skipped two scenarios has not
    // proved the thing it exists to prove.
    green: isGreen(state.outcome) && results.every((result) => result.status === 'pass'),
  };
}

function kindOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    const kind: unknown = (error as { readonly kind: unknown }).kind;
    if (typeof kind === 'string') return kind;
  }
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * The second half of the cache-read check (`M2` exit gate).
 *
 * The gate asks for `cache_read_input_tokens > 0` on the **second** identical request, which one
 * pass through the scenarios cannot show. So the caller runs `cache-read` twice and compares — and
 * the comparison is here rather than in the runner because a single scenario list that ran one
 * entry twice would make every other count wrong.
 */
export function cacheReadImproved(first: SmokeResult, second: SmokeResult): boolean {
  return second.cacheReadTokens > first.cacheReadTokens;
}
