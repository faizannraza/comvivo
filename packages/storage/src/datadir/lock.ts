/**
 * The instance lock: one writer per data directory (`12` §3.7, spine §8, `02` D22).
 *
 * Two server processes against one SQLite database is the failure this prevents, and it is worse
 * than it sounds: SQLite's own locking keeps the *file* consistent, but this product's invariants
 * are not file-level. Two processes would both run the outbox (I6, exactly-once intent), both run
 * actors, and both believe they own the turn journal — so the file would be fine and the group
 * would get everything twice.
 *
 * `12` §3.7's design, and every part of it is there for a case that happens:
 *
 *  - **`O_EXCL`**, so creating the lock is itself the mutual exclusion. A `stat`-then-write would
 *    have a window between the two.
 *  - **A heartbeat every 10 s**, because a process can die without unlinking anything — `SIGKILL`,
 *    OOM, a yanked power cable — and a lock with no liveness signal would make the next boot
 *    require manual intervention. That is the most common bad experience in self-hosted software.
 *  - **Takeover when the heartbeat is older than 60 s**, which is the only safe signal available
 *    across hosts. Six missed heartbeats, so a loaded Pi pausing for a few seconds is not a
 *    takeover.
 *  - **Takeover when the hostname matches and the PID is dead**, which is faster and is the common
 *    case: a container restarted, or a crash on this machine. `process.kill(pid, 0)` can only be
 *    trusted about *our own* host, because PIDs are not globally unique.
 *  - **`bootId`**, so a PID reused after a reboot is not mistaken for the old holder. Without it,
 *    a host that rebooted quickly and happened to reassign the PID would refuse to start.
 *
 * Otherwise the second process exits with `STORAGE_LOCKED` and a message naming the holder, which
 * is the whole point: "another one of me is already running, here is which".
 *
 * The clock and the liveness probe are injected. A heartbeat and a 60-second timeout cannot be
 * tested against a real clock without a test that takes a minute and is flaky, and `12` §3.7's
 * acceptance criterion asks for exactly that — "lock heartbeat and stale takeover tested with a
 * fake clock".
 */
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { StorageError, z } from '@comvivo/shared';
import { writeFileAtomic } from './atomic.js';
import { DIR_MODE, dataDirLayout, FILE_MODE } from './layout.js';

/** `12` §3.7: how often the holder refreshes `heartbeatAt`. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * `12` §3.7: how stale a heartbeat has to be before another process may take over.
 *
 * Six intervals, not two. A heartbeat is a write to a file on a possibly-slow disk, and a Pi doing
 * a migration or an embedding pass can genuinely stall for several seconds — a tight timeout would
 * turn a busy host into a split brain, which is the one outcome this lock exists to prevent.
 */
export const HEARTBEAT_STALE_MS = 60_000;

/** A timestamp a comparison can actually use. See `heartbeatAt` below. */
const isoTimestamp = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'a timestamp must be parseable',
  });

export const lockSchema = z.object({
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  /** Distinguishes a reused PID after a reboot from the original holder. */
  bootId: z.string().min(1),
  version: z.string().min(1),
  startedAt: isoTimestamp,
  /**
   * Validated as a **parseable** timestamp, not merely as a non-empty string.
   *
   * `isStale` compares this against the clock, so a garbage value would produce `NaN` and the lock
   * would never be considered stale — wedging the data directory until somebody deleted the file
   * by hand, which is precisely the manual intervention the heartbeat exists to avoid. Refusing it
   * here makes `readLock` report the file as absent instead, and an unreadable lock is replaced.
   */
  heartbeatAt: isoTimestamp,
  /** `12` §3.7: `--role=web` processes take their own lock file. */
  role: z.string().min(1).default('main'),
});

export type LockFile = z.infer<typeof lockSchema>;

/** What the environment has to answer for the lock to make a decision. */
export interface LockEnvironment {
  now(): Date;
  /** This process. */
  readonly pid: number;
  readonly hostname: string;
  /** Stable for the life of the machine's boot. */
  readonly bootId: string;
  readonly version: string;
  /**
   * Is this PID alive **on this host**? Never asked about another host, because PIDs are not
   * globally unique and a wrong answer there would mean two writers.
   */
  isAlive(pid: number): boolean;
}

