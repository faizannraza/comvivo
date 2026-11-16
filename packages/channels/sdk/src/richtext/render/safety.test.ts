/**
 * Outbound content safety (`08` §3.12, S5, S6; `M3-T10`).
 *
 * Three rules, and the order of these blocks is the order of how badly each one fails:
 *
 * 1. **A mass mention** notifies a hundred people at two in the morning, from the thing a family
 *    installed to be considerate. It arrives in **content** — quoted, repeated back by a model,
 *    forwarded in from an email — so the renderer is the only place it can be stopped.
 * 2. **A link preview** renders the linked page's content to everyone in the chat, fetched by the
 *    platform from a URL that may have come from a stranger.
 * 3. **The mention cap** is the quiet one: nine phones buzzing for one reminder. No platform limit
 *    sits behind it, so nothing fails if it is missing.
 */

import type { Block, RichText } from '@comvivo/core';
import type { MemberId } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { profiles } from '../../profiles.js';
import { ZWSP } from './escape.js';
import { renderPart } from './index.js';
import {
  capMentions,
  linkPreviewPolicy,
  MAX_MENTIONS_PER_MESSAGE,
  neutraliseAllMassMentions,
  safetyFindings,
  sanitiseButtonLabel,
  sanitiseDocument,
  UNIVERSAL_MASS_MENTION_TOKENS,
} from './safety.js';

const member = (n: number): MemberId =>
  `mbr_01jd00000000000000000000${String(n).padStart(2, '0')}` as unknown as MemberId;

const context = {
  mentions: Object.fromEntries(
    Array.from({ length: 9 }, (_, at) => [
      member(at + 1),
      {
        platformUserId: `u${String(at + 1)}`,
        displayName: `Member ${String(at + 1)}`,
        canPing: true,
      },
    ]),
  ),
  self: { platformUserId: 'bot', displayName: 'Village', flags: {} },
  linkPreview: false,
  locale: 'en',
};

/** A paragraph naming `count` distinct members. */
function naming(count: number): RichText {
  return {
    v: 1,
    blocks: [
      {
        t: 'p',
        c: Array.from({ length: count }, (_, at) => ({
          t: 'mention' as const,
          target: { kind: 'member' as const, memberId: member(at + 1) },
          fallback: `@Member ${String(at + 1)}`,
        })),
      },
    ],
  };
}

/** A paragraph naming `count` members starting at `from`. */
function paragraphNaming(from: number, count: number): Block {
  return {
    t: 'p',
    c: Array.from({ length: count }, (_, at) => ({
      t: 'mention' as const,
      target: { kind: 'member' as const, memberId: member(from + at) },
      fallback: `@Member ${String(from + at)}`,
    })),
  };
}

const text = (value: string): RichText => ({
  v: 1,
  blocks: [{ t: 'p', c: [{ t: 'text', text: value }] }],
});

