/**
 * The redactor and `fixtures:lint` (`06` §3.25; `M3-T9`).
 *
 * `M3-T9`'s AC asks for two things this file proves: a **deterministic** redactor, and a linter that
 * **catches seeded secrets**. The second is the one that matters, and it is tested the way a guard
 * has to be: by planting the thing it exists to find, in each of the shapes it actually arrives in.
 *
 * The seeds below are all invalid by construction — a `telegram_bot_token` whose numeric half is
 * `000000000`, an email at `.invalid` — because a test fixture containing a credential-shaped string
 * is itself a thing a scanner will flag, and a corpus that cannot be committed is a test nobody
 * runs. They match the patterns and grant nothing.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonFiles, lintFixtures, main, requiresMarkers, scanMarkers, scanText } from './lint.js';
import { buildFixture, writeFixture } from './record.js';
import { fakeId, fakeName, PERSONAS, redact, SCRUB_RULES, SCRUBBED, saltId } from './redact.js';
import { nodeFixtureStore } from './store.js';

const SALT = 'a-salt-long-enough-to-pass';
const OTHER_SALT = 'a-different-salt-also-long';

/**
 * Credential-shaped and worthless. See the header.
 *
 * The first two are **assembled at runtime** from separate literals, which is what
 * `scripts/secrets/check.ts` prescribes and `08` §3.10 requires: written out whole they trip the
 * repository's own secret scanner — and that guard firing on this file is the guard working, not an
 * obstacle. The value the scanner under test receives is identical, because the pieces are joined
 * before it sees them.
 */
