/**
 * The instance lock (`12` §3.7, spine §8).
 *
 * Every test here is about one question: **can two processes end up writing to one data
 * directory?** Not "does the lock file get created" — that is incidental. Two writers would both
 * run the outbox and both own the turn journal, so the database would stay internally consistent
 * while the group received everything twice.
 *
 * The clock is fake, because `12` §3.7's acceptance criterion says so and the arithmetic forces
 * it: the stale threshold is sixty seconds, so a real-clock takeover test would take over a minute
 * and be the flakiest test in the suite. The liveness probe is fake for a stronger reason — a test
 * that killed real processes to check PID detection would be a test that can kill the wrong one.
 */
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  acquireLock,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  heartbeat,
  isStale,
  type LockFile,
  lockedError,
  lockPath,
  readLockHolder,
  releaseLock,
} from './lock.js';
import { fakeEnvironment, withDataDir } from './testing/data-dir.js';

/** The holder, as it is on disk. */
async function onDisk(root: string, role = 'main'): Promise<LockFile> {
  return JSON.parse(await readFile(lockPath(root, role), 'utf8')) as LockFile;
}

describe('two processes starting at once (C1)', { tags: ['slow'] }, () => {
  /**
   * The race the M1 exit gate's reviewer measured at **112 of 200** cold starts, reproduced.
   *
   * The old acquisition created the lock file with `O_CREAT|O_EXCL` and wrote its content
   * afterwards, so the loser of that race read an **empty** file, `readLock` reported unparseable
   * as absent, and the absent branch replaced it — deleting the winner's lock. Both processes then
   * opened the writer connection: two outboxes, two turn journals, every message sent twice.
   *
   * Every lock test in this file was sequential before this one, which is exactly why the defect
   * survived to the gate. `Promise.all` is the whole point of the test.
   */
  it('lets exactly one of two concurrent cold starts acquire it', async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await withDataDir(async (root) => {
        const first = fakeEnvironment({ pid: 101, hostname: 'alpha', alive: [101, 102] });
        const second = fakeEnvironment({ pid: 102, hostname: 'alpha', alive: [101, 102] });
        const [a, b] = await Promise.all([acquireLock(root, first), acquireLock(root, second)]);
        const winners = [a, b].filter((result) => result.acquired);
        expect(winners, `attempt ${String(attempt)}: ${JSON.stringify([a, b])}`).toHaveLength(1);
        // And the loser is told who holds it, with a parseable claim on disk — not an empty file
        // that the next process would treat as free.
        const held = await onDisk(root);
        expect([101, 102]).toContain(held.pid);
      });
    }
  });

  it('refuses a lock file it cannot parse until that file is old enough to be a corpse', async () => {
    await withDataDir(async (root) => {
      const environment = fakeEnvironment({ pid: 200 });
      // An acquire first, so `run/` exists — then the claim is corrupted in place. This is what a
      // reader saw mid-create before the content-first fix, and what a torn write would still look
      // like. Replacing it on sight is what made the race above a second writer, so a young one is
      // treated as a holder.
      await acquireLock(root, fakeEnvironment({ pid: 199, alive: [199] }));
      await writeFile(lockPath(root), '{"pid":1', 'utf8');
      const refused = await acquireLock(root, environment);
      expect(refused.acquired).toBe(false);

      // Once it is older than the stale window it is a corpse, and no human has to delete it —
      // which is the property the old unconditional replacement was protecting. Backdated with
      // `utimes` rather than by advancing the fake clock: the age of an unparseable file is an
      // `mtime`, which the kernel wrote, so the comparison is against the real clock.
      const old = new Date(Date.now() - HEARTBEAT_STALE_MS - 60_000);
      await utimes(lockPath(root), old, old);
      const taken = await acquireLock(root, environment);
      expect(taken.acquired).toBe(true);
    });
  });

  /**
   * The second race, measured at 5 of 5: a holder that stalls past the stale window is taken over
   * correctly, and then puts its own claim back over the new holder's.
   *
   * The heartbeat now checks ownership and writes through **one descriptor**, so a write after a
   * takeover lands in the unlinked inode and the new holder's file is untouched.
   */
  it('does not let a stalled holder take the lock back from the process that took over', async () => {
    await withDataDir(async (root) => {
      const stalled = fakeEnvironment({ pid: 301, hostname: 'alpha', alive: [301, 302] });
      const taker = fakeEnvironment({ pid: 302, hostname: 'alpha', alive: [301, 302] });
      expect((await acquireLock(root, stalled)).acquired).toBe(true);

      // Six missed intervals: the takeover is legitimate.
      stalled.advance(HEARTBEAT_STALE_MS + 1_000);
      taker.advance(HEARTBEAT_STALE_MS + 1_000);
      const takeover = await acquireLock(root, taker);
      expect(takeover.acquired).toBe(true);

      // The stalled process wakes up and heartbeats. It must be told it no longer holds the lock,
      // and the file must still be the taker's.
      expect(await heartbeat(root, stalled)).toBe(false);
      expect((await onDisk(root)).pid).toBe(302);
      // And the taker's own heartbeat still works, which is what makes the assertion above about
      // the right thing rather than about a broken heartbeat.
      expect(await heartbeat(root, taker)).toBe(true);
      expect((await onDisk(root)).pid).toBe(302);
    });
  });
});

