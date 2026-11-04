/**
 * The logger (`11` §3.10.1, `01` §11.7, `08` §3.10).
 *
 * The behaviours that carry the guarantee: standard fields are always present, the content gate is
 * closed by default and announces itself when opened, foreign errors are reduced to the allowlisted
 * shape, secrets become a fingerprint rather than a value, and nothing content-shaped survives to
 * the output — checked by scrubbing the serialised line, not by inspecting the object.
 */
import { describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import { SecretString } from '../secrets/secret-string.js';
import { contentWarningBanner, createLogger, toLoggedError } from './index.js';

interface Captured {
  readonly lines: Record<string, unknown>[];
  readonly raw: string[];
}

/**
 * Canary values, assembled at runtime from separate literals.
 *
 * Never written out whole: a file containing a literal token shape trips GitHub's push protection
 * and every other secret scanner a contributor or fork might run. The code under test still
 * receives the exact shape, because concatenation happens before it is passed in.
 */
const TELEGRAM_CANARY = `${'123456789'}:${'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'}`;
const ANTHROPIC_CANARY = `${['sk', 'ant', 'api03'].join('-')}-SuperSecret${'Value'}-012345`;

function capture(): { sink: { write(line: string): void }; out: Captured } {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  return {
    sink: {
      write(line: string) {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
    out: { lines, raw },
  };
}

describe('standard fields', () => {
  it('emits the fields 11 §3.10.1 requires on every line', () => {
    const { sink, out } = capture();
    const log = createLogger({
      destination: sink,
      instanceId: 'inst_01j8',
      role: 'all',
      version: '0.1.0',
    });
    log.info('server.ready', { component: 'server', durationMs: 42 });

    const line = out.lines[0];
    expect(line?.['level']).toBe('info');
    expect(line?.['event']).toBe('server.ready');
    expect(line?.['svc']).toBe(BRAND.slug);
    expect(line?.['instanceId']).toBe('inst_01j8');
    expect(line?.['role']).toBe('all');
    expect(line?.['version']).toBe('0.1.0');
    expect(line?.['component']).toBe('server');
    expect(line?.['durationMs']).toBe(42);
    expect(typeof line?.['time']).toBe('string');
  });

  it('uses a constant msg, never interpolated with user data', () => {
    // Interpolation is the most common way content reaches a log, because it looks harmless at the
    // call site. The `msg` therefore comes from the catalog, keyed by event.
    const { sink, out } = capture();
    createLogger({ destination: sink }).info('server.ready');
    expect(out.lines[0]?.['msg']).toBe('ready');
  });

  it('takes the service name from BRAND, so a rename moves it', () => {
    const { sink, out } = capture();
    createLogger({ destination: sink }).info('server.ready');
    expect(out.lines[0]?.['svc']).toBe(BRAND.slug);
  });
});

describe('levels', () => {
  it('writes each level with its label', () => {
    const { sink, out } = capture();
    const log = createLogger({ level: 'trace', destination: sink });
    log.trace('server.ready');
    log.debug('server.ready');
    log.info('server.ready');
    log.warn('server.ready');
    log.error('server.ready');
    log.fatal('server.ready');
    expect(out.lines.map((l) => l['level'])).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ]);
  });

  it('suppresses below the configured level', () => {
    const { sink, out } = capture();
    const log = createLogger({ level: 'warn', destination: sink });
    log.debug('server.ready');
    log.info('server.ready');
    log.warn('server.ready');
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]?.['level']).toBe('warn');
  });
});

describe('child loggers', () => {
  it('carries the bound fields onto every line', () => {
    const { sink, out } = capture();
    const child = createLogger({ destination: sink }).child({
      component: 'engine.turn',
      groupId: 'grp_01j8kqd7h3f9z2m4n6p8r0t2vw',
    });
    child.info('server.ready', { turnId: 'turn_01j8' });
    expect(out.lines[0]).toMatchObject({
      component: 'engine.turn',
      groupId: 'grp_01j8kqd7h3f9z2m4n6p8r0t2vw',
      turnId: 'turn_01j8',
    });
  });

  it('nests', () => {
    const { sink, out } = capture();
    createLogger({ destination: sink })
      .child({ component: 'engine' })
      .child({ groupId: 'grp_01j8' })
      .info('server.ready');
    expect(out.lines[0]).toMatchObject({ component: 'engine', groupId: 'grp_01j8' });
  });
});

