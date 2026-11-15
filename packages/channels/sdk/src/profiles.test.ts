/**
 * The capability profiles (`M3-T2`'s AC: "profiles match `06` §3.2").
 *
 * Two kinds of assertion, and the second is the one that will catch a real drift.
 *
 * **Structural**, here: the pairings and totals that must hold whatever the platforms do — every
 * profile parses, `signal` is the only byte-counted one, `matrix` and `signal` have no buttons.
 * These say the data is self-consistent.
 *
 * **Against the plan**, in `test/plan/channel-profiles.test.ts`: the numbers in `06` §3.2's table
 * compared cell by cell against the constants. That file reads the markdown, which needs
 * `node:fs`, which this package may not have — the same split the built-in tool catalogue uses
 * (`test/plan/builtin-catalog.test.ts`). The split matters because §3.2 carries a **source link
 * per cell** — the Bot API changelog, signal-cli's own source — so the table is the citation and
 * the constants are the data, and a test that only checked the data against itself would let both
 * drift together.
 */
import { describe, expect, it } from 'vitest';
import { ChannelCapabilitiesSchema, PROFILE_NAMES, profiles } from './index.js';

describe('the profile set', () => {
  it('has the seven 06 §4.1 names, and `ideal` is one of them', () => {
    expect([...PROFILE_NAMES].toSorted()).toEqual([
      'discord',
      'ideal',
      'matrix',
      'signal',
      'slack',
      'telegram',
      'web',
    ]);
  });

  it('parses every profile against the schema', () => {
    for (const name of PROFILE_NAMES) {
      expect(ChannelCapabilitiesSchema.safeParse(profiles[name]).success, name).toBe(true);
    }
  });

  it('is frozen, so a test or an adapter cannot edit a shared profile', () => {
    // These are module-level constants shared by every adapter and the simulator. One adapter
    // mutating `profiles.telegram.maxMessageChars` would change what every other one measures
    // against, in a way no test would attribute correctly.
    expect(Object.isFrozen(profiles)).toBe(true);
    for (const name of PROFILE_NAMES) expect(Object.isFrozen(profiles[name]), name).toBe(true);
  });
});

describe('the differences that the product actually branches on', () => {
  it('counts Signal in UTF-8 bytes and everything else in UTF-16', () => {
    // The single most consequential cell in §3.2. Signal's limit is 2 000 **bytes**, which is
    // roughly 500 characters of Arabic or Japanese — so a splitter that measured UTF-16 here
    // would build messages the platform refuses, for exactly the groups least able to work
    // around it.
    expect(profiles.signal.lengthUnit).toBe('utf8-bytes');
    expect(profiles.signal.maxMessageChars).toBe(2_000);
    const utf16 = PROFILE_NAMES.filter((name) => profiles[name].lengthUnit === 'utf16');
    expect(utf16).toHaveLength(PROFILE_NAMES.length - 1);
  });

  it('gives Matrix and Signal no buttons, which is why the choice fallback exists', () => {
    // `M3-T6`'s `renderChoiceFallback` turns a choice into reactions plus numbered text. Its
    // reason for existing is these two cells.
    expect(profiles.matrix.buttons).toBe(false);
    expect(profiles.matrix.buttonLimits).toBeNull();
    expect(profiles.signal.buttons).toBe(false);
    expect(profiles.signal.buttonLimits).toBeNull();
  });

  it('sizes Telegram’s button token in bytes, not characters', () => {
    // `callback_data` is 1–64 **bytes**, and an interaction token is base64url — so the budget is
    // exact and a token one byte over is a button the platform refuses to attach.
    expect(profiles.telegram.buttonLimits?.tokenMaxBytes).toBe(64);
  });

  it('leaves Slack and Matrix polls emulated, and Signal’s off until SP-8', () => {
    // Slack has no polls at all. Matrix's are an unstable MSC. Signal's are native in signal-cli
    // 0.14.9 and stay off until SP-8 passes (`01` §14 A28): an unproven native path is worse than
    // a working emulation.
    expect(profiles.slack.nativePolls).toBe(false);
    expect(profiles.matrix.nativePolls).toBe(false);
    expect(profiles.signal.nativePolls).toBe(false);
    expect(profiles.telegram.nativePolls).toBe(true);
    expect(profiles.discord.nativePolls).toBe(true);
  });

  it('marks Telegram inbound deletes absent, because the Bot API has no such update', () => {
    // A deleted message stays in our history until something else contradicts it, which the
    // engine has to know rather than assume.
    expect(profiles.telegram.inboundDeletes).toBe(false);
    expect(profiles.telegram.inboundEdits).toBe(true);
  });

  it('names the mass-mention tokens each platform needs neutralised', () => {
    // `08` PSC-9 S6. The injection is in the **content** — a model asked to summarise a message
    // containing `@everyone` would otherwise notify a whole server — so the fix is in the
    // renderer, and the renderer reads this list.
    expect(profiles.discord.massMentionTokens).toEqual(['@everyone', '@here']);
    expect(profiles.slack.massMentionTokens).toEqual(['<!channel>', '<!here>', '<!everyone>']);
    expect(profiles.matrix.massMentionTokens).toEqual(['@room']);
    // Telegram and Signal have no such token, and saying so explicitly is what stops a renderer
    // from inventing one.
    expect(profiles.telegram.massMentionTokens).toEqual([]);
    expect(profiles.signal.massMentionTokens).toEqual([]);
  });

  it('marks Matrix and Signal link previews client-side, which we cannot suppress', () => {
    // `08` PSC-9 S5. On these two the decision belongs to each member's client, so a URL in a
    // reply may render a preview the group did not ask for — an egress of the linked page's
    // content. The renderer cannot prevent it and the capability says so rather than pretending.
    expect(profiles.matrix.linkPreviewControl).toBe('client-side');
    expect(profiles.signal.linkPreviewControl).toBe('client-side');
    expect(profiles.telegram.linkPreviewControl).toBe('per-message');
  });

  it('gives Telegram the only delete window', () => {
    // 48 hours. After that an own message cannot be deleted, which the retention job has to know.
    expect(profiles.telegram.deleteWindowSec).toBe(172_800);
    for (const name of PROFILE_NAMES.filter((candidate) => candidate !== 'telegram')) {
      expect(profiles[name].deleteWindowSec, name).toBeNull();
    }
  });

  it('makes `ideal` strictly the most capable, which is what makes it a control', () => {
    // A test that fails under `ideal` has found a bug in the product; one that passes under
    // `ideal` and fails under `signal` has found a degradation path that does not work. The
    // second answer is only meaningful if `ideal` really is a ceiling.
    const booleans = [
      'threads',
      'reactions',
      'edits',
      'deletes',
      'nativePolls',
      'buttons',
      'typingIndicator',
      'voiceNotes',
      'images',
      'files',
      'mentionsByUserId',
      'inboundEdits',
      'inboundDeletes',
      'silentSend',
      'datetimeTokens',
    ] as const;
    for (const flag of booleans) expect(profiles.ideal[flag], flag).toBe(true);
    for (const name of PROFILE_NAMES) {
      expect(profiles.ideal.maxMessageChars, name).toBeGreaterThanOrEqual(
        profiles[name].maxMessageChars,
      );
    }
    expect(profiles.ideal.ephemeral).toBe('reliable');
    expect(profiles.ideal.memberListing).toBe('exact');
  });
});
