/**
 * CLI for the install-script and native-dependency policy. See `native-policy.ts` for what it
 * checks and why. Exits non-zero on any problem so CI and `pnpm verify` both fail loudly.
 */
import { exit, stdout } from 'node:process';
import {
  checkAllowBuilds,
  checkSettings,
  findCudaArtefacts,
  type PolicyProblem,
  readWorkspacePolicy,
} from './native-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

const policy = readWorkspacePolicy(`${ROOT}/pnpm-workspace.yaml`);
const problems: PolicyProblem[] = [...checkSettings(policy), ...checkAllowBuilds(policy)];

for (const found of await findCudaArtefacts(`${ROOT}/node_modules`)) {
  problems.push({
    kind: 'cuda-artefact',
    message:
      `ONNX Runtime CUDA artefact present: ${found.slice(ROOT.length + 1)}. ` +
      'The onnxruntime-node install script is denied precisely so this never downloads; its ' +
      'presence means the policy was bypassed.',
  });
}

if (problems.length === 0) {
  stdout.write(
    'supply: install-script policy matches 08 §3.15 and docs/architecture/native-deps.md; ' +
      'no ONNX Runtime CUDA artefacts present.\n',
  );
  exit(0);
}

stdout.write(`supply: ${String(problems.length)} policy problem(s).\n\n`);
for (const problem of problems) stdout.write(`  [${problem.kind}] ${problem.message}\n`);
stdout.write('\nSpecification: docs/plan/08-security-privacy.md §3.15.\n');
exit(1);
