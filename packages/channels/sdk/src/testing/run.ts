/**
 * Running the kit (`06` §3.25; `M3-T9`).
 *
 * Three entry points, in increasing convenience: {@link conformanceCases} is the list,
 * {@link runCase} runs one against a fresh fake, and {@link describeAdapterConformance} binds them
 * to a test runner.
 *
 * ## A fresh fake per case, always
 *
 * C18 revokes the credentials. C15 stops the adapter. C12 drains a chat's rate-limit bucket for
 * twenty virtual minutes. Sharing one platform across the 24 would make the suite order-dependent
 * in the worst way — passing in the order it was written and failing when somebody adds a case —
 * so each gets its own fake, adapter, clock and context. It costs nothing: a fake platform is a few
 * maps and a `VirtualClock`.
 *
 * ## Why the runner is a parameter
 *
 * `06` §3.25 types `describeAdapterConformance(h, opts?)` with the test runner implied. It takes the
 * runner explicitly instead, and the reason is the people the kit is for: §3.25's last line asks
 * third-party channel plugins to pass it, and an `import { describe, it } from 'vitest'` inside a
 * published package makes Vitest a dependency of anyone who installs it — including an author using
 * `node:test`, and including the production bundle, where a test runner in the graph is a
 * supply-chain surface for no benefit. The binding is five lines the author writes once. Amended in
 * `06` §3.25 at `M3-T9`.
 */
import { VirtualClock } from '@comvivo/shared/testing';
import { createTestContext } from './adapter-context.js';
import { ConformanceFailure } from './assert.js';
import { C01, C02, C03, C04, C05, C16, C17, C20 } from './cases/ingest.js';
import { C06, C07, C08, C09, C10, C13, C14, C19 } from './cases/outbound.js';
import { C11, C12, C15, C18, C21, C22, C23, C24 } from './cases/resilience.js';
import { memoryFixtureStore } from './fixtures.js';
import {
  type CaseContext,
  type CaseId,
  type ConformanceCase,
  type ConformanceHarness,
  type ConformanceOptions,
  conformancePlan,
  type FakePlatformControl,
} from './harness.js';

/**
 * Enough hops for an adapter's deepest continuation chain; see `CaseContext.settle`.
 *
 * Sixty-four rather than a dozen, because a conformance case drives a **multi-part** send: each
 * part is about six hops through the limiter, the call wrapper and the fake, so three parts already
 * pass sixteen — which is what the kit's first full run reported as "the adapter is still waiting
 * and no timer is pending" on the very first send of C07.
 */
const MICROTASK_HOPS = 64;

/** How many times a stalled chain is given another full settle before it is called stuck. */
const MAX_STALLS = 8;

async function settleMicrotasks(): Promise<void> {
  for (let hop = 0; hop < MICROTASK_HOPS; hop += 1) await Promise.resolve();
}

/** A bound on the timer jumps, so a self-rescheduling loop fails rather than hangs. */
const MAX_CLOCK_STEPS = 20_000;

/**
 * Drive `work` to completion, jumping the clock from one due timer to the next.
 *
 * See `CaseContext.drain` for why this exists. The two failure modes it turns into messages:
 * nothing pending and work unfinished (the adapter is waiting on something real), and a timer loop
 * that never ends (a refresh with no ceiling).
 */
