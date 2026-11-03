/**
 * Tests for the literal-secret guard.
 *
 * Every canary here is assembled at runtime from separate literals — the same discipline the guard
 * enforces. That makes this file its own first test case: if the guard's advice did not work, this
 * file could not exist, because `pnpm secrets:check` scans it along with everything else.
 */
import { describe, expect, it } from 'vitest';
import { EXEMPT, explain, findInSource, isScanned, SECRET_SHAPES } from './literal-secrets.js';

/** Shapes the guard must catch, built from pieces so none appears verbatim in this source. */
const SHOULD_CATCH: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'Slack bot token', value: `xoxb${'-'}${['123456789012', 'ABCDEFGHIJKL'].join('-')}` },
  { label: 'Slack user token', value: `xoxp${'-'}${['987654321098', 'ZYXWVUTSRQPO'].join('-')}` },
  {
    label: 'Slack app token',
    value: `xapp${'-'}${['1', 'A12BC34DE56', '1234567890123', 'abcdef0123456789'].join('-')}`,
  },
  {
    label: 'Anthropic key',
    value: `${['sk', 'ant', 'api03'].join('-')}-NotARealKeyAtAll_01234567`,
  },
  { label: 'OpenAI key', value: `sk${'-'}${'A'.repeat(20)}${'b7Qx'.repeat(4)}` },
  { label: 'Google key', value: `AIza${'Sy'}${'D'.repeat(16)}${'_fake-key-here'}` },
  { label: 'Telegram token', value: `${'123456789'}:${'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'}` },
  { label: 'Matrix token', value: `syt_${'YWRtaW4'}${'_'}${'zZmFrZXRva2VuMTIzNA'}` },
  { label: 'GitHub PAT', value: `ghp_${'x'.repeat(36)}` },
  { label: 'AWS key id', value: `AKIA${'IOSFODNN7EXAMPLE'}` },
  { label: 'private key header', value: `-----BEGIN ${'RSA'} PRIVATE KEY-----` },
];

/**
 * Shapes the guard must **not** catch.
 *
 * This half matters more than the other. A guard in `pnpm verify` that fires on ordinary code gets
 * disabled within a week, and then it protects nothing at all.
 */
const SHOULD_ALLOW: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'a TypeID', value: 'msg_01jfgh2k3m4n5p6q7r8s9t0v' },
  { label: 'a UUID', value: '018fe4a1-7c3d-7000-8000-5f2a9b4c1d6e' },
  { label: 'a git SHA', value: 'ec386f0a1b2c3d4e5f60718293a4b5c6d7e8f901' },
  {
    label: 'a lockfile integrity hash',
    value: 'sha512-AbCdEf0123456789+/aBcDeF9876543210abcdefABCDEF==',
  },
  { label: 'a timestamp with a colon', value: '2026-11-03T12:34:56.789Z' },
  {
    label: 'a base64 image prefix',
    value: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
  },
  {
    label: 'a long import path',
    value: "import { x } from '@comvivo/shared/src/logger/ring-buffer.js';",
  },
  { label: 'the redaction sentinel', value: 'const REDACTED = "[redacted]";' },
  {
    label: 'a Tailwind class list',
    value: 'class="flex min-h-0 flex-1 items-center gap-2 rounded-md"',
  },
  { label: 'an env var name', value: 'COMVIVO_ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic' },
  { label: 'a docker digest', value: 'ghcr.io/faizannraza/comvivo@sha256:' + 'a'.repeat(64) },
];

describe('SECRET_SHAPES', () => {
  it('catches every shape a scanner would block', () => {
    for (const { label, value } of SHOULD_CATCH) {
      const findings = findInSource('packages/x/src/fixture.ts', `const t = '${value}';`);
      expect(findings.length, `${label} was not caught: ${value.slice(0, 12)}…`).toBeGreaterThan(0);
    }
  });

  it('leaves ordinary code alone', () => {
    for (const { label, value } of SHOULD_ALLOW) {
      const findings = findInSource('packages/x/src/real.ts', value);
      expect(findings, `${label} is a false positive: ${value.slice(0, 40)}`).toEqual([]);
    }
  });

  it('reports the line number, so the message is actionable', () => {
    const source = ['// one', '// two', `const t = '${SHOULD_CATCH[0]?.value ?? ''}';`].join('\n');
    const findings = findInSource('a.ts', source);
    expect(findings[0]?.line).toBe(3);
  });

  it('uses patterns anchored on a distinctive prefix or separator', () => {
    // Guards against someone adding a pure-entropy pattern later: those cannot distinguish a key
    // from a hash, and a false positive here blocks a commit.
    for (const { name, pattern } of SECRET_SHAPES) {
      const source = pattern.source;
      const hasAnchor = /^[A-Za-z-]{2,}|\\-|:|-----/.test(source);
      expect(hasAnchor, `${name} has no distinctive prefix: ${source}`).toBe(true);
    }
  });
});

describe('isScanned', () => {
  it.each([
    ['packages/shared/src/logger/scrub.test.ts', true],
    ['apps/dashboard/src/routes/settings.tsx', true],
    ['.github/workflows/ci.yml', true],
    ['package.json', true],
    ['.env.example', true],
    ['scripts/deploy.sh', true],
  ])('scans %s', (path, expected) => {
    expect(isScanned(path)).toBe(expected);
  });

  it.each([
    // The two files that must name these shapes to do their job.
    ['scripts/security/literal-secrets.ts', false],
    ['packages/shared/src/logger/scrub.ts', false],
    ['docs/plan/08-security-privacy.md', false],
    // Not source.
    ['README.md', false],
    ['assets/logo.svg', false],
  ])('skips %s', (path, expected) => {
    expect(isScanned(path)).toBe(expected);
  });

  it('keeps the exemption list short', () => {
    // Each exemption is a file where a real credential could sit unnoticed. If this number grows,
    // the reason had better be in the commit message.
    expect(EXEMPT.length).toBeLessThanOrEqual(4);
  });
});

describe('explain', () => {
  it('tells the reader what to do instead, not just that it failed', () => {
    const message = explain([{ file: 'a.ts', line: 7, shape: 'Slack token' }]);
    expect(message).toContain('a.ts:7');
    expect(message).toContain('rotate it');
    expect(message).toContain('assemble it at runtime');
    expect(message).toContain('scrub.test.ts');
  });
});
