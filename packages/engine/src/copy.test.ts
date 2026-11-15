/**
 * The runtime copy catalog (`05` §3.11; `M3-T12`).
 *
 * Three things are checked here that `scripts/copy/check.ts` cannot, because they need the
 * formatter and a `Logger`:
 *
 *  - **every key of every catalog renders**, with representative params. The script compares key
 *    lists; this one exercises the ICU patterns, which is where a stray brace or a plural category
 *    a locale does not have actually surfaces;
 *  - **the fallback chain**, including the part that is easy to state and hard to get right: a
 *    partial translation falls back **per key**, and a translation whose pattern cannot render
 *    falls back too, with a `warn` line naming the locale and the key;
 *  - **English throws rather than returning nothing.** A missing English key is a defect in this
 *    repository, and the reply that explains a failure must never itself be empty.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { LogFields } from '@comvivo/shared';
import { silentLogger } from '@comvivo/shared/testing';
import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import {
  BASE_LOCALE,
  type Catalog,
  RUNTIME_COPY_KEYS,
  RuntimeCopy,
  type RuntimeCopyKey,
  type RuntimeCopyOptions,
  type RuntimeCopyParams,
} from './copy.js';

const CATALOG_DIR = new URL('../copy/', import.meta.url);

function catalogFiles(): readonly { readonly locale: string; readonly catalog: Catalog }[] {
  return readdirSync(CATALOG_DIR)
    .map((name) => ({ name, locale: /^runtime\.([^.]+)\.json$/.exec(name)?.[1] }))
    .filter((each): each is { name: string; locale: string } => each.locale !== undefined)
    .map(({ name, locale }) => ({
      locale,
      catalog: JSON.parse(readFileSync(new URL(name, CATALOG_DIR), 'utf8')) as Catalog,
    }));
}

/**
 * One representative argument set per key.
 *
 * Written out rather than generated, because a generated `{ [param]: 'x' }` would prove the
 * pattern parses and nothing about whether the sentence reads. These values are the shapes the
 * callers will pass — a handle with an `@`, a localised instant, a percentage as a **fraction**
 * — so the assertions below are about sentences a member could actually receive.
 */
const PARAMS: { readonly [K in RuntimeCopyKey]: RuntimeCopyParams[K] } = {
  'info.still_working': { activity: 'checking the calendar' },
  'err.timeout_continuing': {},
  'err.timeout_final': { doneLines: 'I added the task *Bins*. ' },
  'err.provider_unavailable': {},
  'err.provider_unavailable_final': {},
  'err.provider_busy': {},
  'err.refusal': {},
  'err.budget_member': { period: 'this month', resetAt: 'on 1 December' },
  'admin.budget_economy': {
    group: 'The Rahmans',
    pct: 0.9,
    period: 'monthly',
    resetAt: '1 December',
  },
  'admin.budget_reached': {
    group: 'The Rahmans',
    period: 'monthly',
    spent: '$40.12',
    limit: '$40.00',
    resetAt: '1 December',
    link: 'http://127.0.0.1:8787/settings/budget',
  },
  'admin.provider_auth': { provider: 'Anthropic', reason: 'invalid key' },
  'err.guard_blocked': { offerDm: true },
  'err.context_too_long': {},
  'err.too_long': {},
  'err.turn_budget': { doneLines: 'I added the task *Bins*.' },
  'err.local_no_tools': {},
  'err.crash_retry_apology': {},
  'info.recovery_intro': {},
  'info.cancelled': {},
  'info.cancelled_with_effects': { doneLines: 'I added the task *Bins*.' },
  'err.slow_down': {},
  'info.trimmed': {},
  'confirm.request.self': { action: 'cancel Thursday’s dinner' },
  'confirm.request.approver': {
    requester: '@sana',
    action: 'cancel Thursday’s dinner',
    role: 'a parent',
  },
  'confirm.request.approver_deeplink': { approver: 'ali' },
  'confirm.result.approved': {
    approver: '@ali',
    effectLine: 'I cancelled *Dinner* (Thursday 19:00).',
  },
  'confirm.result.expired': { approver: '@ali', action: 'cancel Thursday’s dinner' },
  'confirm.result.declined': { approver: '@ali', action: 'cancel Thursday’s dinner' },
  'confirm.result.stale': { action: 'cancel Thursday’s dinner' },
  'confirm.result.no_longer_allowed': { action: 'cancel Thursday’s dinner' },
  'err.generic': {},
  'info.sent_privately': {},
  'info.dm_needed': {},
};

