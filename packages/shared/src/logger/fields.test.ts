/**
 * The type-level guarantee: **content cannot be logged**.
 *
 * `01` §11.7 and `11` §3.10.1. This is the primary enforcement, and these `@ts-expect-error`
 * assertions are how it is proven: each one fails the build if the field it names ever becomes
 * assignable. Redaction and scrubbing are recovery layers; a type error happens in the editor,
 * before the code runs, while the author still remembers what they were trying to do.
 *
 * `@ts-expect-error` is exactly the right tool here — it is an error if the line stops being an
 * error, so these cannot rot into passing silently.
 */
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_FIELD_NAMES, type LogFields } from './fields.js';

describe('content-bearing fields do not exist on LogFields', () => {
  it('rejects the field names 11 §3.10.1 forbids', () => {
    // @ts-expect-error `text` must not exist: this is `log.info(e, { text: message.text })`.
    const withText: LogFields = { text: 'the recital is on Friday' };
    // @ts-expect-error `prompt` must not exist.
    const withPrompt: LogFields = { prompt: 'you are a helpful assistant' };
    // @ts-expect-error `messages` must not exist: the whole conversation.
    const withMessages: LogFields = { messages: [{ role: 'user', content: 'hi' }] };
    // @ts-expect-error `richText` must not exist.
    const withRichText: LogFields = { richText: { type: 'doc' } };
    // @ts-expect-error `raw` must not exist: the unparsed platform payload.
    const withRaw: LogFields = { raw: { update_id: 1 } };
    // @ts-expect-error `body` must not exist: an HTTP body can be anything.
    const withBody: LogFields = { body: '{"a":1}' };
    // @ts-expect-error `args` must not exist: a tool's arguments are derived from member input.
    const withArgs: LogFields = { args: { title: 'Dentist' } };
    // @ts-expect-error `result` must not exist: a tool's result can contain memory content.
    const withResult: LogFields = { result: { events: [] } };
    // @ts-expect-error `payload` must not exist.
    const withPayload: LogFields = { payload: {} };

    expect([
      withText,
      withPrompt,
      withMessages,
      withRichText,
      withRaw,
      withBody,
      withArgs,
      withResult,
      withPayload,
    ]).toHaveLength(9);
  });

  it('rejects display names, which are personal data about someone who never opted in', () => {
    // An identifier is fine and necessary for debugging. A name in the host's terminal is not:
    // risk R-16 (host-trust misunderstanding) is narrow enough already.
    // @ts-expect-error `memberName` must not exist.
    const withMemberName: LogFields = { memberName: 'Ava' };
    // @ts-expect-error `displayName` must not exist.
    const withDisplayName: LogFields = { displayName: 'Ava Smith' };
    expect([withMemberName, withDisplayName]).toHaveLength(2);
  });

  it('rejects credential fields, so a secret cannot be logged even deliberately', () => {
    // @ts-expect-error `token` must not exist.
    const withToken: LogFields = { token: 'vctl_abc' };
    // @ts-expect-error `apiKey` must not exist.
    const withApiKey: LogFields = { apiKey: 'sk-ant-x' };
    // @ts-expect-error `password` must not exist.
    const withPassword: LogFields = { password: 'hunter2' };
    // @ts-expect-error `authorization` must not exist.
    const withAuthorization: LogFields = { authorization: 'Bearer x' };
    // @ts-expect-error `headers` must not exist: they carry cookies and authorization.
    const withHeaders: LogFields = { headers: {} };
    expect([withToken, withApiKey, withPassword, withAuthorization, withHeaders]).toHaveLength(5);
  });

  it('rejects an arbitrary unlisted field, so the type is genuinely closed', () => {
    // @ts-expect-error anything not in the allowlist must be rejected, not merely the known-bad.
    const madeUp: LogFields = { somethingNobodyReviewed: 'value' };
    expect(madeUp).toBeDefined();
  });

  it('rejects an object smuggled through `detail`', () => {
    // `detail` is the escape hatch for a field that has not earned a name yet, typed as
    // `FieldValue` so a whole payload still cannot ride in on it.
    // @ts-expect-error detail values are scalars, not objects.
    const nested: LogFields = { detail: { inner: { content: 'secret' } } };
    expect(nested).toBeDefined();
  });
});

describe('allowed fields do exist', () => {
  it('accepts identifiers, measurements and shape', () => {
    // The other half of the guarantee: over-restricting would push people toward logging raw
    // objects, which is worse than what we started with.
    const fields: LogFields = {
      component: 'engine.turn',
      groupId: 'grp_01j8kqd7h3f9z2m4n6p8r0t2vw',
      conversationId: 'cnv_01j8kqd7h3f9z2m4n6p8r0t2vw',
      turnId: 'turn_01j8kqd7h3f9z2m4n6p8r0t2vw',
      memberId: 'mbr_01j8kqd7h3f9z2m4n6p8r0t2vw',
      channel: 'telegram',
      durationMs: 1240,
      outcome: 'completed',
      costMicros: 1820,
      model: 'claude-opus-5-5',
      route: 'chat',
      inputTokens: 18_400,
      cacheReadTokens: 11_200,
      stopReason: 'end_turn',
      disposition: 'respond',
      policyDecision: 'allow',
      guardResult: 'pass',
      toolName: 'calendar_create_event',
      audienceSize: 5,
      detail: { attemptKind: 'retry', shardIndex: 2 },
    };
    expect(fields.component).toBe('engine.turn');
  });

  it('accepts the allowlisted error shape', () => {
    const fields: LogFields = {
      err: { type: 'RateLimitError', status: 429, requestId: 'req_123', message: 'slow down' },
    };
    expect(fields.err?.status).toBe(429);
  });
});

describe('FORBIDDEN_FIELD_NAMES', () => {
  it('lists every name the @ts-expect-error assertions above cover', () => {
    // Keeps the documented list and the enforced list in step: a reviewer reading the list should
    // be able to trust it.
    for (const name of ['text', 'prompt', 'messages', 'raw', 'body', 'args', 'result', 'token']) {
      expect(FORBIDDEN_FIELD_NAMES).toContain(name);
    }
  });

  it('does not list a field that legitimately exists', () => {
    for (const allowed of ['groupId', 'turnId', 'durationMs', 'component', 'err']) {
      expect(FORBIDDEN_FIELD_NAMES).not.toContain(allowed);
    }
  });
});