const FILLER = 'a'.repeat(33);
const SEEDS: readonly { readonly rule: string; readonly text: string }[] = [
  { rule: 'telegram_bot_token', text: `000000000${':'}AA${FILLER}` },
  { rule: 'prefixed_token', text: ['xoxb', '000000000000', '000000000000', FILLER].join('-') },
  { rule: 'bearer', text: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  { rule: 'signed_url', text: 'https://files.invalid/a/b.jpg?hm=aaaaaaaaaaaaaaaaaaaa' },
  { rule: 'phone', text: '+15550001111' },
  { rule: 'email', text: 'someone@example.invalid' },
  // The header segment has to be at least eight characters after `eyJ` to match the pattern, and
  // the first version of this seed was seven — so the rule looked untested and was in fact
  // untestable by it. This decodes to `{"alg":"HS256"}` and `{"sub":"123456"}`.
  { rule: 'jwt', text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.aaaaaaaaaaaaaaaa' },
];

describe('the redactor is deterministic', () => {
  it('maps one input to one output, run after run', () => {
    const payload = { message: { chat: { id: -1001234567890 }, from: { first_name: 'Rhiannon' } } };
    const first = redact(payload, SALT);
    const second = redact(payload, SALT);
    expect(second.value).toEqual(first.value);
    expect(second.saltId).toBe(first.saltId);
  });

  it('maps one id to one fake across files, which is what makes a corpus coherent', () => {
    // The property a counter cannot give without shared state: two recordings of the same chat,
    // redacted independently, still refer to the same chat.
    const inbound = redact({ chat_id: '-1001234567890' }, SALT).value;
    const outbound = redact({ request: { chat_id: '-1001234567890' } }, SALT).value;
    expect((inbound as { chat_id: string }).chat_id).toBe(
      (outbound as { request: { chat_id: string } }).request.chat_id,
    );
  });

  it('gives a different salt a different mapping', () => {
    expect(fakeId(SALT, '-1001234567890')).not.toBe(fakeId(OTHER_SALT, '-1001234567890'));
    expect(saltId(SALT)).not.toBe(saltId(OTHER_SALT));
  });

  it('never writes the salt into the manifest', () => {
    // `saltId` proves two fixtures were remapped consistently. The salt itself would make every
    // remapped id reversible by anyone who could guess the original.
    const { saltId: id } = redact({ id: 1 }, SALT);
    expect(id).not.toContain(SALT);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses a salt too short to be irreversible', () => {
    expect(() => redact({ id: 1 }, 'short')).toThrow(RangeError);
  });
});

describe('a fake id keeps the shape of the original', () => {
  it('because an adapter’s own parsing is part of what the fixture tests', () => {
    // Telegram rejects a `chat_id` that is not an integer; a Matrix room id is `!localpart:server`;
    // Slack's `ts` must stay parseable as a decimal. A hex digest in any of those slots tests the
    // fixture loader rather than the adapter.
    expect(fakeId(SALT, '-1001234567890')).toMatch(/^-\d{13}$/);
    expect(fakeId(SALT, '987654321')).toMatch(/^\d{9}$/);
    expect(fakeId(SALT, '!abcdef:matrix.org')).toMatch(/^![0-9a-f]{18}:fixture\.invalid$/);
    expect(fakeId(SALT, '@alice:matrix.org')).toMatch(/^@[0-9a-f]{18}:fixture\.invalid$/);
    expect(fakeId(SALT, 'C01ABCDEF')).toMatch(/^C[0-9A-F]{8}$/);
    expect(fakeId(SALT, '1700000000.000100')).toMatch(/^\d{10}\.\d{6}$/);
  });

  it('never produces a leading zero that would shorten a parsed number', () => {
    for (let n = 0; n < 500; n += 1) {
      expect(fakeId(SALT, String(1_000_000 + n)), String(n)).not.toMatch(/^0/);
      expect(fakeId(SALT, `-${String(1_000_000 + n)}`), String(n)).not.toMatch(/^-0/);
    }
  });

  it('is stable for a numeric id whether it arrived as a number or a string', () => {
    // Platforms are inconsistent about this within one payload — Telegram's `chat.id` is a number
    // and its `callback_query.chat_instance` is a string — so the mapping has to agree.
    const asNumber = redact({ chat_id: -1001234567890 }, SALT).value as { chat_id: number };
    const asString = redact({ chat_id: '-1001234567890' }, SALT).value as { chat_id: string };
    expect(String(asNumber.chat_id)).toBe(asString.chat_id);
    expect(typeof asNumber.chat_id).toBe('number');
  });
});

describe('names become personas', () => {
  it('one person, one persona, everywhere', () => {
    expect(fakeName(SALT, 'Rhiannon')).toBe(fakeName(SALT, 'rhiannon '));
    expect(PERSONAS).toContain(fakeName(SALT, 'Rhiannon'));
  });

  it('replaces the name keys a platform payload actually uses', () => {
    const payload = {
      from: { first_name: 'Rhiannon', last_name: 'Okafor', username: 'rhi_1987' },
      chat: { title: 'Okafor family' },
    };
    const value = JSON.stringify(redact(payload, SALT).value);
    for (const original of ['Rhiannon', 'Okafor', 'rhi_1987', 'Okafor family']) {
      expect(value, original).not.toContain(original);
    }
  });
});

describe('credentials are removed, not remapped', () => {
  it('because no shape-preserving fake is worth one looking real', () => {
    for (const seed of SEEDS) {
      const value = redact({ text: `before ${seed.text} after` }, SALT).value as { text: string };
      expect(value.text, seed.rule).toContain(SCRUBBED);
      expect(value.text, seed.rule).not.toContain(seed.text);
    }
  });

  it('finds one inside a message body, where the key-driven walk would not look', () => {
    // The real leak path: not somebody skipping the redactor, but a member pasting a token into a
    // chat. The value is scrubbed wherever it appears, not only under a known key.
    const payload = { message: { text: `the token is ${SEEDS[0]?.text ?? ''}` } };
    expect(JSON.stringify(redact(payload, SALT).value)).toContain(SCRUBBED);
  });

  it('counts what each rule replaced, so a rule that never fires is visible', () => {
    const { replaced } = redact({ a: SEEDS[4]?.text, b: SEEDS[5]?.text, id: 7 }, SALT);
    expect(replaced['phone']).toBe(1);
    expect(replaced['email']).toBe(1);
    expect(replaced['id']).toBe(1);
    expect(replaced['jwt']).toBeUndefined();
  });
});

describe('fixtures:lint catches a seeded secret', () => {
  it('in every shape the patterns cover', () => {
    for (const seed of SEEDS) {
      const findings = scanText(`{\n  "text": "${seed.text}"\n}\n`, 'inbound/x.json');
      expect(
        findings.map((finding) => finding.rule),
        seed.rule,
      ).toContain(seed.rule);
    }
  });

  it('reports the line, which is why the recorder pretty-prints', () => {
    const text = `{\n  "a": 1,\n  "b": 2,\n  "c": "${SEEDS[5]?.text ?? ''}"\n}\n`;
    expect(scanText(text, 'f.json')[0]?.line).toBe(4);
  });

  it('masks what it found rather than reprinting it', () => {
    // A CI log is a public artefact. A finding that quotes the credential in full has moved it from
    // one public place to another.
    const finding = scanText(`"${SEEDS[1]?.text ?? ''}"`, 'f.json')[0];
    expect(finding?.sample).not.toContain('aaaaaaaa');
    expect(finding?.sample).toMatch(/chars\)$/);
  });

  it('does not depend on how long the previous file was', () => {
    // `SCRUB_RULES` are `g`-flagged module constants, so a shared `lastIndex` would make the second
    // file's findings depend on the first's length — the classic stateful-regex bug, and one that
    // only shows up once a corpus has more than one file.
    const long = `${' '.repeat(5_000)}"${SEEDS[5]?.text ?? ''}"`;
    const short = `"${SEEDS[5]?.text ?? ''}"`;
    expect(scanText(long, 'a.json')).toHaveLength(1);
    expect(scanText(short, 'b.json')).toHaveLength(1);
    expect(scanText(short, 'c.json')).toHaveLength(1);
  });

  it('leaves a clean fixture alone', () => {
    expect(scanText('{"text":"shall we meet at six?"}', 'f.json')).toEqual([]);
  });

  it('covers every rule the redactor scrubs', () => {
    // Two lists that can disagree is how a rule comes to be redacted and not linted, or the
    // reverse — and the second is the one that leaks.
    expect(SEEDS.map((seed) => seed.rule).toSorted()).toEqual(
      SCRUB_RULES.map((rule) => rule.name).toSorted(),
    );
  });
});

describe('the redaction marker', () => {
  it('is required on a recorded channel fixture', () => {
    const recorded = { meta: { source: 'recorded' }, raw: {}, expect: {} };
    expect(scanMarkers(recorded, 'f.json').map((finding) => finding.rule)).toEqual([
      'recorded_without_redaction',
    ]);
  });

  it('is satisfied by what the recorder writes', () => {
    const fixture = buildFixture({
      dir: 'x',
      path: 'inbound/a.json',
      platformVersion: 'Bot API 9.4',
      raw: { message: { chat: { id: -100123 }, text: 'hi' } },
      expect: { channel: 'telegram' },
      salt: SALT,
      recordedAt: '2026-11-15T12:00:00Z',
    });
    expect(scanMarkers(fixture, 'f.json')).toEqual([]);
  });

  it('is not demanded of a synthetic fixture', () => {
    expect(scanMarkers({ meta: { source: 'synthetic' } }, 'f.json')).toEqual([]);
  });

  it('treats a fixture with no `meta` at all as unsafe', () => {
    // The absence of a marker is the whole finding. "It looks clean" is not evidence.
    expect(scanMarkers({ raw: {} }, 'f.json').map((finding) => finding.rule)).toEqual(['no_meta']);
    expect(scanMarkers(null, 'f.json').map((finding) => finding.rule)).toEqual(['no_meta']);
  });

  it('applies to channel fixtures and not to the provider corpus', () => {
    // A channel fixture records a member's chat; a provider fixture records a request Village made.
    // `M2` wrote 28 of the latter before this marker existed, and they carry no member data.
    expect(requiresMarkers('fixtures/channels/telegram/inbound/a.json')).toBe(true);
    expect(requiresMarkers('fixtures/providers/openai/usage.json')).toBe(false);
  });
});

describe('the recorder', () => {
  it('redacts the payload and its expectation together', async () => {
    // One call, not two: the ids in the expectation *are* the ids in the payload, and two calls
    // agree only because the mapping happens to be deterministic. Redacting the pair says so.
    const dir = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    await writeFixture({
      dir,
      path: 'inbound/a.json',
      platformVersion: 'Bot API 9.4',
      raw: { chat_id: '-1001234567890', text: 'ring +15550001111' },
      expect: { platformChatId: '-1001234567890' },
      salt: SALT,
      recordedAt: '2026-11-15T12:00:00Z',
      note: 'a plain group message',
    });
    const findings = await lintFixtures([dir]);
    expect(findings).toEqual([]);
    const written = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(dir, 'inbound/a.json'), 'utf8'),
    ) as { raw: { chat_id: string }; expect: { platformChatId: string }; meta: { note?: string } };
    expect(written.raw.chat_id).toBe(written.expect.platformChatId);
    expect(written.raw.chat_id).not.toBe('-1001234567890');
    expect(written.meta.note).toBe('a plain group message');
  });

  it('writes one value per line, which is what makes a line number useful', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    const full = await writeFixture({
      dir,
      path: 'inbound/b.json',
      platformVersion: 'v10',
      raw: { a: 1, b: 2 },
      expect: {},
      salt: SALT,
      recordedAt: '2026-11-15T12:00:00Z',
    });
    const text = await (await import('node:fs/promises')).readFile(full, 'utf8');
    expect(text.split('\n').length).toBeGreaterThan(5);
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('the filesystem fixture store', () => {
  it('lists each family in `06` §3.25’s layout, sorted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    await mkdir(join(dir, 'inbound'), { recursive: true });
    await writeFile(join(dir, 'inbound/b.json'), '{"meta":{}}', 'utf8');
    await writeFile(join(dir, 'inbound/a.json'), '{"meta":{}}', 'utf8');
    await writeFile(join(dir, 'inbound/notes.md'), 'hello', 'utf8');
    const store = nodeFixtureStore(dir);
    expect(await store.list('inbound')).toEqual(['inbound/a.json', 'inbound/b.json']);
  });

  it('treats a missing family directory as empty', async () => {
    // A channel with no native polls has no `probe/` directory to write, and the alternative is
    // every adapter shipping four directories so that one of them can be empty.
    const dir = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    expect(await nodeFixtureStore(dir).list('probe')).toEqual([]);
  });

  it('reads a fixture back as parsed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    await mkdir(join(dir, 'errors'), { recursive: true });
    await writeFile(join(dir, 'errors/x.json'), '{"meta":{"source":"synthetic"}}', 'utf8');
    expect(await nodeFixtureStore(dir).read('errors/x.json')).toEqual({
      meta: { source: 'synthetic' },
    });
  });

  it('names the file when the JSON is broken', async () => {
    // `Unexpected token } in JSON at position 412` with no filename is the least useful message a
    // corpus of two hundred files can produce.
    const dir = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    await mkdir(join(dir, 'inbound'), { recursive: true });
    await writeFile(join(dir, 'inbound/broken.json'), '{ "a": ', 'utf8');
    await expect(nodeFixtureStore(dir).read('inbound/broken.json')).rejects.toThrow(
      /inbound\/broken\.json is not valid JSON/,
    );
  });
});

