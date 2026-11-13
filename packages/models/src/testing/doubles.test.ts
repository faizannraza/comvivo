/**
 * `ScriptedModel`, `CassetteModel` and `RecordingGateway` (`11` §3.2.4; `M2-T7`).
 *
 * All three share one assertion that matters more than the rest: **a miss fails**. A scripted
 * conversation that ran off the end, a cassette whose prompt changed, a recording with nothing to
 * record — each of those is a test that has stopped testing, and the only way that stays visible is
 * if it throws.
 */
import type { ModelTurnRequest } from '@comvivo/core';
import { VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { bindingFor, OPUS, turnRequest } from '../anthropic/testing/fixtures.js';
import { hashTurnRequest } from './canonical-hash.js';
import { CassetteMiss, CassetteModel, replyText } from './cassette-model.js';
import { FakeModelGateway, FakeScriptExhausted } from './fake-gateway.js';
import { RecordingGateway, scrubDeep, scrubText } from './recorder.js';
import { ScriptedModel } from './scripted-model.js';

const SIGNAL = (): AbortSignal => AbortSignal.timeout(5_000);

function base(): { clock: VirtualClock; bindingFor: () => ReturnType<typeof bindingFor> } {
  return { clock: new VirtualClock('2026-11-12T12:00:00Z'), bindingFor: () => bindingFor() };
}

/** A follow-up request, which continues the turn in progress rather than starting a new one. */
function toolRoundTrip(): ModelTurnRequest {
  return turnRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        provider: 'anthropic',
        servedModel: OPUS,
        raw: [],
        view: [{ type: 'tool_call', id: 'toolu_1', name: 't', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'toolu_1', content: 'ok', isError: false }],
      },
    ],
  });
}

describe('ScriptedModel', () => {
  it('answers by position, so the script reads as a transcript', async () => {
    const scripted = new ScriptedModel({
      ...base(),
      script: [
        { at: { route: 'chat', turn: 1, call: 1 }, reply: (r) => r.toolCall('t', {}) },
        { at: { route: 'chat', turn: 1, call: 2 }, reply: (r) => r.text('after the tool') },
        { at: { route: 'chat', turn: 2, call: 1 }, reply: (r) => r.text('second turn') },
      ],
    });

    expect((await scripted.run(turnRequest(), SIGNAL())).stop.reason).toBe('tool_use');
    // A tool round trip continues the turn, which is what makes `(turn, call)` mean what a reader
    // expects.
    expect((await scripted.run(toolRoundTrip(), SIGNAL())).text).toBe('after the tool');
    expect((await scripted.run(turnRequest(), SIGNAL())).text).toBe('second turn');
  });

  it('fails loudly when the script runs out', async () => {
    const scripted = new ScriptedModel({
      ...base(),
      script: [{ at: { route: 'chat', turn: 1, call: 1 }, reply: (r) => r.text('only one') }],
    });
    await scripted.run(turnRequest(), SIGNAL());
    await expect(scripted.run(turnRequest(), SIGNAL())).rejects.toBeInstanceOf(FakeScriptExhausted);
  });

  it('reports entries the conversation never reached', async () => {
    const scripted = new ScriptedModel({
      ...base(),
      script: [
        { at: { route: 'chat', turn: 1, call: 1 }, reply: (r) => r.text('a') },
        { at: { route: 'chat', turn: 9, call: 1 }, reply: (r) => r.text('never') },
      ],
    });
    await scripted.run(turnRequest(), SIGNAL());
    expect(scripted.unusedEntries()).toEqual([{ route: 'chat', turn: 9, call: 1 }]);
  });

  it('accepts a matcher for the cases position cannot express', async () => {
    const scripted = new ScriptedModel({
      ...base(),
      script: [
        {
          at: (req, position) => position.call === 1 && JSON.stringify(req).includes('recital'),
          reply: (r) => r.text('matched by content'),
        },
      ],
    });
    const result = await scripted.run(
      turnRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'recital' }] }] }),
      SIGNAL(),
    );
    expect(result.text).toBe('matched by content');
  });

  it('keeps the captured calls, like the fake it wraps', async () => {
    const scripted = new ScriptedModel({
      ...base(),
      script: [{ at: { route: 'chat', turn: 1, call: 1 }, reply: (r) => r.text('a') }],
    });
    await scripted.run(turnRequest(), SIGNAL());
    expect(scripted.calls).toHaveLength(1);
  });
});

