/**
 * The capability profiles match `06` §3.2's table (`M3-T2`'s AC).
 *
 * §3.2 carries a **source link per cell** — the Bot API changelog, Discord's reference, Slack's
 * method docs, the Matrix spec, signal-cli's own source. That makes the table the citation and
 * `profiles.ts` the data, and a test comparing the data against itself would let both drift
 * together: somebody edits a constant, the structural tests still pass, and the number nobody can
 * trace is the one that reaches a family's phone.
 *
 * So this reads the markdown. It lives under `test/plan/` because that needs `node:fs` and
 * `@comvivo/channel-sdk` is a pure package — the same split `test/plan/builtin-catalog.test.ts`
 * uses for the tool catalogue, and for the same reason.
 *
 * ## What it compares, and what it cannot
 *
 * The cells that are **numbers or closed vocabularies** are compared exactly: message limits,
 * poll and button limits, the delete window, `lengthUnit`, `markup`, `dmInitiation`,
 * `memberListing`, `deliveryVerification`, `commands`. Those are the cells a wrong value breaks
 * something with.
 *
 * The prose cells are not, and the honest reason is that they are prose: "1 per msg, restricted
 * emoji set" is a sentence with a link in it, and a parser that extracted a boolean from it would
 * be guessing. Where a prose cell carries a decision the product branches on, the structural test
 * in `profiles.test.ts` asserts the decision and names the cell — which is a weaker guarantee,
 * stated rather than implied.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { profiles } from '../../packages/channels/sdk/src/index.js';

const SPEC = fileURLToPath(new URL('../../docs/plan/06-channels.md', import.meta.url));

/** §3.2's table, by row label, with one cell per platform column. */
function capabilityMatrix(): ReadonlyMap<string, readonly string[]> {
  const markdown = readFileSync(SPEC, 'utf8');
  const section = markdown.split('### 3.2 Platform capability matrix')[1];
  if (section === undefined) throw new Error('06 §3.2 not found; the heading moved');
  const table = section.split('\n### ')[0] ?? section;

  const rows = new Map<string, readonly string[]>();
  for (const line of table.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|');
    const label = (cells[0] ?? '').trim();
    if (label === '' || label.startsWith('---') || label === 'Capability') continue;
    rows.set(
      label,
      cells.slice(1).map((cell) => cell.trim()),
    );
  }
  return rows;
}

/** The column order of §3.2's header, so a cell can be read by platform. */
const COLUMNS = ['telegram', 'discord', 'slack', 'matrix', 'signal', 'web', 'simulator'] as const;

function cell(label: string, platform: (typeof COLUMNS)[number]): string {
  const row = capabilityMatrix().get(label);
  if (row === undefined) throw new Error(`06 §3.2 has no row "${label}"`);
  const value = row[COLUMNS.indexOf(platform)];
  if (value === undefined) throw new Error(`06 §3.2 row "${label}" has no ${platform} column`);
  return value;
}

/** Every integer in a cell, so "4096 … / utf16 visible" yields [4096]. */
function numbersIn(text: string): readonly number[] {
  return [...text.replaceAll(/\[[^\]]*\]\([^)]*\)/g, ' ').matchAll(/\b(\d[\d\s]*)\b/g)]
    .map((match) => Number((match[1] ?? '').replaceAll(/\s/g, '')))
    .filter((value) => Number.isFinite(value));
}

