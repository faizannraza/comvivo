/**
 * A real, private, throwaway `keys/` directory for one test.
 *
 * A scope guard rather than a `beforeEach`/`afterEach` pair holding module-level `let`s. Two
 * reasons, and the second is the one that made this a file:
 *
 *  - the resource's lifetime becomes visible at the use site, so a test cannot accidentally read a
 *    directory a previous test created, and `scripts/hygiene/check.ts` is right to refuse the
 *    module-level form;
 *  - `M1-T6` (recovery-key codec) and `M1-T7` (the database) need exactly this, and a helper that
 *    already removes its directory on the failure path is worth sharing rather than retyping.
 *
 * `await`ed inside the `try`, not returned from it: a synchronous `finally` around asynchronous
 * work removes the directory the moment the promise is *created*, which is how the storage spike's
 * crash test deleted its own database before the child process opened it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';

/**
 * Run `fn` with a fresh `<tmp>/<slug>-keyring-XXXX/keys` path, then remove the whole tree.
 *
 * The `keys` directory is deliberately **not** created: `12` §3.7 requires `KeyringStore` to
 * create it 0700 itself, and a test that pre-created it would never check that.
 */
export async function withKeysDir<T>(fn: (keysDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `${BRAND.slug}-keyring-`));
  try {
    return await fn(join(root, 'keys'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
