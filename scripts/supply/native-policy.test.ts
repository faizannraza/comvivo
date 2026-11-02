/**
 * The supply-chain policy has to be checked, not trusted. These tests assert the real
 * `pnpm-workspace.yaml` satisfies `08` §3.15, and that each check fails when the policy is
 * weakened — a check that cannot fail is not a check.
 */
import { describe, expect, it } from 'vitest';
import {
  checkAllowBuilds,
  checkSettings,
  EXPECTED_ALLOW_BUILDS,
  REQUIRED_SETTINGS,
  readWorkspacePolicy,
} from './native-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const real = readWorkspacePolicy(`${ROOT}/pnpm-workspace.yaml`);

describe('the real pnpm-workspace.yaml', () => {
  it('satisfies every setting 08 §3.15 requires', () => {
    expect(checkSettings(real)).toEqual([]);
  });

  it('quarantines new releases for three days', () => {
    // The unit is minutes, which is easy to get wrong by a factor of 60.
    expect(real['minimumReleaseAge']).toBe(60 * 24 * 3);
  });

  it('grants no exemptions from the quarantine', () => {
    expect(real['minimumReleaseAgeExclude']).toEqual([]);
  });

  it('allows exactly the documented install scripts and no others', () => {
    expect(checkAllowBuilds(real)).toEqual([]);
    expect(real['allowBuilds']).toEqual(EXPECTED_ALLOW_BUILDS);
  });

  it('denies the ONNX Runtime CUDA download', () => {
    // The one entry whose *value* is the point: `false` is an explicit deny, not an omission.
    expect((real['allowBuilds'] as Record<string, unknown>)['onnxruntime-node']).toBe(false);
  });

  it('declares the workspace globs that pick up future plugin packages', () => {
    expect(real['packages']).toContain('packages/plugins/*');
  });
});

describe('the checks fail when the policy is weakened', () => {
  it('catches a shortened quarantine', () => {
    const problems = checkSettings({ ...real, minimumReleaseAge: 60 });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('minimumReleaseAge');
  });

  it('catches trustPolicy being switched off', () => {
    expect(checkSettings({ ...real, trustPolicy: 'off' })[0]?.message).toContain('trustPolicy');
  });

  it('catches strictDepBuilds being switched off, which would silently skip builds', () => {
    expect(checkSettings({ ...real, strictDepBuilds: false })[0]?.message).toContain(
      'strictDepBuilds',
    );
  });

  it('catches a missing setting as firmly as a wrong one', () => {
    const { blockExoticSubdeps: _omitted, ...without } = real;
    expect(checkSettings(without)[0]?.message).toContain('blockExoticSubdeps');
  });

  it('catches an exemption being added to the quarantine', () => {
    const problems = checkSettings({ ...real, minimumReleaseAgeExclude: ['left-pad@1.3.0'] });
    expect(problems.some((p) => p.message.includes('advisory'))).toBe(true);
  });

  it('catches a new install script being allowed without documentation', () => {
    const problems = checkAllowBuilds({
      ...real,
      allowBuilds: { ...EXPECTED_ALLOW_BUILDS, 'some-new-native-thing': true },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('undocumented entry');
  });

  it('catches the ONNX Runtime deny being flipped to an allow', () => {
    const problems = checkAllowBuilds({
      ...real,
      allowBuilds: { ...EXPECTED_ALLOW_BUILDS, 'onnxruntime-node': true },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('onnxruntime-node');
  });

  it('catches an expected entry being dropped entirely', () => {
    const { 'onnxruntime-node': _dropped, ...rest } = EXPECTED_ALLOW_BUILDS;
    const problems = checkAllowBuilds({ ...real, allowBuilds: rest });
    expect(problems).toHaveLength(1);
  });

  it('keeps REQUIRED_SETTINGS and the real file in agreement about which keys matter', () => {
    for (const key of Object.keys(REQUIRED_SETTINGS)) {
      expect(real, `pnpm-workspace.yaml is missing ${key}`).toHaveProperty(key);
    }
  });
});