describe('the mention cap (08 §3.12)', () => {
  it('is five', () => {
    expect(MAX_MENTIONS_PER_MESSAGE).toBe(5);
  });

  it('keeps the first five and flattens the rest to their fallback', () => {
    // Flattened, not removed: the reader still sees who the message is about, which is the point of
    // having named them. What they lose is the notification.
    const { document, dropped } = capMentions(naming(9));
    expect(dropped).toBe(4);
    const [block] = document.blocks;
    const kinds = block?.t === 'p' ? block.c.map((node) => node.t) : [];
    expect(kinds).toEqual([
      'mention',
      'mention',
      'mention',
      'mention',
      'mention',
      'text',
      'text',
      'text',
      'text',
    ]);
    const flattened = block?.t === 'p' ? block.c.at(-1) : undefined;
    expect(flattened?.t === 'text' ? flattened.text : '').toBe('@Member 9');
  });

  it('counts distinct members, not mention nodes', () => {
    // A reply that repeats a name naturally has still mentioned one person, and counting nodes
    // would punish it.
    const twice: RichText = {
      v: 1,
      blocks: [
        {
          t: 'p',
          c: Array.from({ length: 12 }, () => ({
            t: 'mention' as const,
            target: { kind: 'member' as const, memberId: member(1) },
            fallback: '@Member 1',
          })),
        },
      ],
    };
    expect(capMentions(twice).dropped).toBe(0);
  });

  it('keeps a repeat of an already-named member once the cap is full', () => {
    // The boundary the `kept.has(id)` clause exists for, and the one a repeat-only case cannot
    // reach: five distinct members fill the cap, and the sixth *node* names member 1 again. It has
    // to survive, because it adds no notification — somebody is already being pinged. A cap that
    // only asked "is there room" would flatten it and the message would read "@Member 1 … Member
    // 1", the same name twice in two different shapes.
    const full: RichText = {
      v: 1,
      blocks: [
        {
          t: 'p',
          c: [
            ...Array.from({ length: 5 }, (_, at) => ({
              t: 'mention' as const,
              target: { kind: 'member' as const, memberId: member(at + 1) },
              fallback: `@Member ${String(at + 1)}`,
            })),
            {
              t: 'mention' as const,
              target: { kind: 'member' as const, memberId: member(1) },
              fallback: '@Member 1',
            },
            {
              t: 'mention' as const,
              target: { kind: 'member' as const, memberId: member(6) },
              fallback: '@Member 6',
            },
          ],
        },
      ],
    };
    const { document, dropped } = capMentions(full);
    // Only the sixth distinct person is dropped.
    expect(dropped).toBe(1);
    const [block] = document.blocks;
    const kinds = block?.t === 'p' ? block.c.map((node) => node.t) : [];
    expect(kinds).toEqual([
      'mention',
      'mention',
      'mention',
      'mention',
      'mention',
      'mention',
      'text',
    ]);
  });

  it('keeps the author’s order, so the person the message is for is not the one dropped', () => {
    // `05`'s copy puts the addressee first. A cap that dropped by any other rule would silently
    // un-notify the one member who needed it.
    const { document } = capMentions(naming(9));
    const [block] = document.blocks;
    const first = block?.t === 'p' ? block.c[0] : undefined;
    expect(
      first?.t === 'mention' ? String(first.target.kind === 'member' && first.target.memberId) : '',
    ).toBe(member(1));
  });

  it('returns the same document object when nothing was dropped', () => {
    // The common path. A fresh copy per message would be a walk and an allocation for nothing.
    const under = naming(3);
    expect(capMentions(under).document).toBe(under);
  });

  it('reaches into quotes and lists', () => {
    // **Different** members in each container. The first version put members 1–4 in both, which is
    // four distinct people and under the cap — so the walk could have skipped containers entirely
    // and the case would still have passed.
    const nested: RichText = {
      v: 1,
      blocks: [
        { t: 'quote', c: [paragraphNaming(1, 4) as never] },
        { t: 'list', ordered: false, items: [[paragraphNaming(5, 4) as never]] },
      ],
    };
    // Eight distinct members across two containers, five kept.
    expect(capMentions(nested).dropped).toBe(3);
  });
});

