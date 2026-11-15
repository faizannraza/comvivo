/**
 * The runtime copy catalog (`05` §3.11; `01` §11.12 "copy is product").
 *
 * Every sentence Village says to a member when something goes wrong, is slow, needs approval or
 * was cancelled, as **ICU MessageFormat** in `copy/runtime.<locale>.json`. `05` §3.11's table is
 * the specification and `scripts/copy/check.ts` compares the two in both directions, so a key the
 * spec adds and the catalog lacks fails `pnpm verify` rather than surfacing as a blank reply.
 *
 * ## Why the keys are a type and the catalog is JSON
 *
 * JSON because a translator edits it (`05` §3.11: "other locales community-contributed"), and a
 * TypeScript module would make a translation a code change. A **union type** for the keys and a
 * per-key params type because the alternative — `format(key: string, params: object)` — turns
 * every typo and every forgotten `{action}` into a runtime `MissingValueError` on the one code
 * path whose job is to apologise for a failure. The two are kept in step by `RUNTIME_COPY_KEYS`
 * and a test that compares it against the file.
 *
 * ## The fallback chain, and the one it is not
 *
 * `05` §3.11 is "hint → group → `en`": the language hint the router inferred, then the group's
 * locale, then English. Resolved **per key** rather than per catalog, because a community
 * translation is partial by nature — a `de` catalog missing `confirm.result.stale` should produce
 * the English sentence rather than nothing, and a reader who sees one English line among German
 * ones has learned something true about the translation.
 *
 * A **render** failure falls back the same way, which is the part that needs saying: if a
 * translated pattern names a parameter the caller did not pass, `intl-messageformat` throws
 * `MissingValueError`, and this module catches it, logs at `warn` and renders English. A thrown
 * error here would mean the reply that explains a failure is itself a failure. English failing is
 * a bug in this repository, and it throws — `copy.test.ts` renders all 33 keys with representative
 * params, so it cannot reach a host.
 */
import { readFileSync } from 'node:fs';
import type { Logger } from '@comvivo/shared';
import { IntlMessageFormat } from 'intl-messageformat';

/**
 * Where the catalogs live, relative to the built module.
 *
 * `copy/` is a sibling of `src/`, not a file inside it, so `tsc` neither copies nor type-checks
 * it — which is correct for a file a translator owns. `package.json`'s `files` lists `copy`
 * alongside `dist` so it ships. Read at first use rather than imported, because a JSON import
 * would have to be inside `rootDir` and would make every catalog a compilation input.
 */
const CATALOG_DIR = new URL('../copy/', import.meta.url);

/** `05` §3.11's base locale, and the end of every fallback chain. */
export const BASE_LOCALE = 'en';

/**
 * Every key in `05` §3.11's table, in the table's order.
 *
 * The list is here and not derived from the JSON because deriving it would give
 * `Record<string, string>` — the keys would typecheck against any string, which is the whole of
 * what this type is for. `copy.test.ts` asserts the two agree in both directions.
 */
export const RUNTIME_COPY_KEYS = [
  'info.still_working',
  'err.timeout_continuing',
  'err.timeout_final',
  'err.provider_unavailable',
  'err.provider_unavailable_final',
  'err.provider_busy',
  'err.refusal',
  'err.budget_member',
  'admin.budget_economy',
  'admin.budget_reached',
  'admin.provider_auth',
  'err.guard_blocked',
  'err.context_too_long',
  'err.too_long',
  'err.turn_budget',
  'err.local_no_tools',
  'err.crash_retry_apology',
  'info.recovery_intro',
  'info.cancelled',
  'info.cancelled_with_effects',
  'err.slow_down',
  'info.trimmed',
  'confirm.request.self',
  'confirm.request.approver',
  'confirm.request.approver_deeplink',
  'confirm.result.approved',
  'confirm.result.expired',
  'confirm.result.declined',
  'confirm.result.stale',
  'confirm.result.no_longer_allowed',
  'err.generic',
  'info.sent_privately',
  'info.dm_needed',
] as const;

export type RuntimeCopyKey = (typeof RUNTIME_COPY_KEYS)[number];

/**
 * A key whose sentence takes no parameters. Sixteen of the thirty-three do.
 *
 * `{ params?: never }` rather than `Record<never, never>`, and the difference is not cosmetic:
 * every spelling of an empty object type — `{}`, an empty interface, `Record<never, never>` —
 * resolves to `{}` and therefore accepts **any** non-nullish value, `42` and `''` included. Both
 * linters refuse it and they are right; `core/src/ports/storage/store.ts` records the same finding
 * about `ReadScope`. One optional member that no caller can satisfy makes `format('err.generic',
 * {})` the call shape and `format('err.generic', 42)` a type error.
 *
 * The call still passes `{}` rather than taking no second argument, because a variadic conditional
 * on "is this type empty" is the same `extends {}` test wearing a disguise — and a uniform call
 * shape is worth two characters.
 */