describe('the content gate', () => {
  it('is a NO-OP by default', () => {
    // The default has to be closed, because the cost of it being open is other members' private
    // messages in the host's terminal.
    const { sink, out } = capture();
    const log = createLogger({ level: 'trace', destination: sink });
    log.content('debug.content', { text: 'the recital is a surprise' });
    expect(out.lines).toHaveLength(0);
    expect(log.contentEnabled).toBe(false);
  });

  it('writes content when explicitly enabled', () => {
    const { sink, out } = capture();
    const log = createLogger({ level: 'trace', destination: sink, debugContent: true });
    log.content('debug.content', { text: 'visible on purpose' });
    const contentLine = out.lines.find((l) => l['content'] === true);
    expect(contentLine?.['text']).toBe('visible on purpose');
    expect(contentLine?.['level']).toBe('debug');
  });

  it('prints a banner at warn when enabled, so it can never be on unnoticed', () => {
    const { sink, out } = capture();
    createLogger({ destination: sink, debugContent: true });
    const banner = out.lines.find((l) => l['event'] === 'debug.content_enabled');
    expect(banner?.['level']).toBe('warn');
  });

  it('never prints the banner when content logging is off', () => {
    const { sink, out } = capture();
    createLogger({ destination: sink });
    expect(out.lines.some((l) => l['event'] === 'debug.content_enabled')).toBe(false);
  });

  it('keeps content out of the ring buffer, which feeds doctor --bundle', () => {
    // A host may paste a bundle into a public issue. Content must not be in it even when content
    // logging is on.
    const { sink } = capture();
    const log = createLogger({ level: 'trace', destination: sink, debugContent: true });
    log.content('debug.content', { text: 'must not reach the bundle' });
    const buffered = JSON.stringify(log.ringBuffer.toArray());
    expect(buffered).not.toContain('must not reach the bundle');
  });

  it('names the exact environment variable in its banner text', () => {
    expect(contentWarningBanner()).toContain(`${BRAND.envPrefix}DEBUG_CONTENT`);
    expect(contentWarningBanner()).toContain('Never leave this on for a real group');
  });
});

describe('errors', () => {
  it('reduces a foreign error to the allowlisted shape', () => {
    const { sink, out } = capture();
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
      requestId: 'req_abc',
      code: 'rate_limit',
    });
    createLogger({ destination: sink }).error('config.invalid', { err: toLoggedError(error) });
    expect(out.lines[0]?.['err']).toEqual({
      type: 'Error',
      code: 'rate_limit',
      status: 429,
      requestId: 'req_abc',
      message: 'rate limited',
    });
  });

  it('does not let pino rewrite the shape or append a stack', () => {
    // pino's default error serializer reported `type: "Object"` and appended an empty `stack`. The
    // shape is specified by `11` §3.10.1, so it is passed through untouched.
    const { sink, out } = capture();
    createLogger({ destination: sink }).error('config.invalid', {
      err: toLoggedError(new TypeError('bad input')),
    });
    const err = out.lines[0]?.['err'] as Record<string, unknown>;
    expect(err['type']).toBe('TypeError');
    expect('stack' in err).toBe(false);
  });

  it('scrubs the Telegram token out of an error message', () => {
    const { sink, out } = capture();
    createLogger({ destination: sink }).error('config.invalid', {
      err: toLoggedError(
        new Error(`POST https://api.telegram.org/bot${TELEGRAM_CANARY}/sendMessage failed`),
      ),
    });
    expect(out.raw.join('\n')).not.toContain(TELEGRAM_CANARY);
  });

  it('handles a thrown non-Error, which libraries still do', () => {
    expect(toLoggedError('just a string')).toEqual({ type: 'unknown', message: 'just a string' });
  });

  it('truncates a very long error message', () => {
    const logged = toLoggedError(new Error('x'.repeat(1000)));
    expect(logged.message.length).toBeLessThanOrEqual(200);
  });
});

