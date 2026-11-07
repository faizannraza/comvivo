/**
 * `nodeLockEnvironment` against the real process and OS (`12` §3.7).
 *
 * `lock.test.ts` drives every decision through a fake clock and a fake liveness probe, which is the
 * only way to test a sixty-second timeout. What it cannot test is whether the **real** probe
 * answers correctly — and that is the half the whole design rests on: a liveness check that said
 * "dead" about a living process would hand the data directory to a second writer.
 *
 * The same gap this subsystem has found twice now. `nodeUnlockIo` sat at 58% function coverage
 * with every `08` §3.7.5 ordering rule green, and before that `syncDirectory` opened a directory
 * with `r+` and failed with `EISDIR` on Linux. A fake can be wrong in the same direction as the
 * code; only the real syscall settles it.
 */
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  acquireLock,
  heartbeat,
  nodeLockEnvironment,
  readLockHolder,
  releaseLock,
} from './lock.js';
import { withDataDir } from './testing/data-dir.js';

/**
 * A PID that is definitely not running.
 *
 * Spawned and awaited rather than invented: a made-up number might belong to something, and
 * `isAlive` would then be asked a question with no correct answer. A process that has exited is
 * the only PID this test can be sure about.
 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  expect(pid).toBeDefined();
  await new Promise<void>((resolve) => {
    child.on('close', () => {
      resolve();
    });
  });
  // The PID is released at `close`; reuse within the next few milliseconds is possible in
  // principle but needs the kernel to wrap all the way around its PID space first.
  return pid ?? 0;
}

describe('the real environment', { tags: ['slow'] }, () => {
  it('reports this process, this host and the version it was given', async () => {
    const environment = await nodeLockEnvironment('4.5.6');
    expect(environment.pid).toBe(process.pid);
    expect(environment.hostname).toBe(hostname());
    expect(environment.version).toBe('4.5.6');
  });

  it('reports a clock that is actually the clock', async () => {
    const environment = await nodeLockEnvironment('0.0.0');
    expect(Math.abs(environment.now().getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('reports a stable, non-empty boot id', async () => {
    // Stable is the property that matters: `bootId` is how a PID reused after a reboot is told
    // apart from the original holder, so two reads within one boot must agree.
    const first = await nodeLockEnvironment('0.0.0');
    const second = await nodeLockEnvironment('0.0.0');
    expect(first.bootId).not.toBe('');
    expect(second.bootId).toBe(first.bootId);
  });

  it('knows this process is alive', async () => {
    const environment = await nodeLockEnvironment('0.0.0');
    expect(environment.isAlive(process.pid)).toBe(true);
  });

  it('knows a process that has exited is dead', async () => {
    const environment = await nodeLockEnvironment('0.0.0');
    expect(environment.isAlive(await deadPid())).toBe(false);
  });

  it('treats a process it may not signal as alive', async () => {
    // `process.kill(1, 0)` raises `EPERM` for a non-root user: pid 1 exists and is not ours to
    // touch. Reading that as "dead" would be the one wrong answer that loses data — a takeover
    // from a live holder — so the implementation treats everything but `ESRCH` as alive. Skipped
    // when running as root, where signalling pid 1 is permitted and the probe returns true for a
    // different reason.
    if (process.getuid?.() === 0) return;
    const environment = await nodeLockEnvironment('0.0.0');
    expect(environment.isAlive(1)).toBe(true);
  });

  it('treats a nonsensical pid as alive rather than dead', async () => {
    // `EINVAL`, not `ESRCH`. Same reasoning: only "no such process" is evidence of death.
    const environment = await nodeLockEnvironment('0.0.0');
    expect(environment.isAlive(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('a real lock, taken by this process', { tags: ['slow'] }, () => {
  it('acquires, heartbeats and releases', async () => {
    // The whole cycle through the real environment and a real filesystem, which is what the server
    // actually does. The fake-clock suite proves the decisions; this proves the plumbing.
    await withDataDir(async (root) => {
      const environment = await nodeLockEnvironment('1.0.0');

      const acquired = await acquireLock(root, environment);
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;
      expect(acquired.lock.pid).toBe(process.pid);
      expect(acquired.lock.bootId).toBe(environment.bootId);

      expect(await heartbeat(root, environment)).toBe(true);
      const holder = await readLockHolder(root, environment);
      expect(holder?.pid).toBe(process.pid);
      // A heartbeat just happened, so the age is a few milliseconds at most.
      expect(holder?.ageMs).toBeLessThan(5_000);

      expect(await releaseLock(root, environment)).toBe(true);
      expect(await readLockHolder(root, environment)).toBeUndefined();
    });
  });

  it('refuses itself a second time, through the real liveness probe', async () => {
    // The real `isAlive` says this process is alive, so its own lock is not stale — which is the
    // behaviour that stops a restart loop from stomping on a running server.
    await withDataDir(async (root) => {
      const environment = await nodeLockEnvironment('1.0.0');
      expect((await acquireLock(root, environment)).acquired).toBe(true);

      const again = await acquireLock(root, environment);
      expect(again.acquired).toBe(false);
      if (again.acquired) return;
      expect(again.heldBy.pid).toBe(process.pid);
    });
  });

  it('takes over from a process that has really exited', async () => {
    // The common case in production: a container was killed, or the host crashed. The real probe
    // has to notice, or every restart after a hard kill would need a human.
    await withDataDir(async (root) => {
      const environment = await nodeLockEnvironment('1.0.0');
      const corpse = await deadPid();

      // A lock written as though the dead process held it, with a fresh heartbeat — so the only
      // thing that can make it stale is the PID check, which is the one under test here.
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await mkdir(join(root, 'run'), { recursive: true, mode: 0o700 });
      const { lockPath } = await import('./lock.js');
      await writeFile(
        lockPath(root),
        JSON.stringify({
          pid: corpse,
          hostname: environment.hostname,
          bootId: environment.bootId,
          version: '0.9.0',
          startedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          role: 'main',
        }),
        { mode: 0o600 },
      );

      const result = await acquireLock(root, environment);
      expect(result.acquired).toBe(true);
      if (!result.acquired) return;
      expect(result.tookOverFrom?.pid).toBe(corpse);
      expect(result.lock.pid).toBe(process.pid);
    });
  });

  it('writes the lock 0600, because it names the host and the version', async () => {
    await withDataDir(async (root) => {
      const environment = await nodeLockEnvironment('1.0.0');
      await acquireLock(root, environment);

      const { stat } = await import('node:fs/promises');
      const { lockPath } = await import('./lock.js');
      expect((await stat(lockPath(root))).mode & 0o777).toBe(0o600);
    });
  });
});
