/**
 * Typed errors (`01` §11.6). The properties that matter downstream: `code` is stable, `cause` is
 * preserved so a stack is never lost, `userMessage` stays separate from the log message, and
 * `instanceof` works for every subclass.
 */
import { describe, expect, it } from 'vitest';
import {
  AppError,
  BugError,
  ConfigError,
  IoError,
  isAppError,
  TimeoutError,
  toAppError,
  ValidationError,
} from './errors.js';

describe('AppError', () => {
  it('carries a stable code and a name that matches the subclass', () => {
    const error = new ConfigError('bad port', { path: 'dashboard.port' });
    expect(error.code).toBe('config.invalid');
    expect(error.name).toBe('ConfigError');
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
  });

  it('keeps the user-facing message separate from the log message', () => {
    // Collapsing these gives you either a stack trace in a family group chat or a useless
    // "something went wrong" in the log. Both are failures of `00` §3.
    const error = new ConfigError('ENOENT: /data/keys/master.key', {
      userMessage: 'I could not find my encryption key.',
    });
    expect(error.message).toContain('ENOENT');
    expect(error.userMessage).toBe('I could not find my encryption key.');
  });

  it('preserves the original error as cause, so no stack is lost', () => {
    const cause = new Error('underlying');
    expect(new IoError('wrapped', { cause }).cause).toBe(cause);
  });

  it('leaves userMessage undefined when there is nothing useful to say', () => {
    expect(new IoError('EPIPE').userMessage).toBeUndefined();
  });
});

describe('BugError', () => {
  it('is for broken invariants, and says nothing revealing to the user', () => {
    const error = new BugError('label join produced an empty reader set');
    expect(error.code).toBe('bug');
    expect(error.message).toContain('label join');
    expect(error.userMessage).toBe('Something went wrong on my side. Nothing was changed.');
  });

  it('reassures the user that nothing changed, because for a bug that is the first question', () => {
    expect(new BugError('x').userMessage).toMatch(/Nothing was changed/);
  });
});

describe('ValidationError', () => {
  it('carries per-field issues so a fix-it message can list them', () => {
    const error = new ValidationError('2 problems', [
      { path: 'dashboard.port', message: 'too big' },
      { path: 'privacy.messageRetentionDays', message: 'must be positive' },
    ]);
    expect(error.issues).toHaveLength(2);
    expect(error.issues[0]?.path).toBe('dashboard.port');
  });
});

describe('ConfigError', () => {
  it('names the path at fault', () => {
    expect(new ConfigError('x', { path: 'network.egress.allowPrivate' }).path).toBe(
      'network.egress.allowPrivate',
    );
  });

  it('accepts a more specific code', () => {
    expect(new ConfigError('x', { code: 'config.secret_missing' }).code).toBe(
      'config.secret_missing',
    );
  });
});

describe('TimeoutError', () => {
  it('records how long it waited, in the message detail and as a field', () => {
    const error = new TimeoutError('turn deadline exceeded', 60_000);
    expect(error.afterMs).toBe(60_000);
    expect(error.detail).toEqual({ afterMs: 60_000 });
  });
});

describe('toAppError', () => {
  it('passes our own errors through untouched', () => {
    const original = new BugError('x');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps a foreign Error, keeping it as the cause', () => {
    const cause = new TypeError('not a function');
    const wrapped = toAppError(cause, 'while rendering');
    expect(wrapped).toBeInstanceOf(IoError);
    expect(wrapped.message).toBe('while rendering: not a function');
    expect(wrapped.cause).toBe(cause);
  });

  it('wraps a thrown non-Error, which libraries still do', () => {
    const wrapped = toAppError('a bare string', 'while parsing');
    expect(wrapped.message).toBe('while parsing: a bare string');
    expect(wrapped.cause).toBe('a bare string');
  });

  it('works without context', () => {
    expect(toAppError(new Error('x')).message).toBe('x');
  });
});

describe('isAppError', () => {
  it('distinguishes ours from anything else', () => {
    expect(isAppError(new BugError('x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError('x')).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