export type NoParams = { readonly params?: never };

/**
 * What each key needs, by key.
 *
 * Spelled out rather than `Record<string, string>`, because the parameters are the part a caller
 * gets wrong: `confirm.result.declined` without `{approver}` renders as a `MissingValueError` on
 * the path that tells a member their request was refused. Every value is a string the caller has
 * already rendered — a handle, a localised instant, a block of effect lines — except the two the
 * formatter itself formats.
 */
export interface RuntimeCopyParams {
  /** The current phase or tool, e.g. "checking the calendar" (`05` §3.3.6's `activityKey`). */
  'info.still_working': { readonly activity: string };
  'err.timeout_continuing': NoParams;
  /**
   * `doneLines` is **pre-rendered and ends with its own separator**, or is `''`.
   *
   * `05` §3.11's copy has no space before "Could", which is the spec saying so: the lines come
   * from `effects.<locale>.json` (§3.7.1) and are a block, not a word.
   */
  'err.timeout_final': { readonly doneLines: string };
  'err.provider_unavailable': NoParams;
  'err.provider_unavailable_final': NoParams;
  'err.provider_busy': NoParams;
  'err.refusal': NoParams;
  'err.budget_member': { readonly period: string; readonly resetAt: string };
  /** `pct` is a **fraction**: `0.9` renders as `90%`. See the note in `05` §3.11. */
  'admin.budget_economy': {
    readonly group: string;
    readonly pct: number;
    readonly period: string;
    readonly resetAt: string;
  };
  'admin.budget_reached': {
    readonly group: string;
    readonly period: string;
    readonly spent: string;
    readonly limit: string;
    readonly resetAt: string;
    /** The dashboard's budget page. An absolute URL, because this arrives in a DM. */
    readonly link: string;
  };
  /**
   * `provider` is a vendor name, and this is one of the two places `05` §3.11 permits one.
   *
   * The other is `/why` for `traces.read.group`. This message goes to a **host or admin DM**: the
   * person who can fix the key is the person who needs to know which key it is.
   */
  'admin.provider_auth': { readonly provider: string; readonly reason: string };
  /** `offerDm` adds "Ask me in a DM." — true when the requester is not the audience. */
  'err.guard_blocked': { readonly offerDm: boolean };
  'err.context_too_long': NoParams;
  'err.too_long': NoParams;
  'err.turn_budget': { readonly doneLines: string };
  'err.local_no_tools': NoParams;
  'err.crash_retry_apology': NoParams;
  'info.recovery_intro': NoParams;
  'info.cancelled': NoParams;
  'info.cancelled_with_effects': { readonly doneLines: string };
  'err.slow_down': NoParams;
  'info.trimmed': NoParams;
  'confirm.request.self': { readonly action: string };
  'confirm.request.approver': {
    readonly requester: string;
    readonly action: string;
    readonly role: string;
  };
  'confirm.request.approver_deeplink': { readonly approver: string };
  'confirm.result.approved': { readonly approver: string; readonly effectLine: string };
  'confirm.result.expired': { readonly approver: string; readonly action: string };
  'confirm.result.declined': { readonly approver: string; readonly action: string };
  'confirm.result.stale': { readonly action: string };
  'confirm.result.no_longer_allowed': { readonly action: string };
  'err.generic': NoParams;
  'info.sent_privately': NoParams;
  'info.dm_needed': NoParams;
}

/** One catalog's raw messages, as the file holds them. */
export type Catalog = Readonly<Record<string, string>>;

/** A locale tag, or the chain of them `05` §3.11 resolves in order. */
export type LocaleChain = readonly string[];

/**
 * A missing catalog file, remembered.
 *
 * `null` rather than an absent entry, so a locale nobody has translated is one `readFileSync`
 * attempt for the process rather than one per message. The distinction matters because the common
 * case *is* a missing file: `en` is the only catalog at 1.0, and every non-English group would
 * otherwise re-stat two files per reply.
 */
type CacheEntry = Catalog | null;

export interface RuntimeCopyOptions {
  /**
   * Where a render failure is reported.
   *
   * Required rather than optional: the whole point of falling back to English is that somebody
   * finds out the translation is wrong, and a default no-op logger would make this module silent
   * about the one thing it is designed to notice.
   */
  readonly logger: Logger;
  /** For tests: supply catalogs directly instead of reading `copy/`. */
  readonly catalogs?: Readonly<Record<string, Catalog>>;
}

/**
 * `05` §3.11's catalog, compiled on demand and cached.
 *
 * One instance per process. `IntlMessageFormat` parses its pattern in the constructor, so a
 * per-call instance would re-parse the same sentence on every reply; the cache is keyed on the
 * locale **and** the key because the compiled form is locale-specific — plural categories and
 * number formats differ, which is the reason ICU takes a locale at all.
 */