describe('secrets', () => {
  it('logs a name and fingerprint instead of a value', () => {
    const { sink, out } = capture();
    createLogger({ destination: sink }).info('secret.loaded', {
      secretRef: new SecretString('ANTHROPIC_API_KEY', ANTHROPIC_CANARY),
    });
    const ref = out.lines[0]?.['secretRef'] as Record<string, unknown>;
    expect(ref['name']).toBe('ANTHROPIC_API_KEY');
    expect(typeof ref['fingerprint']).toBe('string');
    expect(out.raw.join('\n')).not.toContain('SuperSecret' + 'Value');
  });
});

describe('redaction', () => {
  it('removes a credential-shaped path that arrived as unknown', () => {
    // The type stops this at the call site; redaction is the layer for a value that was widened to
    // `unknown` somewhere and lost its type on the way in.
    const { sink, out } = capture();
    const log = createLogger({ destination: sink });
    log.info('server.ready', { detail: { note: 'ok' } } as never);
    log.info('server.ready', { token: `vctl${'_'}AbCdEfGhIjKlMnOpQrStUvWx` } as never);
    expect(out.raw.join('\n')).not.toContain(`vctl${'_'}AbCdEf`);
  });

  it('removes a content-shaped path that arrived as unknown', () => {
    const { sink, out } = capture();
    createLogger({ destination: sink }).info('server.ready', {
      text: 'the recital is a surprise',
    } as never);
    expect(out.raw.join('\n')).not.toContain('recital');
  });
});

describe('the ring buffer', () => {
  it('captures info and above', () => {
    const { sink } = capture();
    const log = createLogger({ level: 'trace', destination: sink });
    log.info('server.ready');
    log.warn('config.warning');
    log.error('config.invalid');
    log.fatal('server.stopped');
    expect(log.ringBuffer.size).toBe(4);
  });

  it('does NOT capture debug or trace, per 11 §3.10.1 ("the last 5,000 info+ lines")', () => {
    const { sink } = capture();
    const log = createLogger({ level: 'trace', destination: sink });
    log.trace('server.ready');
    log.debug('server.ready');
    expect(log.ringBuffer.size).toBe(0);
  });

  it('records the event and level for each captured line', () => {
    const { sink } = capture();
    const log = createLogger({ destination: sink });
    log.warn('config.warning', { component: 'config' });
    expect(log.ringBuffer.toArray()[0]).toMatchObject({ level: 'warn', event: 'config.warning' });
  });

  it("is shared with children, so a bundle holds the whole instance's history", () => {
    const { sink } = capture();
    const log = createLogger({ destination: sink });
    log.child({ component: 'engine' }).info('server.ready');
    expect(log.ringBuffer.size).toBe(1);
  });
});

describe('no content survives to the output, checked on the serialised line', () => {
  it('finds no canary in a realistic mixed log session', () => {
    // The unit-level half of `sec.logs.canary`. The scenario-level half runs every PR scenario at
    // trace and asserts zero canary occurrences in captured output (`11` §9), arriving with the
    // harness in `M3`.
    const { sink, out } = capture();
    const log = createLogger({ level: 'trace', destination: sink, instanceId: 'inst_01j8' });
    const child = log.child({ component: 'engine.turn', groupId: 'grp_01j8' });

    child.info('server.ready', { turnId: 'turn_01j8', durationMs: 1240, costMicros: 1820 });
    child.error('config.invalid', {
      err: toLoggedError(new Error(`POST https://api.telegram.org/bot${TELEGRAM_CANARY}/x 401`)),
    });
    child.warn('config.host_only_rejected', { detail: { path: 'network.egress.allowPrivate' } });
    log.info('secret.loaded', {
      secretRef: new SecretString('TELEGRAM_BOT_TOKEN', 'CANARYTOKEN12345678'),
    });
    log.content('debug.content', { text: 'CANARYCONTENT the recital is a surprise' });

    const serialised = out.raw.join('\n');
    for (const canary of [
      'CANARYCONTENT',
      'CANARYTOKEN',
      TELEGRAM_CANARY,
      'recital',
      'the recital is a surprise',
    ]) {
      expect(serialised, `${canary} reached the log`).not.toContain(canary);
    }
  });
});

