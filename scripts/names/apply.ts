/**
 * `pnpm names:apply` — rewrite every legacy distribution name to the current one (`12` §3.1).
 *
 * This is the "final rename" the spec refers to, and the operation `13` §3.A.6's weekly drill
 * exercises: if the project is ever forced to change its name, this plus the `BRAND` constant is
 * the whole job.
 *
 * Idempotent by construction — it rewrites legacy names to current ones, and a current name is not
 * a legacy name. `--check` reports what it would do without writing, which is what the drill runs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { applyTo, namesSchema, stripComments } from './names-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const dryRun = argv.includes('--check');

const parsed = namesSchema.safeParse(
  stripComments(JSON.parse(readFileSync(`${ROOT}/deploy/names.json`, 'utf8'))),
);
if (!parsed.success) {
  stdout.write('names: deploy/names.json is not valid; run `pnpm names:check`.\n');
  exit(1);
}
const names = parsed.data;

/**
 * The manifest is excluded from its own scan: it **declares** the legacy names, so scanning it
 * finds every one of them. Obvious once stated, and found on the first run.
 */
const MANIFEST = 'deploy/names.json';

const SCANNED = [/^deploy\//, /^\.github\//, /package\.json$/, /^pnpm-workspace\.yaml$/];

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\0')
  .filter((path) => path !== '')
  .filter(
    (path) =>
      SCANNED.some((pattern) => pattern.test(path)) &&
      !path.startsWith('docs/') &&
      path !== MANIFEST,
  );

const changed: string[] = [];
for (const path of files) {
  let source: string;
  try {
    source = readFileSync(`${ROOT}/${path}`, 'utf8');
  } catch {
    continue;
  }
  const rewritten = applyTo(source, names);
  if (rewritten === source) continue;
  changed.push(path);
  if (!dryRun) writeFileSync(`${ROOT}/${path}`, rewritten);
}

if (changed.length === 0) {
  stdout.write(`names: nothing to rewrite in ${String(files.length)} files.\n`);
  exit(0);
}

stdout.write(
  `names: ${dryRun ? 'would rewrite' : 'rewrote'} ${String(changed.length)} file(s).\n\n` +
    changed.map((path) => `  ${path}\n`).join('') +
    '\n',
);
exit(dryRun ? 1 : 0);
