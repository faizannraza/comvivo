/**
 * `pnpm supply:lockfile` — the dependency-source half of `sec.supply.policy` (`08` §3.15).
 *
 * The `allowBuilds` and native-artefact half is `check-native.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { exit, stdout } from 'node:process';
import { checkManifests, findExoticResolutions, type Problem, report } from './lockfile-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

const manifests = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '*package.json'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\0')
  .filter((path) => path !== '' && !path.includes('node_modules/'));

const problems: Problem[] = [...checkManifests(ROOT, manifests)];

try {
  problems.push(
    ...findExoticResolutions('pnpm-lock.yaml', readFileSync(`${ROOT}/pnpm-lock.yaml`, 'utf8')),
  );
} catch {
  problems.push({
    file: 'pnpm-lock.yaml',
    detail: 'is missing',
    fix: 'Run `pnpm install` and commit the lockfile. CI installs with `--frozen-lockfile`.',
  });
}

if (problems.length > 0) {
  stdout.write(report(problems));
  exit(1);
}

stdout.write(
  `supply: every dependency in ${String(manifests.length)} manifest${manifests.length === 1 ? '' : 's'} ` +
    'resolves from the registry.\n',
);
