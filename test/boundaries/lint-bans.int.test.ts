/**
 * Every lint ban is proven to bite, and proven to apply where it is meant to.
 *
 * Two halves, because a ban can fail in two different ways:
 *
 *  1. **The rule does not catch the thing.** Checked by linting real source through the rule
 *     definitions exported from `scripts/lint/rules.ts` — the same objects `eslint.config.ts`
 *     uses, so the test cannot drift from the config.
 *  2. **The rule is wired to the wrong files.** Checked by asking the *real* `eslint.config.ts`
 *     which rules it would apply to a given path. A core-purity ban that is silently scoped to
 *     nothing passes half 1 and protects nothing.
 *
 * Specified by `M0-T4`. Tagged integration because it loads and resolves the real ESLint config.
 */
import { ESLint } from 'eslint';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import {
  CORE_PURITY_RULES,
  FETCH_ALLOWED_GLOBS,
  FETCH_BAN,
  SECURITY_RULES,
  UNFILTERED_ALLOWED_GLOBS,
  UNFILTERED_READ_BAN,
} from '../../scripts/lint/rules.js';

const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

/**
 * An ESLint instance carrying exactly the given rules and nothing else. The TypeScript parser is
 * set explicitly: without it ESLint falls back to espree and reports a parse error instead of the
 * rule, which looks like the ban failing when it is really the harness.
 */
function linterWith(rules: Record<string, unknown>): ESLint {
  return new ESLint({
    cwd: REPO,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
          // Same globals as the real config. `no-implied-eval` is inert without them, so a test
          // that omitted them would report the ban as broken when it is the harness that is.
          globals: { ...globals.node, ...globals.browser, ...globals.es2024 },
        },
        rules: rules as never,
      },
    ],
  });
}

/** Lint one snippet and return the messages, asserting it parsed. */
async function lintSnippet(
  rules: Record<string, unknown>,
  code: string,
  filePath: string,
): Promise<ESLint.LintResult['messages']> {
  const [result] = await linterWith(rules).lintText(code, { filePath: `${REPO}/${filePath}` });
  const messages = result?.messages ?? [];
  const parseError = messages.find((m) => m.fatal === true);
  if (parseError !== undefined) {
    throw new Error(`the snippet did not parse, so no rule could run: ${parseError.message}`);
  }
  return messages;
}

/** Lint one snippet with exactly the given rules, and return the rule ids that fired. */
async function rulesFiredFor(
  rules: Record<string, unknown>,
  code: string,
  filePath = 'packages/core/src/planted.ts',
): Promise<string[]> {
  const messages = await lintSnippet(rules, code, filePath);
  return messages.flatMap((m) => (m.ruleId === null ? [] : [m.ruleId]));
}

/** The first message's text, for asserting a ban explains itself. */
async function firstMessageFor(
  rules: Record<string, unknown>,
  code: string,
  filePath: string,
): Promise<string> {
  const messages = await lintSnippet(rules, code, filePath);
  return messages[0]?.message ?? '';
}

/** Which rules the real config would apply to this path. */
async function configuredRulesFor(filePath: string): Promise<Record<string, unknown>> {
  const eslint = new ESLint({ cwd: REPO });
  const config = (await eslint.calculateConfigForFile(`${REPO}/${filePath}`)) as {
    rules?: Record<string, unknown>;
  };
  return config.rules ?? {};
}