/** Why a lock could not be acquired, for the message the second process prints. */
export interface LockHolder {
  readonly pid: number;
  readonly hostname: string;
  readonly version: string;
  readonly heartbeatAt: string;
  readonly ageMs: number;
}

export type AcquireResult =
  | { readonly acquired: true; readonly lock: LockFile; readonly tookOverFrom?: LockHolder }
  | { readonly acquired: false; readonly heldBy: LockHolder };

/** The real environment. `bootId` is read from the OS where one is available. */
export async function nodeLockEnvironment(version: string): Promise<LockEnvironment> {
  return {
    now: () => new Date(),
    pid: process.pid,
    hostname: hostname(),
    bootId: await readBootId(),
    version,
    isAlive: (pid: number) => {
      try {
        // Signal 0 performs the permission and existence checks without sending anything.
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return aliveDespite(error);
      }
    },
  };
}

/**
 * Does this `process.kill` failure mean the process is **alive**?
 *
 * Only `ESRCH` ("no such process") is evidence of death. `EPERM` means the process exists but
 * belongs to another user — alive, and certainly not ours to take over. Anything else is
 * unexpected, and the default has to be "alive": refusing to start is an inconvenience a host can
 * fix, and two writers is data loss they cannot.
 *
 * Extracted so the decision is testable without the operating system. The test that covered
 * `EPERM` did it by signalling pid 1 as a non-root user and **returned early when running as
 * root** — a bare `return` with no assertion before it, in a container, which is where CI is
 * heading. A test named for "the one wrong answer that loses data" silently asserting nothing is
 * the worst version of that. Found by the M1 independent review.
 */
export function aliveDespite(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH';
}

/**
 * A boot identifier, so a reused PID after a reboot is not mistaken for the old holder.
 *
 * `/proc/sys/kernel/random/boot_id` on Linux; on macOS and Windows there is no equivalent that is
 * cheap and dependency-free, so the machine's boot time stands in — it changes on reboot, which is
 * the only property needed. Falls back to the hostname plus the process start, which is weaker but
 * never wrong in the dangerous direction: a *different* boot id only ever makes the lock more
 * conservative, never less.
 */
async function readBootId(): Promise<string> {
  try {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } catch {
    const { uptime } = await import('node:os');
    return `boot-${String(Math.floor(Date.now() / 1000 - uptime()))}`;
  }
}

/**
 * Take the instance lock, or report who holds it.
 *
 * `O_EXCL` first, always — the fast path is a single syscall and it is the only operation here
 * that is genuinely atomic. Everything after it is the stale-lock analysis, which only runs when
 * the file already exists.
 */
export async function acquireLock(
  root: string,
  environment: LockEnvironment,
  options: { readonly role?: string } = {},
): Promise<AcquireResult> {
  const role = options.role ?? 'main';
  const path = lockPath(root, role, environment.pid);
  await mkdir(dataDirLayout(root).run, { recursive: true, mode: DIR_MODE });

  const next = newLock(environment, role);
  if (await writeExclusive(path, next)) {
    return { acquired: true, lock: next };
  }

  // The file exists. Either its holder is alive, or it is a corpse — and `12` §3.7 gives two
  // independent ways to tell, because neither is sufficient alone.
  const existing = await readLock(path);
  if (existing === undefined) {
    // Unreadable or malformed. A lock file nobody can parse cannot be proof of a live process, and
    // leaving it forever would require manual intervention — the thing the heartbeat exists to
    // avoid. Replaced, with the same `O_EXCL` dance so two processes racing here cannot both win.
    return (await replaceLock(path, next))
      ? { acquired: true, lock: next }
      : { acquired: false, heldBy: await describeHolder(path, environment) };
  }

  const holder = toHolder(existing, environment.now());
  if (!isStale(existing, environment)) {
    return { acquired: false, heldBy: holder };
  }

  return (await replaceLock(path, next))
    ? { acquired: true, lock: next, tookOverFrom: holder }
    : { acquired: false, heldBy: await describeHolder(path, environment) };
}

/**
 * Is this lock a corpse?
 *
 * The two tests are deliberately independent. The PID test is fast and exact but only valid on the
 * same host *and* the same boot; the heartbeat test works across hosts but has to wait out the
 * timeout. A lock is stale if either says so.
 */
