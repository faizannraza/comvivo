/**
 * The recorder the `node:fs` mock writes into (`M1-T27` AC's "no plaintext temp files (fs spy)").
 *
 * A module of its own because of how ESM mocking works: `vi.spyOn(fs, 'createWriteStream')` fails
 * with *Module namespace is not configurable in ESM*, so the spy has to be a `vi.mock('node:fs')`
 * factory — and a factory is hoisted above every other statement in its file, so it cannot close
 * over a local array. It can import one.
 */

/** Every path opened for writing since the last `resetWriteLog`. */
export const writeLog: string[] = [];

export function resetWriteLog(): void {
  writeLog.length = 0;
}

export function recordWrite(path: unknown): void {
  writeLog.push(String(path));
}
