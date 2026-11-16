/**
 * The button limits `06` §3.7 sets for the product, and label truncation (`M3-T6`).
 *
 * Every platform's own ceiling is already in its profile — Telegram allows 100 buttons and
 * 64-character labels, Discord 25 and 80. `06` §3.7 sets a **tighter** rule on top of all of them:
 * "Each message has ≤8 buttons, ≤3 per row and labels ≤30 characters, truncated with `…`. This
 * stays under every platform limit."
 *
 * That rule is a product decision, not a technical one, and it needs one home or it becomes five
 * adapters each rounding it differently. A message with twelve buttons is unusable on a phone
 * whatever the API allows, and a 64-character label wraps to three lines in a Telegram keyboard.
 *
 * ## The caps are overridable, because `06` §3.8 overrides them
 *
 * An **emulated poll** is "one message with the question and one button per option (Slack ≤5 per
 * `actions` block)" — ten options means ten buttons in rows of five, which is over both of §3.7's
 * numbers on purpose. So §3.7's limits are the default for *action* buttons on a normal message,
 * and a producer with a layout of its own passes it. `06` §3.7 and §3.8 are amended in this
 * commit to say so; the first version of this module read §3.7 as universal and would have made
 * `M8`'s emulated polls impossible to build without weakening it.
 */

import type { ActionButton, ActionRow, ButtonLimits } from '../contract.js';
import { graphemesOf } from '../richtext/split.js';

/** `06` §3.7's per-message rule for action buttons. Under every platform's own numbers. */
export const PRODUCT_BUTTON_LIMITS = Object.freeze({
  maxPerMessage: 8,
  maxPerRow: 3,
  maxLabelChars: 30,
});

/** The one character `06` §3.7 names for a truncated label. */
export const LABEL_ELLIPSIS = '…';

/** How many of `graphemes` fit inside both a grapheme count and a UTF-16 budget. */
function fitting(graphemes: readonly string[], maxGraphemes: number, maxUnits: number): number {
  let units = 0;
  let count = 0;
  for (const grapheme of graphemes) {
    if (count + 1 > maxGraphemes || units + grapheme.length > maxUnits) break;
    units += grapheme.length;
    count += 1;
  }
  return count;
}

/**
 * A label at `06` §3.7's 30 characters, truncated with `…`.
 *
 * Two budgets at once, and the second is the one a character count misses. `06` §3.7 says 30
 * *characters*, which for a human means graphemes: cutting "👨‍👩‍👧" after two code points leaves a
 * man and a woman and a broken joiner on the end. But a platform's `maxLabelChars` is its own
 * unit — Telegram's 64 is UTF-16 — and 30 emoji graphemes are 60 to 120 UTF-16 units, which is
 * over it. So the walk stops at whichever budget runs out first, and the ellipsis is paid for out
 * of both.
 */
export function truncateButtonLabel(
  label: string,
  limits?: ButtonLimits | null,
  // Annotated: `PRODUCT_BUTTON_LIMITS` is a frozen literal, so the inferred default type would
  // be `30` and a caller passing any other number would not compile.
  maxChars: number = PRODUCT_BUTTON_LIMITS.maxLabelChars,
): string {
  const platformUnits = limits?.maxLabelChars ?? Number.POSITIVE_INFINITY;
  const maxGraphemes = Math.min(maxChars, platformUnits);
  const graphemes = graphemesOf(label);
  if (fitting(graphemes, maxGraphemes, platformUnits) === graphemes.length) return label;
  const keep = fitting(graphemes, maxGraphemes - 1, platformUnits - LABEL_ELLIPSIS.length);
  return `${graphemes.slice(0, keep).join('')}${LABEL_ELLIPSIS}`;
}

export interface LayoutOptions {
  /** Defaults to `06` §3.7's 8. An emulated poll (§3.8) passes its option count. */
  readonly maxPerMessage?: number;
  /** Defaults to `06` §3.7's 3. Slack's emulated poll block takes 5. */
  readonly maxPerRow?: number;
}

/**
 * Lay a flat list of buttons into rows, truncating every label.
 *
 * **Throws** above the cap rather than dropping the overflow. A message arriving with nine options
 * is a bug in the producer, and the two ways to be forgiving are both worse than failing: dropping
 * the ninth button silently removes an answer the member needed, and widening the row silently
 * produces a keyboard that is unreadable on the platform the limit was chosen for. The throw lands
 * in the producer's own test, which is where a layout decision belongs.
 */
export function layoutActionRows(
  buttons: readonly ActionButton[],
  limits: ButtonLimits | null,
  options: LayoutOptions = {},
): readonly ActionRow[] {
  const maxPerMessage = Math.min(
    options.maxPerMessage ?? PRODUCT_BUTTON_LIMITS.maxPerMessage,
    limits?.maxPerMessage ?? Number.POSITIVE_INFINITY,
  );
  const maxPerRow = Math.min(
    options.maxPerRow ?? PRODUCT_BUTTON_LIMITS.maxPerRow,
    limits?.maxPerRow ?? Number.POSITIVE_INFINITY,
  );
  if (buttons.length > maxPerMessage) {
    throw new RangeError(
      `${String(buttons.length)} buttons exceeds the ${String(maxPerMessage)} this message may carry (06 §3.7)`,
    );
  }
  const rows: ActionRow[] = [];
  for (let at = 0; at < buttons.length; at += maxPerRow) {
    rows.push(
      buttons
        .slice(at, at + maxPerRow)
        .map((button) => ({ ...button, label: truncateButtonLabel(button.label, limits) })),
    );
  }
  return rows;
}
