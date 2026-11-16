/**
 * `06` §3.7's button limits and label truncation (`M3-T6`).
 *
 * The limits themselves are three numbers, so the tests that matter are about the two places a
 * number is not enough:
 *
 * **The label budget is two budgets.** `06` §3.7 says 30 *characters*, which for a reader means
 * graphemes — cutting a family emoji after two code points leaves a man, a woman and a dangling
 * joiner. But a platform's `maxLabelChars` is UTF-16, and 30 emoji graphemes are 160 UTF-16 units,
 * which is over Telegram's 64. A grapheme-only truncation produces a keyboard Telegram refuses;
 * a unit-only truncation produces a mangled emoji. Both budgets, or neither is right.
 *
 * **Overflow is a throw.** The two forgiving options are both worse: dropping the ninth button
 * removes an answer the member needed, and widening the row produces a keyboard unusable on the
 * platform the limit was chosen for.
 */
import { describe, expect, it } from 'vitest';
import type { ActionButton, ButtonLimits } from '../contract.js';
import { PROFILE_NAMES, profiles } from '../index.js';
import {
  LABEL_ELLIPSIS,
  layoutActionRows,
  PRODUCT_BUTTON_LIMITS,
  truncateButtonLabel,
} from './buttons.js';
import { mintInteractionToken } from './token.js';

const button = (label: string): ActionButton => ({
  label,
  style: 'secondary',
  token: mintInteractionToken(),
});
const buttons = (count: number): readonly ActionButton[] =>
  Array.from({ length: count }, (_, index) => button(`Option ${String(index + 1)}`));

/** 👨‍👩‍👧 — one grapheme, eight UTF-16 units, five code points. */
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
/** 🇯🇵 — one grapheme, four UTF-16 units. */
const FLAG = String.fromCodePoint(0x1f1ef, 0x1f1f5);

describe('PRODUCT_BUTTON_LIMITS', () => {
  it('is 06 §3.7’s three numbers', () => {
    expect(PRODUCT_BUTTON_LIMITS).toEqual({ maxPerMessage: 8, maxPerRow: 3, maxLabelChars: 30 });
  });

  it('stays under every platform’s own numbers, which is 06 §3.7’s claim', () => {
    for (const name of PROFILE_NAMES) {
      const limits = profiles[name].buttonLimits;
      if (limits === null) continue;
      expect(limits.maxPerMessage, `${name}/perMessage`).toBeGreaterThanOrEqual(
        PRODUCT_BUTTON_LIMITS.maxPerMessage,
      );
      expect(limits.maxPerRow, `${name}/perRow`).toBeGreaterThanOrEqual(
        PRODUCT_BUTTON_LIMITS.maxPerRow,
      );
      expect(limits.maxLabelChars, `${name}/labelChars`).toBeGreaterThanOrEqual(
        PRODUCT_BUTTON_LIMITS.maxLabelChars,
      );
    }
  });
});