describe('core purity bans bite', { tags: ['slow'] }, () => {
  it.each([
    ['new Date()', 'export const now = new Date();'],
    ['Date.now()', 'export const ms = Date.now();'],
    ['a bare Date reference', 'export const ctor = Date;'],
    ['Date inside a function', 'export function f(): number { return new Date().getTime(); }'],
  ])('rejects %s', async (_label, code) => {
    expect(await rulesFiredFor(CORE_PURITY_RULES, code)).toContain('no-restricted-globals');
  });

  it('rejects Math.random, so a fairness decision stays replayable', async () => {
    const fired = await rulesFiredFor(
      CORE_PURITY_RULES,
      'export const pick = (n: number): number => Math.floor(Math.random() * n);',
    );
    expect(fired).toContain('no-restricted-properties');
  });

  it('rejects process, so configuration cannot leak into the pure layer', async () => {
    const fired = await rulesFiredFor(CORE_PURITY_RULES, 'export const dir = process.cwd();');
    expect(fired).toContain('no-restricted-globals');
  });

  it('explains what to do instead, rather than only refusing', async () => {
    const message = await firstMessageFor(
      CORE_PURITY_RULES,
      'export const t = new Date();',
      'packages/core/src/planted.ts',
    );
    expect(message).toMatch(/injected Clock port/);
  });

  it.each([
    ['Temporal types, which are the correct replacement', 'export type T = { at: string };'],
    ['an injected clock', 'export const f = (clock: { now(): string }): string => clock.now();'],
    ['arithmetic that merely mentions random in a name', 'export const randomSeed = 7;'],
  ])('allows %s', async (_label, code) => {
    expect(await rulesFiredFor(CORE_PURITY_RULES, code)).toEqual([]);
  });
});

describe('security bans bite', { tags: ['slow'] }, () => {
  it.each([
    ['eval', 'export const r = eval("1+1");', 'no-eval'],
    ['new Function', 'export const f = new Function("return 1");', 'no-new-func'],
    ['setTimeout with a string body', 'setTimeout("doThing()", 10);', 'no-implied-eval'],
    ['a javascript: URL', 'export const href = "javascript:alert(1)";', 'no-script-url'],
  ])('rejects %s', async (_label, code, expected) => {
    expect(await rulesFiredFor(SECURITY_RULES, code)).toContain(expected);
  });

  it("rejects dangerouslySetInnerHTML, the stored-XSS path into another member's session", async () => {
    const fired = await rulesFiredFor(
      SECURITY_RULES,
      'export const El = () => <div dangerouslySetInnerHTML={{ __html: text }} />;\n',
      'apps/dashboard/src/planted.tsx',
    );
    expect(fired).toContain('no-restricted-syntax');
  });

  it('rejects hand-parsing configuration off the environment', async () => {
    const fired = await rulesFiredFor(
      SECURITY_RULES,
      'export const cfg = JSON.parse(process.env.SETTINGS ?? "{}");',
      'apps/server/src/planted.ts',
    );
    expect(fired).toContain('no-restricted-syntax');
  });

  it('allows ordinary code', async () => {
    expect(
      await rulesFiredFor(SECURITY_RULES, 'export const add = (a: number, b: number) => a + b;'),
    ).toEqual([]);
  });
});

describe('the guarded-egress ban bites', { tags: ['slow'] }, () => {
  it('rejects the fetch global', async () => {
    const fired = await rulesFiredFor(
      FETCH_BAN,
      'export const get = (u: string) => fetch(u);',
      'packages/engine/src/planted.ts',
    );
    expect(fired).toContain('no-restricted-globals');
  });

  it('names safeFetch as the replacement', async () => {
    const message = await firstMessageFor(
      FETCH_BAN,
      'export const g = (u: string) => fetch(u);',
      'packages/engine/src/planted.ts',
    );
    expect(message).toMatch(/safeFetch/);
    expect(message).toMatch(/I5/);
  });
});

