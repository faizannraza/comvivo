/**
 * The action-kind registry (`06` §3.7 "Action kinds"; `M3-T6`).
 *
 * The AC is one line — "the action-kind registry rejects unknown kinds" — and the interesting part
 * is the word *rejects*. There are four ways to get a kind wrong and only one of them is a
 * misspelling:
 *
 * | What arrived | Why | What must happen |
 * |---|---|---|
 * | A kind nobody registered | A downgrade, a removed plugin, a closed flag | `unknown_kind` → "expired" |
 * | A kind no `actionKind` could have produced | A tampered or corrupt row | `unknown_kind`, with no map lookup |
 * | Params that no longer validate | The owner's schema changed under the row | `invalid_params`, never run |
 * | A kind two owners claim | A composition bug | the process does not start |
 *
 * The last one is the only `throw`, and it is deliberately not recoverable: a click would run
 * whichever handler won a module-evaluation race, with the clicker's authority, against somebody
 * else's action.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ACTION_KIND_MAX_CHARS,
  ACTION_KIND_PATTERN,
  ActionKindRegistry,
  actionKind,
} from './registry.js';

const confirm = actionKind(
  'confirm',
  z.strictObject({ confirmationId: z.string().min(1), option: z.enum(['approve', 'reject']) }),
);
const undo = actionKind('cmd.undo', z.strictObject({ effectId: z.string().min(1) }));

const populated = () => new ActionKindRegistry().register(confirm).register(undo);

describe('actionKind', () => {
  it('accepts the shapes 06 §3.7 lists', () => {
    for (const kind of [
      'confirm',
      'rsvp',
      'cmd.undo',
      'reminder.snooze',
      'plan.step.confirm',
      'poll.vote',
      'setup.template',
      'link.confirm',
      'proactive.feedback',
    ]) {
      expect(actionKind(kind, z.unknown()).kind, kind).toBe(kind);
    }
  });

  it('refuses a name that would break a metric label or a prefix query', () => {
    // `action.kind` is a `TEXT` column in `02`'s `interaction_tokens`, a `11` §3.1.6 metric label
    // and a namespace. A colon would collide with `02` §3.3.8's scope-key delimiter; a space or an
    // uppercase letter would make two distinct kinds look like one in a dashboard.
    for (const bad of [
      '',
      'Confirm',
      'cmd undo',
      'cmd:undo',
      'cmd.',
      '.cmd',
      'cmd..undo',
      '1cmd',
      'cmd-undo',
      'cmd.Undo',
      'cmd/undo',
    ]) {
      expect(() => actionKind(bad, z.unknown()), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it('refuses a name longer than the label bound', () => {
    expect(() => actionKind('a'.repeat(ACTION_KIND_MAX_CHARS + 1), z.unknown())).toThrow(
      RangeError,
    );
    expect(actionKind('a'.repeat(ACTION_KIND_MAX_CHARS), z.unknown()).kind).toHaveLength(
      ACTION_KIND_MAX_CHARS,
    );
  });

  it('exports a pattern that agrees with what it accepts', () => {
    expect(ACTION_KIND_PATTERN.test('plan.step.claim')).toBe(true);
    expect(ACTION_KIND_PATTERN.test('plan.step.claim ')).toBe(false);
  });
});

describe('register', () => {
  it('starts empty, because the SDK owns none of the kinds', () => {
    // `06` §3.7 assigns every kind to `05`, `07`, `06`'s engine flows or another owner, and each
    // registers at composition time. A registry seeded here would be a guess at params nobody has
    // designed — the template picker is `M4-T1` — that read like a contract.
    expect(new ActionKindRegistry().kinds()).toEqual([]);
  });

  it('lists what it holds, sorted', () => {
    expect(populated().kinds()).toEqual(['cmd.undo', 'confirm']);
  });

  it('refuses a second owner for one kind', () => {
    const registry = populated();
    expect(() => registry.register(actionKind('confirm', z.unknown()))).toThrow(TypeError);
    // And the first registration survives, so a caught throw cannot leave a half-replaced kind.
    expect(
      registry.resolve({ kind: 'confirm', params: { confirmationId: 'c', option: 'approve' } }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a malformed name written as an object literal', () => {
    // `ActionKind` is an interface, so the factory can be skipped. Checking the name here is what
    // makes the check observable at all — see `resolve`'s comment.
    const registry = new ActionKindRegistry();
    expect(() => registry.register({ kind: 'CONFIRM', params: z.unknown() })).toThrow(TypeError);
    expect(() => registry.register({ kind: 'cmd:undo', params: z.unknown() })).toThrow(TypeError);
    expect(() => registry.register({ kind: 'a'.repeat(200), params: z.unknown() })).toThrow(
      RangeError,
    );
    expect(registry.kinds()).toEqual([]);
  });

  it('is per instance, so one test cannot leak a kind into the next', () => {
    expect(new ActionKindRegistry().has('confirm')).toBe(false);
    expect(populated().has('confirm')).toBe(true);
  });
});

describe('resolve', () => {
  it('returns the parsed params for a registered kind', () => {
    const result = populated().resolve({
      kind: 'confirm',
      params: { confirmationId: 'cnf_1', option: 'reject' },
    });
    expect(result).toEqual({
      ok: true,
      kind: 'confirm',
      params: { confirmationId: 'cnf_1', option: 'reject' },
    });
  });

  it('rejects an unknown kind, which 06 §3.7 step 6 answers as expired', () => {
    for (const kind of ['rsvp', 'setup.template', 'cmd.redo', '']) {
      expect(populated().resolve({ kind, params: {} }), kind).toEqual({
        ok: false,
        kind,
        reason: 'unknown_kind',
      });
    }
  });

  it('rejects a malformed kind without reaching the map', () => {
    // A tampered or corrupt row. `unknown_kind` rather than a throw: the row is real and the click
    // is honest, and `06` §3.7 owes the member an answer rather than a 500.
    for (const kind of ['CONFIRM', 'confirm;drop table', '../confirm', 'confirm '])
      expect(populated().resolve({ kind, params: {} }), kind).toMatchObject({
        reason: 'unknown_kind',
      });
  });

  it('rejects params the owner’s schema no longer accepts', () => {
    // The row was written by a previous build. `CLAUDE.md` §2 — "validate every boundary … JSON
    // columns" — and the other side of this boundary is the past.
    for (const params of [
      {},
      { confirmationId: 'cnf_1' },
      { confirmationId: 'cnf_1', option: 'approve_always' },
      { confirmationId: '', option: 'approve' },
      { confirmationId: 'cnf_1', option: 'approve', extra: 1 },
      null,
      'approve',
    ]) {
      expect(populated().resolve({ kind: 'confirm', params }), JSON.stringify(params)).toEqual({
        ok: false,
        kind: 'confirm',
        reason: 'invalid_params',
      });
    }
  });

  it('distinguishes an unknown kind from bad params, because the engine logs them differently', () => {
    // Same member-facing copy, different operator signal: a stream of `invalid_params` for one
    // kind is a schema change that broke live rows, and that is worth an alert. Collapsing the two
    // would hide it.
    const registry = populated();
    expect(registry.resolve({ kind: 'nope', params: {} })).toMatchObject({
      reason: 'unknown_kind',
    });
    expect(registry.resolve({ kind: 'confirm', params: {} })).toMatchObject({
      reason: 'invalid_params',
    });
  });

  it('applies each kind’s own schema and not the first one registered', () => {
    const registry = populated();
    expect(registry.resolve({ kind: 'cmd.undo', params: { effectId: 'eff_1' } })).toMatchObject({
      ok: true,
    });
    expect(
      registry.resolve({ kind: 'cmd.undo', params: { confirmationId: 'c', option: 'approve' } }),
    ).toMatchObject({ reason: 'invalid_params' });
  });
});
