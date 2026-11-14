/**
 * The prompt assertions (`11` §3.2.4).
 *
 * This file had **no tests at all** until the M2 second-pass review, and the coverage config
 * excludes every `testing` directory — so nothing measured whether any of it worked. That is bad
 * for two reasons at once: one function was wrong in a way that could only fire on correct code
 * (`expectNoSamplingParams`, now removed; see `assertions.ts`), and `expectNoReadUp` is the
 * assertion `M5`'s invariant **I1** property test is specified to drive. An untested assertion
 * that an invariant holds is a test that passes.
 *
 * So each one is driven through both outcomes: the thing it exists to catch, and a correct input
 * it must not reject.
 */

import { type Audience, type GroupSnapshot, type Label, StubInformationFlow } from '@comvivo/core';
import type { GroupId, MemberId } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { turnRequest } from '../anthropic/testing/fixtures.js';
import {
  effortsRequested,
  expectNoReadUp,
  expectSystemBytesStable,
  expectToolResultsInSingleMessage,
  expectTurnNotesContain,
} from './assertions.js';

const GROUP = 'grp_01jc000000000000000000' as GroupId;
const ANA = 'mbr_01jc00000000000000000a' as MemberId;
const BEN = 'mbr_01jc00000000000000000b' as MemberId;

const SNAPSHOT: GroupSnapshot = { groupId: GROUP, membershipEpoch: 1, memberIds: [ANA, BEN] };
const GROUP_AUDIENCE: Audience = { kind: 'group', groupId: GROUP };
const ANA_ONLY: Audience = { kind: 'members', groupId: GROUP, memberIds: [ANA] };

function label(readers: Audience, owner: MemberId | 'group' = 'group'): Label {
  return {
    groupId: GROUP,
    readers,
    owner,
    coOwners: [],
    sensitivity: 'normal',
    influence: 'none',
    untrusted: false,
  };
}

/** A turn request carrying a context manifest, which is what `expectNoReadUp` reads. */
function withManifest(labelIds: readonly number[]) {
  return turnRequest({
    meta: {
      manifest: {
        labelIds: [...labelIds],
        messageIds: [],
        memoryIds: [],
        entityRefs: [],
        tokenEstimate: 0,
        contextHash: 'c0ffee',
      },
    },
  });
}

describe('expectNoReadUp — invariant I1', () => {
  it('passes when every label in the manifest is readable by the audience', () => {
    expect(() =>
      expectNoReadUp([withManifest([1])], {
        audience: GROUP_AUDIENCE,
        labels: new Map([[1, label(GROUP_AUDIENCE)]]),
        snapshot: SNAPSHOT,
        ifc: StubInformationFlow,
      }),
    ).not.toThrow();
  });

  it('fails on a label the audience may not read, which is the read-up it exists to catch', () => {
    // Ana's private label in a turn whose audience is the whole group. This is I1's failure in its
    // simplest form, and the assertion `M5`'s property test drives over generated audiences.
    expect(() =>
      expectNoReadUp([withManifest([1])], {
        audience: GROUP_AUDIENCE,
        labels: new Map([[1, label(ANA_ONLY, ANA)]]),
        snapshot: SNAPSHOT,
        ifc: StubInformationFlow,
      }),
    ).toThrow(/may not read \(I1\)/);
  });

  it('fails on a turn with no manifest, rather than reading it as nothing to check', () => {
    // The distinction the doc comment makes and nothing verified: a turn whose context was never
    // recorded is a turn nobody can audit, and a passing assertion over it would make I1 stop
    // being enforced exactly where the context builder is broken.
    expect(() =>
      expectNoReadUp([turnRequest()], {
        audience: GROUP_AUDIENCE,
        labels: new Map(),
        snapshot: SNAPSHOT,
        ifc: StubInformationFlow,
      }),
    ).toThrow(/no `meta.manifest`/);
  });

  it('fails on a manifest naming a label the caller did not supply', () => {
    // Not a pass: an unknown id means the manifest and the label map disagree, and deciding I1
    // from a map that is missing entries is deciding it from incomplete evidence.
    expect(() =>
      expectNoReadUp([withManifest([7])], {
        audience: GROUP_AUDIENCE,
        labels: new Map([[1, label(GROUP_AUDIENCE)]]),
        snapshot: SNAPSHOT,
        ifc: StubInformationFlow,
      }),
    ).toThrow(/not in the label map/);
  });
});

describe('expectSystemBytesStable', () => {
  it('passes when every call sends the same system prompt', () => {
    const call = turnRequest();
    expect(() => expectSystemBytesStable([call, turnRequest()])).not.toThrow();
  });

  it('fails when one byte of it changed, and says why that costs money', () => {
    const drifted = turnRequest({ system: [{ id: 'charter', text: 'You are helpful. ' }] });
    expect(() => expectSystemBytesStable([turnRequest(), drifted])).toThrow(
      /invalidates the cached prefix/,
    );
  });
});

describe('expectToolResultsInSingleMessage', () => {
  it('passes when a round’s results arrive together', () => {
    const call = turnRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', provider: 'anthropic', servedModel: 'm', raw: [], view: [] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolCallId: 'a', content: 'ok', isError: false },
            { type: 'tool_result', toolCallId: 'b', content: 'ok', isError: false },
          ],
        },
      ],
    });
    expect(() => expectToolResultsInSingleMessage([call])).not.toThrow();
  });

  it('fails when they are split across two messages', () => {
    // `01` §2.1: splitting them trains the model to stop calling tools in parallel — a quality
    // regression with no error attached, which is why it is asserted rather than hoped for.
    const call = turnRequest({
      messages: [
        { role: 'assistant', provider: 'anthropic', servedModel: 'm', raw: [], view: [] },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolCallId: 'a', content: 'ok', isError: false }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolCallId: 'b', content: 'ok', isError: false }],
        },
      ],
    });
    expect(() => expectToolResultsInSingleMessage([call])).toThrow();
  });
});

describe('expectTurnNotesContain and effortsRequested', () => {
  it('finds a note in a system message, and reports the efforts asked for', () => {
    const call = turnRequest({
      messages: [
        { role: 'system', kind: 'notes', text: 'Ana is away until Tuesday.', scope: 'turn' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    });
    expect(() => expectTurnNotesContain([call], 'away until Tuesday')).not.toThrow();
    expect(() => expectTurnNotesContain([call], 'never written')).toThrow(/no call carried/);
    expect(effortsRequested([call, turnRequest({ effort: 'high' })])).toEqual(['medium', 'high']);
  });
});
