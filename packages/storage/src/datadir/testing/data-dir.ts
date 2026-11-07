/**
 * A real, throwaway data directory for one test.
 *
 * A scope guard for the same reasons as `crypto/testing/keys-dir.ts`: the lifetime is visible at
 * the use site, the directory is removed on the failure path, and `scripts/hygiene/check.ts`
 * refuses the module-level `let` the alternative needs.
 *
 * The directory is **created but left empty** — `createLayout` is usually the thing under test, and
 * a helper that pre-created the layout would make every "does it create the layout correctly" test
 * vacuous.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import type { LockEnvironment } from '../lock.js';

export async function withDataDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `${BRAND.slug}-datadir-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export interface FakeEnvironmentOptions {
  readonly pid?: number;
  readonly hostname?: string;
  readonly bootId?: string;
  readonly version?: string;
  readonly now?: Date;
  /** PIDs this fake considers alive. Everything else is dead. */
  readonly alive?: readonly number[];
}

/**
 * A `LockEnvironment` with a clock a test drives by hand.
 *
 * `12` §3.7's acceptance criterion is "lock heartbeat and stale takeover tested with a fake clock",
 * and the reason is arithmetic: the stale threshold is 60 seconds, so a real-clock test of takeover
 * would take over a minute and would be the flakiest test in the suite.
 */
export interface FakeLockEnvironment extends LockEnvironment {
  /** Move the clock forward. */
  advance(ms: number): void;
  /** Change which PIDs are alive, for the "the holder just died" case. */
  kill(pid: number): void;
  revive(pid: number): void;
}

export function fakeEnvironment(options: FakeEnvironmentOptions = {}): FakeLockEnvironment {
  let at = (options.now ?? new Date('2026-11-06T09:00:00.000Z')).getTime();
  const alive = new Set(options.alive ?? [options.pid ?? 4242]);

  return {
    pid: options.pid ?? 4242,
    hostname: options.hostname ?? 'test-host',
    bootId: options.bootId ?? 'boot-1',
    version: options.version ?? '0.1.0',
    now: () => new Date(at),
    isAlive: (pid: number) => alive.has(pid),
    advance(ms: number) {
      at += ms;
    },
    kill(pid: number) {
      alive.delete(pid);
    },
    revive(pid: number) {
      alive.add(pid);
    },
  };
}
