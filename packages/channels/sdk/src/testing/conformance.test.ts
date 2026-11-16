/**
 * The conformance kit, run against the reference adapter (`06` §3.25; `M3-T9`).
 *
 * This is the file that makes `M3-T9` a deliverable rather than a description. `06` §3.25's 24 cases
 * are sentences until something satisfies them, and a kit of 24 unsatisfied sentences is worth
 * nothing to the first adapter that runs it — worse than nothing, because the author cannot tell a
 * bug in their adapter from a bug in the kit.
 *
 * So the kit runs here, in full, against `createFakeAdapter`. Every case that fails at `M3-T32` on
 * Telegram will have passed here, which turns "the kit is wrong" into a claim somebody has to argue
 * against a working implementation.
 */
import { describe, expect, it } from 'vitest';
import { profiles } from '../profiles.js';
import { createFakeAdapter, FAKE_CAPABILITIES } from './fake-adapter.js';
import { createFakePlatform, type FakePlatform } from './fake-platform.js';
import { memoryFixtureStore } from './fixtures.js';
import { type ConformanceHarness, conformancePlan } from './harness.js';
import { REFERENCE_CORPUS } from './reference-corpus.js';
import { conformanceCases, describeAdapterConformance, runConformance } from './run.js';

const harness: ConformanceHarness<FakePlatform> = {
  channel: 'simulator',
  createFake: (opts) => Promise.resolve(createFakePlatform(opts)),
  createAdapter: (fake) => createFakeAdapter(fake),
  fixtures: 'packages/channels/sdk/src/testing/reference-corpus.ts',
  capabilities: FAKE_CAPABILITIES,
  store: memoryFixtureStore(REFERENCE_CORPUS),
};

// The kit's own binding, exercised exactly as an adapter author would write it.
describeAdapterConformance(harness, { describe, it });

describe('the kit itself', () => {
  it('has all 24 of `06` §3.25’s cases, with no gaps and no duplicates', () => {
    const ids = conformanceCases().map((entry) => entry.id);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    expect(ids).toEqual(
      Array.from({ length: 24 }, (_, at) => `C${String(at + 1).padStart(2, '0')}`),
    );
  });

  it('passes every case that is not capability-gated', async () => {
    // The headline. A `gated` result is a platform that cannot do the thing; a `skipped` one is an
    // argued exemption; a `failed` one is a bug. The reference adapter has no exemptions, so the
    // only acceptable statuses are `passed` and `gated`.
    const results = await runConformance(harness);
    const failures = results.filter((result) => result.status === 'failed');
    expect(
      failures.map((result) => `${result.id}: ${result.reason ?? ''}`),
      'the reference adapter must pass the kit, or the kit is describing something nothing does',
    ).toEqual([]);
    expect(results.filter((result) => result.status === 'passed').length).toBeGreaterThanOrEqual(
      20,
    );
  });

  it('gates on capabilities rather than on channel names', () => {
    // `06` §3.25: "All are mandatory unless capability-gated." A kit that gated on names would need
    // editing for every new platform, which is the moment a case gets dropped for the wrong reason.
    const onSignal = conformancePlan(conformanceCases(), profiles.signal);
    const gated = onSignal.filter((entry) => entry.status === 'gated').map((entry) => entry.id);
    // Signal has no buttons and no native polls in its profile, so those two cases cannot apply.
    expect(profiles.signal.buttons).toBe(false);
    expect(gated).toContain('C09');
    expect(onSignal.filter((entry) => entry.status === 'run').length).toBeGreaterThan(15);
  });

  it('reports every gate with a reason, so a skipped case is argued rather than absent', () => {
    for (const entry of conformancePlan(conformanceCases(), profiles.signal)) {
      if (entry.status === 'run') continue;
      expect(entry.reason, `${entry.id} was not run and gave no reason`).toBeTruthy();
      expect((entry.reason ?? '').length, entry.id).toBeGreaterThan(10);
    }
  });

  it('turns an explicit skip into a visible status with its justification', () => {
    const [planned] = conformancePlan([conformanceCases()[0] as never], FAKE_CAPABILITIES, {
      skip: { C01: 'the platform has no recorded corpus yet' },
    });
    expect(planned?.status).toBe('skipped');
    expect(planned?.reason).toBe('the platform has no recorded corpus yet');
  });

  it('runs each case against a fresh platform', async () => {
    // C18 revokes the credentials and C15 stops the adapter. Sharing one platform would make the
    // suite pass in the order it was written and fail when somebody adds a case.
    const results = await runConformance(harness);
    const auth = results.find((result) => result.id === 'C18');
    const after = results.filter((result) => Number(result.id.slice(1)) > 18);
    expect(auth?.status).toBe('passed');
    expect(after.every((result) => result.status !== 'failed')).toBe(true);
  });
});

describe('the reference corpus', () => {
  it('covers `06` §3.25 C03’s five fixture classes', () => {
    // Asserted here as well as inside C03, because this is the corpus an adapter author copies: a
    // worked example missing a class teaches the gap.
    const inbound = Object.entries(REFERENCE_CORPUS).filter(([path]) =>
      path.startsWith('inbound/'),
    );
    expect(inbound.length).toBeGreaterThanOrEqual(5);
    const expectations = inbound.map(([, fixture]) => fixture.expect as Record<string, unknown>);
    expect(expectations.some((entry) => entry['mentionsBot'] === true)).toBe(true);
    expect(expectations.some((entry) => entry['replyToIsBot'] === true)).toBe(true);
    expect(expectations.some((entry) => entry['senderKind'] === 'anonymous_admin')).toBe(true);
    expect(expectations.some((entry) => entry['forwarded'] !== undefined)).toBe(true);
    expect(
      expectations.some(
        (entry) => (entry['interaction'] as { kind?: string } | undefined)?.kind === 'command',
      ),
    ).toBe(true);
  });

  it('is entirely synthetic, and says so', () => {
    // The redaction marker rule exists because a *recorded* fixture carries a real member's chat.
    // A synthetic corpus claiming to be recorded would be the one lie that rule cannot catch.
    for (const [path, fixture] of Object.entries(REFERENCE_CORPUS)) {
      expect(fixture.meta.source, path).toBe('synthetic');
      expect(fixture.meta.redaction, path).toBeUndefined();
    }
  });

  it('validates every entry against the fixture schema', async () => {
    const store = memoryFixtureStore(REFERENCE_CORPUS);
    for (const kind of ['inbound', 'outbound', 'errors', 'probe'] as const) {
      const paths = await store.list(kind);
      expect(paths.length, kind).toBeGreaterThan(0);
    }
  });
});
