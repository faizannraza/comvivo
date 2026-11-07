#!/usr/bin/env tsx
/**
 * Rewrite `tsconfig.runtime.json` from `tsconfig.paths.json` (`M1-T14`).
 *
 * See the header of `tsconfig.runtime.json` for why it exists. This script is how it is
 * regenerated; `test/boundaries/depcruise-paths.test.ts` is what notices when it is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePathsEntries } from './paths-tsconfig.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = resolve(REPO_ROOT, 'tsconfig.runtime.json');

/** Everything above the `paths` object, preserved so the file keeps explaining itself. */
function header(existing: string): string {
  const marker = '    "paths": ';
  const index = existing.indexOf(marker);
  if (index === -1) throw new Error('tsconfig.runtime.json has no "paths" key to replace');
  return existing.slice(0, index + marker.length);
}

const existing = readFileSync(TARGET, 'utf8');
const body = JSON.stringify(runtimePathsEntries(REPO_ROOT), null, 6).replaceAll('\n', '\n    ');
writeFileSync(TARGET, `${header(existing)}${body}\n  }\n}\n`);
process.stdout.write('rewrote tsconfig.runtime.json\n');
