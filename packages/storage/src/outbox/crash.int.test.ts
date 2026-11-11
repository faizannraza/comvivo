/**
 * `outbox.crash.test` (`M1-T22`; `02` §9.3).
 *
 * `02` §9.3 states it: a child process `kill -9`ed at five injected points — after enqueue, after
 * claim, after send-before-receipt, after receipt, and mid-recovery — with **no logical duplicate
 * and no loss** across 50 iterations.
 *
 * ## What "no logical duplicate" can and cannot mean
 *
 * It cannot mean "the platform receives each message once". The `send` point kills the process
 * *after* the platform accepted the message and *before* the receipt is recorded, and no amount of
 * local bookkeeping can undo that — which is why `06` §3.13 sorts platforms by whether they can
 * deduplicate or verify, and why `02` §3.9 keeps a `maybe_sent` column rather than pretending the
 * question is answerable. The fake platform here has native idempotency (Discord, Matrix, Slack),
 * so a re-send returns the **same** message id.
 *
 * What it does mean, and what this test asserts, is that the *record* is single: one `sent` row and
 * one assistant message per idempotency key, no matter where the process died. That is the
 * guarantee the storage layer owes, and the thing `messages` being a copy of what the group was
 * told depends on — Q-ING-5 reads it to recognise a reply to the bot, and two rows for one reply
 * would make the bot answer itself.
 *
 * ## Why a child process
 *
 * `SIGKILL` is the only faithful crash: no unwinding, no `close()`, nothing flushed that was not
 * already committed. A test that threw an exception instead would exercise rollback, which is a
 * different mechanism and one that already works.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, envVar } from '@comvivo/shared';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { writeSourcePathsTsconfig } from '../../../../scripts/support/paths-tsconfig.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// `HERE` is `src/outbox`, so the package root is two levels up — not one. The first version
// pointed at `src/`, and `writeSourcePathsTsconfig` failed on a missing `tsconfig.paths.json`.
const PACKAGE_ROOT = resolve(HERE, '../..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const RUNNER = join(HERE, 'testing/crash-runner.mjs');
const MIGRATIONS = join(PACKAGE_ROOT, 'migrations');

/** `02` §9.3's five injection points. */
const POINTS = ['enqueue', 'claim', 'send', 'receipt', 'recover'] as const;

/**
 * `02` §9.3's "across 50 iterations", split evenly across the five points.
 *
 * Overridable so a developer iterating on this file can run one pass per point; the default is the
 * number the spec names, because `CLAUDE.md` §8 does not allow a gate to be quietly smaller than
 * the criterion it reports on. Built through `envVar` rather than written out, so a rename stays
 * one command (`13` §3.A.6).
 */
const ITERATIONS_PER_POINT = Number(process.env[envVar('OUTBOX_CRASH_ITERATIONS')] ?? '10');

const SENDS = 4;

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), `${BRAND.slug}-outbox-crash-`));
  temporaries.push(path);
  return path;
}

interface Run {
  readonly status: number | null;
  readonly output: string;
}

/**
 * Run the dispatcher script under `tsx`, in a child process.
 *
 * `TSX_TSCONFIG_PATH` is not optional, for the reason `migrations.int.test.ts` records at length:
 * `tsconfig.base.json`'s workspace `paths` redirect `better-sqlite3-multiple-ciphers` to the
 * **declaration file** the package ships but hides behind its `exports`, and tsx then *executes*
 * the `.d.ts` — the child dies with `ReferenceError: Database is not defined`.
 * `writeSourcePathsTsconfig` filters `.d.ts` targets, and it is shared precisely so the next
 * child-process test does not rediscover this.
 *
 * The binary is named by **absolute** path. A relative `node_modules/.bin/tsx` with `cwd` set made
 * `execFileSync` throw `ENOENT`, which arrives as `status: null` — and `null` is not `137`, so the
 * kill assertion failed with no output to explain why.
 */
function runChild(root: string, point: string): Run {
  const tsconfig = writeSourcePathsTsconfig(tempDir(), REPO_ROOT, 'tsconfig.child.json');
  try {
    const output = execFileSync(
      join(REPO_ROOT, 'node_modules/.bin/tsx'),
      [RUNNER, join(root, 'data.db'), join(root, 'journal.txt'), point, String(SENDS), MIGRATIONS],
      {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
      },
    );
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? null,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

/** Every delivery the fake platform recorded, in order. */
function journal(root: string): readonly string[] {
  const path = join(root, 'journal.txt');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

function rows(root: string, sql: string): unknown[] {
  const db = new Database(join(root, 'data.db'), { readonly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

describe('outbox.crash.test (02 §9.3)', { tags: ['slow', 'chaos', 'db'] }, () => {
  for (const point of POINTS) {
    it(`loses nothing and duplicates nothing when killed after ${point}`, () => {
      for (let iteration = 0; iteration < ITERATIONS_PER_POINT; iteration += 1) {
        const root = tempDir();

        // ── The crash.
        const killed = runChild(root, point);
        // **Measured in `M1-T14`: the signal arrives as an exit code, not as a signal.**
        // `node_modules/.bin/tsx` is a shell shim, so the process `execFileSync` spawns is the
        // shim — it observes its own child being killed and exits `128 + 9`, leaving `signal`
        // null. Asserting `signal === 'SIGKILL'` would fail on a correctly killed child.
        expect(killed.status, killed.output).toBe(128 + 9);
        // The guard that it failed by being *killed* rather than by crashing. Without this, a
        // child that never started would look like a successful kill and the assertions below
        // would pass against a database nothing had touched.
        expect(killed.output, 'the child must fail by being killed, not by crashing').not.toMatch(
          /ReferenceError|Cannot find (module|package)|ERR_MODULE_NOT_FOUND|SyntaxError|is not defined|STORAGE_/,
        );

        // ── The resume, which is what a restart does.
        const resumed = runChild(root, 'none');
        expect(resumed.status, resumed.output).toBe(0);

        // ── No loss: every send reached the platform and is recorded as sent.
        const delivered = journal(root);
        const keys = new Set(delivered);
        expect(keys.size, `iteration ${String(iteration)} lost a send`).toBe(SENDS);
        expect(
          rows(root, "SELECT id FROM outbox_messages WHERE status = 'sent'"),
          `iteration ${String(iteration)} did not settle every send`,
        ).toHaveLength(SENDS);
        expect(rows(root, "SELECT id FROM outbox_messages WHERE status != 'sent'")).toEqual([]);

        // ── No logical duplicate: one assistant message per send, however many times the
        // platform saw it. The dedupe key is derived from the platform's message id, and a
        // platform with native idempotency returns the same id for a re-send — which is the
        // mechanism `02` §3.9(a) and §3.3.3 rely on, acting here rather than in a comment.
        expect(
          rows(root, "SELECT id FROM messages WHERE kind = 'assistant'"),
          `iteration ${String(iteration)} wrote the same reply twice`,
        ).toHaveLength(SENDS);

        // ── The physical duplicate, where it is unavoidable, is **recorded** rather than denied.
        // Killing after the platform accepted and before the receipt is the one case local
        // bookkeeping cannot undo, and `06` §3.13 is the policy for it.
        if (point === 'send') {
          expect(delivered.length).toBeGreaterThanOrEqual(SENDS);
        } else {
          expect(delivered.length, `iteration ${String(iteration)} sent something twice`).toBe(
            SENDS,
          );
        }

        // ── And the queue is in a resting state: nothing claimable, nothing in flight.
        expect(
          rows(root, "SELECT id FROM outbox_messages WHERE status IN ('pending', 'sending')"),
        ).toEqual([]);
      }
    });
  }
});