describe('the CLI’s exit code', () => {
  it('is zero on a clean corpus and one on a finding', async () => {
    // `main` is the CI entry point, and a guard whose exit code nobody tested is a guard that can
    // report a finding and pass the build. It is a function rather than a top-level script for
    // exactly this reason — `process.exit` in a module makes the behaviour untestable.
    const clean = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    await writeFile(join(clean, 'ok.json'), '{"meta":{"source":"synthetic"}}', 'utf8');
    expect(await main([clean])).toBe(0);

    const dirty = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    await writeFile(dirty.concat('/leak.json'), `{"t":"${SEEDS[5]?.text ?? ''}"}`, 'utf8');
    expect(await main([dirty])).toBe(1);
  });
});

describe('the directory walk', () => {
  it('is recursive, sorted, and ignores everything that is not JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    await writeFile(join(dir, 'b.json'), '{}', 'utf8');
    await writeFile(join(dir, 'a.json'), '{}', 'utf8');
    await writeFile(join(dir, 'notes.md'), 'hello', 'utf8');
    const files = await jsonFiles(dir);
    expect(files.map((file) => file.split('/').at(-1))).toEqual(['a.json', 'b.json']);
  });

  it('treats a missing directory as empty rather than failing', async () => {
    // A channel with no polls has no `probe/` directory to write, and the alternative is every
    // adapter shipping four directories so that one of them can be empty.
    //
    // The missing path is derived from a real `mkdtemp` rather than written as a fixed name, which
    // `hygiene:check`'s `no-shared-temp-dir` rightly insists on: a fixed temp path is shared state
    // between runs, and the nightly `--sequence.shuffle` hunt exists to find exactly that.
    const parent = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    expect(await jsonFiles(join(parent, 'no-such-directory'))).toEqual([]);
  });

  it('reports invalid JSON rather than crashing the run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'comvivo-fixtures-'));
    await writeFile(join(dir, 'broken.json'), '{ "a": ', 'utf8');
    expect((await lintFixtures([dir])).map((finding) => finding.rule)).toEqual(['invalid_json']);
  });
});