describe('CassetteModel', () => {
  it('replays a recorded reply by hash', async () => {
    const request = turnRequest();
    const hash = await hashTurnRequest(request);
    const cassette = new CassetteModel({
      ...base(),
      entries: [{ hash, note: 'chat/turn.reply', reply: replyText('from the cassette') }],
    });
    expect((await cassette.run(request, SIGNAL())).text).toBe('from the cassette');
  });

  it('fails on a miss, which is what strict mode means', async () => {
    const cassette = new CassetteModel({ ...base(), entries: [] });
    await expect(cassette.run(turnRequest(), SIGNAL())).rejects.toBeInstanceOf(CassetteMiss);
  });

  it('names the hash in the miss, which is what a re-record needs', async () => {
    const cassette = new CassetteModel({ ...base(), entries: [] });
    const hash = await hashTurnRequest(turnRequest());
    await expect(cassette.run(turnRequest(), SIGNAL())).rejects.toThrow(hash);
  });

  it('misses when the prompt changed, which is the design and not a bug', async () => {
    const request = turnRequest();
    const cassette = new CassetteModel({
      ...base(),
      entries: [{ hash: await hashTurnRequest(request), reply: replyText('recorded') }],
    });
    // A charter edit changes the system prompt, which changes the hash. `11` §3.2.4 is explicit
    // that this is by design — and it is why the PR-tier suites use `ScriptedModel`.
    const edited = turnRequest({ system: [{ id: 'charter', text: 'a new charter' }] });
    await expect(cassette.run(edited, SIGNAL())).rejects.toBeInstanceOf(CassetteMiss);
  });

  it('records its misses for the message a re-record prints', async () => {
    const cassette = new CassetteModel({ ...base(), entries: [], strict: false });
    await cassette.run(turnRequest(), SIGNAL());
    expect(cassette.misses()).toHaveLength(1);
  });
});

describe('scrubbing (05 §3.5.7, 08 §3.16)', () => {
  it('replaces names with personas, deterministically', () => {
    const once = scrubText('Maria asked Diego about the recital');
    const twice = scrubText('Maria asked Diego about the recital');
    // Stable, or a two-turn conversation stops being a conversation.
    expect(once).toBe(twice);
    expect(once).not.toContain('Maria');
    expect(once).not.toContain('Diego');
  });

  it('keeps the shape of the text, because a fixture of [REDACTED] tests nothing', () => {
    const scrubbed = scrubText('Maria asked about the recital on 2026-11-14 at 18:30');
    expect(scrubbed).toContain('asked about the recital on');
    // A date still parses as a date and a time still reads as a time.
    expect(scrubbed).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('replaces an email with a persona at an unroutable domain', () => {
    const scrubbed = scrubText('write to maria.lopez@example.com please');
    expect(scrubbed).not.toContain('maria.lopez');
    expect(scrubbed).toContain('@example.invalid');
  });

  it('replaces a token outright, because a token has no useful shape', () => {
    expect(scrubText('key sk-ant-abc123def456 here')).toContain('<token>');
    expect(scrubText('Authorization: Bearer abcdef123456')).toContain('<token>');
    expect(scrubText('key sk-ant-abc123def456 here')).not.toContain('abc123def456');
  });

  it('shuffles digit runs rather than deleting them', () => {
    const scrubbed = scrubText('call 555 0199 about it');
    expect(scrubbed).not.toContain('555');
    expect(scrubbed).toMatch(/\d{3} \d{4}/);
  });

  it('walks a nested value, leaving the structure intact', () => {
    const scrubbed = scrubDeep({
      messages: [{ text: 'Maria is late', count: 3 }],
      flag: true,
      nothing: null,
    });
    expect(scrubbed).toMatchObject({ flag: true, nothing: null });
    expect(JSON.stringify(scrubbed)).not.toContain('Maria');
    // Numbers are not strings: a count stays a count.
    expect((scrubbed as { messages: { count: number }[] }).messages[0]?.count).toBe(3);
  });
});

describe('RecordingGateway', () => {
  function recordingHarness(): {
    readonly recorder: RecordingGateway;
    readonly written: Map<string, string>;
  } {
    const written = new Map<string, string>();
    const inner = new FakeModelGateway(base());
    inner.when({ route: 'chat' }).respond((r) => r.text('Maria will be at the recital'));
    const recorder = new RecordingGateway({
      inner,
      provider: 'anthropic',
      write: (path, contents) => {
        written.set(path, contents);
        return Promise.resolve();
      },
    });
    return { recorder, written };
  }

  it('delegates unchanged and returns the real result', async () => {
    const { recorder } = recordingHarness();
    const result = await recorder.run(turnRequest(), SIGNAL());
    // The *recording* is scrubbed; the result the caller sees is not, or the eval would be
    // measuring a scrubbed conversation.
    expect(result.text).toBe('Maria will be at the recital');
  });

  it('writes one scrubbed fixture per call, keyed by the request hash', async () => {
    const { recorder, written } = recordingHarness();
    const request = turnRequest();
    await recorder.run(request, SIGNAL());
    const hash = await hashTurnRequest(request);
    expect([...written.keys()]).toEqual([`anthropic/chat/${hash}.json`]);
    const contents = written.get(`anthropic/chat/${hash}.json`) ?? '';
    expect(contents).not.toContain('Maria');
    expect(contents).toContain('recital');
  });

  it('keeps what it recorded, for an assertion after the run', async () => {
    const { recorder } = recordingHarness();
    await recorder.run(turnRequest(), SIGNAL());
    const [exchange] = recorder.recorded();
    expect(exchange?.provider).toBe('anthropic');
    expect(exchange?.route).toBe('chat');
    expect(exchange?.response.stop).toBe('end_turn');
    expect(JSON.stringify(exchange)).not.toContain('Maria');
  });

  it('answers routeInfo and embed through the wrapped gateway', async () => {
    const { recorder } = recordingHarness();
    expect(recorder.routeInfo('chat')).toMatchObject({ model: OPUS });
    expect((await recorder.embed(['x'], 'query'))[0]).toBeInstanceOf(Float32Array);
  });
});