describe('06 §3.2’s table is the citation and profiles.ts is the data', () => {
  it('parses the table, so the comparisons below are comparing something', () => {
    // The positive control. A parser that silently found nothing would make every assertion here
    // pass vacuously, which is the failure this whole file exists to prevent elsewhere.
    const matrix = capabilityMatrix();
    expect(matrix.size).toBeGreaterThan(15);
    expect(matrix.has('`markup`')).toBe(true);
    expect(cell('`markup`', 'telegram')).toContain('telegram-html');
  });

  it('agrees on `markup` for all six real platforms', () => {
    for (const platform of ['telegram', 'discord', 'slack', 'matrix', 'web'] as const) {
      expect(cell('`markup`', platform), platform).toContain(profiles[platform].markup);
    }
    // Signal's cell reads "`plain` + style ranges" — the markup is `plain` and the ranges are an
    // adapter detail, so the cell contains the value rather than equalling it.
    expect(cell('`markup`', 'signal')).toContain('plain');
  });

  it('agrees on every message-length limit', () => {
    // The numbers the splitter budgets against, which is the cell a wrong value truncates a
    // family's reply with.
    const limits = cell('`maxMessageChars` / unit', 'telegram');
    expect(numbersIn(limits)).toContain(profiles.telegram.maxMessageChars);
    expect(numbersIn(cell('`maxMessageChars` / unit', 'discord'))).toContain(
      profiles.discord.maxMessageChars,
    );
    expect(numbersIn(cell('`maxMessageChars` / unit', 'slack'))).toContain(
      profiles.slack.maxMessageChars,
    );
    expect(numbersIn(cell('`maxMessageChars` / unit', 'matrix'))).toContain(
      profiles.matrix.maxMessageChars,
    );
    expect(numbersIn(cell('`maxMessageChars` / unit', 'signal'))).toContain(
      profiles.signal.maxMessageChars,
    );
    expect(numbersIn(cell('`maxMessageChars` / unit', 'web'))).toContain(
      profiles.web.maxMessageChars,
    );
  });

  it('agrees that Signal counts bytes and that the table says so', () => {
    // Stated twice on purpose: the constant and the table both have to say "bytes", because this
    // is the one cell where the unit changes the arithmetic.
    expect(cell('`maxMessageChars` / unit', 'signal').toLowerCase()).toContain('byte');
    expect(profiles.signal.lengthUnit).toBe('utf8-bytes');
  });

  it('agrees on Telegram’s poll and button limits', () => {
    const polls = numbersIn(cell('`nativePolls`', 'telegram'));
    expect(polls).toContain(profiles.telegram.pollLimits?.maxOptions);
    expect(polls).toContain(profiles.telegram.pollLimits?.maxQuestionChars);
    expect(polls).toContain(profiles.telegram.pollLimits?.maxOptionChars);
    // `callback_data` **1–64 bytes**, which is the interaction token's whole budget.
    expect(numbersIn(cell('`buttons`', 'telegram'))).toContain(
      profiles.telegram.buttonLimits?.tokenMaxBytes,
    );
  });

  it('agrees on Discord’s poll limits', () => {
    const polls = numbersIn(cell('`nativePolls`', 'discord'));
    expect(polls).toContain(profiles.discord.pollLimits?.maxOptions);
    expect(polls).toContain(profiles.discord.pollLimits?.maxQuestionChars);
    expect(polls).toContain(profiles.discord.pollLimits?.maxOptionChars);
  });

  it('agrees on `dmInitiation`, `memberListing`, `deliveryVerification` and `commands`', () => {
    // Four closed vocabularies, which is what makes them comparable. Each decides a branch: who
    // the bot may DM first, whether an audience list is complete enough for IFC, whether a resend
    // can be proven safe, and whether a command arrives as a slash or as text.
    for (const [label, key] of [
      ['`dmInitiation`', 'dmInitiation'],
      ['`memberListing`', 'memberListing'],
      ['`deliveryVerification`', 'deliveryVerification'],
      ['`commands`', 'commands'],
    ] as const) {
      for (const platform of ['telegram', 'discord', 'slack', 'matrix', 'signal', 'web'] as const) {
        expect(cell(label, platform), `${label} ${platform}`).toContain(profiles[platform][key]);
      }
    }
  });

  it('agrees on `readsAllGroupMessages`, which decides whether setup is needed', () => {
    for (const platform of ['telegram', 'discord', 'slack', 'matrix', 'signal', 'web'] as const) {
      expect(cell('`readsAllGroupMessages`', platform), platform).toContain(
        profiles[platform].readsAllGroupMessages,
      );
    }
  });

  it('agrees on Telegram’s inbound attachment ceiling', () => {
    // 20 MB on `getFile`, which is the number that decides whether a voice note can be
    // transcribed at all.
    const bytes = profiles.telegram.maxInboundAttachmentBytes;
    expect(bytes).not.toBeNull();
    expect(numbersIn(cell('voice / images / files', 'telegram'))).toContain(
      (bytes ?? 0) / (1024 * 1024),
    );
  });

  it('agrees on the `ephemeral` tier for each platform', () => {
    for (const platform of ['telegram', 'discord', 'slack', 'matrix', 'signal', 'web'] as const) {
      expect(cell('`ephemeral`', platform), platform).toContain(profiles[platform].ephemeral);
    }
  });
});
