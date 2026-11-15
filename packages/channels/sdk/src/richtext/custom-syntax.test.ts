/**
 * The two pieces of syntax CommonMark does not have (`06` §3.5.2; `M3-T3`).
 *
 * The corpus covers these end to end through `parse`. This file covers them **as a function**,
 * because that is the only level at which the mark arithmetic is visible: `**a ||b|| c**` has to
 * come out as three runs with the middle one carrying `b` *and* `spoiler`, in `06` §3.5.1's
 * canonical order, and a corpus line showing the right sketch does not say which of the three
 * things that could have produced it actually did.
 */
import type { Inline } from '@comvivo/core';
import type { MemberId } from '@comvivo/shared';
import { recordingLogger } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  applyCustomSyntax,
  canonicalMarks,
  type MentionResolver,
  textNode,
  UNRESOLVED_MENTION_TEXT,
} from './custom-syntax.js';
import { sketchInline } from './sketch.js';

const MBR = 'mbr_01jd0000000000000000000000' as MemberId;

const roster: MentionResolver = (id) => (id === MBR ? { fallback: '@Ana' } : undefined);
const nobody: MentionResolver = () => undefined;

function apply(inlines: readonly Inline[], resolve: MentionResolver = roster): string {
  return applyCustomSyntax(inlines, { resolveMember: resolve }).map(sketchInline).join(' ');
}

/** One text run, the shape the parser hands this module. */
function run(text: string, ...marks: Parameters<typeof canonicalMarks>[0]): Inline {
  return textNode(text, marks);
}

describe('spoilers (06 §3.5.2)', () => {
  it('marks the inside and leaves the rest alone', () => {
    expect(apply([run('a ||b|| c')])).toBe('"a " "b"*spoiler " c"');
  });

  it('keeps the surrounding marks on both the hidden and the visible parts', () => {
    // The reason this is a mark rewrite rather than a text substitution: a regex over the source
    // string could not have expressed "bold, and also hidden".
    expect(apply([run('a ||b|| c', 'b')])).toBe('"a "*b "b"*bspoiler " c"*b');
  });

  it('sorts the marks canonically, whatever order they arrived in', () => {
    // `06` §3.5.1: "marks sorted canonical: b,i,s,spoiler". Two nodes differing only in mark order
    // would compare unequal in every corpus and in every renderer's cache key.
    expect(apply([run('||x||', 's', 'i', 'b')])).toBe('"x"*bisspoiler');
  });

  it('handles several in one run', () => {
    expect(apply([run('||a|| and ||b||')])).toBe('"a"*spoiler " and " "b"*spoiler');
  });

  it('does not nest', () => {
    // `06` §3.5.2: "single text run, no nesting". The trailing delimiter stays as text, which is
    // what a reader sees on every platform that has no nested-spoiler primitive — all of them.
    expect(apply([run('||a||b||')])).toBe('"a"*spoiler "b||"');
  });

  it('needs something inside it', () => {
    expect(apply([run('||||')])).toBe('"||||"');
  });

  it('does not cross a line break', () => {
    // A spoiler spanning paragraphs would hide text the model meant to show: the delimiters are
    // far apart and the model probably meant two tables of `|`.
    expect(apply([run('||a\nb||')])).toBe('"||a\\nb||"');
  });

  it('leaves an unclosed delimiter as text', () => {
    expect(apply([run('||a')])).toBe('"||a"');
  });

  it('never touches inline code', () => {
    // `06` §3.5.2's "never inside code" — the clause that keeps `a||b` in a shell snippet readable.
    expect(apply([{ t: 'code', text: 'a||b||c' }])).toBe('c("a||b||c")');
  });

  it('never touches a link’s URL or a mention’s fallback', () => {
    const inlines: Inline[] = [
      { t: 'link', url: 'https://e.co/a||b||c', c: [{ t: 'text', text: 'l' }] },
      { t: 'mention', target: { kind: 'member', memberId: MBR }, fallback: '@||Ana||' },
    ];
    expect(apply(inlines)).toBe(
      'a(https://e.co/a||b||c)["l"] @(member:mbr_01jd0000000000000000000000|@||Ana||)',
    );
  });
});