export function isStale(lock: LockFile, environment: LockEnvironment): boolean {
  const sameHost = lock.hostname === environment.hostname;
  const sameBoot = lock.bootId === environment.bootId;
  if (sameHost && sameBoot && !environment.isAlive(lock.pid)) return true;

  // `heartbeatAt` is schema-validated as parseable, so this is a real number — a lock whose
  // timestamp could not be parsed is reported as absent by `readLock` and replaced instead.
  //
  // A heartbeat from the *future* means a clock jumped, on this host or the holder's. Not treated
  // as stale: taking over on the strength of a bad clock is how two writers happen, and the holder
  // will either keep refreshing the heartbeat or stop.
  const age = environment.now().getTime() - Date.parse(lock.heartbeatAt);
  return age > HEARTBEAT_STALE_MS;
}

/**
 * Refresh `heartbeatAt`, so other processes can tell this one is alive.
 *
 * Refuses to refresh a lock this process does not hold. That matters more than it looks: a
 * heartbeat loop that kept writing after a takeover would resurrect a dead claim and produce
 * exactly the two-writer state the lock exists to prevent — and the loop is the last place anyone
 * would look for it.
 */
export async function heartbeat(
  root: string,
  environment: LockEnvironment,
  options: { readonly role?: string } = {},
): Promise<boolean> {
  const role = options.role ?? 'main';
  const path = lockPath(root, role, environment.pid);
  const existing = await readLock(path);
  if (existing === undefined) return false;
  if (!ownedBy(existing, environment, role)) return false;

  await writeLock(path, { ...existing, heartbeatAt: environment.now().toISOString() });
  return true;
}

/** Release the lock, if this process holds it. A lock held by somebody else is left alone. */
export async function releaseLock(
  root: string,
  environment: LockEnvironment,
  options: { readonly role?: string } = {},
): Promise<boolean> {
  const role = options.role ?? 'main';
  const path = lockPath(root, role, environment.pid);
  const existing = await readLock(path);
  if (existing === undefined || !ownedBy(existing, environment, role)) return false;
  await rm(path, { force: true });
  return true;
}

/** Who holds the lock, or `undefined` if nobody does. For `doctor` and for error messages. */
export async function readLockHolder(
  root: string,
  environment: LockEnvironment,
  options: { readonly role?: string } = {},
): Promise<LockHolder | undefined> {
  const existing = await readLock(lockPath(root, options.role ?? 'main', environment.pid));
  return existing === undefined ? undefined : toHolder(existing, environment.now());
}

/**
 * The `STORAGE_LOCKED` error a second process exits with (`02` §3.6.2, `12` §3.7).
 *
 * Names the holder, because "the data directory is locked" with no detail is the message that
 * sends somebody to a forum. The PID, host and version are what let them recognise their own
 * stray container.
 */
export function lockedError(holder: LockHolder, path: string): StorageError {
  const seconds = Math.round(holder.ageMs / 1000);
  return new StorageError(
    'STORAGE_LOCKED',
    `this data directory is in use by pid ${String(holder.pid)} on ${holder.hostname} ` +
      `(version ${holder.version}), last seen ${String(seconds)}s ago`,
    {
      hint:
        'One process per data directory. Stop the other one and try again — if you are sure it is ' +
        `gone, its lock at ${path} becomes stale ` +
        `${String(Math.round(HEARTBEAT_STALE_MS / 1000))}s after its last heartbeat and will be ` +
        'taken over automatically.',
      detail: { pid: holder.pid, holderHost: holder.hostname, ageMs: holder.ageMs },
    },
  );
}

/**
 * `12` §3.7: `main` uses `<slug>.lock`; every other role takes `run/<role>.<pid>.lock`.
 *
 * The two serve different purposes, and conflating them was the bug. The **instance** lock is
 * exclusive — "one writer per data dir", invariant C1 — and a second process asking for it is
 * refused. A **role** lock is a *presence marker*: `12` §3.7 says "`--role=web` processes take
 * `run/web.<pid>.lock`", one file per process, because a host runs several web workers and they do
 * not contend with each other or with the writer.
 *
 * This returned `run/<role>.lock` with no pid, so a second `--role=web` process was **refused** —
 * and `lock.test.ts` asserted that refusal as correct, which is the part that would have cost
 * someone an afternoon: a future engineer adding a second worker would have hit a refusal with a
 * passing test telling them it was intended. Found by the M1 independent review.
 *
 * `pid` is required for a non-`main` role precisely so a caller cannot forget it and silently get
 * a shared file back.
 */
