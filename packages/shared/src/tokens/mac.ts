/**
 * The two derived tokens: the CSRF synchroniser and the magic link (`08` §3.7.12).
 *
 * Neither is stored. Both are a MAC under the **token MAC key**, which `08` §3.7.2 derives as
 * `HKDF(RDK, salt=instanceId, info="comvivo/v1/token-mac/epoch=<e>")` — so bumping the session
 * epoch changes the key and every token derived from the old one stops verifying, at once, with no
 * row to delete. That is what "log everybody out" has to mean, and the epoch lives in the
 * encrypted database settings so a file-level edit cannot roll it back.
 *
 * ## The order of checks is the security property
 *
 * `verifyMagicLink` compares the MAC **before** it decodes the payload, let alone parses it. The
 * payload is attacker-controlled bytes in a URL fragment; a verifier that reads `exp` or `sub`
 * first has already made a decision based on them. So the signed part is the literal prefix of the
 * token — everything before the last `.` — which means verification needs no decoding at all, and
 * the only thing a tampered payload can do is fail the comparison.
 *
 * Specification: `docs/plan/08-security-privacy.md` §3.7.12, §3.7.13; `09` §3.7.
 */

import type { Temporal } from 'temporal-polyfill';
import { secureEqual } from '../crypto/equal.js';
import { hmacSha256Base64Url } from '../crypto/hmac.js';
import { randomToken } from '../crypto/random.js';
import { type InstanceId, idSchema, type PersonId } from '../ids.js';
import { canonicalJsonBytes } from '../json/canonical.js';
import { err, ok, type Result } from '../result.js';
import { SecretString } from '../secrets/secret-string.js';
import { z } from '../zod.js';

/** The CSRF label (`08` §3.7.12: `HMAC(tokenMac, "csrf"‖sessionDigest)`). */
export const CSRF_LABEL = 'csrf';

/** The magic link's format tag, and the first component of every magic-link token. */
export const MAGIC_LINK_TAG = 'vml1';

/**
 * `08` §3.7.13: "Token `exp` allows 60 s skew."
 *
 * A host whose clock is a minute ahead of the browser's must still be able to log in, and the
 * doctor warns about NTP skew separately. Sixty seconds against a ten-minute TTL is a 10% widening
 * of the window, which is the trade the spec makes explicitly.
 */
export const CLOCK_SKEW_SECONDS = 60;

/** `08` §3.7.12's magic-link payload. */
export const MagicLinkPayloadSchema = z.strictObject({
  /** 128 bits, base64url: the row that records single use. */
  jti: z.string().length(22),
  sub: idSchema('prs'),
  aud: idSchema('inst'),
  purpose: z.literal('login'),
  /** Epoch **seconds**, because no security decision here depends on anything finer (§3.7.13). */
  exp: z.int().positive(),
});

export type MagicLinkPayload = z.infer<typeof MagicLinkPayloadSchema>;

export type MagicLinkRejection =
  | { readonly reason: 'malformed' }
  | { readonly reason: 'bad-mac' }
  | { readonly reason: 'bad-payload'; readonly detail: string }
  | { readonly reason: 'wrong-audience' }
  | { readonly reason: 'expired'; readonly expSeconds: number };

/**
 * A MAC key bound to one instance and one session epoch.
 *
 * Takes the **derived** key rather than the root data key: `KeyService.tokenMacKey(epoch)` already
 * owns that derivation (`08` §3.7.2), and a second copy of an HKDF label is a second chance to get
 * it wrong. The epoch is carried here so a caller can log which epoch refused a token — the one
 * question "my session stopped working" actually needs answered.
 */
export interface TokenMac {
  readonly epoch: number;
  readonly instanceId: InstanceId;
  /** The CSRF token for a session, derived from its stored digest. Nothing is persisted. */
  csrf(sessionDigest: Uint8Array): string;
  /** Constant-time check of a presented CSRF token (`08` §3.8.6 layer 3). */
  verifyCsrf(sessionDigest: Uint8Array, presented: string): boolean;
  /** A magic-link token for `sub`, expiring `ttlSeconds` from `now`. */
  mintMagicLink(sub: PersonId, now: Temporal.Instant, ttlSeconds: number): SecretString;
  /** Verify a presented magic link: MAC first, then the payload, then the clock. */
  verifyMagicLink(
    presented: string,
    now: Temporal.Instant,
  ): Result<MagicLinkPayload, MagicLinkRejection>;
}