describe('taking the lock', { tags: ['slow'] }, () => {
  it('creates the lock and records who holds it', async () => {
    await withDataDir(async (root) => {
      const environment = fakeEnvironment({ pid: 100, hostname: 'alpha', version: '1.2.3' });
      const result = await acquireLock(root, environment);

      expect(result.acquired).toBe(true);
      if (!result.acquired) return;
      expect(result.lock.pid).toBe(100);
      expect(result.lock.hostname).toBe('alpha');
      expect(result.lock.version).toBe('1.2.3');
      expect(result.lock.role).toBe('main');
      expect(result.lock.startedAt).toBe(result.lock.heartbeatAt);
      expect(result.tookOverFrom).toBeUndefined();
      expect(await onDisk(root)).toEqual(result.lock);
    });
  });

  it('creates run/ if it is not there, so a fresh install can take the lock', async () => {
    await withDataDir(async (root) => {
      const result = await acquireLock(root, fakeEnvironment());
      expect(result.acquired).toBe(true);
    });
  });

  it('refuses a second process while the first is alive', async () => {
    // The whole point. Both environments say the first PID is alive, which is the normal case.
    await withDataDir(async (root) => {
      const first = fakeEnvironment({ pid: 100, hostname: 'alpha' });
      const second = fakeEnvironment({ pid: 200, hostname: 'alpha', alive: [100, 200] });

      expect((await acquireLock(root, first)).acquired).toBe(true);
      const result = await acquireLock(root, second);

      expect(result.acquired).toBe(false);
      if (result.acquired) return;
      expect(result.heldBy.pid).toBe(100);
      expect(result.heldBy.ageMs).toBe(0);
      // The first process's lock is untouched — a failed acquire must not disturb the holder.
      expect((await onDisk(root)).pid).toBe(100);
    });
  });

  it('refuses a second process on another host, whose PID it cannot judge', async () => {
    // `process.kill(pid, 0)` says nothing useful about a PID on a different machine, so across
    // hosts the heartbeat is the only evidence — and a fresh heartbeat means "alive".
    await withDataDir(async (root) => {
      const first = fakeEnvironment({ pid: 100, hostname: 'alpha' });
      const second = fakeEnvironment({ pid: 100, hostname: 'beta', alive: [] });

      expect((await acquireLock(root, first)).acquired).toBe(true);
      const result = await acquireLock(root, second);
      expect(result.acquired).toBe(false);
    });
  });

  it('is idempotent for the same process', async () => {
    // A process that calls `acquireLock` twice — a retry, or a second subsystem — must not be told
    // it is competing with itself. Its own lock is stale by neither test, so it is refused, and the
    // holder it names is itself.
    await withDataDir(async (root) => {
      const environment = fakeEnvironment({ pid: 100 });
      expect((await acquireLock(root, environment)).acquired).toBe(true);
      const again = await acquireLock(root, environment);
      expect(again.acquired).toBe(false);
      if (again.acquired) return;
      expect(again.heldBy.pid).toBe(100);
    });
  });
});