describe('truncateButtonLabel', () => {
  it('leaves a label at the limit alone', () => {
    const exact = 'a'.repeat(30);
    expect(truncateButtonLabel(exact)).toBe(exact);
    expect(truncateButtonLabel('Approve')).toBe('Approve');
    expect(truncateButtonLabel('')).toBe('');
  });

  it('truncates one character over, and the ellipsis is paid for out of the budget', () => {
    const over = truncateButtonLabel('a'.repeat(31));
    expect(over).toBe(`${'a'.repeat(29)}${LABEL_ELLIPSIS}`);
    expect([...over]).toHaveLength(30);
  });

  it('cuts between graphemes, never inside one', () => {
    const label = FAMILY.repeat(40);
    const cut = truncateButtonLabel(label);
    expect(cut.endsWith(LABEL_ELLIPSIS)).toBe(true);
    const body = cut.slice(0, -LABEL_ELLIPSIS.length);
    // A code-point cut would leave a trailing ZWJ or a lone 👨; the body has to be whole families.
    expect(body.replaceAll(FAMILY, '')).toBe('');
  });

  it('honours the platform’s UTF-16 budget, which a character count misses', () => {
    // 30 families are 240 UTF-16 units. Telegram's label budget is 64, so a grapheme-only
    // truncation would produce a keyboard the platform refuses — with a label that looks, in every
    // editor and every test fixture, exactly 30 characters long.
    const telegram = profiles.telegram.buttonLimits;
    expect(telegram).not.toBeNull();
    const cut = truncateButtonLabel(FAMILY.repeat(30), telegram);
    expect(cut.length).toBeLessThanOrEqual(telegram?.maxLabelChars ?? 0);
    expect(cut.slice(0, -LABEL_ELLIPSIS.length).replaceAll(FAMILY, '')).toBe('');
  });

  it('keeps a flag whole under the same budget', () => {
    const telegram = profiles.telegram.buttonLimits;
    const cut = truncateButtonLabel(FLAG.repeat(30), telegram);
    expect(cut.length).toBeLessThanOrEqual(telegram?.maxLabelChars ?? 0);
    expect(cut.slice(0, -LABEL_ELLIPSIS.length).replaceAll(FLAG, '')).toBe('');
  });

  it('respects a platform tighter than 06 §3.7, and a caller tighter still', () => {
    const tiny: ButtonLimits = {
      maxPerMessage: 8,
      maxPerRow: 3,
      maxLabelChars: 6,
      tokenMaxBytes: 64,
    };
    expect(truncateButtonLabel('Approve this', tiny)).toBe(`Appro${LABEL_ELLIPSIS}`);
    expect(truncateButtonLabel('Approve this', null, 4)).toBe(`App${LABEL_ELLIPSIS}`);
  });
});

describe('layoutActionRows', () => {
  it('fills rows of three, the last one short', () => {
    const rows = layoutActionRows(buttons(8), profiles.telegram.buttonLimits);
    expect(rows.map((row) => row.length)).toEqual([3, 3, 2]);
    expect(rows.flat().map((entry) => entry.label)).toEqual(buttons(8).map((entry) => entry.label));
  });

  it('keeps one button on one row', () => {
    expect(layoutActionRows(buttons(1), null).map((row) => row.length)).toEqual([1]);
    expect(layoutActionRows([], null)).toEqual([]);
  });

  it('throws above the cap instead of dropping or widening', () => {
    expect(() => layoutActionRows(buttons(9), profiles.telegram.buttonLimits)).toThrow(RangeError);
  });

  it('truncates every label it lays out', () => {
    const [row] = layoutActionRows([button('a'.repeat(50))], profiles.telegram.buttonLimits);
    expect(row?.[0]?.label).toBe(`${'a'.repeat(29)}${LABEL_ELLIPSIS}`);
  });

  it('carries the token and the style through unchanged', () => {
    const original = button('Approve');
    const [row] = layoutActionRows([original], null);
    expect(row?.[0]).toEqual(original);
  });

  it('takes the tighter of the product rule and the platform’s', () => {
    const narrow: ButtonLimits = {
      maxPerMessage: 4,
      maxPerRow: 2,
      maxLabelChars: 30,
      tokenMaxBytes: 64,
    };
    expect(layoutActionRows(buttons(4), narrow).map((row) => row.length)).toEqual([2, 2]);
    expect(() => layoutActionRows(buttons(5), narrow)).toThrow(RangeError);
  });

  it('lets an emulated poll pass its own layout (06 §3.8)', () => {
    // "One message with the question and one button per option (Slack ≤5 per `actions` block)" —
    // ten options is over both of §3.7's numbers on purpose, and the platform's ceiling still
    // applies.
    const rows = layoutActionRows(buttons(10), profiles.slack.buttonLimits, {
      maxPerMessage: 10,
      maxPerRow: 5,
    });
    expect(rows.map((row) => row.length)).toEqual([5, 5]);
    expect(() =>
      layoutActionRows(buttons(10), profiles.slack.buttonLimits, { maxPerMessage: 9 }),
    ).toThrow(RangeError);
  });
});