async function drive<T>(clock: VirtualClock, work: Promise<T>): Promise<T> {
  // A holder read through a function, not a bare `let`. TypeScript keeps a local's narrowing across
  // an `await` — it cannot see the mutation happening inside a `.then` — so a direct `if (settled)`
  // is reported as always-falsy by `no-unnecessary-condition`, correctly for the compiler's model
  // and wrongly for the runtime. The call defeats the narrowing without weakening the rule.
  const state = { settled: false };
  const isSettled = (): boolean => state.settled;
  const tracked = work.then(
    (value) => {
      state.settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      state.settled = true;
      return { ok: false as const, error };
    },
  );
  let stalls = 0;
  for (let step = 0; step < MAX_CLOCK_STEPS; step += 1) {
    await settleMicrotasks();
    if (isSettled()) break;
    const due = clock.nextDueAt();
    if (due !== null) {
      stalls = 0;
      await clock.advanceTo(due);
      continue;
    }
    // Nothing pending and nothing finished. Give the continuation chain several more full settles
    // before calling it stuck: the cost is microseconds and the alternative is a correct adapter
    // failing the kit because its chain is one hop longer than a constant.
    stalls += 1;
    if (stalls > MAX_STALLS) {
      throw new Error(
        'the adapter is still waiting and no timer is pending. Something outside the kit — a real ' +
          'socket, a real `setTimeout`, an unresolved promise — is holding it, which is a ' +
          'conformance failure rather than a slow test (`06` §3.25 C15).',
      );
    }
  }
  if (!isSettled()) {
    throw new Error(
      `the adapter was still working after ${String(MAX_CLOCK_STEPS)} timer steps. A refresh loop ` +
        'with no ceiling looks exactly like this.',
    );
  }
  const outcome = await tracked;
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

/** `06` §3.25's 24 cases, in id order. */
export function conformanceCases(): readonly ConformanceCase[] {
  return [
    C01,
    C02,
    C03,
    C04,
    C05,
    C06,
    C07,
    C08,
    C09,
    C10,
    C11,
    C12,
    C13,
    C14,
    C15,
    C16,
    C17,
    C18,
    C19,
    C20,
    C21,
    C22,
    C23,
    C24,
  ];
}

export interface CaseResult {
  readonly id: CaseId;
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'gated' | 'skipped';
  readonly reason: string | null;
  readonly error?: Error;
}

/**
 * Set up a fresh platform and adapter, and hand a case its context.
 *
 * Exported so an adapter author can run one case in isolation while fixing it — which is what
 * somebody does with a conformance failure, and running all 24 to see one is a slow loop.
 */
export async function prepareCase<P extends FakePlatformControl>(
  harness: ConformanceHarness<P>,
  seed = 1,
): Promise<{ readonly ctx: CaseContext<P>; stop(): Promise<void> }> {
  const clock = new VirtualClock();
  const test = createTestContext({ channel: harness.channel, clock });
  // Wired before the adapter exists, so every call it makes — including the ones in `start` — lands
  // in the same ordered trace as the ingests. C05 is an assertion about that order.
  const fake = await harness.createFake({
    clock,
    seed,
    onCall: (call) => {
      test.notePlatformAck(call.method);
    },
  });
  const adapter = harness.createAdapter(fake);
  await adapter.start(test.ctx);
  const ctx: CaseContext<P> = {
    harness,
    fake,
    adapter,
    clock,
    store: harness.store ?? memoryFixtureStore({}),
    context: test.ctx,
    // Arrow-wrapped rather than passed by reference: these are methods on `test`, and
    // `unbound-method` is right that handing one over loses its receiver — harmless here, and the
    // kind of thing that stops being harmless the moment the recorder grows state.
    logs: () => test.logs(),
    ingested: () => test.ingested(),
    trace: () => test.trace(),
    health: () => test.health(),
    settle: settleMicrotasks,
    drain: (work) => drive(clock, work),
  };
  return {
    ctx,
    stop: async () => {
      // `stop` on a fresh adapter is harmless and on a half-failed one is the difference between a
      // suite that finishes and one that hangs on a pending timer.
      try {
        await adapter.stop();
      } catch {
        // A case that already broke the adapter must not also break the teardown.
      }
    },
  };
}

/** Run one case, or report why it did not run. */
export async function runCase<P extends FakePlatformControl>(
  harness: ConformanceHarness<P>,
  entry: ConformanceCase,
  options: ConformanceOptions = {},
): Promise<CaseResult> {
  const [planned] = conformancePlan([entry], harness.capabilities, options);
  if (planned === undefined) {
    return { id: entry.id, name: entry.name, status: 'failed', reason: 'the case was not planned' };
  }
  if (planned.status !== 'run') {
    return { id: entry.id, name: entry.name, status: planned.status, reason: planned.reason };
  }
  const prepared = await prepareCase(harness);
  try {
    await entry.run(prepared.ctx);
    return { id: entry.id, name: entry.name, status: 'passed', reason: null };
  } catch (error) {
    return {
      id: entry.id,
      name: entry.name,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      error:
        error instanceof Error
          ? error
          : new ConformanceFailure(entry.id, `threw a non-error: ${String(error)}`),
    };
  } finally {
    await prepared.stop();
  }
}

/** Run all 24 and report. For a milestone report, and for a CI job that wants one summary line. */
export async function runConformance<P extends FakePlatformControl>(
  harness: ConformanceHarness<P>,
  options: ConformanceOptions = {},
): Promise<readonly CaseResult[]> {
  const out: CaseResult[] = [];
  for (const entry of conformanceCases()) out.push(await runCase(harness, entry, options));
  return out;
}

/** The two functions a test runner has to provide. Vitest, Jest and `node:test` all do. */
export interface TestRunner {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

/**
 * Bind the kit to a runner (`06` §3.25's `describeAdapterConformance`).
 *
 * One `it` per case, so a failure names the case and the other 23 still run — which is the whole
 * value of a conformance suite over a single integration test. A gated or skipped case gets an `it`
 * that asserts nothing and says why in its name, rather than being absent: `06` §3.25's point is
 * that a skip is **visible**, and a test that silently does not exist is the opposite of that.
 */
export function describeAdapterConformance<P extends FakePlatformControl>(
  harness: ConformanceHarness<P>,
  runner: TestRunner,
  options: ConformanceOptions = {},
): void {
  runner.describe(`channel conformance: ${harness.channel}`, () => {
    for (const entry of conformanceCases()) {
      const [planned] = conformancePlan([entry], harness.capabilities, options);
      const label =
        planned === undefined || planned.status === 'run'
          ? `${entry.id} — ${entry.name}`
          : `${entry.id} — ${entry.name} [${planned.status}: ${planned.reason ?? ''}]`;
      runner.it(label, async () => {
        const result = await runCase(harness, entry, options);
        if (result.error !== undefined) throw result.error;
      });
    }
  });
}
