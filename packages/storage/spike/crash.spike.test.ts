/**
 * `kill -9` in the middle of a write loop, twenty times (`02` §3.6.3 step 8).
 *
 * Two properties, and they are different:
 *
 *  - **`PRAGMA integrity_check` is `ok`.** The encrypted database plus its WAL survives an abrupt
 *    death without structural damage. This is the one that would block D8 if it failed.
 *  - **No committed row is lost.** Under `synchronous = NORMAL` in WAL mode, a committed
 *    transaction survives a *process* kill because the pages are in the OS page cache; it is a
 *    power cut that can lose the last commits. So the child reports each commit on stdout and the
 *    parent checks every reported row is readable afterwards — rather than assuming a count,
 *    which would either hide a durability bug or invent one.
 *
 * This is the test that would have caught a codec that buffers pages in process memory and writes
 * them at close.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_FILENAME, openSpikeDatabase, withSpikeDirAsync } from './open.js';

const WRITER = new URL('crash-writer.mjs', import.meta.url).pathname;

interface CrashOutcome {
  readonly committed: number;
  readonly integrity: string;
  readonly present: number;
  readonly missing: number[];
}

/**
 * Start the writer, kill it with `SIGKILL` once it has committed at least `after` rows, then
 * reopen and report what survived.
 */
async function crashOnce(dir: string, key: Buffer, after: number): Promise<CrashOutcome> {
  const dbPath = join(dir, DB_FILENAME);
  const keyFile = join(dir, 'key.bin');
  writeFileSync(keyFile, key, { mode: 0o600 });

  const committed = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, dbPath, keyFile, '100000'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let highest = 0;
    let killed = false;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const n = Number(line);
        if (Number.isInteger(n) && n > highest) highest = n;
      }
      if (!killed && highest >= after) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', reject);
    child.on('close', () => {
      if (highest < after) {
        reject(new Error(`the writer only committed ${String(highest)} rows before exiting`));
        return;
      }
      resolve(highest);
    });
  });

  const db = openSpikeDatabase({ path: dbPath, key, fileMustExist: true });
  try {
    const integrity = (db.pragma('integrity_check') as { integrity_check: string }[])[0]
      ?.integrity_check;
    const rows = db.prepare('select n from rows_written order by n').all() as { n: number }[];
    const present = new Set(rows.map((r) => r.n));
    const missing: number[] = [];
    for (let n = 1; n <= committed; n += 1) if (!present.has(n)) missing.push(n);
    return { committed, integrity: integrity ?? 'missing', present: present.size, missing };
  } finally {
    db.close();
  }
}

describe('an abrupt kill during a write loop', { tags: ['db', 'chaos', 'slow'] }, () => {
  it('leaves an intact database and loses no committed row, twenty times over', async () => {
    // Twenty iterations, as `02` §3.6.3 step 8 asks, each killed at a different point in the WAL
    // so the kill lands in different places relative to a checkpoint. A single iteration would
    // only ever test one of them.
    const outcomes: CrashOutcome[] = [];
    for (let iteration = 0; iteration < 20; iteration += 1) {
      // 40, 60, 80 … rows: enough to have committed, varied enough to move the kill around.
      const after = 40 + iteration * 20;
      // Deliberately serial: each iteration spawns a process and kills it, and running them
      // concurrently would make the kill points meaningless and the machine's load the real
      // variable.
      const outcome = await withSpikeDirAsync((dir) => crashOnce(dir, randomBytes(32), after));
      outcomes.push(outcome);
    }

    // Non-vacuous in both directions: if the writer never committed anything, every assertion
    // below is empty; and if it ran to completion the kill never happened and this is a durability
    // test with no crash in it.
    expect(outcomes).toHaveLength(20);
    expect(Math.min(...outcomes.map((o) => o.committed))).toBeGreaterThanOrEqual(40);
    expect(
      Math.max(...outcomes.map((o) => o.committed)),
      'the writer finished all 100k rows, so it was never actually killed',
    ).toBeLessThan(100_000);

    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.integrity, `iteration ${String(index)}: integrity_check`).toBe('ok');
      expect(
        outcome.missing,
        `iteration ${String(index)}: ${String(outcome.missing.length)} of ` +
          `${String(outcome.committed)} committed rows were lost after SIGKILL`,
      ).toEqual([]);
    }
  });

  it('recovers the WAL on reopen rather than needing a repair step', async () => {
    // The practical question behind step 8: after a kill, does a plain `openDatabase()` just work?
    // If recovery needed an explicit step, every start-up path in the product would have to know
    // about it — and the one that forgot would be the CLI somebody runs at 2am.
    const outcome = await withSpikeDirAsync((dir) => crashOnce(dir, randomBytes(32), 100));
    expect(outcome.integrity).toBe('ok');
    expect(outcome.present).toBeGreaterThanOrEqual(100);
    expect(outcome.missing).toEqual([]);
  });
});
