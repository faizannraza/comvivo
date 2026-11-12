/**
 * Where the committed migrations live, resolved from this module's own location.
 *
 * Its own file because three modules need it — the test kit, the snapshot seeder and the crash
 * runner — and each computing its own `../..` chain is how one of them ends up pointing at the
 * wrong directory after a file moves.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
