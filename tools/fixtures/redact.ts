/**
 * The fixture redactor (`06` §3.25; `M3-T9`).
 *
 * A recorded fixture is a real payload from a real chat. Before it reaches the repository it has to
 * stop being one, and the thing that makes that safe rather than hopeful is **determinism**: the
 * same input and the same salt produce the same output, so an id that appeared in three recordings
 * is the same fake id in all three, and a reviewer can diff a re-recording against its predecessor
 * and see only what actually changed on the platform.
 *
 * `06` §3.25 names four rules:
 *
 * 1. **Ids are remapped to stable fakes via HMAC with a per-repo salt.** HMAC rather than a counter,
 *    because a counter needs shared state across files and across runs; HMAC needs only the salt.
 *    The output keeps the *shape* of the original — Telegram's negative supergroup ids stay negative
 *    and 13 digits, a Matrix room id keeps its `!…:server` form — because an adapter's own parsing
 *    is part of what the fixture tests, and a fake id of the wrong shape tests the wrong thing.
 * 2. **Names are replaced from a persona list**, chosen by HMAC so the same person is the same
 *    persona everywhere.
 * 3. **Tokens, signed URLs, phone numbers and emails are removed**, not remapped. There is no
 *    shape-preserving fake for a credential that is worth the risk of one looking real.
 * 4. **Media is replaced with tiny synthetic files** — out of scope here, which handles JSON; the
 *    recorder writes the files and this records that it did.
 *
 * ## Why the salt never enters the tree
 *
 * The manifest carries `saltId`, an HMAC *of* the salt under a fixed label. Two fixtures with the
 * same `saltId` were remapped consistently, which is the only property a reviewer needs — and the
 * salt itself stays in `.env`, because publishing it would make every remapped id reversible by
 * anyone who could guess the original.
 */
import { createHmac } from 'node:crypto';

/** Bumped when a rule changes, so a fixture redacted by an older rule set is visible in review. */
export const REDACTOR_VERSION = 1;

/**
 * The personas. Deliberately unremarkable and from several scripts, because a corpus of fixtures is
 * also the thing a contributor reads to learn the product, and `Test User 1` teaches nothing about
 * how a name renders.
 */
export const PERSONAS: readonly string[] = [
  'Ana Oyelaran',
  'Sam Whitfield',
  'Mira Castellano',
  'Jonah Petrov',
  'Priya Raghunathan',
  'Tomas Lindqvist',
  'Yuki Nakamura',
  'Leila Haddad',
  'Ben Okonkwo',
  'Noor Rahimi',
  'Elif Demirci',
  'Caleb Mwangi',
];

/** What a removed credential is replaced with. Searchable, and obviously not a credential. */
export const SCRUBBED = '[redacted]';

/**
 * The patterns that are **removed** rather than remapped.
 *
 * Each one is a thing that grants access or identifies a person outside the group, and the order
 * matters: the signed-URL rule runs before the generic token rule, so a URL's query string is
 * scrubbed as a unit rather than leaving `https://…?hm=[redacted]` with the file path intact.
 */
