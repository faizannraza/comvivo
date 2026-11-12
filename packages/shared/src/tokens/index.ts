/**
 * `@comvivo/shared` tokens — every credential format `08` §3.7.12 defines.
 *
 * | Module | What |
 * |---|---|
 * | `format` | The prefixed random tokens, the cookie names and the CSRF header |
 * | `codes` | Human-typed Crockford codes: pairing, claim, link |
 * | `mac` | The two derived tokens — CSRF and magic link — and epoch invalidation |
 *
 * Not here: issuance policy, TTL enforcement, attempt limits and revocation. Those need a database
 * and a clock, and they belong to `09` §3.7 (the auth routes), `06` §3.20.1 (the chat-side
 * limits) and `10` §3.7 (MCP scopes). This package owns the *shapes* and the comparisons, so that
 * every one of those has the same answer to "is this one of ours, and does it still verify".
 */
export {
  CLAIM_CODE_PREFIX,
  canonicalizeTypedCode,
  mintClaimCode,
  mintTypedCode,
  type ParsedCode,
  parseClaimCode,
  parseTypedCode,
  TYPED_CODE_CHARS,
} from './codes.js';
export {
  type CookieScope,
  CSRF_HEADER,
  MCP_ID_CHARS,
  MCP_SECRET_BYTES,
  MCP_TOKEN_PREFIX,
  mintMcpToken,
  mintToken,
  type ParsedMcpToken,
  type ParsedToken,
  parseMcpToken,
  parseToken,
  pendingCookieName,
  sessionCookieName,
  TOKEN_SHAPES,
  type TokenKind,
  type TokenRejection,
  type TokenShape,
} from './format.js';
export {
  CLOCK_SKEW_SECONDS,
  CSRF_LABEL,
  MAGIC_LINK_TAG,
  type MagicLinkPayload,
  MagicLinkPayloadSchema,
  type MagicLinkRejection,
  type TokenMac,
  tokenMac,
} from './mac.js';
