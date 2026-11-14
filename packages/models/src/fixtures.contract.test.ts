/**
 * Replaying `fixtures/providers/**` through each adapter (`11` §3.1.9; `M2-T14`).
 *
 * §3.1.9: the fixtures "replay captured bodies through the same `raw` turn". That is what this
 * does — each stored body is served back verbatim by `FakeProviderServer`'s `raw` turn, over a real
 * socket, to the real adapter and the real SDK.
 *
 * ## What this catches that the scripted contract suite does not
 *
 * The scripted suite asks the fake to render a reply and then asserts the adapter read it. Both
 * halves are ours, so they can **drift together**: a renderer that stopped emitting a field and an
 * adapter that stopped reading it would still agree, and would agree with no real provider.
 *
 * A committed fixture breaks that symmetry. The bytes are frozen at the moment the format was
 * verified against the provider's own documentation, so a renderer change shows up as a fixture
 * diff and an adapter change shows up as a replay failure. The two can no longer move in step
 * without somebody seeing it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelTurnResult } from '@comvivo/core';
import { describe, expect, it } from 'vitest';
import { anthropicSubject } from './anthropic/testing/contract-subject.js';
import { googleSubject } from './google/testing/contract-subject.js';
import { openaiSubject } from './openai/testing/contract-subject.js';
import { localSubject } from './openai-compatible/testing/contract-subject.js';

const ROOT = fileURLToPath(new URL('../../../fixtures/providers', import.meta.url));

/** The four subjects, each able to replay a stored body through its own harness. */
const SUBJECTS = [anthropicSubject(), openaiSubject(), googleSubject(), localSubject()] as const;

/** Every fixture for a provider, by case name. */
function fixturesFor(
  provider: string,
): readonly { readonly name: string; readonly body: unknown }[] {
  const dir = join(ROOT, provider);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .toSorted()
    .map((file) => ({
      name: file.replace(/\.json$/, ''),
      body: JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown,
    }));
}

/** What each case must mean, after the adapter has read it. Hand-written, not a snapshot. */
const EXPECTATIONS: Readonly<Record<string, (result: ModelTurnResult) => void>> = {
  'plain-text': (result) => {
    expect(result.text).toBe('Six people said yes.');
    expect(result.stop.reason).toBe('end_turn');
  },
  'tool-call': (result) => {
    expect(result.stop.reason).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(1);
    // The **id** is asserted, not only the input. Renaming `call_id` in a fixture slipped past an
    // earlier version of this expectation, which is the exact field an adapter gets wrong — the
    // Responses API has both `id` and `call_id` on a function-call item and only one of them
    // matches a `function_call_output`. A tool result attached to the wrong id is a tool whose
    // answer never reaches the model.
    expect(result.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'get_forecast',
      input: { q: 'Lisbon' },
    });
  },
  'parallel-tool-calls': (result) => {
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((call) => call.id)).toEqual(['call_1', 'call_2']);
    expect(result.toolCalls.map((call) => call.input)).toEqual([{ q: 'Lisbon' }, { q: 'Porto' }]);
  },
  'thinking-then-text': (result) => {
    expect(result.text).toBe('Yes.');
    // The model's reasoning must not reach the typed view a disclosure guard could log.
    expect(JSON.stringify(result.assistant.view)).not.toContain('weighing it up');
  },
  'max-tokens': (result) => {
    expect(result.stop.reason).toBe('max_tokens');
    // Truncated mid-thought, so none of it is shown.
    expect(result.text).toBe('');
  },
  refusal: (result) => {
    expect(result.stop.reason).toBe('refusal');
    expect(result.text).toBe('');
  },
  'usage-with-cache': (result) => {
    const [iteration] = result.usage;
    expect(iteration).toBeDefined();
    expect(iteration?.cacheRead).toBe(900);
    expect(iteration?.output).toBe(40);
  },
};

describe('the fixture set itself', () => {
  it('ships the same cases for all four providers, so none is untested anywhere', () => {
    const providers = readdirSync(ROOT).toSorted();
    expect(providers).toEqual(['anthropic', 'google', 'openai', 'openai-compatible']);
    const names = Object.keys(EXPECTATIONS).toSorted();
    for (const provider of providers) {
      expect(
        fixturesFor(provider).map((entry) => entry.name),
        provider,
      ).toEqual(names);
    }
  });

  it('has a hand-written expectation for every case', () => {
    // `11` §3.1.10: an expectation file is hand-reviewed, not generated. A fixture with no
    // expectation would be a file that proves the adapter did not crash and nothing more.
    for (const entry of fixturesFor('anthropic')) {
      expect(EXPECTATIONS[entry.name], entry.name).toBeDefined();
    }
  });

  it('carries no member data, because every reply is written in the recorder', () => {
    // These are not live recordings — `RecordingGateway` does that and scrubs on the way. Asserted
    // so a contributor who pastes a real body in gets a failure rather than a committed leak.
    for (const provider of readdirSync(ROOT)) {
      for (const entry of fixturesFor(provider)) {
        const dumped = JSON.stringify(entry.body);
        for (const leak of ['@', 'Maria', 'Theo']) {
          expect(dumped, `${provider}/${entry.name}`).not.toContain(leak);
        }
      }
    }
  });
});

for (const subject of SUBJECTS) {
  describe(`${subject.provider}: replaying stored bodies`, () => {
    for (const entry of fixturesFor(subject.provider)) {
      it(`reads ${entry.name} the same way it was recorded`, async () => {
        const assertion = EXPECTATIONS[entry.name];
        if (assertion === undefined) throw new Error(`no expectation for "${entry.name}"`);
        assertion(await subject.rawRun(entry.body));
      });
    }
  });
}