describe('the heartbeat', { tags: ['slow'] }, () => {
  it('refreshes heartbeatAt and leaves startedAt alone', async () => {
    // `startedAt` is what tells a host how long the process has been up; a heartbeat that moved it
    // would make every uptime reading wrong by up to ten seconds, and always in the same direction.
    await withDataDir(async (root) => {
      const environment = fakeEnvironment({ pid: 100 });
      const acquired = await acquireLock(root, environment);
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;

      environment.advance(HEARTBEAT_INTERVAL_MS);
      expect(await heartbeat(root, environment)).toBe(true);

      const after = await onDisk(root);
      expect(after.startedAt).toBe(acquired.lock.startedAt);
      expect(Date.parse(after.heartbeatAt) - Date.parse(acquired.lock.heartbeatAt)).toBe(
        HEARTBEAT_INTERVAL_MS,
      );
    });
  });

  it('keeps the lock fresh across the stale threshold', async () => {
    // Six heartbeats at the specified interval cover the whole timeout, which is what makes the
    // 60-second threshold safe rather than a slow leak toward takeover.
    await withDataDir(async (root) => {
      const holder = fakeEnvironment({ pid: 100 });
      await acquireLock(root, holder);

      for (let tick = 0; tick < HEARTBEAT_STALE_MS / HEARTBEAT_INTERVAL_MS + 2; tick += 1) {
        holder.advance(HEARTBEAT_INTERVAL_MS);
        expect(await heartbeat(root, holder)).toBe(true);
      }

      const other = fakeEnvironment({
        pid: 200,
        hostname: 'beta',
        now: new Date(holder.now()),
        alive: [200],
      });
      expect((await acquireLock(root, other)).acquired).toBe(false);
    });
  });

  it('refuses to refresh a lock this process no longer holds', async () => {
    // The dangerous case, and the reason `heartbeat` checks ownership at all. After a takeover the
    // old process's heartbeat loop is still running; if it kept writing, it would resurrect a dead
    // claim and produce exactly the two-writer state the lock exists to prevent — and the loop is
    // the last place anyone would look.
    await withDataDir(async (root) => {
      const first = fakeEnvironment({ pid: 100, hostname: 'alpha' });
      await acquireLock(root, first);

      const second = fakeEnvironment({
        pid: 200,
        hostname: 'alpha',
        now: new Date(first.now()),
        alive: [200],
      });
      second.advance(HEARTBEAT_STALE_MS + 1);
      expect((await acquireLock(root, second)).acquired).toBe(true);

      first.advance(HEARTBEAT_STALE_MS + 1);
      expect(await heartbeat(root, first)).toBe(false);
      // The new holder's claim is intact.
      expect((await onDisk(root)).pid).toBe(200);
    });
  });

  it('refuses to refresh a lock that is not there', async () => {
    await withDataDir(async (root) => {
      expect(await heartbeat(root, fakeEnvironment())).toBe(false);
    });
  });

  it('refuses to refresh across a reboot, even with the same pid', async () => {
    // `bootId` exists for this: a PID reused after a reboot is a different process, and a
    // heartbeat from the new one would make a dead claim look alive.
    await withDataDir(async (root) => {
      const before = fakeEnvironment({ pid: 100, bootId: 'boot-1' });
      await acquireLock(root, before);

      const after = fakeEnvironment({ pid: 100, bootId: 'boot-2', now: new Date(before.now()) });
      expect(await heartbeat(root, after)).toBe(false);
    });
  });
});