describe('mass-mention neutralisation (S6)', () => {
  it('breaks a token with a zero-width space, leaving it readable', () => {
    expect(neutraliseAllMassMentions('@everyone read this', profiles.discord)).toBe(
      `@${ZWSP}everyone read this`,
    );
  });

  it('breaks every token in the universal list, whatever the profile says', () => {
    // `08` §3.12: "No group-wide notification tokens are ever emitted in 1.0." Telegram's profile
    // list is empty — it has no `@everyone` — so a profile-driven check alone would let one through
    // on the platform whose renderer is the most used.
    expect(profiles.telegram.massMentionTokens).toEqual([]);
    for (const token of UNIVERSAL_MASS_MENTION_TOKENS) {
      expect(neutraliseAllMassMentions(token, profiles.telegram), token).not.toBe(token);
    }
  });

  it('sweeps a mention’s fallback, which a member chooses', () => {
    // A fallback is built from a display name (`06` §3.5.2), and a display name is whatever a
    // member set it to — so `@everyone` is a display name somebody can have.
    const document: RichText = {
      v: 1,
      blocks: [
        {
          t: 'p',
          c: [
            {
              t: 'mention',
              target: { kind: 'member', memberId: member(1) },
              fallback: '@everyone',
            },
          ],
        },
      ],
    };
    const swept = sanitiseDocument(document, profiles.discord);
    const [block] = swept.document.blocks;
    const node = block?.t === 'p' ? block.c[0] : undefined;
    expect(node?.t === 'mention' ? node.fallback : '').toBe(`@${ZWSP}everyone`);
    expect(swept.massMentionsBroken).toBe(1);
  });

  it('sweeps a code block, for the platform that has no code markup', () => {
    // A mass mention inside inline code is inert on every platform with markup. Signal and the
    // `plain` renderer have none, so the token reaches the chat as text.
    const document: RichText = { v: 1, blocks: [{ t: 'code', text: 'ping @here' }] };
    const swept = sanitiseDocument(document, profiles.signal);
    const [block] = swept.document.blocks;
    expect(block?.t === 'code' ? block.text : '').toBe(`ping @${ZWSP}here`);
  });
});

describe('the pass runs before rendering, not after', () => {
  it('because the plain renderer’s Signal offsets are into the text it produced', () => {
    // The finding that decided the order. Inserting a zero-width space into the *output* shifts
    // every range after it by one — a mention highlight landing on the wrong word, or past the end
    // of the message. Breaking the token in the AST means the offsets are computed over the final
    // text, which is the only way the two can agree.
    const document: RichText = {
      v: 1,
      blocks: [
        {
          t: 'p',
          c: [
            { t: 'text', text: '@everyone — ' },
            {
              t: 'mention',
              target: { kind: 'member', memberId: member(1) },
              fallback: '@Member 1',
            },
          ],
        },
      ],
    };
    const part = renderPart(document, context, profiles.signal);
    const payload = part.payload as {
      text: string;
      mentions: readonly { start: number; length: number }[];
    };
    expect(payload.text).toContain(ZWSP);
    for (const range of payload.mentions) {
      const slice = payload.text.slice(range.start, range.start + range.length);
      expect(slice, JSON.stringify(range)).toBe('@Member 1');
    }
  });
});

describe('renderPart applies the pass to every markup', () => {
  it('so a renderer cannot forget, and a new one gets it for free', () => {
    for (const name of ['telegram', 'signal', 'web'] as const) {
      const part = renderPart(text('tell @everyone and @here'), context, profiles[name]);
      const serialised =
        typeof part.payload === 'string' ? part.payload : JSON.stringify(part.payload);
      expect(serialised, name).not.toContain('@everyone');
      expect(serialised, name).not.toContain('@here');
      expect(part.plainText, `${name}/plainText`).not.toContain('@everyone');
    }
  });

  it('caps the mentions too', () => {
    const part = renderPart(naming(9), context, profiles.telegram);
    const html = part.payload as string;
    // Five pings, four plain names.
    expect([...html.matchAll(/tg:\/\/user/g)]).toHaveLength(5);
  });
});

describe('link previews (S5)', () => {
  it('are off unless the message asks for one', () => {
    // A preview is the linked page's content rendered to everyone present, on a URL that may have
    // come from a model or a stranger's email.
    expect(linkPreviewPolicy(profiles.telegram, undefined).suppress).toBe(true);
    expect(linkPreviewPolicy(profiles.telegram, false).suppress).toBe(true);
    expect(linkPreviewPolicy(profiles.telegram, true).suppress).toBe(false);
  });

  it('report where the platform will not listen', () => {
    // Matrix and Signal unfurl client-side with no flag, so S5 is a provenance decision there
    // rather than a switch — `03`'s guard has to decide whether the URL may be in the message.
    expect(linkPreviewPolicy(profiles.telegram, undefined).enforceable).toBe(true);
    expect(linkPreviewPolicy(profiles.matrix, undefined).enforceable).toBe(false);
    expect(linkPreviewPolicy(profiles.signal, undefined).enforceable).toBe(false);
  });

  it('match each profile’s declared control', () => {
    for (const [name, caps] of Object.entries(profiles)) {
      expect(linkPreviewPolicy(caps, undefined).enforceable, name).toBe(
        caps.linkPreviewControl === 'per-message',
      );
    }
  });
});

