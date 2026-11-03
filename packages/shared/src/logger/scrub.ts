/**
 * Scrubbing: the layer that assumes something content-bearing reached a log anyway.
 *
 * `01` §11.7 forbids message and memory content in logs above `debug`, and `08` §3.10 (S2) forbids
 * secrets in logs at all. The type system enforces the first (`fields.ts` has no content field) and
 * `SecretString` enforces the second. This module exists because neither covers the one place a
 * secret genuinely tends to appear: **inside an error message from somebody else's code.**
 *
 * The canonical example is Telegram. Its API URL *is* the bot token —
 * `https://api.telegram.org/bot<TOKEN>/sendMessage` — so any HTTP error that quotes its own URL
 * publishes the credential. Anthropic and OpenAI put request ids and sometimes echoes of the
 * request in error bodies. A library that logs `err.message` without scrubbing leaks all of it.
 *
 * `scrubErrorMessage` runs the four steps `11` §3.10.1 specifies, in order, then the secret-shape
 * patterns from `08` §3.10 layer 2. The order matters: quoted content goes first (it is the biggest
 * leak and the easiest to recognise), then URLs (which removes the Telegram token wholesale), then
 * the remaining shapes.
 */

/** What a scrubbed span is replaced with. Distinct from `SecretString`'s `[redacted]` so a reader can tell which layer fired. */
export const SCRUBBED = '[scrubbed]' as const;

/**
 * Secret shapes from `08` §3.10 layer 2, each named so a test can target it and a reader can see
 * what it is for.
 *
 * **Note on the `v…` prefixes.** `08` §3.7.11 and §3.10 define this project's own token prefixes as
 * `vs1_`, `vmcp_`, `vml1.`, `vlp_`, `vics_`, `vctl_`, `VLG-` and `VRK1-` — the `v` is for the old
 * codename. They are kept verbatim here so the canary test matches the spec exactly. Re-deriving
 * them from `BRAND` belongs to `M1-T29` (`TokenService`), which is the task that actually mints
 * them and the last moment it is free: once a token exists in someone's `data/keys/`, changing the
 * prefix becomes a migration. Recorded in `STATUS.md` → Plan changes.
 */
export const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  // --- This project's own tokens (08 §3.7.11) ------------------------------------------------
  {
    name: 'own-token-prefix',
    pattern: /\b(?:vs1_|vmcp_|vlp_|vics_|vctl_)[A-Za-z0-9_-]{8,}/g,
  },
  { name: 'own-magic-link', pattern: /\bvml1\.[A-Za-z0-9_.-]{8,}/g },
  { name: 'own-pairing-code', pattern: /\bVLG-[A-Z0-9-]{4,}/g },
  { name: 'own-recovery-key', pattern: /\bVRK1-[A-Z0-9-]{8,}/g },

  // --- Provider keys ---------------------------------------------------------------------------
  // `sk-ant-` first, so the Anthropic shape is named in diagnostics rather than being swallowed by
  // the broader `sk-` rule.
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g },
  // `08` §3.10 writes this as exactly `{35}`. Loosened to `{30,}`: a real key is `AIza` + 35, but an
  // exact count with a trailing `\b` silently misses a key that is longer or butted against another
  // word — and missing one is far worse than scrubbing a few extra characters.
  { name: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'slack-token', pattern: /\bxox[bpasr]-[A-Za-z0-9-]{10,}/g },
  { name: 'slack-app-token', pattern: /\bxapp-[A-Za-z0-9-]{10,}/g },

  // --- Platform tokens -------------------------------------------------------------------------
  // Telegram: `<bot-id>:<secret>`. This is the one that hides inside a URL, which is why the URL
  // step runs before the shape steps.
  { name: 'telegram-token', pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}/g },
  // Discord: three dot-separated base64url segments.
  {
    name: 'discord-token',
    pattern: /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}\b/g,
  },
  // Matrix access tokens.
  { name: 'matrix-token', pattern: /\bsyt_[A-Za-z0-9_-]{16,}/g },

  // --- Key material ----------------------------------------------------------------------------
  {
    name: 'pem-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // A long base64 blob sitting next to the word key, secret, token or password. Narrow on purpose:
  // an unqualified "long base64" rule would eat legitimate ids and hashes out of every message.
  {
    name: 'adjacent-base64',
    pattern:
      /\b(key|secret|token|password|apiKey|api_key)\b["'\s:=]{1,6}[A-Za-z0-9+/]{32,}={0,2}/gi,
  },
];

/** A bearer or basic credential in an `Authorization` header that leaked into prose. */
const AUTHORIZATION = /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/** `user@example.com` */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * An international-looking phone number: 8–15 digits, optionally with `+`, spaces, dashes or
 * parentheses. Deliberately requires 8 digits so timestamps, byte counts and ids survive.
 */
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{6,17}\d(?![\w.])/g;

/** A quoted span. Group 1 and 2 are the double- and single-quoted bodies. */
const QUOTED = /"([^"]*)"|'([^']*)'/g;