describe('stale takeover (12 §3.7)', { tags: ['slow'] }, () => {
  it('takes over when the hostname matches and the pid is dead', async () => {
    // The common case: a container restarted, or the process was killed. Fast, because it needs no
    // waiting — the kernel already knows the PID is gone.
    await withDataDir(async (root) => {
      const first = fakeEnvironment({ pid: 100, hostname: 'alpha' });
      await acquireLock(root, first);

      const second = fakeEnvironment({
        pid: 200,
        hostname: 'alpha',
        now: new Date(first.now()),
        alive: [200],
      });
      const result = await acquireLock(root, second);

      expect(result.acquired).toBe(true);
      if (!result.acquired) return;
      expect(result.tookOverFrom?.pid).toBe(100);
      expect((await onDisk(root)).pid).toBe(200);
    });
  });

  it('takes over when the heartbeat is older than the threshold', async () => {
    // The cross-host case, where the PID says nothing. Sixty seconds of silence is the only
    // evidence available, and it has to be enough or a crashed host would need a human.
    await withDataDir(async (root) => {
      const first = fakeEnvironment({ pid: 100, hostname: 'alpha' });
      await acquireLock(root, first);

      const second = fakeEnvironment({
        pid: 100,
        hostname: 'beta',
        bootId: 'boot-2',
        now: new Date(first.now()),
        alive: [100],
      });
      second.advance(HEARTBEAT_STALE_MS + 1);
      const result = await acquireLock(root, second);

      expect(result.acquired).toBe(true);
      if (!result.acquired) return;
      expect(result.tookOverFrom?.pid).toBe(100);
      expect(result.tookOverFrom?.hostname).toBe('alpha');
    });
  });

  it('does not take over one second before the threshold', async () => {
    // The boundary, asserted from both sides. A takeover that fired early would be a split brain
    // on any host that paused for a moment.
    await withDataDir(async (root) => {
      const first = fakeEnvironment({ pid: 100, hostname: 'alpha' });
      await acquireLock(root, first);

      const second = fakeEnvironment({
        pid: 200,
        hostname: 'beta',
        now: new Date(first.now()),
        alive: [100, 200],
      });
      second.advance(HEARTBEAT_STALE_MS);
      expect((await acquireLock(root, second)).acquired).toBe(false);

      second.advance(1);
      expect((await acquireLock(root, second)).acquired).toBe(true);
    });
  });

  it('does not take over on the strength of a clock that jumped backwards', async () => {
    // A heartbeat from the future means somebody's clock is wrong. Taking over then would be
    // taking over because of a clock, which is how two writers happen.
    await withDataDir(async (root) => {
      const holder = fakeEnvironment({ pid: 100, hostname: 'alpha' });
      await acquireLock(root, holder);

      const behind = fakeEnvironment({
        pid: 200,
        hostname: 'beta',
        now: new Date(holder.now().getTime() - 10 * HEARTBEAT_STALE_MS),
        alive: [100, 200],
      });
      expect((await acquireLock(root, behind)).acquired).toBe(false);
    });
  });

  it('replaces a lock file that cannot be parsed once it is old enough', async () => {
    // A lock nobody can read is not evidence of a live process, and leaving it would require the
    // manual intervention the heartbeat exists to avoid — so it is still replaced, but **only
    // after the stale window**. This test used to corrupt the file and take the lock immediately,
    // which is the behaviour that turned a cold-start race into two writers: the loser of the
    // `O_EXCL` race read the winner's not-yet-written file and replaced it on sight. Amended at
    // the M1 exit gate; `two processes starting at once (C1)` covers the young case.
    await withDataDir(async (root) => {
      await acquireLock(root, fakeEnvironment({ pid: 100 }));
      await writeFile(lockPath(root), 'this is not json');
      const old = new Date(Date.now() - HEARTBEAT_STALE_MS - 60_000);
      await utimes(lockPath(root), old, old);

      const result = await acquireLock(root, fakeEnvironment({ pid: 200, alive: [200] }));
      expect(result.acquired).toBe(true);
      if (!result.acquired) return;
      expect((await onDisk(root)).pid).toBe(200);
    });
  });

  it('replaces a lock whose heartbeat is not a usable timestamp', async () => {
    // Validated in the schema for exactly this reason: a garbage timestamp would make `isStale`
    // compare against `NaN`, the lock would never be stale, and the data directory would be wedged
    // until somebody deleted the file by hand.
    await withDataDir(async (root) => {
      const first = await acquireLock(root, fakeEnvironment({ pid: 100 }));
      expect(first.acquired).toBe(true);
      if (!first.acquired) return;
      await writeFile(
        lockPath(root),
        JSON.stringify({ ...first.lock, heartbeatAt: 'some time last tuesday' }),
      );
      // Backdated for the same reason as the test above: an unreadable claim is a holder until it
      // is old enough to be a corpse.
      const old = new Date(Date.now() - HEARTBEAT_STALE_MS - 60_000);
      await utimes(lockPath(root), old, old);

      const result = await acquireLock(root, fakeEnvironment({ pid: 200, alive: [200] }));
      expect(result.acquired).toBe(true);
    });
  });

  it('judges staleness the same way through isStale', async () => {
    // The predicate is exported because `doctor` reports it without acquiring anything, so the two
    // must not be able to disagree.
    await withDataDir(async (root) => {
      const holder = fakeEnvironment({ pid: 100, hostname: 'alpha' });
      const acquired = await acquireLock(root, holder);
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;

      const live = fakeEnvironment({
        pid: 200,
        hostname: 'alpha',
        now: new Date(holder.now()),
        alive: [100, 200],
      });
      expect(isStale(acquired.lock, live)).toBe(false);

      live.kill(100);
      expect(isStale(acquired.lock, live)).toBe(true);
    });
  });
});

