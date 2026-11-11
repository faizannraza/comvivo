/**
 * Every token shape `08` §3.7.12 defines, as data — plus one parser for all of them.
 *
 * A token is a prefix, a length and an encoding. Writing that down once, as a table, is what makes
 * the two properties that matter checkable:
 *
 *  - **A token of one kind never parses as another.** A session cookie presented as a control
 *    token, or an ICS feed token presented as a personal access token, must be refused by shape
 *    before anything looks it up. With one parser and a prefix per kind that is true by
 *    construction, and `format.prop.test.ts` proves it over every pair.
 *  - **The parser is total.** It takes a string off a cookie, a URL or a chat message — the most
 *    hostile input the product has — and returns a verdict rather than throwing. A parser that can
 *    throw is a parser whose failure path is somebody else's `catch`.
 *
 * ## Why the prefixes are not renamed
 *
 * `vs1_`, `vlp_`, `vctl_`, `vics_`, `vmcp_` and `vml1.` are **format tags**, not brand surfaces —
 * the same decision `M1-T2` recorded for the `VBL1` and `VBK1` magic bytes. A tag's requirements
 * are uniqueness and stability, and stability is the one a stored token actually depends on:
 * renaming the prefix would invalidate every session, every member's ICS subscription and every
 * configured MCP client, to no one's benefit. What *is* derived from `BRAND` is everything a host
 * sees as a name: the cookie names and the CSRF header below.
 *
 * Specification: `docs/plan/08-security-privacy.md` §3.7.12, §3.7.13.
 */
import { BRAND } from '../brand.js';
import { sha256 } from '../crypto/hmac.js';
import { randomToken } from '../crypto/random.js';
import { err, ok, type Result } from '../result.js';
import { SecretString } from '../secrets/secret-string.js';

/**
 * The kinds that are a prefix plus one random body.
 *
 * `mcp` is not here: a personal access token carries its own id (`vmcp_<id>_<secret>`) and has its
 * own functions below. The magic link is not here either — it is a *MAC*, not a random secret, and
 * lives in `mac.ts`. Plugin IPC (§3.7.12's last row) has no format at all: it is a per-process
 * secret that is compared and never serialised, so `randomToken()` is the whole of it.
 */
export type TokenKind =
  | 'pendingLogin'
  | 'session'
  | 'control'
  | 'icsFeed'
  | 'claimLink'
  | 'inviteLink';

export interface TokenShape {
  /** The literal prefix, including its separator. */
  readonly prefix: string;
  /** Bytes of entropy in the body. */
  readonly bytes: number;
  /** The body's length once base64url-encoded without padding. Derived, and asserted in tests. */
  readonly chars: number;
  /** Where this token appears, for the error message a host will read. */
  readonly where: string;
}

/** `bytes` bytes, base64url, no padding. */
const encodedLength = (bytes: number): number => Math.ceil((bytes * 8) / 6);

const shape = (prefix: string, bytes: number, where: string): TokenShape => ({
  prefix,
  bytes,
  chars: encodedLength(bytes),
  where,
});

/**
 * `08` §3.7.12's table, as the code the product runs.
 *
 * The entropy column is 256 bits for anything that authenticates on its own, and 128 bits for the
 * two deep-link tokens, which are short-lived *and* single use — the figures are the spec's, not a
 * judgement made here.
 */
export const TOKEN_SHAPES: Readonly<Record<TokenKind, TokenShape>> = Object.freeze({
  pendingLogin: shape('vlp_', 32, 'the browser half of a pairing login'),
  session: shape('vs1_', 32, 'a dashboard session cookie'),
  control: shape('vctl_', 32, 'the CLI control token'),
  icsFeed: shape('vics_', 32, 'a calendar feed URL'),
  claimLink: shape('c_', 16, 'an instance claim deep link'),
  inviteLink: shape('lnk_', 16, 'a group link deep link'),
});

/** `vmcp_<26-char `mtk_` id suffix>_<43 base64url>` (`08` §3.7.12; scopes and UX in `10` §3.7). */
export const MCP_TOKEN_PREFIX = 'vmcp_';
/** The id half is a typeid suffix: 26 lowercase Crockford characters. */
export const MCP_ID_CHARS = 26;
export const MCP_SECRET_BYTES = 32;

/** Why a token was refused. Never contains any part of the token itself. */
export type TokenRejection =
  | { readonly reason: 'empty' }
  | { readonly reason: 'wrong-prefix'; readonly expected: string }
  | { readonly reason: 'wrong-length'; readonly expected: number; readonly actual: number }
  | { readonly reason: 'not-base64url' }
  | { readonly reason: 'not-crockford' };

export interface ParsedToken {
  readonly kind: TokenKind | 'mcp';
  /** The token as presented, wrapped so it cannot be logged by accident (`08` §3.7.13). */
  readonly secret: SecretString;
  /**
   * SHA-256 of the **whole** presented token, prefix included — the lookup key, because
   * `08` §3.7.12 stores digests rather than tokens.
   *
   * Including the prefix is deliberate and is pinned by a known-answer test. It binds the digest to
   * the kind, so a digest stored for one kind of token cannot be matched by another kind even if
   * their bodies were somehow equal, and it means the host stores a digest of exactly the string
   * the holder has.
   */
  readonly digest: Buffer;
}

/** A personal access token also carries the id of the row it belongs to. */
export interface ParsedMcpToken extends ParsedToken {
  readonly kind: 'mcp';
  /** The full `mtk_…` id, ready to use as a primary key. */
  readonly id: string;
}

