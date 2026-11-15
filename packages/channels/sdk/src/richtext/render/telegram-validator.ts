/**
 * A validator for Telegram HTML (`06` §3.5.3; `M3-T4`'s AC).
 *
 * `M3-T4`'s acceptance criterion is "Telegram HTML validator (balanced, allowlisted tags) passes
 * for every output", and the reason it is a validator rather than a set of expectations is the
 * failure mode: Telegram answers `400 can't parse entities` and sends **nothing**. There is no
 * partial render, no fallback inside the platform, and the input that triggers it is a message
 * somebody else wrote — so the corpus of inputs that could break it is not enumerable, and what
 * can be enumerated is the property every output must have.
 *
 * Four properties, each one a way Telegram's parser actually fails:
 *
 *  1. **every tag is allowlisted.** Telegram rejects an unknown tag rather than ignoring it, so a
 *     renderer reaching for `<u>` or `<em>` is a 400 on every message that uses it;
 *  2. **tags are balanced and properly nested.** `<b><i>x</b></i>` is a 400;
 *  3. **`<code>` has no tags inside it**, per §3.5.3 — accepted by the parser and rendered
 *     differently on Desktop and Android, which is worse than a rejection;
 *  4. **no entity outside the four that exist.** `&nbsp;` is a 400.
 *
 * This is a checker for *our* output, not a general HTML parser: it assumes the renderer emits
 * double-quoted attributes and no self-closing tags, both of which it asserts.
 */

/** The tags `06` §3.5.3 allows this renderer to emit. */
export const TELEGRAM_TAGS: readonly string[] = [
  'a',
  'b',
  'i',
  's',
  'tg-spoiler',
  'tg-time',
  'code',
  'pre',
  'blockquote',
];

/** The attributes each tag may carry, which is the other half of the allowlist. */
const TELEGRAM_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href'],
  code: ['class'],
  'tg-time': ['unix', 'format'],
  blockquote: ['expandable'],
};

export interface TelegramHtmlProblem {
  readonly kind:
    | 'unknown_tag'
    | 'unknown_attribute'
    | 'unbalanced'
    | 'tag_inside_code'
    | 'unknown_entity'
    | 'malformed';
  readonly detail: string;
}

/** A tag as the scanner read it. */
interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly attributes: readonly TagAttribute[];
  readonly at: number;
}

/** One attribute of one tag. `value` is `undefined` for a bare attribute like `expandable`. */
export interface TagAttribute {
  readonly name: string;
  readonly value?: string | undefined;
}

/** One attribute, with the tag it was on. */
export interface TelegramAttribute extends TagAttribute {
  readonly tag: string;
}

/** Every way `html` would fail Telegram's parser. Empty means it parses. */
export function validateTelegramHtml(html: string): readonly TelegramHtmlProblem[] {
  const problems: TelegramHtmlProblem[] = [];
  const stack: string[] = [];

  for (const tag of scanTags(html, problems)) {
    if (!TELEGRAM_TAGS.includes(tag.name)) {
      problems.push({ kind: 'unknown_tag', detail: `<${tag.closing ? '/' : ''}${tag.name}>` });
      continue;
    }
    problems.push(...checkTag(tag, stack));
    if (tag.closing) stack.pop();
    else stack.push(tag.name);
  }

  if (stack.length > 0) {
    problems.push({ kind: 'unbalanced', detail: `unclosed: ${stack.join(', ')}` });
  }
  problems.push(...unknownEntities(html));
  return problems;
}

/**
 * The problems one tag has, given what is open around it.
 *
 * Lifted out of the loop above so each function stays under Biome's complexity ceiling — and the
 * split falls where the reading does: the loop maintains the stack, this decides whether one tag
 * is allowed where it is.
 */
function checkTag(tag: Tag, stack: readonly string[]): readonly TelegramHtmlProblem[] {
  const problems: TelegramHtmlProblem[] = [];
  // Anything opened while `code` is on the stack is inside it, and `pre` wrapping `code` is the
  // one legitimate pairing — which is why this looks at the stack rather than at the previous tag.
  if (!tag.closing && stack.includes('code')) {
    problems.push({ kind: 'tag_inside_code', detail: `<${tag.name}> inside <code>` });
  }
  for (const attribute of tag.attributes) {
    if (!(TELEGRAM_ATTRIBUTES[tag.name] ?? []).includes(attribute.name)) {
      problems.push({ kind: 'unknown_attribute', detail: `${attribute.name} on <${tag.name}>` });
    }
  }
  if (tag.closing) {
    const open = stack.at(-1);
    if (open !== tag.name) {
      problems.push({ kind: 'unbalanced', detail: `</${tag.name}> closes <${open ?? 'nothing'}>` });
    }
  }
  return problems;
}

/** Whether `html` is something Telegram will accept. */
export function isValidTelegramHtml(html: string): boolean {
  return validateTelegramHtml(html).length === 0;
}

