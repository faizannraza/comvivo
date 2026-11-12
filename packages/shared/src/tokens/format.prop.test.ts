/**
 * `tokens.parsers.property` (`M1-T29` AC: "parsers property-tested").
 *
 * Four properties, each about a way a token parser can be wrong in a way an example-based test
 * would not notice:
 *
 *  1. **Round-trip.** Every minted token parses, and its digest is the digest of what was minted.
 *  2. **Cross-kind confusion.** No token of one kind parses as any other kind. This is the one
 *     that matters: a session cookie accepted as the CLI control token is a privilege escalation,
 *     and the only thing standing between them is a prefix.
 *  3. **Totality.** The parsers never throw, for any string — they take input from cookies, URLs
 *     and chat messages, which is the most hostile input the product has.
 *  4. **Mutation.** A single character changed, added or removed anywhere in a token either fails
 *     to parse or produces a different digest. Never the same digest, which would mean two
 *     distinct tokens addressing one row.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fcConfig } from '../testing/index.js';
import {
  MCP_TOKEN_PREFIX,
  mintMcpToken,
  mintToken,
  parseMcpToken,
  parseToken,
  TOKEN_SHAPES,
  type TokenKind,
} from './format.js';

const KINDS = Object.keys(TOKEN_SHAPES) as readonly TokenKind[];
const kind = () => fc.constantFrom(...KINDS);

/** A plausible `mtk_` id: the prefix plus 26 lowercase Crockford characters. */
const mcpId = () =>
  fc
    .array(fc.constantFrom(...'0123456789abcdefghjkmnpqrstvwxyz'), { minLength: 26, maxLength: 26 })
    .map((chars) => `mtk_${chars.join('')}`);

describe('tokens.parsers.property (08 §3.7.12)', () => {
  it('round-trips every kind', () => {
    fc.assert(
      fc.property(kind(), (which) => {
        const minted = mintToken(which).expose();
        const parsed = parseToken(which, minted);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value.kind).toBe(which);
        expect(parsed.value.secret.expose()).toBe(minted);
        expect(parsed.value.digest).toHaveLength(32);
      }),
      fcConfig(),
    );
  });

  it('never parses a token of one kind as another', () => {
    fc.assert(
      fc.property(kind(), kind(), (minting, parsing) => {
        const minted = mintToken(minting).expose();
        const parsed = parseToken(parsing, minted);
        // `claimLink` is `c_` and `control` is `vctl_`: neither is a prefix of the other, and this
        // property is what keeps that true as kinds are added. A new kind whose prefix extends an
        // existing one fails here before it can be shipped.
        expect(parsed.ok).toBe(minting === parsing);
      }),
      fcConfig(),
    );
  });

  it('never throws, whatever the string', () => {
    fc.assert(
      fc.property(kind(), fc.string({ maxLength: 200 }), (which, input) => {
        expect(() => parseToken(which, input)).not.toThrow();
        expect(() => parseMcpToken(input)).not.toThrow();
      }),
      fcConfig(),
    );
  });

  it('refuses a mutated token, or gives it a different digest', () => {
    fc.assert(
      fc.property(
        kind(),
        fc.nat({ max: 60 }),
        fc.constantFrom('replace', 'insert', 'remove'),
        (which, at, how) => {
          const minted = mintToken(which).expose();
          const index = at % minted.length;
          const char = minted[index] === 'A' ? 'B' : 'A';
          const mutated =
            how === 'replace'
              ? minted.slice(0, index) + char + minted.slice(index + 1)
              : how === 'insert'
                ? minted.slice(0, index) + char + minted.slice(index)
                : minted.slice(0, index) + minted.slice(index + 1);
          if (mutated === minted) return;
          const parsed = parseToken(which, mutated);
          if (!parsed.ok) return;
          const original = parseToken(which, minted);
          expect(original.ok).toBe(true);
          if (!original.ok) return;
          expect(parsed.value.digest.equals(original.value.digest)).toBe(false);
        },
      ),
      fcConfig(),
    );
  });

  it('round-trips an MCP token and keeps its id', () => {
    fc.assert(
      fc.property(mcpId(), (id) => {
        const minted = mintMcpToken(id).expose();
        const parsed = parseMcpToken(minted);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value.id).toBe(id);
        expect(minted.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
      }),
      fcConfig(),
    );
  });
});