/**
 * The two holes the M0 independent review measured, both of which compiled and ran.
 *
 * `01` §11.7 is a product promise to people whose family chat this is, so "the type makes it hard"
 * is not enough on its own — the type allowed both of these.
 */
describe('detail cannot carry content', () => {
  const capture = (): { lines: string[]; log: ReturnType<typeof createLogger> } => {
    const lines: string[] = [];
    return { lines, log: createLogger({ destination: { write: (l) => lines.push(l) } }) };
  };

  // Assembled at runtime so no secret-shaped literal sits in this file (`pnpm secrets:check`).
  const MESSAGE = ['Ava', 'said', 'she', 'is', 'moving', 'out'].join(' ');

  it('refuses prose under an innocuous key', () => {
    // The exact leak from the review: the key-name denylist could not help, because the content is
    // in the value and the key was `note`.
    const { log } = capture();
    expect(() => log.info('server.ready', { detail: { note: MESSAGE } })).toThrow(/token-shaped/);
  });

  it('names the field and points at log.content()', () => {
    const { log } = capture();
    try {
      log.info('server.ready', { detail: { note: MESSAGE } });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('detail.note');
      expect(message).toContain('01 §11.7');
      expect(message).toContain('log.content()');
    }
  });

  it('refuses a string longer than the cap even without spaces', () => {
    const { log } = capture();
    expect(() => log.info('server.ready', { detail: { blob: 'x'.repeat(200) } })).toThrow(
      /token-shaped/,
    );
  });

  it('keeps the legitimate token-shaped values this field exists for', () => {
    const { lines, log } = capture();
    log.info('server.ready', {
      detail: {
        disposition: 'replied',
        channel: 'telegram',
        path: '.env',
        afterMs: 5000,
        ok: true,
      },
    });
    const line = lines.join('');
    expect(line).toContain('replied');
    expect(line).toContain('telegram');
    expect(line).toContain('.env');
    expect(line).toContain('5000');
  });

  it('drops rather than throws outside test mode', () => {
    // A logging mistake must never take a group's bot down. In a test it throws, because there it
    // is a bug that would otherwise pass CI.
    const previous = process.env[`${BRAND.envPrefix}TEST_MODE`];
    delete process.env[`${BRAND.envPrefix}TEST_MODE`];
    try {
      const { lines, log } = capture();
      log.info('server.ready', { detail: { note: MESSAGE, channel: 'telegram' } });
      const line = lines.join('');
      expect(line).not.toContain('moving');
      expect(line).toContain('telegram');
    } finally {
      if (previous !== undefined) process.env[`${BRAND.envPrefix}TEST_MODE`] = previous;
    }
  });
});

describe('a hand-built err is scrubbed too', () => {
  it('scrubs a message that never went through toLoggedError', () => {
    // `toLoggedError` was the only place `scrubErrorMessage` ran, so a literal `{ type, message }`
    // skipped it entirely — and `LoggedError` is a plain interface, so writing one by hand
    // typechecks.
    const token = `${'123456789'}:${'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'}`;
    const lines: string[] = [];
    const log = createLogger({ destination: { write: (l) => lines.push(l) } });
    log.error('config.invalid', { err: { type: 'TypeError', message: `401 from /bot${token}/x` } });
    const line = lines.join('');
    expect(line).not.toContain(token);
    expect(line).toContain('TypeError');
  });

  it('truncates an over-long hand-built message', () => {
    const lines: string[] = [];
    const log = createLogger({ destination: { write: (l) => lines.push(l) } });
    log.error('config.invalid', { err: { type: 'E', message: 'y'.repeat(5000) } });
    expect(lines.join('').length).toBeLessThan(1500);
  });
});