/**
 * Every attribute on every **real** tag in `html`.
 *
 * Exported because a test that wants to know "does any `href` here hold a `tg://` URL" cannot ask
 * a regex: `&lt;a href="tg://…"&gt;` is *escaped text* and matches `/href="([^"]*)"/` while being
 * completely inert. `06` §3.5.3 escapes `"` only inside attribute values, so a quote in text stays
 * a quote — which is correct, and which makes a regex over the whole string answer a different
 * question from the one being asked. The first version of `injection.test.ts` asked it that way
 * and failed on exactly that input.
 */
export function telegramAttributes(html: string): readonly TelegramAttribute[] {
  const out: TelegramAttribute[] = [];
  for (const tag of scanTags(html, [])) {
    for (const attribute of tag.attributes) out.push({ tag: tag.name, ...attribute });
  }
  return out;
}

/**
 * The tags in `html`, in order.
 *
 * A hand-written scan rather than a regex, because the one thing a regex gets wrong here is a `>`
 * inside an attribute value — and that is exactly the case an escaping bug produces, so the
 * scanner has to be right about it to be worth running.
 */
function scanTags(html: string, problems: TelegramHtmlProblem[]): readonly Tag[] {
  const tags: Tag[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open === -1) break;
    const parsed = readTag(html, open, problems);
    if (parsed === undefined) {
      at = open + 1;
      continue;
    }
    tags.push(parsed.tag);
    at = parsed.end;
  }
  return tags;
}

function readTag(
  html: string,
  open: number,
  problems: TelegramHtmlProblem[],
): { tag: Tag; end: number } | undefined {
  let at = open + 1;
  const closing = html[at] === '/';
  if (closing) at += 1;
  const nameStart = at;
  while (at < html.length && /[a-zA-Z0-9-]/.test(html[at] ?? '')) at += 1;
  const name = html.slice(nameStart, at).toLowerCase();
  if (name === '') {
    // A bare `<` in text. The renderer escapes those, so reaching here is an escaping bug — and
    // Telegram reads it as the start of a tag, which is the 400.
    problems.push({ kind: 'malformed', detail: `unescaped '<' at ${String(open)}` });
    return undefined;
  }
  const attributes: TagAttribute[] = [];
  while (at < html.length) {
    while (html[at] === ' ' || html[at] === '\n') at += 1;
    if (html[at] === '>') return { tag: { name, closing, attributes, at: open }, end: at + 1 };
    if (html[at] === '/' && html[at + 1] === '>') {
      problems.push({ kind: 'malformed', detail: `self-closing <${name}>` });
      return { tag: { name, closing, attributes, at: open }, end: at + 2 };
    }
    const read = readAttribute(html, at, name, problems);
    if (read === undefined) return undefined;
    attributes.push(read.attribute);
    at = read.end;
  }
  problems.push({ kind: 'malformed', detail: `unterminated <${name}> at ${String(open)}` });
  return undefined;
}

/** One `name` or `name="value"`, or `undefined` with the problem recorded. */
function readAttribute(
  html: string,
  from: number,
  tag: string,
  problems: TelegramHtmlProblem[],
): { attribute: TagAttribute; end: number } | undefined {
  let at = from;
  while (at < html.length && /[a-zA-Z0-9-]/.test(html[at] ?? '')) at += 1;
  const name = html.slice(from, at).toLowerCase();
  if (name === '') {
    problems.push({ kind: 'malformed', detail: `unparseable <${tag}> at ${String(from)}` });
    return undefined;
  }
  // A bare attribute, which is how the renderer writes `expandable`.
  if (html[at] !== '=') return { attribute: { name }, end: at };
  at += 1;
  if (html[at] !== '"') {
    problems.push({ kind: 'malformed', detail: `${name} on <${tag}> is not quoted` });
    return undefined;
  }
  at += 1;
  const valueEnd = html.indexOf('"', at);
  if (valueEnd === -1) {
    problems.push({ kind: 'malformed', detail: `${name} on <${tag}> is unterminated` });
    return undefined;
  }
  // Skipping to the closing quote is what makes a `>` inside the value harmless, which is the
  // reason this is not a regex.
  return { attribute: { name, value: html.slice(at, valueEnd) }, end: valueEnd + 1 };
}

/** `&…;` sequences that are not one of Telegram's four (`06` §3.5.3: "never emit others"). */
function unknownEntities(html: string): readonly TelegramHtmlProblem[] {
  const problems: TelegramHtmlProblem[] = [];
  for (const match of html.matchAll(/&[a-zA-Z#][a-zA-Z0-9#]*;?/g)) {
    const entity = match[0];
    if (entity === '&amp;' || entity === '&lt;' || entity === '&gt;' || entity === '&quot;') {
      continue;
    }
    problems.push({ kind: 'unknown_entity', detail: entity });
  }
  return problems;
}
