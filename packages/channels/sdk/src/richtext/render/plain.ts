/**
 * The `plain` renderer (`06` §3.5.3; `M3-T4`).
 *
 * Every other renderer has a fallback and this one **is** the fallback. It serves three callers:
 *
 *  - **Signal**, whose only markup is a list of offset ranges over plain text (`06` §3.5.3);
 *  - the **markup-rejection path**: when a platform refuses the markup, §3.5.3 re-sends the part
 *    once as plain, so this has to produce something readable for any AST at all;
 *  - `RenderedPart.plainText`, which every other renderer carries for the log line and for Slack's
 *    notification text.
 *
 * ## Why it emits the style ranges
 *
 * Marks are "dropped" in the sense that there is no markup for them — but their **positions** are
 * only knowable while walking the AST, and §3.5.3's Signal row needs exactly that:
 * `start:length:BOLD|ITALIC|STRIKETHROUGH|SPOILER|MONOSPACE` in UTF-16 offsets. Returning them
 * here costs one counter during a walk that already happens; computing them later would mean the
 * Signal adapter re-walking the AST and agreeing, character for character, with this function
 * about where the text ended up. The ranges are ignored by every other caller.
 *
 * UTF-16 offsets, not code points and not graphemes, because that is what signal-cli counts.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import type { RenderContext } from '../../contract.js';

/** `06` §3.5.3's Signal style names. */
export type PlainStyle = 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'SPOILER' | 'MONOSPACE';

/** One `start:length:STYLE` range, in UTF-16 offsets. */
export interface PlainStyleRange {
  readonly start: number;
  readonly length: number;
  readonly style: PlainStyle;
}

/** One `start:length:<ACI>` mention range (`06` §3.5.3's Signal row). */
export interface PlainMentionRange {
  readonly start: number;
  readonly length: number;
  readonly platformUserId: string;
}

export interface PlainRender {
  readonly text: string;
  readonly styles: readonly PlainStyleRange[];
  readonly mentions: readonly PlainMentionRange[];
}

/** `hr`, which has no plain equivalent and reads as one (`06` §3.5.3). */
export const PLAIN_RULE = '———';

const MARK_STYLES: Readonly<Record<string, PlainStyle>> = {
  b: 'BOLD',
  i: 'ITALIC',
  s: 'STRIKETHROUGH',
  spoiler: 'SPOILER',
};

/**
 * Render to plain text.
 *
 * A class-free accumulator, because the one piece of state is the output length and threading it
 * through a recursion that also returns strings is how the offsets come to disagree with the text.
 */
export function renderPlain(document: RichText, context: RenderContext): PlainRender {
  const out = new PlainWriter(context);
  out.blocks(document.blocks, 0);
  return out.finish();
}

class PlainWriter {
  #text = '';
  readonly #styles: PlainStyleRange[] = [];
  readonly #mentions: PlainMentionRange[] = [];
  readonly #context: RenderContext;

  constructor(context: RenderContext) {
    this.#context = context;
  }

  finish(): PlainRender {
    // Trailing blank lines come from the `\n\n` every block appends; a message that ends in them
    // shows an empty bubble tail on some clients and costs length on all of them.
    const text = this.#text.replace(/\n+$/, '');
    return { text, styles: this.#styles, mentions: this.#mentions };
  }

  blocks(blocks: readonly Block[], depth: number): void {
    for (const block of blocks) this.#block(block, depth);
  }

  #block(block: Block, depth: number): void {
    switch (block.t) {
      case 'p':
        this.#inlines(block.c);
        this.#write('\n\n');
        return;
      case 'h':
        // A heading is a line, not a decoration: `#` would read as the markup it is.
        this.#inlines(block.c);
        this.#write('\n\n');
        return;
      case 'list':
        this.#list(block, depth);
        return;
      case 'code':
        // Verbatim, and on its own lines. Signal gets a MONOSPACE range over it; everybody else
        // gets text that is still readable without one.
        this.#styled(block.text, 'MONOSPACE');
        this.#write('\n\n');
        return;
      case 'quote':
        this.#quote(block, depth);
        return;
      case 'hr':
        this.#write(`${PLAIN_RULE}\n\n`);
        return;
    }
  }