/** Any URL. Replaced with scheme and host only. */
const URL_PATTERN = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#"'<>]+)(\/[^\s"'<>]*)?/gi;

export const MAX_MESSAGE_LENGTH = 200;

/** Longer than this inside quotes and it is treated as content rather than as an identifier. */
const MAX_QUOTED_LENGTH = 24;

/** Replace the secret shapes from `08` §3.10 layer 2. Exported so the canary test can target it. */
export function scrubSecretShapes(text: string): string {
  let out = text;
  for (const { pattern } of SECRET_PATTERNS) {
    // A fresh regex each time: a shared `g`-flagged pattern carries `lastIndex` between calls, and
    // reusing one would skip matches non-deterministically.
    out = out.replace(new RegExp(pattern.source, pattern.flags), SCRUBBED);
  }
  return out.replace(AUTHORIZATION, SCRUBBED);
}

/**
 * Make a foreign error message safe to log.
 *
 * Order is `11` §3.10.1's:
 *   1. drop quoted substrings longer than 24 characters — that is where a library echoes back the
 *      input, and for us the input is somebody's private message;
 *   2. reduce URLs to `scheme://host/…`, which removes the Telegram `bot<token>` path segment;
 *   3. mask email, phone and secret shapes;
 *   4. truncate to 200 characters.
 */
export function scrubErrorMessage(message: string): string {
  if (message === '') return '';

  // 1. Quoted content. A short quoted span is usually an identifier or a field name worth keeping.
  let out = message.replace(
    QUOTED,
    (match, double: string | undefined, single: string | undefined) => {
      const body = double ?? single ?? '';
      if (body.length <= MAX_QUOTED_LENGTH) return match;
      const quote = double === undefined ? "'" : '"';
      return `${quote}${SCRUBBED}${quote}`;
    },
  );

  // 2. URLs → scheme://host/… The path, query and fragment all go; for Telegram the path IS the
  // credential, and for every provider the query can carry one.
  out = out.replace(URL_PATTERN, (_match, scheme: string, host: string, path?: string) =>
    path === undefined || path === '/' ? `${scheme}://${host}` : `${scheme}://${host}/…`,
  );

  // 3. Shapes.
  out = scrubSecretShapes(out);
  out = out.replace(EMAIL, SCRUBBED).replace(PHONE, SCRUBBED);

  // 4. Truncate. The ellipsis makes it obvious the message was cut rather than ending oddly.
  return out.length <= MAX_MESSAGE_LENGTH ? out : `${out.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

/**
 * Scrub every string anywhere in a value, leaving the structure intact.
 *
 * Used on the serialised form of a log line as the last thing before it is written, and on the
 * `doctor --bundle` output. Cycles are handled, because an error with a `cause` chain can contain
 * one.
 */
export function scrubDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubSecretShapes(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      scrubDeep(item, seen),
    ]),
  );
}