/** base64url, no padding. Rejects `+`, `/` and `=`, which is the point. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Lowercase Crockford base32, as `ids.ts` encodes a typeid suffix. */
const TYPEID_SUFFIX = /^[0-9abcdefghjkmnpqrstvwxyz]+$/;

/**
 * A fresh token of `kind`.
 *
 * Returns a `SecretString`, so the only way to get the characters is `.expose()` — which `08`
 * §3.7.13 makes the audit trail: `grep -rn '\.expose()'` is the list of every place a secret
 * becomes a plain string.
 */
export function mintToken(kind: TokenKind): SecretString {
  const token = TOKEN_SHAPES[kind];
  return new SecretString(kind, `${token.prefix}${randomToken(token.bytes)}`);
}

/**
 * Parse a presented token of `kind`.
 *
 * Shape only: this says "it could be one of ours", never "it is valid". The caller still has to
 * find the row by `digest` and check its expiry, its single-use flag and its bindings — which is
 * why the digest is here and the plaintext is wrapped.
 */
export function parseToken(
  kind: TokenKind,
  presented: string,
): Result<ParsedToken, TokenRejection> {
  const token = TOKEN_SHAPES[kind];
  if (presented === '') return err({ reason: 'empty' });
  if (!presented.startsWith(token.prefix)) {
    return err({ reason: 'wrong-prefix', expected: token.prefix });
  }
  const body = presented.slice(token.prefix.length);
  if (body.length !== token.chars) {
    return err({ reason: 'wrong-length', expected: token.chars, actual: body.length });
  }
  if (!BASE64URL.test(body)) return err({ reason: 'not-base64url' });
  return ok({ kind, secret: new SecretString(kind, presented), digest: sha256(presented) });
}

/** A fresh personal access token for the row `id` (`10` §3.7 owns issuance). */
export function mintMcpToken(id: string): SecretString {
  const suffix = idSuffix(id);
  if (suffix === undefined) {
    throw new RangeError(
      `an MCP token belongs to an mtk_ id with ${String(MCP_ID_CHARS)} suffix characters, got ${JSON.stringify(id)}`,
    );
  }
  return new SecretString('mcp', `${MCP_TOKEN_PREFIX}${suffix}_${randomToken(MCP_SECRET_BYTES)}`);
}

/** The 26-character suffix of an `mtk_` id, or `undefined` if that is not what this is. */
function idSuffix(id: string): string | undefined {
  const prefix = 'mtk_';
  if (!id.startsWith(prefix)) return undefined;
  const suffix = id.slice(prefix.length);
  return suffix.length === MCP_ID_CHARS && TYPEID_SUFFIX.test(suffix) ? suffix : undefined;
}

/**
 * Parse a presented personal access token.
 *
 * The id travels in the token so a lookup is a primary-key read rather than a scan of every token
 * digest in the table — and so a token for a revoked row can be refused by id without a timing
 * difference that depends on the secret.
 */
export function parseMcpToken(presented: string): Result<ParsedMcpToken, TokenRejection> {
  if (presented === '') return err({ reason: 'empty' });
  if (!presented.startsWith(MCP_TOKEN_PREFIX)) {
    return err({ reason: 'wrong-prefix', expected: MCP_TOKEN_PREFIX });
  }
  const rest = presented.slice(MCP_TOKEN_PREFIX.length);
  const separator = rest.indexOf('_');
  const suffix = separator === -1 ? '' : rest.slice(0, separator);
  const body = separator === -1 ? '' : rest.slice(separator + 1);
  const expected = MCP_ID_CHARS + 1 + encodedLength(MCP_SECRET_BYTES);
  if (suffix.length !== MCP_ID_CHARS || body.length !== encodedLength(MCP_SECRET_BYTES)) {
    return err({ reason: 'wrong-length', expected, actual: rest.length });
  }
  if (!TYPEID_SUFFIX.test(suffix)) return err({ reason: 'not-crockford' });
  if (!BASE64URL.test(body)) return err({ reason: 'not-base64url' });
  return ok({
    kind: 'mcp',
    id: `mtk_${suffix}`,
    secret: new SecretString('mcp', presented),
    digest: sha256(presented),
  });
}

/**
 * Which cookie name an exposure mode uses (`08` §3.8.1).
 *
 * `__Host-` is the strongest prefix a browser offers — it refuses the cookie unless it is `Secure`,
 * has no `Domain` and is scoped to `/` — so it is only available when the dashboard is served over
 * HTTPS at a path root. A sub-path deployment gets `__Secure-`, and plain HTTP (loopback, or an
 * insecure LAN the host opted into) gets the bare name, because a browser rejects both prefixes
 * without `Secure`.
 */
export type CookieScope = 'host' | 'secure' | 'plain';

const COOKIE_PREFIX: Readonly<Record<CookieScope, string>> = Object.freeze({
  host: '__Host-',
  secure: '__Secure-',
  plain: '',
});

/** `<prefix><slug>_<name>`, derived from `BRAND` so a rename cannot leave one behind. */
function cookieName(scope: CookieScope, name: string): string {
  return `${COOKIE_PREFIX[scope]}${BRAND.slug}_${name}`;
}

/** The dashboard session cookie (`08` §3.7.12). */
export const sessionCookieName = (scope: CookieScope): string => cookieName(scope, 'session');

/** The pending-login cookie: the browser's half of a pairing login (S8). */
export const pendingCookieName = (scope: CookieScope): string => cookieName(scope, 'pending');

/**
 * The CSRF header (`08` §3.7.12, §3.8.6).
 *
 * Derived from the display name, which is what a host sees in a devtools panel or a reverse-proxy
 * rule. Header names are case-insensitive on the wire; this is the canonical spelling.
 */
export const CSRF_HEADER = `X-${BRAND.displayName}-CSRF`;