describe('releasing and reporting', { tags: ['slow'] }, () => {
  it('releases a lock this process holds', async () => {
    await withDataDir(async (root) => {
      const environment = fakeEnvironment({ pid: 100 });
      await acquireLock(root, environment);

      expect(await releaseLock(root, environment)).toBe(true);
      expect(await readLockHolder(root, environment)).toBeUndefined();
      // And the directory is immediately usable by the next process.
      expect((await acquireLock(root, fakeEnvironment({ pid: 200 }))).acquired).toBe(true);
    });
  });

  it('leaves somebody else’s lock alone', async () => {
    // A shutdown path that unlinked whatever lock it found would delete the claim of the process
    // that took over from it — turning an orderly exit into a race.
    await withDataDir(async (root) => {
      await acquireLock(root, fakeEnvironment({ pid: 100 }));
      const other = fakeEnvironment({ pid: 200, alive: [200] });

      expect(await releaseLock(root, other)).toBe(false);
      expect((await onDisk(root)).pid).toBe(100);
    });
  });

  it('reports no holder for a directory with no lock', async () => {
    await withDataDir(async (root) => {
      expect(await readLockHolder(root, fakeEnvironment())).toBeUndefined();
    });
  });

  it('reports the holder and the age of its heartbeat', async () => {
    await withDataDir(async (root) => {
      const holder = fakeEnvironment({ pid: 100, hostname: 'alpha', version: '9.9.9' });
      await acquireLock(root, holder);
      holder.advance(25_000);

      const found = await readLockHolder(root, holder);
      expect(found?.pid).toBe(100);
      expect(found?.hostname).toBe('alpha');
      expect(found?.version).toBe('9.9.9');
      expect(found?.ageMs).toBe(25_000);
    });
  });
});

