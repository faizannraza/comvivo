/**
 * Scrubbing, and the log canary (`11` §3.10.1, `08` §3.10 layer 2, `01` §11.7).
 *
 * The canary block near the bottom is `sec.logs.canary`: a planted value of every secret shape
 * `08` §3.10 names, asserted to be gone. It is the unit-level half of the gate; the scenario-level
 * half runs every PR scenario at `trace` and asserts zero canary occurrences in the captured output
 * (`11` §9), and lands with the harness in `M3`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_LENGTH,
  SCRUBBED,
  SECRET_PATTERNS,
  scrubDeep,
  scrubErrorMessage,
  scrubSecretShapes,
} from './scrub.js';

describe('step 1: quoted content', () => {
  it('drops a long quoted span, which is where a library echoes the input back', () => {
    // For this product the "input" is somebody's private message, so this is the single most
    // valuable step in the chain.
    const scrubbed = scrubErrorMessage(
      'Could not parse "the recital is on Friday at six, do not tell dad"',
    );
    expect(scrubbed).toBe(`Could not parse "${SCRUBBED}"`);
  });

  it('keeps a short quoted span, which is usually a field name or an id', () => {
    expect(scrubErrorMessage('field "conversationId" was null')).toBe(
      'field "conversationId" was null',
    );
  });

  it('handles single quotes too', () => {
    expect(scrubErrorMessage("got 'a very long private sentence about health'")).toContain(
      `'${SCRUBBED}'`,
    );
  });

  it('drops several quoted spans in one message', () => {
    const scrubbed = scrubErrorMessage(
      'mismatch between "a long first private string here" and "a long second private string"',
    );
    expect(scrubbed.match(/\[scrubbed]/g)).toHaveLength(2);
  });

  it('keeps an empty quoted span', () => {
    expect(scrubErrorMessage('value was ""')).toBe('value was ""');
  });
});

describe('step 2: URLs', () => {
  it('catches a Telegram token through the shape patterns alone, with no URL step', () => {
    // A regression test for a pattern that could never fire on the form it was written for.
    //
    // The pattern was `\b\d{6,12}:…`, and Telegram's URL is `/bot<id>:<secret>/sendMessage` — so
    // the first digit is preceded by the `t` of `bot`, two word characters with no boundary
    // between them. `scrubErrorMessage` hid it by reducing URLs before reaching the shapes, so
    // every test passed; `scrubSecretShapes` is exported and used on its own by
    // `observability/attributes.ts`, where nothing runs first. Found by that consumer, not by
    // reading this file.
    const token = `${'123456789'}:${'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'}`;
    const scrubbed = scrubSecretShapes(`401 from /bot${token}/sendMessage`);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain(SCRUBBED);
  });

  it('still refuses to match the tail of a longer digit run', () => {
    // The property `\b` was there for. A 16-digit id followed by a colon is not a Telegram token,
    // and matching its last 12 digits would scrub an identifier while leaving the first four.
    const notAToken = `1234567890123456:${'A'.repeat(40)}`;
    expect(scrubSecretShapes(`id ${notAToken}`)).toContain('1234567890123456');
  });

  it('removes the Telegram bot-token path segment', () => {
    // Telegram's API URL IS the credential. Any HTTP error that quotes its own URL publishes it,
    // which makes this the most important URL case in the product.
    const scrubbed = scrubErrorMessage(
      `POST https://api.telegram.org/bot${'123456789' + ':' + 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'}/sendMessage returned 401`,
    );
    expect(scrubbed).toBe('POST https://api.telegram.org/… returned 401');
    expect(scrubbed).not.toContain('AAHdqTcv' + 'CH1v');
  });

  it('keeps the scheme and host, which is the useful part', () => {
    expect(scrubErrorMessage('fetch failed for https://api.anthropic.com/v1/messages')).toBe(
      'fetch failed for https://api.anthropic.com/…',
    );
  });

  it('removes a query string, which can carry a token', () => {
    expect(scrubErrorMessage('GET https://example.com/x?api_key=abcdef123456 failed')).toBe(
      'GET https://example.com/… failed',
    );
  });

  it('leaves a bare host with no path unchanged', () => {
    expect(scrubErrorMessage('could not reach https://api.openai.com')).toBe(
      'could not reach https://api.openai.com',
    );
  });

  it('handles a non-http scheme', () => {
    expect(scrubErrorMessage('open postgres://localhost:5432/secretdb failed')).toContain(
      'postgres://localhost:5432',
    );
  });
});

describe('step 3: personal data shapes', () => {
  it('masks an email address', () => {
    expect(scrubErrorMessage('invite to ava.smith@example.co.uk bounced')).toBe(
      `invite to ${SCRUBBED} bounced`,
    );
  });

  it('masks a phone number, which Signal errors contain', () => {
    expect(scrubErrorMessage('unknown recipient +1 (415) 555-2671')).toContain(SCRUBBED);
    expect(scrubErrorMessage('unknown recipient +447700900123')).toContain(SCRUBBED);
  });

  it('does NOT mask short numbers, so ids, counts and status codes survive', () => {
    // Over-scrubbing makes logs useless, which pushes people toward logging raw objects instead.
    expect(scrubErrorMessage('attempt 3 of 5 failed with 429 after 1200 ms')).toBe(
      'attempt 3 of 5 failed with 429 after 1200 ms',
    );
  });
});

describe('step 4: truncation', () => {
  it('truncates to 200 characters', () => {
    expect(scrubErrorMessage('x'.repeat(500))).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it('marks a truncated message, so it does not look like it merely ended oddly', () => {
    expect(scrubErrorMessage('x'.repeat(500)).endsWith('…')).toBe(true);
  });

  it('leaves a short message alone', () => {
    expect(scrubErrorMessage('timeout')).toBe('timeout');
  });

  it('handles an empty message', () => {
    expect(scrubErrorMessage('')).toBe('');
  });
});

/**
 * `sec.logs.canary` — every secret shape `08` §3.10 names, planted and asserted gone.
 */