interface Warning {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

/** A logger that keeps what it was told, so a fallback can be asserted rather than assumed. */
function recordingLogger(): {
  readonly logger: RuntimeCopyOptions['logger'];
  readonly warnings: Warning[];
} {
  const warnings: Warning[] = [];
  const logger = {
    ...silentLogger,
    warn(event: string, fields?: LogFields) {
      warnings.push({ event, fields });
    },
    child() {
      return logger;
    },
  } as unknown as RuntimeCopyOptions['logger'];
  return { logger, warnings };
}

describe('the catalog files (05 §3.11)', () => {
  it('has an English catalog holding exactly the declared keys', () => {
    const base = catalogFiles().find((each) => each.locale === BASE_LOCALE);
    expect(base, `there is no runtime.${BASE_LOCALE}.json`).toBeDefined();
    // Both directions, and in order: the key list is what gives a caller a typed key, so a
    // divergence either way is a key that typechecks and renders nothing, or copy with no caller.
    expect(Object.keys(base?.catalog ?? {})).toEqual([...RUNTIME_COPY_KEYS]);
  });

  it('parses every message of every catalog as ICU', () => {
    const files = catalogFiles();
    // Non-vacuity: a glob that matched nothing would make the loop below assert nothing at all.
    expect(files.length).toBeGreaterThanOrEqual(1);
    const broken: string[] = [];
    for (const { locale, catalog } of files) {
      for (const [key, message] of Object.entries(catalog)) {
        try {
          new IntlMessageFormat(message, locale);
        } catch {
          broken.push(`${locale}:${key}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('never puts markup in a message, because 06 §3.5 owns rendering', () => {
    // An ICU rich-text tag (`<b>…</b>`) makes `format` return parts rather than a string, and a
    // platform-specific tag in a *translation* would be a rendering decision made by whoever
    // translated it. `06` §3.5's RichText renderers are where markup is decided per platform.
    const tagged: string[] = [];
    for (const { locale, catalog } of catalogFiles()) {
      for (const [key, message] of Object.entries(catalog)) {
        if (/<[A-Za-z][^>]*>/.test(message)) tagged.push(`${locale}:${key}`);
      }
    }
    expect(tagged).toEqual([]);
  });
});

describe('rendering (05 §3.11)', () => {
  const copy = new RuntimeCopy({ logger: silentLogger });

  it('renders every key to a non-empty sentence with no placeholder left in it', () => {
    for (const key of RUNTIME_COPY_KEYS) {
      const rendered = copy.format(key, PARAMS[key]);
      expect(rendered.length, key).toBeGreaterThan(0);
      // A `{` that survived rendering is a parameter the caller did not pass and ICU did not
      // notice — which is what a literal brace in the catalog would look like.
      expect(rendered, key).not.toContain('{');
    }
  });

  it('formats the budget percentage from a fraction, not from 0–100', () => {
    // `05` §3.11 writes `{pct}%`; the catalog uses ICU's own `number, percent`, which localises
    // the symbol and its placement. The param is therefore a **fraction**, and a caller passing
    // `90` would render "9,000%" — which is why it is stated on `RuntimeCopyParams`.
    expect(copy.format('admin.budget_economy', PARAMS['admin.budget_economy'])).toContain('90%');
  });

  it('adds the DM offer only when the requester is not the audience', () => {
    expect(copy.format('err.guard_blocked', { offerDm: true })).toBe(
      "I can't share that here. Ask me in a DM.",
    );
    expect(copy.format('err.guard_blocked', { offerDm: false })).toBe("I can't share that here.");
  });

  it('leaves no double space when there is nothing done to report', () => {
    // `05` §3.11's copy has no space before "Could", so `doneLines` carries its own separator or
    // is empty. The empty case is the one a reader sees most and the one a stray space would
    // spoil: "that.  Could you".
    expect(copy.format('err.timeout_final', { doneLines: '' })).toBe(
      "Sorry, I couldn't finish that. Could you try a smaller request?",
    );
  });

  it('names a vendor in the admin notice and nowhere else', () => {
    // `05` §3.11: "Model or vendor names are never shown to members, except in `/why` ... and in
    // admin notices." `admin.provider_auth` is the admin notice; the member-facing failures say
    // "my AI service".
    expect(copy.format('admin.provider_auth', PARAMS['admin.provider_auth'])).toContain(
      'Anthropic',
    );
    for (const key of RUNTIME_COPY_KEYS) {
      if (key.startsWith('admin.')) continue;
      const rendered = copy.format(key, PARAMS[key]);
      for (const vendor of ['Anthropic', 'OpenAI', 'Claude', 'Gemini', 'Google', 'GPT']) {
        expect(rendered, `${key} names ${vendor}`).not.toContain(vendor);
      }
    }
  });
});

describe('the locale fallback chain (05 §3.11: hint → group → en)', () => {
  const de: Catalog = {
    // A partial translation, which is what a community translation is.
    'info.cancelled': 'Okay, gestoppt.',
    // A pattern naming a parameter no caller passes — the render failure this is here for.
    'err.generic': 'Entschuldigung, {nichtGeliefert}.',
  };
  const fr: Catalog = { 'info.cancelled': "D'accord, j'arrête." };
  const en: Catalog = JSON.parse(
    readFileSync(new URL(`runtime.${BASE_LOCALE}.json`, CATALOG_DIR), 'utf8'),
  ) as Catalog;

  it('prefers the hint, then the group, then English', () => {
    const copy = new RuntimeCopy({ logger: silentLogger, catalogs: { de, fr, en } });
    expect(copy.format('info.cancelled', {}, ['de', 'fr'])).toBe('Okay, gestoppt.');
    // The hint has no catalog, so the group's is used — the ordinary case for a member writing in
    // a language nobody has translated inside a group that has been.
    expect(copy.format('info.cancelled', {}, ['pt', 'fr'])).toBe("D'accord, j'arrête.");
    expect(copy.format('info.cancelled', {}, [])).toBe('Okay, stopped.');
  });

  it('falls back per key, not per catalog', () => {
    const copy = new RuntimeCopy({ logger: silentLogger, catalogs: { de, en } });
    // `de` has `info.cancelled` and not `info.trimmed`. A per-*catalog* fallback would answer
    // either all German or all English; a reader of a partial translation gets the German it has
    // and English for the rest, which is true about the translation.
    expect(copy.format('info.cancelled', {}, ['de'])).toBe('Okay, gestoppt.');
    expect(copy.format('info.trimmed', {}, ['de'])).toBe('(Trimmed — ask me for the rest.)');
  });

  it('falls back when a translated pattern cannot render, and says so once', () => {
    const { logger, warnings } = recordingLogger();
    const copy = new RuntimeCopy({ logger, catalogs: { de, en } });
    expect(copy.format('err.generic', {}, ['de'])).toBe(
      "Sorry, I didn't get that — could you rephrase?",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.event).toBe('copy.fallback');
    // The locale, the key and the error's class — token-shaped, so `LogFields.detail` accepts
    // them — and **not** the params, which are message content (`01` §11.7).
    expect(warnings[0]?.fields?.detail).toEqual({
      locale: 'de',
      key: 'err.generic',
      reason: 'MissingValueError',
    });
  });

  it('throws rather than rendering nothing when English itself is missing a key', () => {
    const copy = new RuntimeCopy({
      logger: silentLogger,
      catalogs: { en: { 'info.cancelled': 'x' } },
    });
    // The reply that explains a failure must not itself be an empty message. `pnpm verify` is
    // where this is caught — `scripts/copy/check.ts` and the first test in this file — so the
    // throw is the backstop rather than the mechanism.
    expect(() => copy.format('err.generic', {})).toThrow(/no message for err\.generic/);
  });

  it('refuses to read a file a locale tag traversed to', () => {
    const copy = new RuntimeCopy({ logger: silentLogger });
    expect(copy.hasCatalog(BASE_LOCALE)).toBe(true);
    // A locale tag that is well-formed and simply untranslated.
    expect(copy.hasCatalog('en-GB')).toBe(false);

    // And the one that is not a locale tag at all. A language hint comes from a **model**
    // (`05` §3.2.4), so it is attacker-influenced in the sense that matters here: it reaches
    // `readFileSync` as part of a filename.
    //
    // `./../../package` is the measured escape, not a decorative example: the path built from it
    // is `copy/runtime.` + the tag + `.json`, which resolves to `packages/engine/package.json` —
    // a file that **exists**. Without the BCP-47 guard this call returns `true`, because any JSON
    // on the host parses as a catalog, and its values would then be rendered into a member's
    // reply. `../../../etc/passwd` is the version that is merely absent; this is the version that
    // would have worked.
    expect(copy.hasCatalog('./../../package')).toBe(false);
    expect(copy.hasCatalog('../../../etc/passwd')).toBe(false);
    expect(copy.format('info.cancelled', {}, ['./../../package'])).toBe('Okay, stopped.');
  });
});
