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
import { REDACT_PATHS } from './redact.js';

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

/**
 * `['config', 'security', '*']` with a canary becomes `{config: {security: {anySegment: canary}}}`.
 *
 * `*` is replaced by one concrete segment, because pino's `*` matches exactly one — so a payload
 * built this way sits at precisely the depth the path claims to cover, which is the thing being
 * tested.
 */
function nest(segments: readonly string[], canary: string): Record<string, unknown> {
  const [head = 'x', ...rest] = segments;
  const key = head === '*' ? 'anySegment' : head;
  return { [key]: rest.length === 0 ? canary : nest(rest, canary) };
}

describe('redaction', () => {
  it('removes every path it lists, so no path is dead', () => {
    // 68 entries, two of which were proven effective. The module's own docstring says "a path that
    // does not match is a path that does nothing", and nothing iterated the list — so a typo, a
    // wrong `*.` prefix, or a pino version that changed its matching would have left a content or
    // credential field flowing into the log with the suite green. Found by the M1 independent
    // review; `config/host-only.test.ts` already had this shape ("protects at least one real leaf
    // for every pattern, so no pattern is dead") and is the model.
    //
    // Each path gets a canary at the depth it claims to cover: a bare name at the root, a
    // `*.`-prefixed one under a single wrapper segment. That distinction is the whole reason the
    // list is doubled, and it is the most likely mistake — pino's `*` matches exactly one segment,
    // so `*.text` does not match a root-level `text`.
    const survivors: string[] = [];
    for (const [index, path] of REDACT_PATHS.entries()) {
      const canary = `REDACTION-CANARY-${String(index)}-${path.replace(/[^a-z]/gi, '')}`;
      const { sink, out } = capture();
      const log = createLogger({ destination: sink });

      // Built from the path generically rather than by special-casing `*.`: the list holds
      // `headers.*`, `req.headers` and `config.security.*` too, and a builder that only understood
      // a bare name and a `*.` prefix reported eleven of them as dead when they are not. `*`
      // becomes one concrete segment, since that is exactly what pino's `*` matches.
      log.info('server.ready', nest(path.split('.'), canary) as never);

      if (out.raw.join('\n').includes(canary)) survivors.push(path);
    }
    expect(
      survivors,
      'these redact paths did not remove a value placed at the depth they name. A path that does ' +
        'not match is a path that does nothing.',
    ).toEqual([]);
  });

  it('is a list of real size, so the loop above is not empty', () => {
    // `for…of` over an empty array runs no iterations and leaves `survivors` empty, which would
    // make the assertion above pass over nothing.
    expect(REDACT_PATHS.length).toBe(68);
    // Both spellings of the doubling are present, which is the property the loop relies on.
    expect(REDACT_PATHS).toContain('text');
    expect(REDACT_PATHS).toContain('*.text');
  });

  it('would notice a path that stopped working', () => {
    // The control: a key that is **not** in the list survives. Without it, a logger that dropped
    // every field would pass the loop above for the wrong reason.
    const { sink, out } = capture();
    createLogger({ destination: sink }).info('server.ready', {
      notARedactedPath: 'REDACTION-CONTROL',
    } as never);
    expect(out.raw.join('\n')).toContain('REDACTION-CONTROL');
    expect(REDACT_PATHS).not.toContain('notARedactedPath');
  });

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
    // Only the canaries that **could** have reached the output. The content gate is closed on this
    // logger, so `log.content()` wrote nothing at all — which made `CANARYCONTENT`, `recital` and
    // `the recital is a surprise` unable to appear under any implementation. Three of the five
    // canaries in a test named "no content survives to the output" were therefore asserting
    // nothing, and the two that mattered were the secret ones. Found by the M1 independent review.
    //
    // The content half is the test below, with the gate **open**, which is the only arrangement
    // where content exists to leak.
    for (const canary of ['CANARYTOKEN', TELEGRAM_CANARY]) {
      expect(serialised, `${canary} reached the log`).not.toContain(canary);
    }
    // And the content call really did write nothing, so the omission above is the gate working
    // rather than the canaries being mis-spelled.
    expect(out.lines.some((line) => line['content'] === true)).toBe(false);
  });

  it('keeps content off every line above debug, with the gate open', () => {
    // `CLAUDE.md` §2: "Logs never contain message or memory content above `debug`." With the gate
    // **open** the content exists, so this is the arrangement where a leak is possible — and the
    // claim is about *which lines* carry it, not whether it is written at all.
    const { sink, out } = capture();
    const log = createLogger({
      level: 'trace',
      destination: sink,
      debugContent: true,
      instanceId: 'inst_01j8',
    });
    const child = log.child({ component: 'engine.turn', groupId: 'grp_01j8' });

    const CONTENT = 'CANARYCONTENT the recital is a surprise';
    log.content('debug.content', { text: CONTENT });
    // Ordinary lines at every level above debug, interleaved, each carrying the kind of payload a
    // turn produces.
    child.info('server.ready', { turnId: 'turn_01j8', durationMs: 1240 });
    child.warn('config.host_only_rejected', { detail: { path: 'network.egress.allowPrivate' } });
    child.error('config.invalid', { err: toLoggedError(new Error('upstream refused')) });
    log.content('debug.content', { text: CONTENT });

    // The content is present — otherwise everything below passes vacuously, which is exactly how
    // the previous version of this test went wrong.
    expect(out.raw.join('\n'), 'the gate is open, so content must be in the output').toContain(
      'CANARYCONTENT',
    );

    const above = out.lines.filter(
      (line) => line['level'] !== 'debug' && line['level'] !== 'trace',
    );
    expect(above.length, 'no lines above debug to check').toBeGreaterThan(2);
    for (const line of above) {
      const serialised = JSON.stringify(line);
      for (const canary of ['CANARYCONTENT', 'recital', 'the recital is a surprise']) {
        expect(serialised, `${canary} reached a ${String(line['level'])} line`).not.toContain(
          canary,
        );
      }
    }
    // Every line that does carry it is marked, so a reader can filter content out by one field.
    for (const line of out.lines) {
      if (JSON.stringify(line).includes('CANARYCONTENT')) {
        expect(line['content']).toBe(true);
        expect(line['level']).toBe('debug');
      }
    }
    // And none of it reached the ring buffer, which `doctor --bundle` pastes into issues.
    expect(JSON.stringify(log.ringBuffer.toArray())).not.toContain('CANARYCONTENT');
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
