/**
 * `pnpm fixtures:lint` (`06` §3.25; `M3-T9`).
 *
 * A shell around `lint.ts`, kept separate so the scanner is importable by a test without running
 * `process.exit` — the mistake that makes a CI guard untestable and therefore unverified.
 */
import { main } from './lint.js';

process.exitCode = await main(process.argv.slice(2).length > 0 ? process.argv.slice(2) : undefined);