export function tokenMac(key: Uint8Array, instanceId: InstanceId, epoch: number): TokenMac {
  if (key.length < 32) {
    throw new RangeError(
      `a token MAC key is 32 bytes, got ${String(key.length)}. ` +
        'Pass `KeyService.tokenMacKey(epoch)`, not a session token or a digest.',
    );
  }
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new RangeError(`a session epoch is a non-negative integer, got ${String(epoch)}`);
  }

  const macOf = (input: Uint8Array | string): string => hmacSha256Base64Url(key, input);

  const signedPart = (payloadEncoded: string): string => `${MAGIC_LINK_TAG}.${payloadEncoded}`;

  return {
    epoch,
    instanceId,

    csrf(sessionDigest: Uint8Array): string {
      if (sessionDigest.length !== 32) {
        throw new RangeError(
          `a session digest is a 32-byte SHA-256, got ${String(sessionDigest.length)}`,
        );
      }
      // `"csrf"‖sessionDigest`, exactly as `08` §3.7.12 writes it. The label is what stops the
      // same key from producing a CSRF token that is also a valid MAC for something else.
      return macOf(Buffer.concat([Buffer.from(CSRF_LABEL, 'utf8'), sessionDigest]));
    },

    verifyCsrf(sessionDigest: Uint8Array, presented: string): boolean {
      if (presented === '') return false;
      return secureEqual(presented, this.csrf(sessionDigest));
    },

    mintMagicLink(sub: PersonId, now: Temporal.Instant, ttlSeconds: number): SecretString {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
        throw new RangeError(
          `a magic link needs a positive TTL in seconds, got ${String(ttlSeconds)}`,
        );
      }
      const payload: MagicLinkPayload = {
        jti: randomToken(16),
        sub,
        aud: instanceId,
        purpose: 'login',
        exp: Math.floor(now.epochMilliseconds / 1000) + ttlSeconds,
      };
      const encoded = Buffer.from(canonicalJsonBytes(payload)).toString('base64url');
      const signed = signedPart(encoded);
      return new SecretString('magicLink', `${signed}.${macOf(signed)}`);
    },

    verifyMagicLink(
      presented: string,
      now: Temporal.Instant,
    ): Result<MagicLinkPayload, MagicLinkRejection> {
      const lastDot = presented.lastIndexOf('.');
      if (lastDot === -1 || !presented.startsWith(`${MAGIC_LINK_TAG}.`)) {
        return err({ reason: 'malformed' });
      }
      const signed = presented.slice(0, lastDot);
      const mac = presented.slice(lastDot + 1);
      // Two dots exactly: `vml1.<payload>.<mac>`. A payload containing a dot would otherwise shift
      // the split and still verify, which is a signature over a different structure than the one
      // the reader thinks it checked.
      if (mac === '' || signed.indexOf('.') !== MAGIC_LINK_TAG.length) {
        return err({ reason: 'malformed' });
      }
      if (!secureEqual(mac, macOf(signed))) return err({ reason: 'bad-mac' });

      // Only now is any of it decoded.
      const encoded = signed.slice(MAGIC_LINK_TAG.length + 1);
      const parsed = decodePayload(encoded);
      if (!parsed.ok) return parsed;
      const payload = parsed.value;
      if (payload.aud !== instanceId) return err({ reason: 'wrong-audience' });
      // No separate `purpose` check: `MagicLinkPayloadSchema` has it as a `z.literal('login')`, so
      // a payload with any other purpose is refused as `bad-payload` before this line. A second
      // check here would be a branch no input can reach, which is worse than none — it reads as a
      // handled case and shows as missed coverage forever.
      if (Math.floor(now.epochMilliseconds / 1000) > payload.exp + CLOCK_SKEW_SECONDS) {
        return err({ reason: 'expired', expSeconds: payload.exp });
      }
      return ok(payload);
    },
  };
}

/** base64url → JSON → the schema. Every step can fail on hostile input, so each has a verdict. */
function decodePayload(encoded: string): Result<MagicLinkPayload, MagicLinkRejection> {
  // `Buffer.from(…, 'base64url')` never throws for a string — it *ignores* characters it cannot
  // decode — so there is no `catch` here to write. The round-trip comparison is what actually
  // rejects a malformed encoding, and without it `vml1.!!!!` would decode to empty and be reported
  // as bad JSON rather than as a bad token.
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) {
    return err({ reason: 'bad-payload', detail: 'encoding' });
  }
  const text = bytes.toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err({ reason: 'bad-payload', detail: 'json' });
  }
  const result = MagicLinkPayloadSchema.safeParse(json);
  if (!result.success) {
    return err({
      reason: 'bad-payload',
      detail: result.error.issues.map((issue) => issue.path.join('.') || 'payload').join(','),
    });
  }
  return ok(result.data);
}