export function lockPath(root: string, role = 'main', pid?: number): string {
  const layout = dataDirLayout(root);
  if (role === 'main') return layout.lock;
  if (pid === undefined) {
    throw new StorageError('STORAGE_IO', `a ${role} lock path needs the process id`, {
      hint:
        'Role locks are per-process (`12` §3.7: `run/web.<pid>.lock`), so the pid is part of the ' +
        'name. Pass `environment.pid`.',
      category: 'bug',
    });
  }
  return `${layout.run}/${role}.${String(pid)}.lock`;
}

function newLock(environment: LockEnvironment, role: string): LockFile {
  const at = environment.now().toISOString();
  return {
    pid: environment.pid,
    hostname: environment.hostname,
    bootId: environment.bootId,
    version: environment.version,
    startedAt: at,
    heartbeatAt: at,
    role,
  };
}

function ownedBy(lock: LockFile, environment: LockEnvironment, role: string): boolean {
  return (
    lock.pid === environment.pid &&
    lock.hostname === environment.hostname &&
    lock.bootId === environment.bootId &&
    lock.role === role
  );
}

function toHolder(lock: LockFile, now: Date): LockHolder {
  return {
    pid: lock.pid,
    hostname: lock.hostname,
    version: lock.version,
    heartbeatAt: lock.heartbeatAt,
    // Clamped at zero so a holder whose clock is ahead is reported as "just now" rather than as a
    // negative age, which would read as nonsense in the `STORAGE_LOCKED` message.
    ageMs: Math.max(0, now.getTime() - Date.parse(lock.heartbeatAt)),
  };
}

/** A holder description for a file that just defeated us, when it cannot be parsed. */
async function describeHolder(path: string, environment: LockEnvironment): Promise<LockHolder> {
  const existing = await readLock(path);
  return existing === undefined
    ? {
        pid: 0,
        hostname: 'unknown',
        version: 'unknown',
        heartbeatAt: environment.now().toISOString(),
        ageMs: 0,
      }
    : toHolder(existing, environment.now());
}

/** `O_EXCL`: create, or report that somebody else already has. */
async function writeExclusive(path: string, lock: LockFile): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      FILE_MODE,
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new StorageError('STORAGE_IO', `the lock file ${path} could not be created`, {
      hint: 'Check that the data directory exists and the service user can write to it.',
      cause,
    });
  }
  try {
    await handle.writeFile(serialise(lock), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Take over a stale lock without opening a window two processes could both pass through.
 *
 * Unlink then `O_EXCL` create, rather than truncate-and-write: if two processes both decide the
 * same lock is stale, exactly one of them wins the create and the other sees `EEXIST` and backs
 * off. A plain overwrite would let both "succeed".
 */
async function replaceLock(path: string, lock: LockFile): Promise<boolean> {
  await rm(path, { force: true });
  return writeExclusive(path, lock);
}

/**
 * Replace the lock file atomically.
 *
 * It was a plain `writeFile` over the live path. A reader that caught the heartbeat mid-write saw
 * truncated JSON, `readLock` reports unparseable as **absent**, and `acquireLock` then replaces an
 * absent lock with no liveness check — so a second process could take the lock from a live holder
 * and both would believe they had it. That is the two-writer state **C1** forbids, reached without
 * either process doing anything wrong. Found by the M1 independent review.
 *
 * `readLock`'s comment — "a lock file is not evidence of anything unless it can be read" — is a
 * sound argument about a *corrupt* file and was being asked to cover a file that was merely
 * *being written*. With the rename it only has to cover the case it was written for.
 */
async function writeLock(path: string, lock: LockFile): Promise<void> {
  await writeFileAtomic(path, serialise(lock));
}

async function readLock(path: string): Promise<LockFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return lockSchema.parse(JSON.parse(text));
  } catch {
    // Unparseable is treated as absent by every caller, and deliberately so: a lock file is not
    // evidence of anything unless it can be read. The alternative — refusing to start on a
    // corrupt lock — would need a human for a file the product itself wrote.
    return undefined;
  }
}

function serialise(lock: LockFile): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}
