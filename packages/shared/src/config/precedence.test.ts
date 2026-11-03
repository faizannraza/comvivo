/**
 * Configuration precedence (ADR-014) and the host-only exception (`01` §14 A14).
 *
 * The second of those is a security boundary. An admin who could set `network.egress.allowPrivate`
 * from the dashboard could point the instance at a host they control and exfiltrate another
 * member's data through a feature that looks legitimate in the audit log. So the DB value must be
 * **dropped and reported**, not merely overridden — and that is what these tests pin down.
 */
import { describe, expect, it } from 'vitest';
import { flatten, mergeByPrecedence, unflatten } from './precedence.js';

describe('flatten and unflatten', () => {
  it('round-trips a nested object', () => {
    const original = { a: { b: { c: 1 } }, d: 'x' };
    expect(unflatten(flatten(original))).toEqual(original);
  });

  it('treats an array as a leaf', () => {
    // A list is a value a host sets whole. Flattening into indices would make a deep merge union
    // two lists, so `allowPrivate: []` would stop being able to clear an inherited list.
    const flat = flatten({ network: { egress: { allowPrivate: ['a:1', 'b:2'] } } });
    expect(flat.get('network.egress.allowPrivate')).toEqual(['a:1', 'b:2']);
    expect([...flat.keys()]).toEqual(['network.egress.allowPrivate']);
  });

  it('keeps an empty object rather than losing it on the round trip', () => {
    expect(unflatten(flatten({ models: { routes: {} } }))).toEqual({ models: { routes: {} } });
  });

  it('keeps null, which is a meaningful value here', () => {
    // `publicUrl: null` means "no public URL", which is different from "not set".
    expect(flatten({ instance: { publicUrl: null } }).get('instance.publicUrl')).toBeNull();
  });

  it('handles an empty object', () => {
    expect([...flatten({}).keys()]).toEqual([]);
    expect(unflatten([])).toEqual({});
  });

  it('treats a bare scalar at the root as nothing to merge', () => {
    // Reached when a YAML file parses to a scalar. The loader rejects that shape separately with a
    // clear message, so flatten only has to not crash.
    expect([...flatten('not settings').keys()]).toEqual([]);
    expect([...flatten(42).keys()]).toEqual([]);
    expect([...flatten(null).keys()]).toEqual([]);
  });

  it('keeps a scalar when given a prefix, which is the recursive case', () => {
    expect(flatten('x', 'some.path').get('some.path')).toBe('x');
  });
});

describe('precedence order', () => {
  it('lets YAML beat nothing', () => {
    const { settings } = mergeByPrecedence({ yaml: { logging: { level: 'debug' } } });
    expect(settings).toEqual({ logging: { level: 'debug' } });
  });

  it('lets the database beat YAML for a group-owned key', () => {
    const { settings, origin } = mergeByPrecedence({
      yaml: { instance: { name: 'From the file' } },
      db: { instance: { name: 'Renamed in the dashboard' } },
    });
    expect(settings).toEqual({ instance: { name: 'Renamed in the dashboard' } });
    expect(origin.get('instance.name')).toBe('db');
  });

  it('lets the environment beat the database', () => {
    const { settings, origin } = mergeByPrecedence({
      yaml: { logging: { level: 'info' } },
      db: { logging: { level: 'warn' } },
      env: { logging: { level: 'debug' } },
    });
    expect(settings).toEqual({ logging: { level: 'debug' } });
    expect(origin.get('logging.level')).toBe('env');
  });

  it('merges distinct keys from every source rather than letting one replace another', () => {
    const { settings } = mergeByPrecedence({
      yaml: { instance: { name: 'A' } },
      db: { logging: { level: 'warn' } },
      env: { backups: { keep: 7 } },
    });
    expect(settings).toEqual({
      instance: { name: 'A' },
      logging: { level: 'warn' },
      backups: { keep: 7 },
    });
  });

  it('does not supply defaults, because the schema owns them', () => {
    // Exactly one place writes a default. If the merge had its own, the two would drift and a host
    // would get a value that appears in neither the file nor the documented default.
    expect(mergeByPrecedence({}).settings).toEqual({});
  });
});

describe('host-only keys from the database', () => {
  it('ignores a host-only key the database tried to set', () => {
    const { settings, rejectedHostOnlyFromDb } = mergeByPrecedence({
      db: { network: { egress: { allowPrivate: ['attacker.example:443'] } } },
    });
    expect(settings).toEqual({});
    expect(rejectedHostOnlyFromDb).toEqual(['network.egress.allowPrivate']);
  });

  it('does not let a database value override a host-only key set in YAML', () => {
    const { settings } = mergeByPrecedence({
      yaml: { privacy: { encryptAtRest: true } },
      db: { privacy: { encryptAtRest: false } },
    });
    expect(settings).toEqual({ privacy: { encryptAtRest: true } });
  });

  it('still accepts the same key from the environment, which is a host surface', () => {
    const { settings, origin } = mergeByPrecedence({
      db: { privacy: { encryptAtRest: false } },
      env: { privacy: { encryptAtRest: false } },
    });
    expect(settings).toEqual({ privacy: { encryptAtRest: false } });
    expect(origin.get('privacy.encryptAtRest')).toBe('env');
  });

  it('reports every rejection, sorted, so the API can answer 403 host_only', () => {
    const { rejectedHostOnlyFromDb } = mergeByPrecedence({
      db: {
        logging: { debugContent: true, level: 'debug' },
        plugins: { requireApproval: false },
        instance: { name: 'fine' },
      },
    });
    expect(rejectedHostOnlyFromDb).toEqual(['logging.debugContent', 'plugins.requireApproval']);
  });

  it('keeps the group-owned keys from the same database patch', () => {
    // A patch that mixes legitimate and protected keys must not be rejected wholesale: the group
    // still gets to rename itself.
    const { settings } = mergeByPrecedence({
      db: { logging: { debugContent: true, level: 'debug' }, instance: { name: 'ok' } },
    });
    expect(settings).toEqual({ logging: { level: 'debug' }, instance: { name: 'ok' } });
  });

  it('reports nothing when the database only touches what it may', () => {
    expect(
      mergeByPrecedence({ db: { instance: { name: 'x' }, logging: { level: 'warn' } } })
        .rejectedHostOnlyFromDb,
    ).toEqual([]);
  });
});
