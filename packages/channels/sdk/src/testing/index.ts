/**
 * `@comvivo/channel-sdk/testing` — the adapter conformance kit (`06` §3.25; `M3-T9`).
 *
 * An adapter is the one part of this product whose correctness cannot be argued from the source: it
 * translates between a platform nobody controls and an envelope this repository defines, and every
 * failure mode is at the seam. `06` §3.25's answer is 24 cases every adapter runs against a fake
 * platform it can drive, and this is them.
 *
 * ## Using it
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * import { describeAdapterConformance } from '@comvivo/channel-sdk/testing';
 *
 * describeAdapterConformance(myHarness, { describe, it });
 * ```
 *
 * The runner is a parameter rather than an import, so installing this package does not install a
 * test runner — see `run.ts` for why that matters to a third-party plugin author.
 *
 * ## What is here
 *
 * | Module | What |
 * |---|---|
 * | `harness.ts` | `ConformanceHarness`, `FakePlatformControl`, the case ids, and the gating |
 * | `cases/*` | C01–C24, each a plain async function that throws on failure |
 * | `run.ts` | Running one case, all of them, or binding them to a runner |
 * | `assert.ts` | The kit's own assertions, so a case does not depend on a runner's `expect` |
 * | `fixtures.ts` | The fixture file shape and the `FixtureStore` port |
 * | `fake-platform.ts` | The reference fake, which the kit's own suite runs against |
 * | `fake-adapter.ts` | The reference adapter, which proves the cases are tests and not sentences |
 *
 * `nodeFixtureStore` is deliberately **not** here: it lives in this repository's `tools/fixtures/`,
 * because a published test kit should not assume Node. `fixtures.ts` explains the reasoning.
 */
export {
  createTestContext,
  type HealthReport,
  type TestContext,
  type TestContextOptions,
} from './adapter-context.js';
export {
  ConformanceFailure,
  check,
  checkEqual,
  checkMatch,
  checkRejects,
  deepEqual,
} from './assert.js';
export { C01, C02, C03, C04, C05, C16, C17, C20, outbound } from './cases/ingest.js';
export { C06, C07, C08, C09, C10, C13, C14, C19 } from './cases/outbound.js';
export { C11, C12, C15, C18, C21, C22, C23, C24 } from './cases/resilience.js';
export {
  createFakeAdapter,
  FAKE_CAPABILITIES,
  type FakeAdapterOptions,
  toChannelError,
} from './fake-adapter.js';
export {
  createFakePlatform,
  type FakeChat,
  type FakeFile,
  type FakePlatform,
  FakePlatformError,
  type FakePlatformOptions,
  type FakeSender,
  type FakeUpdate,
} from './fake-platform.js';
export {
  FIXTURE_KINDS,
  type Fixture,
  type FixtureKind,
  FixtureMetaSchema,
  FixtureSchema,
  type FixtureStore,
  type LoadedFixture,
  loadFixtures,
  memoryFixtureStore,
  parseFixture,
  type Redaction,
  RedactionSchema,
} from './fixtures.js';
export {
  CASE_IDS,
  type CallMatcher,
  type CaseContext,
  type CaseId,
  type ConformanceCase,
  type ConformanceHarness,
  type ConformanceOptions,
  conformancePlan,
  type FakePlatformControl,
  type IngestedItem,
  type LoggedLine,
  matches,
  type PlannedCase,
  type RecordedCall,
} from './harness.js';
export {
  type CaseResult,
  conformanceCases,
  describeAdapterConformance,
  prepareCase,
  runCase,
  runConformance,
  type TestRunner,
} from './run.js';