describe('button labels (08 §3.12)', () => {
  it('lose the characters that are interpreted rather than read', () => {
    // A newline splits a Block Kit element; a bidi override reorders what the reader sees. A label
    // is one line of text, and everything here either breaks that or lies about it.
    expect(sanitiseButtonLabel('Approve\nReject', profiles.telegram)).toBe('Approve Reject');
    expect(sanitiseButtonLabel(`Approve${String.fromCharCode(0x202e)}`, profiles.telegram)).toBe(
      'Approve',
    );
    expect(sanitiseButtonLabel(`a${String.fromCharCode(0)}b`, profiles.telegram)).toBe('ab');
  });

  it('break a mass mention in a label', () => {
    expect(sanitiseButtonLabel('Tell @everyone', profiles.discord)).toBe(`Tell @${ZWSP}everyone`);
  });

  it('leave an ordinary label alone', () => {
    expect(sanitiseButtonLabel('Approve', profiles.telegram)).toBe('Approve');
    expect(sanitiseButtonLabel('Mark done ✅', profiles.telegram)).toBe('Mark done ✅');
  });

  it('do not truncate, because `interactions/buttons.ts` owns the length', () => {
    // Two places deciding one number is how two answers appear.
    const long = 'a'.repeat(200);
    expect(sanitiseButtonLabel(long, profiles.telegram)).toHaveLength(200);
  });
});

describe('safetyFindings', () => {
  it('is empty for what the renderer produces', () => {
    for (const name of ['telegram', 'signal', 'web'] as const) {
      const part = renderPart(
        text('tell @everyone about <b>this</b> & that'),
        context,
        profiles[name],
      );
      const payload =
        typeof part.payload === 'string' ? part.payload : JSON.stringify(part.payload);
      expect(safetyFindings(payload, profiles[name]), name).toEqual([]);
    }
  });

  it('reports a mass mention that reached the output', () => {
    expect(safetyFindings('tell @everyone', profiles.discord).map((f) => f.rule)).toEqual([
      'mass_mention',
    ]);
  });

  it('reports an unescaped `<` in Telegram HTML', () => {
    // `400 can't parse entities` sends **nothing** — no partial render, no platform fallback — and
    // the input that triggers it is a message somebody else wrote.
    expect(safetyFindings('a < b', profiles.telegram).map((f) => f.rule)).toEqual([
      'unescaped_markup',
    ]);
  });

  it('reports an entity Telegram does not have', () => {
    expect(safetyFindings('5&nbsp;pm', profiles.telegram).map((f) => f.rule)).toEqual([
      'bad_entity',
    ]);
    expect(safetyFindings('a &amp; b', profiles.telegram)).toEqual([]);
  });

  it('accepts a tag the renderer legitimately writes, attributes and all', () => {
    expect(safetyFindings('<a href="https://e.co/?a=1&amp;b=2">x</a>', profiles.telegram)).toEqual(
      [],
    );
    expect(safetyFindings('<blockquote expandable>x</blockquote>', profiles.telegram)).toEqual([]);
  });

  it('reports a control character', () => {
    expect(
      safetyFindings(`a${String.fromCharCode(0x7f)}b`, profiles.signal).map((f) => f.rule),
    ).toEqual(['control_character']);
    // Tab, newline and carriage return are legitimate in a message body.
    expect(safetyFindings('a\tb\nc\r\n', profiles.signal)).toEqual([]);
  });
});