describe('the unfiltered-read ban bites', { tags: ['slow'] }, () => {
  it('rejects a `…Unfiltered` call, which is a labeled read with the label check removed', async () => {
    expect(
      await rulesFiredFor(
        UNFILTERED_READ_BAN,
        'export const all = (repo: { listMessagesUnfiltered(): string[] }) => repo.listMessagesUnfiltered();',
        'packages/engine/src/digest/build.ts',
      ),
    ).toContain('no-restricted-syntax');
  });

  it('catches it on any repository shape, since the suffix is the whole convention', async () => {
    for (const call of [
      'repo.searchMemoriesUnfiltered(q)',
      'uow.messages.listUnfiltered()',
      'store.repos.memory.recentUnfiltered(10)',
    ]) {
      expect(
        await rulesFiredFor(
          UNFILTERED_READ_BAN,
          `export const x = (repo: never, uow: never, store: never, q: never) => ${call};`,
          'packages/engine/src/digest/build.ts',
        ),
        call,
      ).toContain('no-restricted-syntax');
    }
  });

  it('says what to do instead, rather than only refusing', async () => {
    const message = await firstMessageFor(
      UNFILTERED_READ_BAN,
      'export const all = (repo: never) => repo.listMessagesUnfiltered();',
      'packages/engine/src/digest/build.ts',
    );
    expect(message).toContain('EligibleLabelSet');
    expect(message).toContain('02 §3.7.1');
    expect(message).toContain('I1');
  });

  it('leaves an ordinary filtered read alone', async () => {
    expect(
      await rulesFiredFor(
        UNFILTERED_READ_BAN,
        'export const all = (repo: never, eligible: never) => repo.listMessages(eligible);',
        'packages/engine/src/digest/build.ts',
      ),
    ).toEqual([]);
  });

  it('is not fooled by a name that merely contains the word', async () => {
    // `unfilteredCount` is not an unfiltered *read*; banning it would teach people to work around
    // the rule, which is worse than not having it.
    expect(
      await rulesFiredFor(
        UNFILTERED_READ_BAN,
        'export const n = (repo: never) => repo.unfilteredCount();',
        'packages/engine/src/digest/build.ts',
      ),
    ).toEqual([]);
  });
});