export const SCRUB_RULES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  // A Telegram bot token: `<digits>:<35 base64-ish>`. First, because it also matches as a "token".
  { name: 'telegram_bot_token', pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
  // Slack's `xoxb-`/`xapp-`/`xoxp-` family, Discord's bot token, and GitHub's `gh[pousr]_`.
  { name: 'prefixed_token', pattern: /\b(?:xox[bapsr]|xapp|gh[pousr])-?[A-Za-z0-9_-]{10,}\b/g },
  // A bearer token in a header-shaped string.
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  // A URL carrying a signature or token in its query.
  {
    name: 'signed_url',
    pattern:
      /https?:\/\/[^\s"']*[?&](?:hm|sig|signature|token|key|X-Amz-Signature)=[^\s"'&]+[^\s"']*/gi,
  },
  // An E.164-ish phone number. Signal's ACI-adjacent identifiers are the reason this is here.
  { name: 'phone', pattern: /(?<![\w.])\+[1-9]\d{7,14}(?![\w.])/g },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // A JWT, which is how a Matrix or web session arrives.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

/** Keys whose **values** are identifiers to remap, matched case-insensitively on the leaf name. */
const ID_KEYS = new Set([
  'id',
  'chat_id',
  'chatid',
  'user_id',
  'userid',
  'from_id',
  'message_id',
  'messageid',
  'channel_id',
  'channelid',
  'guild_id',
  'guildid',
  'team_id',
  'room_id',
  'roomid',
  'event_id',
  'eventid',
  'thread_ts',
  'ts',
  'platformchatid',
  'platformuserid',
  'platformmessageid',
  'sourceid',
  'uuid',
  'number',
  'recipient',
]);

/** Keys whose values are human names to replace with a persona. */
const NAME_KEYS = new Set([
  'first_name',
  'firstname',
  'last_name',
  'lastname',
  'username',
  'title',
  'display_name',
  'displayname',
  'displayname_',
  'real_name',
  'realname',
  'name',
  'nick',
  'global_name',
  'globalname',
  'author',
]);

export interface RedactResult {
  readonly value: unknown;
  readonly replaced: Readonly<Record<string, number>>;
  readonly saltId: string;
}

/**
 * A separator between the label and the input, so two domains cannot be confused.
 *
 * `U+001F`, built from its code point rather than written literally. The first version of this file
 * did write it literally, and the character survives — but an invisible control character in a
 * source file is one an editor, a formatter or a copy-paste can drop without a trace, and the loss
 * is invisible in every test: without it `mac(salt, 'a', 'bc')` and `mac(salt, 'ab', 'c')` are the
 * same digest, which is a domain-separation bug nothing would report.
 */
const DOMAIN_SEPARATOR = String.fromCharCode(0x1f);

/** A keyed digest, hex, truncated to `chars`. The one primitive the whole module is built on. */
function mac(salt: string, label: string, input: string, chars: number): string {
  return createHmac('sha256', salt)
    .update(`${label}${DOMAIN_SEPARATOR}${input}`)
    .digest('hex')
    .slice(0, chars);
}

/** A stable digest of the salt, for the manifest. Never the salt itself. */
export function saltId(salt: string): string {
  return mac(salt, 'comvivo/fixture-salt-id', '', 16);
}

/**
 * A fake id with the same shape as the original.
 *
 * Shape-preserving because an adapter's parsing is part of what a fixture tests. Telegram rejects a
 * `chat_id` that is not an integer and its supergroup ids are negative and 13 digits; a Matrix room
 * id is `!localpart:server`; Slack's are `U`/`C` plus uppercase base-36. Replacing any of them with
 * a hex digest would test the fixture loader rather than the adapter.
 */
export function fakeId(salt: string, original: string): string {
  const digest = mac(salt, 'comvivo/fixture-id', original, 32);
  const digits = (count: number): string => {
    let out = '';
    for (let at = 0; at < count; at += 1) {
      out += String(Number.parseInt(digest.slice(at * 2, at * 2 + 2), 16) % 10);
    }
    // A leading zero would turn a numeric id into a different number of digits once parsed.
    return out.replace(/^0/, '1');
  };
  const matrix = /^([!@#$])([^:]+):(.+)$/.exec(original);
  if (matrix !== null) {
    return `${matrix[1] ?? '!'}${digest.slice(0, 18)}:fixture.invalid`;
  }
  const negative = /^-(\d+)$/.exec(original);
  if (negative !== null) return `-${digits((negative[1] ?? '').length)}`;
  if (/^\d+$/.test(original)) return digits(original.length);
  const slackish = /^([A-Z])([A-Z0-9]{6,})$/.exec(original);
  if (slackish !== null) {
    return `${slackish[1] ?? 'U'}${digest.slice(0, slackish[2]?.length ?? 8).toUpperCase()}`;
  }
  // A decimal-with-fraction id (Slack's `ts`), kept parseable as one.
  const timestamp = /^(\d+)\.(\d+)$/.exec(original);
  if (timestamp !== null) {
    return `${digits((timestamp[1] ?? '').length)}.${digits((timestamp[2] ?? '').length)}`;
  }
  return digest.slice(0, Math.max(8, Math.min(original.length, 32)));
}

/** A persona, chosen by HMAC so one person is one persona everywhere. */
export function fakeName(salt: string, original: string): string {
  const digest = mac(salt, 'comvivo/fixture-name', original.toLowerCase().trim(), 8);
  const index = Number.parseInt(digest, 16) % PERSONAS.length;
  return PERSONAS[index] ?? PERSONAS[0] ?? 'Ana Oyelaran';
}

/** Remove every credential pattern from a string, counting what fired. */
export function scrub(text: string, counts: Record<string, number>): string {
  let out = text;
  for (const rule of SCRUB_RULES) {
    out = out.replace(rule.pattern, () => {
      counts[rule.name] = (counts[rule.name] ?? 0) + 1;
      return SCRUBBED;
    });
  }
  return out;
}

/**
 * Redact a parsed fixture payload.
 *
 * Walks the value rather than the serialised text, so a key's *meaning* decides what happens to it:
 * `{"id": 4}` is an identifier and `{"width": 4}` is not, and a regex over the JSON cannot tell
 * them apart. Strings are scrubbed wherever they appear, because a token pasted into a message is
 * still a token.
 */
export function redact(value: unknown, salt: string): RedactResult {
  if (salt.length < 16) {
    throw new RangeError(
      `the fixture salt needs at least 16 characters, got ${String(salt.length)}. ` +
        'It is the only thing making a remapped id irreversible.',
    );
  }
  const counts: Record<string, number> = {};
  const walk = (node: unknown, key: string | null): unknown => {
    if (typeof node === 'string') return redactLeaf(node, key, salt, counts);
    if (typeof node === 'number' && key !== null && ID_KEYS.has(key.toLowerCase())) {
      counts['id'] = (counts['id'] ?? 0) + 1;
      const fake = fakeId(salt, String(node));
      return /^-?\d+$/.test(fake) ? Number(fake) : fake;
    }
    if (Array.isArray(node)) return node.map((entry) => walk(entry, key));
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.entries(node).map(([childKey, child]) => [childKey, walk(child, childKey)]),
      );
    }
    return node;
  };
  return { value: walk(value, null), replaced: counts, saltId: saltId(salt) };
}

function redactLeaf(
  text: string,
  key: string | null,
  salt: string,
  counts: Record<string, number>,
): string {
  const leaf = key?.toLowerCase() ?? '';
  if (ID_KEYS.has(leaf)) {
    counts['id'] = (counts['id'] ?? 0) + 1;
    return fakeId(salt, text);
  }
  if (NAME_KEYS.has(leaf)) {
    counts['name'] = (counts['name'] ?? 0) + 1;
    return fakeName(salt, text);
  }
  return scrub(text, counts);
}