  #list(block: Extract<Block, { t: 'list' }>, depth: number): void {
    const indent = '  '.repeat(depth);
    let number = block.start ?? 1;
    for (const item of block.items) {
      const marker = block.ordered ? `${String(number)}. ` : '• ';
      number += 1;
      this.#write(`${indent}${marker}`);
      // The item's own blocks, with the first paragraph joined to the marker and the rest indented
      // under it. Writing the marker and then recursing would put a bullet on an empty line
      // whenever an item starts with a nested list.
      this.#itemBody(item, depth);
    }
    this.#write('\n');
  }

  #itemBody(item: readonly Block[], depth: number): void {
    item.forEach((child, index) => {
      if (index > 0) this.#write('  '.repeat(depth + 1));
      if (child.t === 'p' || child.t === 'h') {
        this.#inlines(child.c);
        this.#write('\n');
        return;
      }
      this.#block(child, depth + 1);
    });
    if (item.length === 0) this.#write('\n');
  }

  #quote(block: Extract<Block, { t: 'quote' }>, depth: number): void {
    // `> ` per line, applied by rendering the children and prefixing afterwards: prefixing as we
    // go would need every writer below to know it is inside a quote, and a nested quote would then
    // have to agree about the order of the two prefixes.
    const inner = new PlainWriter(this.#context);
    inner.blocks(block.c, depth);
    const rendered = inner.finish();

    const lines = rendered.text.split('\n');
    // A blank line gets `>` alone rather than `> `, because a trailing space on an empty line is
    // whitespace a client may strip and a diff cannot show. That one-character difference is why
    // the offsets below are a **map** rather than arithmetic: the first version shifted by two per
    // preceding newline, which over-counted every blank line by one and put a range one character
    // past the end of the text. Found by the test that slices the text a range describes.
    const prefixes = lines.map((line) => (line === '' ? '>' : '> '));
    const prefixed = lines.map((line, index) => `${prefixes[index] ?? '> '}${line}`).join('\n');

    // How much was inserted before the start of each line, cumulatively.
    const inserted: number[] = [];
    let total = 0;
    for (const prefix of prefixes) {
      total += prefix.length;
      inserted.push(total);
    }
    const base = this.#text.length;
    const shift = (offset: number): number => {
      let line = 0;
      for (let at = 0; at < offset && at < rendered.text.length; at += 1) {
        if (rendered.text[at] === '\n') line += 1;
      }
      return base + offset + (inserted[line] ?? 0);
    };

    for (const range of rendered.styles) {
      this.#styles.push({ ...range, start: shift(range.start) });
    }
    for (const range of rendered.mentions) {
      this.#mentions.push({ ...range, start: shift(range.start) });
    }
    this.#text += `${prefixed}\n\n`;
  }

  #inlines(inlines: readonly Inline[]): void {
    for (const inline of inlines) this.#inline(inline);
  }

  #inline(inline: Inline): void {
    switch (inline.t) {
      case 'text': {
        if (inline.marks === undefined || inline.marks.length === 0) {
          this.#write(inline.text);
          return;
        }
        const start = this.#text.length;
        this.#write(inline.text);
        // One range **per mark**, not one per run: a bold-and-italic run is two ranges, which
        // signal-cli accepts and which is the only way to say both. An earlier draft picked the
        // first mark that had a style and silently dropped the rest.
        for (const mark of inline.marks) {
          const name = MARK_STYLES[mark];
          if (name !== undefined) {
            this.#styles.push({ start, length: inline.text.length, style: name });
          }
        }
        return;
      }
      case 'code':
        this.#styled(inline.text, 'MONOSPACE');
        return;
      case 'link': {
        const label = inline.c.map((run) => run.text).join('');
        // `label (url)` unless they are the same, per `06` §3.5.3 — a bare URL written twice is
        // the most common way a plain-text fallback looks broken.
        this.#write(label === '' || label === inline.url ? inline.url : `${label} (${inline.url})`);
        return;
      }
      case 'mention': {
        const resolved = this.#resolve(inline);
        const start = this.#text.length;
        this.#write(resolved.text);
        if (resolved.platformUserId !== undefined) {
          this.#mentions.push({
            start,
            length: resolved.text.length,
            platformUserId: resolved.platformUserId,
          });
        }
        return;
      }
      case 'time':
        // `06` §3.5.1: the fallback is pre-rendered in the reader's zone by whoever built the node.
        this.#write(inline.fallback);
        return;
      case 'br':
        this.#write('\n');
        return;
    }
  }

  /**
   * What a mention becomes, and whether it may ping.
   *
   * `06` §3.6: "A mention that cannot ping renders as the plain `fallback` text." So an unpingable
   * mention gets no range — which is the whole mechanism, because on Signal a range **is** the
   * ping.
   */
  #resolve(inline: Extract<Inline, { t: 'mention' }>): {
    text: string;
    platformUserId?: string;
  } {
    if (inline.target.kind === 'platform_user') {
      return { text: inline.fallback, platformUserId: inline.target.platformUserId };
    }
    const resolved = this.#context.mentions[inline.target.memberId];
    if (resolved === undefined) return { text: inline.fallback };
    const text = `@${resolved.displayName}`;
    if (!resolved.canPing || resolved.platformUserId === undefined) return { text };
    return { text, platformUserId: resolved.platformUserId };
  }

  #styled(text: string, style: PlainStyle): void {
    const start = this.#text.length;
    this.#write(text);
    if (text.length > 0) this.#styles.push({ start, length: text.length, style });
  }

  #write(text: string): void {
    this.#text += text;
  }
}