describe('the real eslint.config.ts wires the bans to the right files', { tags: ['slow'] }, () => {
  /**
   * The effective **options**, not just the rule name.
   *
   * This is the assertion that was missing. ESLint flat config *replaces* a rule's options when a
   * later block sets the same rule; it does not merge them. `no-restricted-globals` is set by both
   * `comvivo/core-purity` and `comvivo/guarded-egress`, and for most of M0 the egress block won —
   * so the effective config for `packages/core/**` banned `fetch` and **not** `Date` or `process`.
   *
   * Every test passed throughout. The isolated rule tests exercise `CORE_PURITY_RULES` directly,
   * and the test below used to assert only that the rule *name* was present. It took planting
   * `new Date()` in core during the M0 exit gate, and seeing `pnpm lint` come back green, to find
   * it.
   */
  const restrictedGlobalsFor = async (file: string): Promise<string[]> => {
    const rules = await configuredRulesFor(file);
    const entry = rules['no-restricted-globals'];
    if (!Array.isArray(entry)) return [];
    return entry
      .slice(1)
      .map((option) => (option as { name?: string }).name ?? '')
      .filter((name) => name !== '')
      .sort();
  };

  it('bans Date, process and fetch inside core — the options, not just the rule', async () => {
    expect(await restrictedGlobalsFor('packages/core/src/policy/authorize.ts')).toEqual([
      'Date',
      'fetch',
      'process',
    ]);
  });

  it('bans only fetch outside core, where a clock is legitimate', async () => {
    // `storage` must be able to call `Date.now()`. If this ever returns `Date`, a block has
    // started matching more than it should; if it returns nothing, one has clobbered the egress
    // ban.
    expect(await restrictedGlobalsFor('packages/storage/src/repositories/groups.ts')).toEqual([
      'fetch',
    ]);
  });

  it('bans nothing where fetch is explicitly allowed', async () => {
    // `FETCH_ALLOWED_GLOBS` exists so an adapter can speak a platform protocol. If the ban leaked
    // in here, the allowlist would be decorative.
    expect(await restrictedGlobalsFor('packages/shared/src/net/safe-fetch.ts')).toEqual([]);
  });

  it('applies the core purity bans inside core', async () => {
    const rules = await configuredRulesFor('packages/core/src/policy/authorize.ts');
    expect(Object.keys(rules)).toContain('no-restricted-globals');
    expect(Object.keys(rules)).toContain('no-restricted-properties');
  });

  it('does not apply them outside core, where a clock is legitimate', async () => {
    // `storage` must be able to call `Date.now()`; the purity rule is specific to core.
    const rules = await configuredRulesFor('packages/storage/src/repositories/groups.ts');
    expect(rules['no-restricted-properties']).toBeUndefined();
  });

  it('applies the type-aware rules that protect I6 and I7', async () => {
    const rules = await configuredRulesFor('packages/engine/src/turn/engine.ts');
    for (const rule of [
      '@typescript-eslint/no-floating-promises',
      '@typescript-eslint/no-misused-promises',
      '@typescript-eslint/switch-exhaustiveness-check',
    ]) {
      expect(Object.keys(rules), `${rule} is not configured for the engine`).toContain(rule);
    }
  });

  it('applies strict-boolean-expressions in core, where a truthiness slip mislabels data', async () => {
    const rules = await configuredRulesFor('packages/core/src/ifc/can-read.ts');
    expect(Object.keys(rules)).toContain('@typescript-eslint/strict-boolean-expressions');
  });

  it('applies the security bans everywhere, including the dashboard', async () => {
    for (const path of [
      'packages/core/src/index.ts',
      'packages/engine/src/index.ts',
      'apps/server/src/index.ts',
      'apps/dashboard/src/main.tsx',
    ]) {
      const rules = await configuredRulesFor(path);
      expect(Object.keys(rules), `no-eval is not configured for ${path}`).toContain('no-eval');
    }
  });

  /** The `no-restricted-syntax` selectors the real config would apply to a path. */
  const selectorsFor = async (file: string): Promise<string[]> => {
    const rules = await configuredRulesFor(file);
    const entry = rules['no-restricted-syntax'];
    if (!Array.isArray(entry)) return [];
    return entry
      .slice(1)
      .map((option) => (option as { selector?: string }).selector ?? '')
      .filter((selector) => selector !== '')
      .sort();
  };

  const UNFILTERED_SELECTOR = 'CallExpression > MemberExpression[property.name=/Unfiltered$/]';

  it('bans the unfiltered-read call shape in the engine', async () => {
    expect(await selectorsFor('packages/engine/src/digest/build.ts')).toContain(
      UNFILTERED_SELECTOR,
    );
  });

  it('allows it in the tool executor and in storage, which are the two listed callers', async () => {
    for (const path of [
      'packages/engine/src/tools-executor/scoped-repos/messages.ts',
      'packages/storage/src/retention/sweep.ts',
    ]) {
      expect(await selectorsFor(path), `the ban leaked into ${path}`).not.toContain(
        UNFILTERED_SELECTOR,
      );
    }
    // And the exemption is listed rather than implicit.
    expect(UNFILTERED_ALLOWED_GLOBS).toEqual([
      'packages/engine/src/tools-executor/**',
      'packages/storage/src/**',
    ]);
  });

  it('keeps every security selector wherever the unfiltered ban applies', async () => {
    // The trap that left core's `Date` ban inert for most of M0: flat config **replaces** a rule's
    // options. `comvivo/unfiltered-reads` sets `no-restricted-syntax`, which `comvivo/security-bans`
    // also sets, so the later block has to carry both lists — asserted here rather than assumed.
    const selectors = await selectorsFor('packages/engine/src/digest/build.ts');
    const security = (SECURITY_RULES['no-restricted-syntax'] as { selector: string }[])
      .slice(1)
      .map((option) => option.selector);
    for (const selector of security) {
      expect(selectors, `the security selector ${selector} was replaced`).toContain(selector);
    }
  });

  it('keeps the security selectors where the unfiltered ban is lifted', async () => {
    const selectors = await selectorsFor('packages/storage/src/retention/sweep.ts');
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors).not.toContain(UNFILTERED_SELECTOR);
  });

  it('bans the fetch global in the engine but allows it in an adapter', async () => {
    const engine = await configuredRulesFor('packages/engine/src/turn/engine.ts');
    expect(Object.keys(engine)).toContain('no-restricted-globals');

    const adapter = await configuredRulesFor('packages/channels/telegram/src/client.ts');
    // The adapter must speak Telegram's HTTP API directly, so the ban is lifted there — and that
    // exemption is listed, not implicit.
    expect(FETCH_ALLOWED_GLOBS).toContain('packages/channels/*/src/**');
    const adapterRestricted = adapter['no-restricted-globals'];
    expect(
      adapterRestricted,
      'the fetch ban leaked into a channel adapter, which must call its platform directly',
    ).toBeUndefined();
  });
});