describe('mentions (06 §3.5.2)', () => {
  it('becomes a mention node with the roster’s fallback', () => {
    expect(apply([run(`@{${MBR}}`)])).toBe(`@(member:${MBR}|@Ana)`);
  });

  it('splits the run around it', () => {
    expect(apply([run(`hi @{${MBR}} there`)])).toBe(`"hi " @(member:${MBR}|@Ana) " there"`);
  });

  it('becomes `@?` when the id is not in this group', () => {
    expect(apply([run(`@{${MBR}}`)], nobody)).toBe(`"${UNRESOLVED_MENTION_TEXT}"`);
  });

  it('keeps the run’s marks on `@?`, so the emphasis survives', () => {
    // `**@{…}**` degrades to a bold `@?` rather than losing what the model put around it.
    expect(apply([run(`@{${MBR}}`, 'b')], nobody)).toBe('"@?"*b');
  });

  it('logs an unresolved mention at warn, with no id in the line', () => {
    const { logger, lines } = recordingLogger();
    applyCustomSyntax([run(`@{${MBR}}`)], { resolveMember: nobody, logger });
    const written = lines();
    const line = written.find((entry) => entry.event === 'channel.mention_unresolved');
    expect(line?.level).toBe('warn');
    // `01` §11.7: a member id is a handle to a person. The count is what an operator acts on.
    expect(JSON.stringify(written)).not.toContain(MBR);
  });

  it('logs nothing when the mention resolves', () => {
    const { logger, lines } = recordingLogger();
    applyCustomSyntax([run(`@{${MBR}}`)], { resolveMember: roster, logger });
    expect(lines().filter((entry) => entry.event === 'channel.mention_unresolved')).toEqual([]);
  });

  it('refuses an id that is not TypeID-shaped, without consulting the roster', () => {
    // Crockford base32 excludes `i`, `l`, `o` and `u`, so an id containing one is ill-formed by
    // construction. Left as text rather than looked up: a lookup would answer "not a member",
    // which is a different and misleading thing to tell an operator.
    const calls: string[] = [];
    const watching: MentionResolver = (id) => {
      calls.push(id);
      return { fallback: '@Ana' };
    };
    const malformed = [
      '@{mbr_123}',
      '@{mbr_01jd000000000000000000000i}',
      '@{grp_01jd0000000000000000000000}',
      `@${MBR}`,
      '@{}',
    ];
    for (const text of malformed) {
      expect(apply([run(text)], watching), text).toBe(JSON.stringify(text));
    }
    expect(calls).toEqual([]);
  });

  it('handles two mentions in one run', () => {
    expect(apply([run(`@{${MBR}} and @{${MBR}}`)])).toBe(
      `@(member:${MBR}|@Ana) " and " @(member:${MBR}|@Ana)`,
    );
  });

  it('applies spoilers to the text around a mention', () => {
    // The two pass over the same run, and the order matters: the mention splits first, so a
    // spoiler cannot swallow a mention's braces.
    expect(apply([run(`||a|| @{${MBR}} ||b||`)])).toBe(
      `"a"*spoiler " " @(member:${MBR}|@Ana) " " "b"*spoiler`,
    );
  });
});

describe('canonicalMarks (06 §3.5.1)', () => {
  it('sorts and de-duplicates', () => {
    expect(canonicalMarks(['spoiler', 's', 'i', 'b'])).toEqual(['b', 'i', 's', 'spoiler']);
    expect(canonicalMarks(['b', 'b', 'i'])).toEqual(['b', 'i']);
    expect(canonicalMarks([])).toEqual([]);
  });
});

describe('textNode', () => {
  it('omits `marks` entirely when there are none', () => {
    // Not `marks: []`. `exactOptionalPropertyTypes` makes the two different types, and a stored
    // row carrying an empty array is a byte difference in a column that is compared for equality.
    expect(textNode('x', [])).toEqual({ t: 'text', text: 'x' });
    expect(textNode('x', undefined)).toEqual({ t: 'text', text: 'x' });
  });
});
