/**
 * The install-script and native-dependency policy, as code.
 *
 * `pnpm-workspace.yaml` holds the policy pnpm enforces. This module holds the parts a YAML file
 * cannot express, and the expectations that must not drift:
 *
 *   1. The `allowBuilds` map still says what `docs/architecture/native-deps.md` and
 *      `docs/plan/08-security-privacy.md` §3.15 say it says. A silent edit here is how a
 *      non-registry download gets back into the install path.
 *   2. `minimumReleaseAge`, `trustPolicy`, `strictDepBuilds` and `blockExoticSubdeps` are set to
 *      the values `08` §3.15 requires, and `minimumReleaseAgeExclude` is empty.
 *   3. No ONNX Runtime CUDA artefact exists in the installed tree — the thing the denied
 *      `onnxruntime-node` script would have fetched.
 *
 * Run by `pnpm supply:check`, and by the `supply-policy` CI workflow (M0-T12).
 */
import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

/** The policy `08` §3.15 requires, restated so a drift in either direction is a test failure. */
export const REQUIRED_SETTINGS = {
  /** Minutes. 4320 = three days. */
  minimumReleaseAge: 4320,
  trustPolicy: 'no-downgrade',
  strictDepBuilds: true,
  blockExoticSubdeps: true,
  pmOnFail: 'error',
} as const;

/**
 * Every package permitted or denied an install script, and why. Adding an entry here without
 * adding it to `docs/architecture/native-deps.md` fails the drift check, which is deliberate: the
 * reason matters more than the switch.
 */
export const EXPECTED_ALLOW_BUILDS: Readonly<Record<string, boolean>> = {
  '@matrix-org/matrix-sdk-crypto-nodejs': true,
  'onnxruntime-node': false,
  esbuild: true,
};

/** Filename fragments that only ever appear in an ONNX Runtime CUDA execution provider. */
const CUDA_ARTEFACTS = ['libonnxruntime_providers_cuda', 'onnxruntime_providers_cuda'] as const;

export interface PolicyProblem {
  readonly kind: 'setting' | 'allow-builds' | 'cuda-artefact';
  readonly message: string;
}

export function readWorkspacePolicy(path: string): Record<string, unknown> {
  // `merge: false` and the core schema keep anchors and merge keys from smuggling structure past
  // the checks below.
  return parse(readFileSync(path, 'utf8'), { merge: false, schema: 'core' }) as Record<
    string,
    unknown
  >;
}

export function checkSettings(policy: Record<string, unknown>): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  for (const [key, want] of Object.entries(REQUIRED_SETTINGS)) {
    const got = policy[key];
    if (got !== want) {
      problems.push({
        kind: 'setting',
        message: `pnpm-workspace.yaml: ${key} is ${JSON.stringify(got)}, must be ${JSON.stringify(want)} (08 §3.15)`,
      });
    }
  }
  const exclude = policy['minimumReleaseAgeExclude'];
  if (Array.isArray(exclude) && exclude.length > 0) {
    problems.push({
      kind: 'setting',
      message:
        `pnpm-workspace.yaml: minimumReleaseAgeExclude has ${exclude.length} entr(ies). ` +
        'Each one is a package that skips the three-day quarantine, so it needs a linked advisory, ' +
        'two maintainer approvals, and removal once the version ages out (08 §3.15).',
    });
  }
  return problems;
}

export function checkAllowBuilds(policy: Record<string, unknown>): PolicyProblem[] {
  const got = (policy['allowBuilds'] ?? {}) as Record<string, unknown>;
  const problems: PolicyProblem[] = [];
  for (const [pkg, want] of Object.entries(EXPECTED_ALLOW_BUILDS)) {
    if (got[pkg] !== want) {
      problems.push({
        kind: 'allow-builds',
        message: `allowBuilds["${pkg}"] is ${JSON.stringify(got[pkg])}, must be ${String(want)} — see docs/architecture/native-deps.md`,
      });
    }
  }
  for (const pkg of Object.keys(got)) {
    if (!(pkg in EXPECTED_ALLOW_BUILDS)) {
      problems.push({
        kind: 'allow-builds',
        message:
          `allowBuilds has an undocumented entry "${pkg}". Every install script this project runs ` +
          'must be justified in docs/architecture/native-deps.md and listed in EXPECTED_ALLOW_BUILDS.',
      });
    }
  }
  return problems;
}

/** Walk the installed tree looking for the CUDA provider the denied script would have fetched. */
export async function findCudaArtefacts(root: string, maxDepth = 8): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // unreadable or vanished mid-walk; nothing to assert about it
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (CUDA_ARTEFACTS.some((fragment) => entry.includes(fragment))) {
        hits.push(full);
        continue;
      }
      let isDir = false;
      try {
        isDir = (await stat(full)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return hits;
}