export class RuntimeCopy {
  readonly #logger: Logger;
  readonly #supplied: Readonly<Record<string, Catalog>> | undefined;
  readonly #catalogs = new Map<string, CacheEntry>();
  readonly #compiled = new Map<string, IntlMessageFormat>();

  constructor(options: RuntimeCopyOptions) {
    this.#logger = options.logger.child({ component: 'copy' });
    this.#supplied = options.catalogs;
  }

  /**
   * Render one key (`05` §3.11).
   *
   * `locales` is the chain in preference order — the router's language hint, then the group's
   * locale. `en` is appended here rather than by every caller, because a caller that forgot it
   * would produce an empty reply on a locale nobody has translated.
   */
  format<K extends RuntimeCopyKey>(
    key: K,
    params: RuntimeCopyParams[K],
    locales: LocaleChain = [],
  ): string {
    for (const locale of [...locales, BASE_LOCALE]) {
      const rendered = this.#tryFormat(locale, key, params, locale === BASE_LOCALE);
      if (rendered !== undefined) return rendered;
    }
    // Unreachable: the loop always ends at `BASE_LOCALE`, where a failure throws rather than
    // returning `undefined`. Spelled out because the alternatives are a `!` or a `?? ''`, and an
    // empty string here is a reply that says nothing at all.
    throw new Error(`copy: ${BASE_LOCALE} rendered ${key} as nothing`);
  }

  /** Whether a locale has a catalog of its own, for `village doctor` and the dashboard. */
  hasCatalog(locale: string): boolean {
    return this.#catalog(locale) !== null;
  }

  /**
   * Render, or `undefined` when this locale cannot.
   *
   * `required` makes the base locale throw instead: a missing English key, or a pattern English
   * cannot render, is a defect in this repository, and swallowing it would turn a test failure
   * into a member seeing nothing.
   */
  #tryFormat(
    locale: string,
    key: RuntimeCopyKey,
    params: Readonly<Record<string, unknown>>,
    required: boolean,
  ): string | undefined {
    const catalog = this.#catalog(locale);
    const message = catalog?.[key];
    if (message === undefined) {
      if (!required) return undefined;
      throw new Error(`copy: ${locale} has no message for ${key}`);
    }
    try {
      const formatted = this.#formatter(locale, key, message).format(params);
      // `format` returns `string | Part[]` for patterns with rich-text tags. The catalog has
      // none — `06` §3.5 owns markup, and a tag here would put a formatting decision inside a
      // translation — so anything but a string is a catalog this build cannot render.
      if (typeof formatted !== 'string') {
        throw new TypeError(`${key} rendered as parts, not a string`);
      }
      return formatted;
    } catch (cause) {
      if (required) throw cause;
      // The case this exists for: a community translation naming a parameter the caller does not
      // pass, or a pattern that does not parse.
      //
      // The locale, the key and the error's **class** — not its message and not the params.
      // `LogFields.detail` refuses a value with a space in it for a measured reason (see
      // `fields.ts`), and all three of these are token-shaped. The class name is what makes the
      // line actionable: "de's `confirm.result.stale` threw `MissingValueError`" tells a
      // translator exactly where to look, and `MissingValueError`'s own message quotes the
      // pattern, which is a sentence.
      this.#logger.warn('copy.fallback', {
        detail: {
          locale,
          key,
          reason: cause instanceof Error ? cause.constructor.name : 'unknown',
        },
      });
      return undefined;
    }
  }

  #formatter(locale: string, key: string, message: string): IntlMessageFormat {
    const cacheKey = `${locale}|${key}`;
    const existing = this.#compiled.get(cacheKey);
    if (existing !== undefined) return existing;
    const compiled = new IntlMessageFormat(message, locale);
    this.#compiled.set(cacheKey, compiled);
    return compiled;
  }

  #catalog(locale: string): CacheEntry {
    const cached = this.#catalogs.get(locale);
    if (cached !== undefined) return cached;
    const loaded = this.#load(locale);
    this.#catalogs.set(locale, loaded);
    return loaded;
  }

  #load(locale: string): CacheEntry {
    const supplied = this.#supplied?.[locale];
    if (supplied !== undefined) return supplied;
    // Tests that supply catalogs supply all of them: reading `copy/` for a locale they left out
    // would make a test's result depend on which translations happen to be in the repository.
    if (this.#supplied !== undefined) return null;
    // A locale tag is BCP 47 and arrives from a model's language hint, so it is **not** trusted as
    // a path component. `en-GB` is fine; `../../etc/passwd` is a hint the router mis-parsed, and
    // the only safe answer to it is "no catalog".
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) return null;
    try {
      return JSON.parse(
        readFileSync(new URL(`runtime.${locale}.json`, CATALOG_DIR), 'utf8'),
      ) as Catalog;
    } catch {
      // A locale nobody has translated. Not logged: at 1.0 `en` is the only catalog, so every
      // non-English group would log twice per reply about a file that is absent by design.
      return null;
    }
  }
}