describe('roles (12 §3.7)', { tags: ['slow'] }, () => {
  it('gives a web process its own lock, so it does not fight the main one', async () => {
    await withDataDir(async (root) => {
      const main = fakeEnvironment({ pid: 100 });
      const web = fakeEnvironment({ pid: 200, alive: [100, 200] });

      expect((await acquireLock(root, main)).acquired).toBe(true);
      expect((await acquireLock(root, web, { role: 'web' })).acquired).toBe(true);
      expect(lockPath(root, 'web', 200)).not.toBe(lockPath(root));
    });
  });

  it('gives **every** web process its own lock, which 12 §3.7 requires', async () => {
    // This test previously asserted the opposite — "still allows only one process per role", with
    // the second web process **refused**. `12` §3.7 says "`--role=web` processes take
    // `run/web.<pid>.lock`": one file per process, because a host runs several web workers and
    // they do not contend. The code returned `run/web.lock` with no pid, so the second was
    // refused, and this test pinned that refusal as correct.
    //
    // That is the expensive shape of wrong test: a future engineer adding a second worker would
    // have hit a refusal with a green suite telling them it was intended. Found by the M1
    // independent review.
    await withDataDir(async (root) => {
      const first = fakeEnvironment({ pid: 100 });
      const second = fakeEnvironment({ pid: 200, alive: [100, 200] });
      const third = fakeEnvironment({ pid: 300, alive: [100, 200, 300] });

      for (const environment of [first, second, third]) {
        expect(
          (await acquireLock(root, environment, { role: 'web' })).acquired,
          `pid ${String(environment.pid)} could not take its own web lock`,
        ).toBe(true);
      }

      // Three distinct files, named by pid, so `doctor` can enumerate the live workers.
      expect(
        new Set([
          lockPath(root, 'web', 100),
          lockPath(root, 'web', 200),
          lockPath(root, 'web', 300),
        ]).size,
      ).toBe(3);
      expect(lockPath(root, 'web', 200)).toContain('web.200.lock');
    });
  });

  it('the instance lock is still exclusive, which is the one C1 cares about', async () => {
    // The distinction the fix rests on: role locks are presence markers, the **instance** lock is
    // "one writer per data dir". Loosening the first must not loosen the second.
    await withDataDir(async (root) => {
      const first = fakeEnvironment({ pid: 100 });
      const second = fakeEnvironment({ pid: 200, alive: [100, 200] });

      expect((await acquireLock(root, first)).acquired).toBe(true);
      expect((await acquireLock(root, second)).acquired).toBe(false);
    });
  });

  it('refuses a role lock path with no pid, rather than sharing one', async () => {
    // The pid is required so a caller cannot forget it and silently get a shared file back, which
    // is exactly how the single-file behaviour arose.
    await withDataDir((root) => {
      expect(() => lockPath(root, 'web')).toThrow(/needs the process id/);
      // `main` needs none: there is only ever one.
      expect(() => lockPath(root)).not.toThrow();
      return Promise.resolve();
    });
  });

  it('refuses to refresh a lock taken under a different role', async () => {
    await withDataDir(async (root) => {
      const environment = fakeEnvironment({ pid: 100 });
      await acquireLock(root, environment, { role: 'web' });
      expect(await heartbeat(root, environment, { role: 'main' })).toBe(false);
      expect(await heartbeat(root, environment, { role: 'web' })).toBe(true);
    });
  });
});

describe('the STORAGE_LOCKED error', () => {
  it('names the holder, because "locked" with no detail sends somebody to a forum', () => {
    const error = lockedError(
      {
        pid: 4242,
        hostname: 'pi',
        version: '1.2.3',
        heartbeatAt: '2026-11-06T09:00:00.000Z',
        ageMs: 3_000,
      },
      '/data/run/x.lock',
    );

    expect(error.storageCode).toBe('STORAGE_LOCKED');
    expect(error.message).toContain('4242');
    expect(error.message).toContain('pi');
    expect(error.message).toContain('1.2.3');
    expect(error.message).toContain('3s ago');
    expect(error.hint).toContain('/data/run/x.lock');
    expect(error.hint).toContain('60s');
  });

  it('carries the holder in detail, with no content and no secrets', () => {
    // `01` §11.7: structured detail is for logs, so it must stay free of anything sensitive. A pid
    // and a hostname are operational facts; nothing else from the lock belongs here.
    const error = lockedError(
      {
        pid: 7,
        hostname: 'pi',
        version: '1.0.0',
        heartbeatAt: '2026-11-06T09:00:00.000Z',
        ageMs: 1,
      },
      '/x',
    );
    expect(error.detail).toEqual({
      storageCode: 'STORAGE_LOCKED',
      pid: 7,
      holderHost: 'pi',
      ageMs: 1,
    });
  });
});
