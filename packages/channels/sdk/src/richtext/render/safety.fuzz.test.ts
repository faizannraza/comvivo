/**
 * `fuzz.render.*` — the renderer's output, over adversarial input (`08` L-10, S5, S6; `M3-T10`).
 *
 * `08` §3.4's L-10 row names this suite: "Improper output handling (markup injection, model text
 * into SQL/paths)", mitigated by "renderer escaping per markup (§3.12)", tested by `fuzz.render.*`.
 *
 * The property is one sentence and it is the whole file: **whatever goes in, nothing comes out that
 * the platform will act on.** No mass-mention token, no unescaped markup, no entity the platform
 * does not have, no control character. Asserted on the **output string** rather than on the AST,
 * because what the renderer intended is not what the group experiences.
 *
 * ## Why this is a fuzz suite rather than a corpus
 *
 * `M3-T4` already has 61 hand-written injection cases, and they are the right shape for the things
 * somebody thought of: `<script>`, `tg://user?id=`, a quote closing an attribute. A fuzz run is for
 * the things nobody thought of, and the generator below is built from the *pieces* that have broken
 * a renderer before — a bare `&`, a lone `<`, a mass-mention token split across two runs, a
 * zero-width character, an unbalanced marker — recombined in ways a person writing cases would not.
 *
 * Both markups `M3-T10`'s AC names are covered (`telegram-html`, `web-md`), plus `plain`, because
 * the Signal profile is the one with no markup to hide behind: a token that survives there survives
 * into the chat as text.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import type { MemberId } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { profiles } from '../../profiles.js';
import { renderPart } from './index.js';
import { safetyFindings, UNIVERSAL_MASS_MENTION_TOKENS } from './safety.js';
import { validateTelegramHtml } from './telegram-validator.js';

const MBR = 'mbr_01jd0000000000000000000001' as unknown as MemberId;

const context = {
  mentions: {
    [MBR]: { platformUserId: 'u1', displayName: 'Ana', canPing: true },
  },
  self: { platformUserId: 'bot', displayName: 'Village', flags: {} },
  linkPreview: false,
  locale: 'en',
};

/**
 * The fragments a renderer has broken on, or could.
 *
 * Every entry is content a member can type or a model can produce. The mass-mention tokens are here
 * whole *and* split, because a token assembled across two text runs is the case an AST-level check
 * misses and an output-level one catches — which is the argument for checking the output.
 */
const FRAGMENTS: readonly string[] = [
  ...UNIVERSAL_MASS_MENTION_TOKENS,
  '@every',
  'one',
  '<!chan',
  'nel>',
  '<',
  '>',
  '&',
  '&amp;',
  '&lt;',
  '&nbsp;',
  '&#x41;',
  '"',
  "'",
  '<b>',
  '</b>',
  '<script>alert(1)</script>',
  '<a href="tg://user?id=99">x</a>',
  'tg://user?id=99',
  '<blockquote expandable>',
  '</pre>',
  '```',
  '*bold*',
  '__under__',
  '~~strike~~',
  '[label](https://e.co)',
  'https://e.co/?hm=abc',
  String.fromCharCode(0x200b),
  String.fromCharCode(0x202e),
  String.fromCharCode(0x2060),
  String.fromCharCode(0x00),
  String.fromCharCode(0x07),
  '\n',
  '\t',
  '👨‍👩‍👧',
  'مرحبا',
  'ok',
  ' ',
];

