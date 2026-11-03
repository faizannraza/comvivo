/**
 * The event catalog (`11` §3.10.1).
 *
 * The event code — not the prose `msg` — is the grep and alert key, so these pin the two properties
 * an operator depends on: a code maps to a constant message, and that message is never built from
 * user data.
 */
import { describe, expect, it } from 'vitest';
import { isKnownEvent, LOG_EVENTS, messageFor } from './events.js';

describe('the catalog', () => {
  it('maps every event to a short constant message', () => {
    for (const [event, msg] of Object.entries(LOG_EVENTS)) {
      expect(msg, `${event} has no message`).toBeTruthy();
      // Short enough to read in a terminal next to the structured fields.
      expect(msg.length, `${event}'s message is too long`).toBeLessThanOrEqual(60);
    }
  });

  it('has no message containing an interpolation marker', () => {
    // Interpolation is the most common way content reaches a log, because it looks harmless at the
    // call site. A catalog entry with a placeholder would invite exactly that.
    for (const [event, msg] of Object.entries(LOG_EVENTS)) {
      expect(msg, `${event} looks interpolated`).not.toMatch(/\$\{|%s|%d|\{\}/);
    }
  });

  it('uses dotted lower-case codes, so an alert rule can match a prefix', () => {
    for (const event of Object.keys(LOG_EVENTS)) {
      expect(event).toMatch(/^[a-z][a-z0-9]*(?:\.[a-z0-9_]+)+$/);
    }
  });

  it('covers the lifecycle, configuration and secret events that exist today', () => {
    for (const event of [
      'server.starting',
      'server.ready',
      'server.stopping',
      'server.stopped',
      'config.loaded',
      'config.invalid',
      'config.host_only_rejected',
      'secret.loaded',
      'secret.missing',
      'debug.content_enabled',
    ]) {
      expect(Object.keys(LOG_EVENTS)).toContain(event);
    }
  });
});

describe('messageFor', () => {
  it('returns the catalog message', () => {
    expect(messageFor('server.ready')).toBe('ready');
    expect(messageFor('config.invalid')).toBe('configuration is not valid');
  });

  it('describes the host-only rejection as the security event it is', () => {
    expect(messageFor('config.host_only_rejected')).toContain('host-only');
  });

  it('makes content logging unmissable in its message', () => {
    expect(messageFor('debug.content_enabled')).toContain('ENABLED');
  });
});

describe('isKnownEvent', () => {
  it('accepts a catalogued code', () => {
    expect(isKnownEvent('server.ready')).toBe(true);
  });

  it('rejects an uncatalogued code, so a typo cannot become a silent new event', () => {
    expect(isKnownEvent('server.redy')).toBe(false);
    expect(isKnownEvent('')).toBe(false);
  });

  it('is not fooled by an inherited Object property', () => {
    // `'toString' in LOG_EVENTS` would be true with a naive check, and a logger that accepted
    // `toString` as an event would emit a line nobody could grep for.
    expect(isKnownEvent('toString')).toBe(false);
    expect(isKnownEvent('constructor')).toBe(false);
    expect(isKnownEvent('__proto__')).toBe(false);
  });
});
