/**
 * Prompt assertions over a `FakeModelGateway`'s captured calls (`05` §3.5.7; `M2-T7`).
 *
 * These are the point of keeping `fake.calls`. A unit test of the context builder can show that it
 * *chose* the right items; only an assertion over the request that was actually composed can show
 * that nothing else got in. `expectNoReadUp` is the one that matters most — it is invariant **I1**
 * (no read-up) checked at the only place where the whole prompt exists as one value.
 *
 * Every function throws an `Error` with the offending call's index and purpose. They are not
 * Vitest matchers on purpose: the simulator scenarios (`11` §3.5) run them outside a test file,
 * and a matcher that only works inside `expect` would be unavailable exactly where a scenario
 * needs it.
 */
import type {
  Audience,
  GroupSnapshot,
  Label,
  ModelTurnRequest,
  ReadEligibility,
  StructuredRequest,
} from '@comvivo/core';
import { canonicalJson } from '@comvivo/shared';

type AnyCall = ModelTurnRequest | StructuredRequest<unknown>;

function turnCallsOf(calls: readonly AnyCall[]): readonly ModelTurnRequest[] {
  return calls.filter((call): call is ModelTurnRequest => 'messages' in call);
}

function fail(index: number, call: AnyCall, detail: string): never {
  throw new Error(
    `call #${String(index)} (route "${call.route}", purpose "${call.purpose}"): ${detail}`,
  );
}

/**
 * Every call's system prompt serialises to the same bytes.
 *
 * The cache prefix is the system prompt, so a byte that moves between turns is a cache miss on
 * every turn of every group — the costliest kind of regression because nothing fails, the bill
 * just goes up. A timestamp or an unsorted map in a system layer is exactly how it happens.
 */
export function expectSystemBytesStable(calls: readonly AnyCall[]): void {
  let first: string | undefined;
  for (const [index, call] of calls.entries()) {
    const bytes = canonicalJson(
      call.system.map((block) => ({
        id: block.id,
        text: block.text,
        ...(block.cache === undefined ? {} : { ttl: block.cache.ttl }),
      })),
    );
    if (first === undefined) {
      first = bytes;
      continue;
    }
    if (bytes !== first) {
      fail(
        index,
        call,
        'the system prompt differs from the first call’s. Any byte that changes between turns ' +
          'invalidates the cached prefix on every turn — look for a timestamp, a set iterated in ' +
          'hash order, or a tool list assembled non-deterministically.',
      );
    }
  }
}

/**
 * **Removed at the M2 second-pass review**: `expectNoSamplingParams` could only ever lie.
 *
 * It scanned `JSON.stringify(call)` for `"temperature"` and friends, over an `AnyCall` — which is a
 * **port-level** `ModelTurnRequest` or `StructuredRequest`. The port has no field for a sampling
 * parameter; that is `01` §2.1's first and cheapest guard, and `model.ts`'s header says so. So the
 * check could not fail for the reason it claimed, and the only thing it could match was a tool's
 * own JSON. The review reproduced it with `10` §4's own Home Assistant example:
 *
 *     tool { name: 'set_temperature', inputSchema: { properties: { temperature: {...} } } }
 *     → "call #0 (route \"chat\"…): carries `temperature`, which 01 §2.1 forbids"
 *
 * A guard that fires on correct code and cannot fire on the fault is worse than none: the first
 * person to hit it deletes it, and takes the real guards' credibility with it.
 *
 * §2.1's runtime enforcement lives where the request is actually built — each adapter's
 * `assertWireInvariants` over its own params, and `testing/adapter-contract.ts`'s
 * `forbiddenKeysPresent` lens over bodies captured off the wire by `FakeProviderServer`. Those see
 * the object that reaches the provider, which is the only object that can carry one.
 */

/**
 * Every round's `tool_result`s arrive in one user message.
 *
 * Splitting them trains the model to stop calling tools in parallel — a quality regression with no
 * error attached, which is why it is asserted rather than hoped for.
 */
export function expectToolResultsInSingleMessage(calls: readonly AnyCall[]): void {
  for (const [index, call] of turnCallsOf(calls).entries()) {
    let seenResults = false;
    for (const message of call.messages) {
      if (message.role === 'assistant') {
        seenResults = false;
        continue;
      }
      if (message.role !== 'user') continue;
      const results = message.content.filter((part) => part.type === 'tool_result');
      if (results.length === 0) continue;
      if (seenResults) {
        fail(index, call, 'tool results are split across more than one user message');
      }
      seenResults = true;
    }
  }
}

export interface ReadUpCheck {
  readonly audience: Audience;
  /** Interned label id → label. `ContextManifest.labelIds` holds the ids; only the caller has the map. */
  readonly labels: ReadonlyMap<number, Label>;
  readonly snapshot: GroupSnapshot;
  /** `StubInformationFlow` until `M5-T1` replaces it with the real lattice. */
  readonly ifc: ReadEligibility;
}

/**
 * Invariant **I1**: every label in the context manifest is readable by the turn's audience.
 *
 * This is the assertion the I1 property test drives. It reads `meta.manifest.labelIds` — the field
 * that exists for exactly this purpose and is never sent to a provider — and asks `canRead` about
 * each one. A missing manifest is a failure, not a pass: a turn whose context was not recorded is
 * a turn nobody can audit, and treating that as "nothing to check" is how the invariant quietly
 * stops being enforced.
 */
export function expectNoReadUp(calls: readonly AnyCall[], check: ReadUpCheck): void {
  for (const [index, call] of turnCallsOf(calls).entries()) {
    const manifest = call.meta?.manifest;
    if (manifest === undefined) {
      fail(
        index,
        call,
        'has no `meta.manifest`, so its context cannot be audited. The context builder must record ' +
          'what it included before I1 can be checked.',
      );
    }
    for (const labelId of manifest.labelIds) {
      const label = check.labels.get(labelId);
      if (label === undefined) {
        fail(index, call, `manifest names label ${String(labelId)}, which is not in the label map`);
      }
      if (!check.ifc.canRead(label, check.audience, check.snapshot)) {
        fail(
          index,
          call,
          `manifest includes label ${String(labelId)}, which this audience may not read (I1)`,
        );
      }
    }
  }
}

/**
 * Some call carries a system note containing `needle`.
 *
 * `05` §3.4's turn notes are operator text in a `role: 'system'` message. The assertion is "some
 * call", not "every call": a note is added for a reason that applies to one turn.
 */
export function expectTurnNotesContain(calls: readonly AnyCall[], needle: string): void {
  const found = turnCallsOf(calls).some((call) =>
    call.messages.some(
      (message) =>
        message.role === 'system' && message.kind !== 'effort' && message.text.includes(needle),
    ),
  );
  if (!found) {
    throw new Error(
      `no call carried a system note containing ${JSON.stringify(needle)}. ` +
        `${String(turnCallsOf(calls).length)} turn call(s) were captured.`,
    );
  }
}

/** Every effort level the gateway was asked for, in call order. Useful for an effort-strategy test. */
export function effortsRequested(calls: readonly AnyCall[]): readonly string[] {
  return calls.map((call) => call.effort);
}