/** A deterministic generator: the seed is the run index, so a failure names its document. */
function generate(seed: number): RichText {
  let state = (seed * 2_654_435_761) % 4_294_967_296;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(next() * values.length)] ?? (values[0] as T);
  const fragment = (): string =>
    Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(FRAGMENTS)).join('');

  const inline = (): Inline => {
    const sort = pick(['text', 'text', 'text', 'code', 'link', 'mention', 'br'] as const);
    if (sort === 'code') return { t: 'code', text: fragment() };
    if (sort === 'link') {
      return {
        t: 'link',
        // The AST field is `url`, not `href`. The first version wrote `href`, which the renderer
        // read as `undefined` and crashed on — a bug in the generator that looked like one in the
        // renderer, and the reason a fuzz corpus has to be read as carefully as the code.
        url: pick(['https://e.co/x', `https://e.co/?q=${encodeURIComponent(fragment())}`]),
        c: [{ t: 'text', text: fragment() }],
      };
    }
    if (sort === 'mention') {
      return { t: 'mention', target: { kind: 'member', memberId: MBR }, fallback: fragment() };
    }
    if (sort === 'br') return { t: 'br' };
    const marks = pick([[], ['b'], ['i'], ['b', 'i'], ['s'], ['spoiler']] as const);
    return marks.length === 0
      ? { t: 'text', text: fragment() }
      : { t: 'text', text: fragment(), marks: [...marks] as never };
  };

  const paragraph = (): Block => ({
    t: 'p',
    c: Array.from({ length: 1 + Math.floor(next() * 4) }, inline),
  });

  const block = (): Block => {
    const sort = pick(['p', 'p', 'h', 'code', 'quote', 'list'] as const);
    if (sort === 'h') return { t: 'h', level: pick([1, 2, 3] as const), c: [inline()] };
    if (sort === 'code') {
      // `lang` is **omitted** rather than set to `undefined`: `exactOptionalPropertyTypes` makes
      // the two different types, and an AST carrying an explicit `undefined` is a shape the parser
      // never produces — so a renderer crash on it would be a bug in the generator, not a finding.
      return next() > 0.5
        ? { t: 'code', lang: 'sh', text: fragment() }
        : { t: 'code', text: fragment() };
    }
    if (sort === 'quote') return { t: 'quote', c: [paragraph()] };
    if (sort === 'list') {
      return {
        t: 'list',
        ordered: next() > 0.5,
        items: Array.from({ length: 1 + Math.floor(next() * 2) }, () => [paragraph()]),
      };
    }
    return paragraph();
  };

  return { v: 1, blocks: Array.from({ length: 1 + Math.floor(next() * 4) }, block) };
}

/** `08` L-10's runs. 2 000 per markup is about a second and covers the recombinations. */
const RUNS = 2_000;

describe('fuzz.render.telegram-html', () => {
  it('never emits a mass-mention token, unescaped markup or a bad entity', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const part = renderPart(generate(seed), context, profiles.telegram);
      const html = part.payload as string;
      const findings = safetyFindings(html, profiles.telegram);
      expect(
        findings,
        `seed ${String(seed)}: ${findings.map((f) => `${f.rule}(${f.detail})`).join(', ')}\n${html}`,
      ).toEqual([]);
    }
  });

  it('never emits markup the validator rejects', () => {
    // The structural half, which `safetyFindings` does not cover: balanced, allowlisted, nothing
    // inside `<code>`. Telegram answers a violation with `400 can't parse entities` and sends
    // **nothing**, so the two checks together are what stop a member getting silence.
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const html = renderPart(generate(seed), context, profiles.telegram).payload as string;
      const problems = validateTelegramHtml(html);
      expect(problems, `seed ${String(seed)}: ${JSON.stringify(problems)}\n${html}`).toEqual([]);
    }
  });
});

describe('fuzz.render.web-md', () => {
  it('never emits a mass-mention token or a control character', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const payload = JSON.stringify(renderPart(generate(seed), context, profiles.web).payload);
      const findings = safetyFindings(payload, profiles.web);
      expect(findings, `seed ${String(seed)}: ${JSON.stringify(findings)}`).toEqual([]);
    }
  });
});

describe('fuzz.render.plain', () => {
  it('never emits a mass-mention token, on the platform with no markup to hide behind', () => {
    // Signal has no markup at all, so a token that survives here is a token in the chat. It is also
    // the profile whose renderer carries **offsets** — the style and mention ranges — which is why
    // the next assertion matters as much as the first.
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const part = renderPart(generate(seed), context, profiles.signal);
      const payload = part.payload as {
        text: string;
        mentions: readonly { start: number; length: number }[];
        styles: readonly { start: number; length: number }[];
      };
      const findings = safetyFindings(payload.text, profiles.signal);
      expect(findings, `seed ${String(seed)}: ${JSON.stringify(findings)}`).toEqual([]);
      for (const range of [...payload.mentions, ...payload.styles]) {
        expect(
          range.start >= 0 && range.start + range.length <= payload.text.length,
          `seed ${String(seed)}: a range ${JSON.stringify(range)} runs past a ${String(payload.text.length)}-character message`,
        ).toBe(true);
      }
    }
  });
});
