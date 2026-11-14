/**
 * The live smoke harness, driven offline (`11` §3.8.4; `M2-T19`).
 *
 * The live run needs the owner's key (`H-2`). What is testable now is everything *around* the HTTP
 * call — the scenario list, the budget wiring, the result shape, the green rule — and testing it
 * matters precisely because the live run cannot be rehearsed: when the key arrives, a harness bug
 * would spend money and produce a misleading report.
 *
 * `CLAUDE.md` §8: a `--fake` run is **not** a live result, and nothing here claims it is.
 */
import type { ModelGateway, ModelRoute, ModelTurnRequest } from '@comvivo/core';
import { bindingFor, FakeModelGateway, type ReplyBuilder } from '@comvivo/models/testing';
import { VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { SMOKE_CAP_MICROS } from '../budget/index.js';
import { cacheReadImproved, runSmoke, SMOKE_SCENARIOS, type SmokeResult } from './smoke.js';

function baseRequest(route: ModelRoute): ModelTurnRequest {
  return {
    route,
    purpose: 'smoke',
    system: [{ id: 'charter', text: 'be useful' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: 'auto',
    effort: 'low',
    maxOutputTokens: 64,
    correlation: {},
  };
}

/** A clock the test drives. */
function clock(): () => number {
  let current = 0;
  return () => {
    current += 10;
    return current;
  };
}

/**
 * A gateway that answers each scenario the way a healthy provider would.
 *
 * `FakeModelGateway` needs a clock and a route resolver, which is the right shape — it simulates
 * the prompt cache and reports usage, and neither is possible without them.
 */
function fakeGateway(reply: (builder: ReplyBuilder) => ReplyBuilder): ModelGateway {
  const fake = new FakeModelGateway({
    clock: new VirtualClock('2026-11-14T10:00:00Z'),
    bindingFor: () => bindingFor(),
  });
  // A rule is a **queue** of outcomes consumed in order, so one `respond` answers one call.
  // `times` repeats it for the whole scenario list, which is what the smoke needs: five turns,
  // every one answered the same way.
  fake
    .when({})
    .respond(reply)
    .times(SMOKE_SCENARIOS.length + 1);
  return fake;
}

function healthyGateway(): ModelGateway {
  return fakeGateway((reply) =>
    reply.text('smoke-7781 OK').toolCall('probe_echo', { value: 'v1' }),
  );
}

describe('the scenario list', () => {
  it('has the five the AC names, each failing differently', () => {
    // Five scenarios that all exercised the same path would tell us one thing five times. A bad
    // key fails all five; a model that cannot call tools fails only `tool-call`; a server that
    // truncates fails only `long-context`.
    expect(SMOKE_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'plain-reply',
      'tool-call',
      'cache-read',
      'structured',
      'long-context',
    ]);
  });

  it('explains why each one is there, for the report', () => {
    for (const scenario of SMOKE_SCENARIOS) {
      expect(scenario.why, scenario.id).not.toBe('');
    }
  });

  it('keeps every scenario at low effort and a small output cap', () => {
    // The smoke proves liveness, not quality, and it spends somebody's money to do it.
    for (const scenario of SMOKE_SCENARIOS) {
      const request = scenario.request(baseRequest(scenario.route));
      expect(request.effort, scenario.id).toBe('low');
      expect(request.maxOutputTokens, scenario.id).toBeLessThanOrEqual(256);
    }
  });

  it('plants the needle near the start of the long-context prompt', () => {
    // A server that truncates drops the **front**, so a needle at the end would come back
    // correctly from a server that had discarded everything before it.
    const scenario = SMOKE_SCENARIOS.find((entry) => entry.id === 'long-context');
    const request = scenario?.request(baseRequest('chat'));
    const part = request?.messages[0];
    const text =
      part?.role === 'user' && part.content[0]?.type === 'text' ? part.content[0].text : '';
    expect(text.indexOf('smoke-7781')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('smoke-7781')).toBeLessThan(100);
    expect(text.length).toBeGreaterThan(30_000);
  });

  it('accepts only an answer that quotes the passcode back', () => {
    const scenario = SMOKE_SCENARIOS.find((entry) => entry.id === 'long-context');
    expect(scenario?.accept('The passcode was smoke-7781.', [])).toBe(true);
    // A confident answer from a truncated prompt is the failure this catches.
    expect(scenario?.accept('I do not recall a passcode.', [])).toBe(false);
  });

  it('accepts a tool call only when the right tool was called', () => {
    const scenario = SMOKE_SCENARIOS.find((entry) => entry.id === 'tool-call');
    expect(scenario?.accept('', [{ name: 'probe_echo' }])).toBe(true);
    expect(scenario?.accept('I could call a tool.', [])).toBe(false);
  });

  it('sends a strict tool, which is 01 §2.1’s rule', () => {
    const scenario = SMOKE_SCENARIOS.find((entry) => entry.id === 'tool-call');
    const request = scenario?.request(baseRequest('chat'));
    expect(request?.tools[0]?.inputSchema).toMatchObject({ additionalProperties: false });
  });
});

describe('running the smoke offline', () => {
  it('passes every scenario against a healthy gateway', async () => {
    const report = await runSmoke({
      gateway: healthyGateway(),
      provider: 'fake',
      live: false,
      capMicros: SMOKE_CAP_MICROS,
      nowMs: clock(),
      baseRequest,
    });
    expect(report.results.map((result) => result.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
    ]);
    expect(report.green).toBe(true);
    expect(report.outcome).toBe('completed');
    // And it is marked as not live, so no report built from it can be read as one.
    expect(report.live).toBe(false);
  });

  it('fails the scenario whose answer is wrong, and only that one', async () => {
    // Answers everything, but never quotes the passcode — the truncating-server signature.
    const report = await runSmoke({
      gateway: fakeGateway((reply) => reply.text('OK').toolCall('probe_echo', { value: 'v1' })),
      provider: 'fake',
      live: false,
      capMicros: SMOKE_CAP_MICROS,
      nowMs: clock(),
      baseRequest,
    });
    const failed = report.results.filter((result) => result.status === 'fail');
    expect(failed.map((result) => result.scenario)).toEqual(['long-context']);
    expect(report.green).toBe(false);
  });

  it('reports a rejected call by kind, never by message', async () => {
    const gateway: ModelGateway = {
      run: () =>
        Promise.reject(
          Object.assign(new Error('quota exceeded for organisation acme about the recital'), {
            kind: 'rate_limited',
          }),
        ),
      structured: () => Promise.reject(new Error('no')),
      embed: () => Promise.reject(new Error('no')),
      routeInfo: () => ({ provider: 'fake', model: 'm', supports: {} as never }),
    };
    const report = await runSmoke({
      gateway,
      provider: 'fake',
      live: false,
      capMicros: SMOKE_CAP_MICROS,
      nowMs: clock(),
      baseRequest,
    });
    expect(report.results[0]?.detail).toContain('rate_limited');
    // This report is an uploaded artifact, and a provider's error text has carried prompt
    // fragments before (`01` §11.7).
    expect(JSON.stringify(report)).not.toContain('recital');
    expect(report.green).toBe(false);
  });

  it('skips rather than fails when the budget stops scheduling', async () => {
    const report = await runSmoke({
      gateway: healthyGateway(),
      provider: 'fake',
      live: false,
      // One scenario's worth, so the guard stops after the first.
      capMicros: 1,
      nowMs: clock(),
      baseRequest,
    });
    const skipped = report.results.filter((result) => result.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    // A refused scenario is the budget's doing, not a broken provider — reporting it as a failure
    // would make a truncated run look like an outage.
    expect(skipped[0]?.detail).toContain('budget guard');
  });

  it('is not green when the run was truncated, even if every attempt passed', async () => {
    // `11` §3.8.4: a truncated run is yellow. A smoke that skipped two scenarios has not proved
    // the thing it exists to prove.
    const report = await runSmoke({
      gateway: healthyGateway(),
      provider: 'fake',
      live: false,
      capMicros: 1,
      nowMs: clock(),
      baseRequest,
    });
    expect(report.results.some((result) => result.status === 'fail')).toBe(false);
    expect(report.green).toBe(false);
  });
});

describe('the cache-read comparison', () => {
  it('needs the second request to read more than the first', () => {
    // The M2 gate's clause is about the **second** identical request, which one pass cannot show.
    const first: SmokeResult = {
      scenario: 'cache-read',
      status: 'pass',
      detail: '',
      costMicros: 0,
      cacheReadTokens: 0,
      latencyMs: 1,
    };
    expect(cacheReadImproved(first, { ...first, cacheReadTokens: 900 })).toBe(true);
    expect(cacheReadImproved(first, first)).toBe(false);
  });
});