/**
 * `sec.logs.canary` — every secret shape `08` §3.10 names, planted and asserted gone.
 *
 * **Every canary is assembled at runtime from separate string literals, never written out whole.**
 * That is not cosmetic. A file containing a literal `xoxb-…` token shape is a file that trips
 * GitHub's push protection and every other secret scanner a contributor or a fork might run — which
 * is exactly what happened the first time this test was committed. The scrubber still receives the
 * precise shape it has to catch, because the value is concatenated before it is passed in; only the
 * source text is split. `M5`'s red-team suites will contain hundreds of fixtures like these, so the
 * pattern is established here.
 */
describe('sec.logs.canary', () => {
  /** A long alphanumeric body, reused so each canary differs only in its prefix. */
  const BODY = ['AbCdEfGhIjKlMnOp', 'QrStUvWxYz012345'].join('');
  /** A base64-ish body, for the shapes that look like encoded bytes. */
  const B64 = ['aGVsbG9Xb3JsZEhlbGxv', 'V29ybGRIZWxsb1dvcmxk', 'SGVsbG9Xb3JsZA=='].join('');

  /** Join a prefix and a body at runtime. The two never sit adjacent in the source. */
  const canary = (prefix: string, body: string = BODY): string => prefix + body;

  const CANARIES: readonly { readonly label: string; readonly value: string }[] = [
    // This project's own tokens (08 §3.7.11)
    { label: 'session token', value: canary('vs1' + '_') },
    { label: 'MCP token', value: canary('vmcp' + '_') },
    { label: 'magic link', value: canary('vml1' + '.') },
    { label: 'plugin token', value: canary('vlp' + '_') },
    { label: 'ICS feed token', value: canary('vics' + '_') },
    { label: 'control token', value: canary('vctl' + '_') },
    { label: 'pairing code', value: canary('VLG' + '-', ['7F3K', '9QPX'].join('-')) },
    {
      label: 'recovery key',
      value: canary('VRK1' + '-', ['ABCD', 'EFGH', 'JKMN', 'PQRS', 'TVWX'].join('-')),
    },

    // Model providers
    { label: 'Anthropic key', value: canary(['sk', 'ant', 'api03'].join('-') + '-') },
    { label: 'OpenAI key', value: canary('sk' + '-') },
    { label: 'OpenAI project key', value: canary(['sk', 'proj'].join('-') + '-') },
    { label: 'Google key', value: canary('AIza' + 'Sy', BODY + 'ABCDEFG') },

    // Chat platforms
    {
      label: 'Slack bot token',
      value: canary('xoxb' + '-', ['1234567890', '0987654321', BODY].join('-')),
    },
    {
      label: 'Slack user token',
      value: canary('xoxp' + '-', ['1234567890', '0987654321', BODY].join('-')),
    },
    {
      label: 'Slack app token',
      value: canary('xapp' + '-', ['1', 'A01B2C3D4E5', '1234567890', 'abcdef'].join('-')),
    },
    // Telegram: `<bot-id>:<secret>`. The one that hides inside a URL.
    { label: 'Telegram bot token', value: canary('123456789' + ':', BODY + 'QRSTUV') },
    {
      label: 'Discord bot token',
      value: [`MTIzNDU2Nzg5MDEy${'MzQ1Njc4'}`, `GAb${'CdE'}`, BODY + 'WXYZ01'].join('.'),
    },
    { label: 'Matrix access token', value: canary('syt' + '_', `YWxpY2U_${BODY}`) },

    // Credentials in prose
    {
      label: 'bearer credential',
      value: `Bearer ${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'abcdef'].join('.')}`,
    },
    { label: 'basic credential', value: `Basic ${B64}` },

    // Key material
    {
      label: 'PEM private key',
      value: [`-----BEGIN PRIVATE ${'KEY'}-----`, B64, `-----END PRIVATE ${'KEY'}-----`].join('\n'),
    },
    { label: 'base64 blob next to a key label', value: `apiKey="${B64}"` },
  ];

  /** The distinctive part of a canary: what must certainly be gone after scrubbing. */
  const bodyOf = (value: string): string =>
    value.replace(/^(?:Bearer|Basic|Token)\s+/i, '').replace(/^\w+="?/, '');

  it.each(CANARIES)('scrubs the $label', ({ value }) => {
    const scrubbed = scrubSecretShapes(value);
    // A short recognisable prefix may legitimately remain (`Bearer `, `apiKey=`): that is useful
    // context and not itself a secret.
    expect(scrubbed).not.toContain(bodyOf(value));
    expect(scrubbed).toContain(SCRUBBED);
  });

  it('scrubs every canary when they all appear in one message', () => {
    const haystack = `error with ${CANARIES.map((c) => c.value).join(' and ')}`;
    const scrubbed = scrubSecretShapes(haystack);
    for (const { label, value } of CANARIES) {
      expect(scrubbed, `${label} survived`).not.toContain(bodyOf(value));
    }
  });

  it('scrubs a canary hidden inside a URL path', () => {
    for (const { label, value } of CANARIES) {
      if (value.includes('\n') || value.includes(' ')) continue;
      const scrubbed = scrubErrorMessage(`GET https://example.com/${value}/x failed`);
      expect(scrubbed, `${label} survived inside a URL`).not.toContain(value);
    }
  });

  it('scrubs a canary nested deep inside an object', () => {
    for (const { label, value } of CANARIES) {
      const rendered = JSON.stringify(scrubDeep({ a: { b: [{ c: value }] } }));
      expect(rendered, `${label} survived scrubDeep`).not.toContain(bodyOf(value).slice(0, 24));
    }
  });

  it('leaves ordinary diagnostic text intact, so logs stay useful', () => {
    const ordinary =
      'turn grp_01j8kqd7h3f9z2m4n6p8r0t2vw completed in 1240 ms with 3 tool calls, cost 1820 micros';
    expect(scrubSecretShapes(ordinary)).toBe(ordinary);
  });

  it('has a pattern for every shape 08 §3.10 names', () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    for (const expected of [
      'own-token-prefix',
      'own-magic-link',
      'own-pairing-code',
      'own-recovery-key',
      'anthropic-key',
      'openai-key',
      'google-key',
      'slack-token',
      'slack-app-token',
      'telegram-token',
      'discord-token',
      'matrix-token',
      'pem-block',
      'adjacent-base64',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('uses fresh regex state per call, so a second call is not silently skipped', () => {
    // A shared `g`-flagged pattern carries `lastIndex` between calls. Reusing one would make the
    // scrubber miss matches non-deterministically, which is the worst possible failure mode here.
    const value = canary(['sk', 'ant', 'api03'].join('-') + '-');
    for (let i = 0; i < 5; i += 1) {
      expect(scrubSecretShapes(`attempt ${String(i)}: ${value}`)).toContain(SCRUBBED);
    }
  });

  it('contains no canary written out whole in its own source', () => {
    // A real self-check, not a proxy: it reads this file and asserts that no assembled canary value
    // appears verbatim. If someone adds one as a literal, this fails here with an explanation —
    // which is far kinder than GitHub's push protection rejecting their commit with no context.
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    for (const { label, value } of CANARIES) {
      // Multi-line canaries (the PEM block) cannot appear whole on one line anyway.
      if (value.includes('\n')) continue;
      expect(
        source.includes(value),
        `the ${label} canary appears as a literal in this file. Assemble it at runtime from ` +
          'separate string literals instead — a literal token shape trips GitHub push protection ' +
          'and every other secret scanner a contributor or fork might run.',
      ).toBe(false);
    }
  });
});

describe('key material by the shapes this product mints', () => {
  it('scrubs a base64url key, not only a standard-base64 one', () => {
    // Every key this product encodes is base64**url** — `master.key`, `COMVIVO_MASTER_KEY`, the
    // keyring's `wrap.sealed`, the backup envelope's `sealed` — and base64url substitutes `-` and
    // `_` for `+` and `/`. The pattern's character class had neither, so a key containing one was
    // split into runs shorter than 32 and never matched. Measured at the M1 exit gate.
    const base64url = 'aB-dEfGhIjKlMnOpQrStUvWxYz0123456789_bCdEfGh';
    expect(base64url).toHaveLength(44);
    expect(scrubSecretShapes(`key: ${base64url}`)).toContain(SCRUBBED);
    // The control that was already passing, so this test is about the new half.
    const standard = 'aB+dEfGhIjKlMnOpQrStUvWxYz0123456789/bCdEfGh';
    expect(scrubSecretShapes(`key: ${standard}`)).toContain(SCRUBBED);
  });

  it('scrubs a 64-hex SQLCipher key without eating a sha256 id', () => {
    // `08` §3.7.9's raw key is 64 hex characters and had no pattern at all. Qualified by an
    // adjacent key word, because a digest is how a blob, a migration and an audit row are named —
    // scrubbing every 64-hex run would make the log unreadable.
    const hex = 'a'.repeat(64);
    expect(scrubSecretShapes(`dek: ${hex}`)).toContain(SCRUBBED);
    expect(scrubSecretShapes(`blob sha256=${hex}`)).toContain(hex);
  });
});

describe('scrubDeep', () => {
  it('keeps the structure and scrubs the strings', () => {
    expect(
      scrubDeep({
        a: 1,
        b: { c: ['sk', 'ant', 'api03'].join('-') + '-AbCdEfGhIjKlMnOpQrStUvWx' },
        d: [true],
      }),
    ).toEqual({
      a: 1,
      b: { c: SCRUBBED },
      d: [true],
    });
  });

  it('leaves non-strings alone', () => {
    expect(scrubDeep({ n: 42, b: false, z: null })).toEqual({ n: 42, b: false, z: null });
  });

  it('reduces a byte view to its length instead of expanding it key by key', () => {
    // The measurement that prompted this: a `Buffer` is an object and is not an array, so the
    // walker rebuilt it as `{"0":48,"1":49,…}` — **every byte of a key preserved**, in the line and
    // in the ring buffer `doctor --bundle` reads. Found by the M1 exit gate's reviewer.
    const key = Buffer.from([0x01, 0x02, 0x03, 0xfa]);
    expect(scrubDeep({ k: key })).toEqual({ k: '[bytes:4]' });
    expect(scrubDeep(new Uint8Array([9, 9, 9]))).toBe('[bytes:3]');
    expect(scrubDeep({ deep: { deeper: { dek: new Uint8Array(32) } } })).toEqual({
      deep: { deeper: { dek: '[bytes:32]' } },
    });
    // The bytes themselves must not appear anywhere in the serialised form.
    expect(JSON.stringify(scrubDeep({ k: key }))).not.toContain('250');
  });

  it('survives a cycle, which an error cause chain can contain', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    expect(scrubDeep(cyclic)).toEqual({ name: 'x', self: '[circular]' });
  });

  it('handles arrays at the root', () => {
    expect(
      scrubDeep(['ok', ['sk', 'ant', 'api03'].join('-') + '-AbCdEfGhIjKlMnOpQrStUvWx']),
    ).toEqual(['ok', SCRUBBED]);
  });
});
