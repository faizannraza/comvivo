/**
 * What `claim-worker.mjs` needs, in one module the parent can resolve for it.
 *
 * The indirection is `read-worker.mjs`'s and the reasoning is recorded there: a worker cannot be
 * relied on to have TypeScript loading active for *nested* relative specifiers on every supported
 * Node, so the parent resolves one path — `dist/` when a build exists, source otherwise — and the
 * worker imports that. A static `import … from '../../db/tx.js'` inside the worker is the thing
 * that breaks on the declared Node floor.
 *
 * `Database` is re-exported too, so the worker opens the connection with the same
 * `better-sqlite3-multiple-ciphers` build the parent migrated with. Two copies of a native module
 * in one process is a class of failure worth not inviting into a concurrency test.
 */
export { SystemClock, TypeIdGenerator } from '@comvivo/shared';
export { SeededRng } from '@comvivo/shared/testing';
export { default as Database } from 'better-sqlite3-multiple-ciphers';
export { makeDb } from '../../db/drizzle.js';
export { SqliteStore } from '../../db/tx.js';
export { makeRepositories } from '../index.js';
