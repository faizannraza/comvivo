/**
 * The two pieces of syntax CommonMark does not have (`06` §3.5.2; `M3-T3`).
 *
 *  - `||secret||` → a `spoiler` mark;
 *  - `@{mbr_…}` → a `mention` node.
 *
 * ## Why this runs after parsing, on `text` nodes only
 *
 * `06` §3.5.2 is explicit: "applied after parsing, to `text` nodes only, never inside code". Both
 * halves matter. Running it *before* `mdast-util-from-markdown` would mean the markdown parser saw
 * tokens this module had already rewritten, and a `||` inside a fenced block would be eaten by a
 * transformation the member never asked for — a reply containing shell code with `a||b` would come
 * back with half of it hidden behind a spoiler.
 *
 * And because it runs on the finished tree, it is a **mark and node rewrite**, not a text
 * substitution: a `||x||` inside a `**bold**` run keeps its `b` mark and gains `spoiler`, which a
 * regex over the source string could not have expressed.
 *
 * ## Why neither nests
 *
 * `06` §3.5.2 says the spoiler is a "single text run, no nesting". That is a product decision
 * rather than a limitation: a spoiler exists so a reader can choose not to see something, and a
 * spoiler containing a link or another spoiler gives platforms — which implement this with five
 * different primitives — five different ways to leak half of it.
 */
import type { Inline, Mark, TextInline } from '@comvivo/core';
import type { Logger, MemberId } from '@comvivo/shared';

/**
 * `@{mbr_<26 chars>}`, the form `05`'s prompt builder tells the model to use.
 *
 * The 26-character suffix is a TypeID's base32, and the character class is Crockford's **without**
 * `i`, `l`, `o` and `u` — so an id with one of those is ill-formed by construction and takes the
 * `@?` path below rather than being looked up and missed.
 */
const MENTION_PATTERN = /@\{(mbr_[0-9abcdefghjkmnpqrstvwxyz]{26})\}/g;

/** `||x||`, non-greedy, no nesting, and never across a line break. */
const SPOILER_PATTERN = /\|\|([^|\n]+)\|\|/g;

/** What a member id resolves to. `undefined` means "not in this group". */
export type MentionResolver = (memberId: MemberId) => MentionResolution | undefined;

export interface MentionResolution {
  /** `"@Display Name"` — what a platform with no mention primitive shows (`06` §3.5.1). */
  readonly fallback: string;
}

export interface CustomSyntaxOptions {
  /**
   * The group's roster.
   *
   * Required, not optional, and that is the point: without a roster every `@{mbr_…}` is unknown
   * and becomes `@?`, which is correct but is also a silent downgrade of every mention in a reply.
   * Making the caller pass something — even an empty resolver — is what stops that from happening
   * by omission.
   */
  readonly resolveMember: MentionResolver;
  readonly logger?: Logger | undefined;
}

/** The text a mention that cannot be resolved is shown as (`06` §3.5.2). */
export const UNRESOLVED_MENTION_TEXT = '@?';

/**
 * Rewrite the custom syntax inside one run of inlines.
 *
 * Takes and returns a list because one `text` node can become several nodes — a mention splits
 * the run around it — and because that keeps the caller (`parse.ts`) from having to know which
 * inline kinds this touches.
 */
export function applyCustomSyntax(
  inlines: readonly Inline[],
  options: CustomSyntaxOptions,
): Inline[] {
  const out: Inline[] = [];
  for (const inline of inlines) {
    // Every other kind passes through untouched. `code` in particular: `06` §3.5.2's "never inside
    // code", which is the clause that keeps a shell snippet readable.
    if (inline.t !== 'text') {
      out.push(inline);
      continue;
    }
    out.push(...expand(inline, options));
  }
  return out;
}

/** One `text` run, with its mentions split out and its spoilers marked. */
function expand(run: TextInline, options: CustomSyntaxOptions): Inline[] {
  const out: Inline[] = [];
  let cursor = 0;
  MENTION_PATTERN.lastIndex = 0;
  for (const match of run.text.matchAll(MENTION_PATTERN)) {
    const start = match.index;
    const id = match[1];
    if (id === undefined) continue;
    pushText(out, run, run.text.slice(cursor, start));
    out.push(...resolve(id as MemberId, run, options));
    cursor = start + match[0].length;
  }
  pushText(out, run, run.text.slice(cursor));
  return out;
}

/** A member id as a `mention`, or `06` §3.5.2's `@?` when the group does not have them. */
function resolve(
  memberId: MemberId,
  run: TextInline,
  options: CustomSyntaxOptions,
): readonly Inline[] {
  const resolution = options.resolveMember(memberId);
  if (resolution === undefined) {
    // No id in the line: a member id is a handle to a person (`01` §11.7). The count is what an
    // operator needs — one of these is a prompt that got the roster wrong, hundreds is a model
    // inventing ids.
    options.logger?.warn('channel.mention_unresolved', {});
    // Carries the run's marks, so `**@{mbr_…}**` degrades to a bold `@?` rather than losing the
    // emphasis the model put around it.
    return [textNode(UNRESOLVED_MENTION_TEXT, run.marks)];
  }
  return [{ t: 'mention', target: { kind: 'member', memberId }, fallback: resolution.fallback }];
}

/** Append `text` as a run with `source`'s marks, with its spoilers applied. Skips empty text. */
function pushText(out: Inline[], source: TextInline, text: string): void {
  if (text === '') return;
  out.push(...markSpoilers(text, source.marks));
}

/**
 * Split `text` on `||…||`, giving the inside an extra `spoiler` mark.
 *
 * The surrounding marks are kept on both the hidden and the visible parts, which is what makes
 * `**a ||b|| c**` come out as three bold runs with the middle one hidden.
 */
function markSpoilers(text: string, marks: readonly Mark[] | undefined): Inline[] {
  const out: Inline[] = [];
  let cursor = 0;
  SPOILER_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(SPOILER_PATTERN)) {
    const inner = match[1];
    if (inner === undefined) continue;
    if (match.index > cursor) out.push(textNode(text.slice(cursor, match.index), marks));
    out.push(textNode(inner, [...(marks ?? []), 'spoiler']));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) out.push(textNode(text.slice(cursor), marks));
  return out;
}

/**
 * A `text` node with canonically sorted, de-duplicated marks (`06` §3.5.1).
 *
 * Sorted here rather than at the point each mark is added, because the AST's contract is "`marks`
 * is sorted canonically: `b`, `i`, `s`, `spoiler`" and two nodes that differ only in mark order
 * would compare unequal in the golden corpus and in every renderer's cache key.
 */
export function textNode(text: string, marks: readonly Mark[] | undefined): TextInline {
  if (marks === undefined || marks.length === 0) return { t: 'text', text };
  return { t: 'text', text, marks: canonicalMarks(marks) };
}

const MARK_ORDER: readonly Mark[] = ['b', 'i', 's', 'spoiler'];

export function canonicalMarks(marks: readonly Mark[]): Mark[] {
  const present = new Set(marks);
  return MARK_ORDER.filter((mark) => present.has(mark));
}
