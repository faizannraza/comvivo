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
import { comvivoPlugin, namesASecret, words } from '../../scripts/lint/no-secret-equality.js';
import {
  AFTER_COMMIT_BAN,
  CORE_PURITY_RULES,
  FC_CONFIG_BAN,
  FETCH_ALLOWED_GLOBS,
  FETCH_BAN,
  RAW_TRANSACTION_BAN,
  SDK_PURITY_RULES,
  SECURITY_RULES,
  SYNC_TX_BAN,
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

  it('bans every impure global inside core — the options, not just the rule', async () => {
    // Sorted, so the assertion is a set rather than an ordering. The four timer/Node names joined
    // the three originals at `M2-T1`, when `packages/core/tsconfig.json` gained `"types":
    // ["node"]` so the model port could name an `AbortSignal` as `01` §7.5 specifies: until then
    // an empty `types` array had been refusing them by accident, and an accident is not a rule.
    expect(await restrictedGlobalsFor('packages/core/src/policy/authorize.ts')).toEqual([
      'Buffer',
      'Date',
      'fetch',
      'process',
      'setImmediate',
      'setInterval',
      'setTimeout',
    ]);
  });

  it.each(['setTimeout', 'setInterval', 'setImmediate', 'Buffer'])(
    'refuses %s in core, which `types: []` used to refuse by accident',
    async (name) => {
      // Planted through the real rule rather than asserted from the config: the four exist because
      // Node's types now make them compile in core, so the thing worth proving is that they still
      // fail.
      const code =
        name === 'Buffer'
          ? 'export const f = () => Buffer.alloc(1);'
          : `export const f = () => ${name}(() => undefined, 1);`;
      expect(
        await rulesFiredFor(CORE_PURITY_RULES, code, 'packages/core/src/policy/authorize.ts'),
      ).toContain('no-restricted-globals');
    },
  );

  it('bans every impure global inside the plugin SDK — the options, not just the rule', async () => {
    // Added at `M2-T5`, when `packages/plugin-sdk/tsconfig.json` gained `"types": ["node"]` so
    // `ToolContext` could name an `AbortSignal` and `EgressHttp` a `Response` (`10` §3.2.4). The
    // same trade core made at `M2-T1`: Node's types make these compile, so they have to be a rule.
    expect(await restrictedGlobalsFor('packages/plugin-sdk/src/tool.ts')).toEqual([
      'Buffer',
      'Date',
      'fetch',
      'process',
      'setImmediate',
      'setInterval',
      'setTimeout',
    ]);
  });

  it.each(['Date', 'process', 'setTimeout', 'setInterval', 'setImmediate', 'Buffer', 'fetch'])(
    'refuses %s in the plugin SDK, where ToolContext supplies the replacement',
    async (name) => {
      const code =
        name === 'Buffer'
          ? 'export const f = () => Buffer.alloc(1);'
          : name === 'Date'
            ? 'export const f = () => Date.now();'
            : name === 'process'
              ? 'export const f = () => process.argv;'
              : name === 'fetch'
                ? 'export const f = () => fetch("https://example.com");'
                : `export const f = () => ${name}(() => undefined, 1);`;
      expect(
        await rulesFiredFor(SDK_PURITY_RULES, code, 'packages/plugin-sdk/src/tool.ts'),
      ).toContain('no-restricted-globals');
    },
  );

  it('refuses Math.random in the plugin SDK, so an invocation can be replayed', async () => {
    expect(
      await rulesFiredFor(
        SDK_PURITY_RULES,
        'export const f = () => Math.random();',
        'packages/plugin-sdk/src/tool.ts',
      ),
    ).toContain('no-restricted-properties');
  });

  it('applies both purity rules inside the plugin SDK', async () => {
    const rules = await configuredRulesFor('packages/plugin-sdk/src/tool.ts');
    expect(Object.keys(rules)).toContain('no-restricted-globals');
    expect(Object.keys(rules)).toContain('no-restricted-properties');
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

describe('the synchronous-transaction ban bites (01 §1, 02 §3.7.2)', { tags: ['slow'] }, () => {
  // `M1-T9`'s acceptance criterion: "the lint rule fails on a fixture that awaits inside a tx".
  // These *are* the fixtures — lint snippets rather than committed files, so a fixture cannot rot
  // into something the rule no longer looks at while the test keeps passing.
  it.each([
    ['store.write with an async arrow', 'export const f = (s: any) => s.write(async () => 1);'],
    [
      'store.read with an async arrow',
      'export const f = (s: any) => s.read(async () => { await 0; return 1; });',
    ],
    [
      'an async function expression',
      'export const f = (s: any) => s.write(async function () { await 0; });',
    ],
    [
      'an await actually inside the callback',
      'export const f = (s: any) => s.write(async () => { await Promise.resolve(); });',
    ],
    [
      'a raw db.transaction with an async callback',
      'export const f = (d: any) => d.transaction(async () => 1);',
    ],
  ])('rejects %s', async (_label, code) => {
    expect(await rulesFiredFor(SYNC_TX_BAN, code, 'packages/engine/src/planted.ts')).toContain(
      'no-restricted-syntax',
    );
  });

  it.each([
    ['a synchronous callback', 'export const f = (s: any) => s.write(() => 1);'],
    [
      'an async function that is not a transaction callback',
      'export const f = async (): Promise<number> => { await 0; return 1; };',
    ],
    [
      'awaiting outside the transaction, which is the correct shape',
      'export const f = async (s: any) => { const v = await Promise.resolve(1); return s.write(() => v); };',
    ],
  ])('allows %s', async (_label, code) => {
    expect(await rulesFiredFor(SYNC_TX_BAN, code, 'packages/engine/src/planted.ts')).not.toContain(
      'no-restricted-syntax',
    );
  });

  it('explains the consequence, not only the rule', async () => {
    // A message that says "callbacks must be synchronous" teaches nothing. The reason — an empty
    // commit, no isolation, nothing thrown — is what stops somebody working around it.
    const message = await firstMessageFor(
      SYNC_TX_BAN,
      'export const f = (s: any) => s.write(async () => 1);',
      'packages/engine/src/planted.ts',
    );
    expect(message).toMatch(/commits an empty transaction/);
    expect(message).toMatch(/no isolation, no rollback/);
  });
});

describe('only SqliteStore may open a transaction (02 §3.7.2)', { tags: ['slow'] }, () => {
  it.each([
    ['db.transaction', 'export const f = (d: any) => d.transaction(() => 1);'],
    ['orm.transaction', 'export const f = (o: any) => o.transaction(() => 1);'],
    ['a transaction called immediately', 'export const f = (d: any) => d.transaction(() => 1)();'],
  ])('rejects %s', async (_label, code) => {
    expect(
      await rulesFiredFor(RAW_TRANSACTION_BAN, code, 'packages/engine/src/planted.ts'),
    ).toContain('no-restricted-syntax');
  });

  it.each([
    ['store.write', 'export const f = (s: any) => s.write(() => 1);'],
    ['a variable merely named transaction', 'export const transaction = 1;'],
    ['a property read without a call', 'export const f = (d: any) => d.transaction;'],
  ])('allows %s', async (_label, code) => {
    expect(
      await rulesFiredFor(RAW_TRANSACTION_BAN, code, 'packages/engine/src/planted.ts'),
    ).not.toContain('no-restricted-syntax');
  });

  it('names the alternative, so the rule is actionable', async () => {
    const message = await firstMessageFor(
      RAW_TRANSACTION_BAN,
      'export const f = (d: any) => d.transaction(() => 1);',
      'packages/engine/src/planted.ts',
    );
    expect(message).toMatch(/store\.write\(fn\)/);
    expect(message).toMatch(/IMMEDIATE lock/);
  });
});

describe('an afterCommit hook must be synchronous (02 §3.7.2)', { tags: ['slow'] }, () => {
  it.each([
    ['an async arrow', 'export const f = (u: any) => u.afterCommit(async () => { await g(); });'],
    [
      'an async function expression',
      'export const f = (u: any) => u.afterCommit(async function () { await g(); });',
    ],
  ])('rejects %s', async (_label, code) => {
    expect(await rulesFiredFor(AFTER_COMMIT_BAN, code, 'packages/engine/src/a.ts')).toContain(
      'no-restricted-syntax',
    );
  });

  it.each([
    ['a synchronous hook', 'export const f = (u: any) => u.afterCommit(() => g());'],
    ['a hook that is merely named', 'export const afterCommit = 1;'],
    [
      'an async callback to something else',
      'export const f = (u: any) => u.onDone(async () => 1);',
    ],
  ])('allows %s', async (_label, code) => {
    expect(await rulesFiredFor(AFTER_COMMIT_BAN, code, 'packages/engine/src/a.ts')).not.toContain(
      'no-restricted-syntax',
    );
  });

  it('describes the post-commit consequence, not the transaction one', async () => {
    // The reason this is a separate ban: `SYNC_TX_BAN`'s message says the transaction "commits an
    // empty transaction and then does its work outside it", which is the wrong failure mode here
    // and would send the reader looking for a lost write. Found by the M1 exit gate's reviewer,
    // who also found that the `afterCommit` alternative had no test at all.
    const message = await firstMessageFor(
      AFTER_COMMIT_BAN,
      'export const f = (u: any) => u.afterCommit(async () => { await g(); });',
      'packages/engine/src/a.ts',
    );
    expect(message).toMatch(/unhandled rejection/);
    expect(message).toMatch(/after the write has already landed/);
    expect(message).not.toMatch(/empty transaction/);
  });

  it('is not what the transaction ban covers, so neither can be deleted for the other', async () => {
    const byTxBan = await rulesFiredFor(
      SYNC_TX_BAN,
      'export const f = (u: any) => u.afterCommit(async () => { await g(); });',
      'packages/engine/src/a.ts',
    );
    expect(byTxBan).not.toContain('no-restricted-syntax');
  });
});

describe('a property suite may not override fcConfig (11 §3.1.6)', { tags: ['slow'] }, () => {
  it.each([
    ['numRuns', 'export const p = { ...fcConfig(), numRuns: 12 };'],
    ['seed', 'export const p = { ...fcConfig(), seed: 7 };'],
    ['endOnFailure', 'export const p = { ...fcConfig(), endOnFailure: false };'],
    ['a second property after the override', 'export const p = { ...fcConfig(), verbose: true };'],
  ])('rejects an override of %s', async (_label, code) => {
    expect(
      await rulesFiredFor(FC_CONFIG_BAN, code, 'packages/engine/src/a.prop.test.ts'),
    ).toContain('no-restricted-syntax');
  });

  it.each([
    ['the argument form', 'export const p = fcConfig({ numRuns: 12 });'],
    ['a spread with nothing added', 'export const p = { ...fcConfig() };'],
    ['an unrelated key beside the spread', 'export const p = { ...fcConfig(), label: "x" };'],
    ['a spread of something else', 'export const p = { ...other(), numRuns: 12 };'],
    ['numRuns on its own object', 'export const p = { numRuns: 12 };'],
  ])('allows %s', async (_label, code) => {
    expect(
      await rulesFiredFor(FC_CONFIG_BAN, code, 'packages/engine/src/a.prop.test.ts'),
    ).not.toContain('no-restricted-syntax');
  });

  it('names the correct form, because the wrong one looks right', async () => {
    const message = await firstMessageFor(
      FC_CONFIG_BAN,
      'export const p = { ...fcConfig(), numRuns: 12 };',
      'packages/engine/src/a.prop.test.ts',
    );
    expect(message).toMatch(/fcConfig\(\{ numRuns: 12 \}\)/);
    expect(message).toMatch(/still green/);
  });
});

describe('the four no-restricted-syntax classes get exactly their own union', {
  tags: ['slow'],
}, () => {
  /**
   * The assertion that catches the flat-config trap.
   *
   * ESLint flat config **replaces** a rule's options and the last matching block wins, so two
   * independent allowlists produce four path classes that each have to restate their whole union.
   * Both failure directions have happened here: `comvivo/guarded-egress` silently removed core's
   * `Date` ban for most of M0, and the first version of `restrictedSyntaxBlocks` flagged the
   * spike's legitimate `db.transaction()` calls while handing `tx.ts` back the `…Unfiltered` ban it
   * is allowlisted against.
   *
   * Asserted on the **effective options** per path rather than on the config's shape, because the
   * shape is exactly what looks right while the effect is wrong.
   */
  const selectorsFor = async (file: string): Promise<string[]> => {
    const rules = await configuredRulesFor(file);
    const entry = rules['no-restricted-syntax'];
    const options = Array.isArray(entry) ? entry.slice(1) : [];
    return options.map((option) => (option as { selector: string }).selector);
  };

  const fragmentOf = (rules: typeof SYNC_TX_BAN): string =>
    ((rules['no-restricted-syntax'] as { selector: string }[])[1] as { selector: string }).selector;

  it.each([
    // [path, raw-transaction ban applies?, `…Unfiltered` ban applies?]
    ['packages/engine/src/index.ts', true, true],
    ['packages/storage/src/db/open.ts', true, false],
    ['packages/storage/spike/bench.ts', false, true],
    ['packages/storage/src/db/tx.ts', false, false],
    ['packages/storage/spike/vec.spike.test.ts', false, false],
  ])('%s — rawTx: %s, unfiltered: %s', async (file, rawTx, unfiltered) => {
    const selectors = await selectorsFor(file);
    const syncTx = fragmentOf(SYNC_TX_BAN);
    const raw = fragmentOf(RAW_TRANSACTION_BAN);
    const unfilteredSelector = fragmentOf(UNFILTERED_READ_BAN);

    // The synchronous-transaction ban is never exempt — a transaction callback that awaits is
    // wrong in a test, in the spike, and in `tx.ts` itself.
    expect(selectors, `${file} must keep the sync-transaction ban`).toContain(syncTx);
    expect(selectors.includes(raw), `${file} raw-transaction ban`).toBe(rawTx);
    expect(selectors.includes(unfilteredSelector), `${file} …Unfiltered ban`).toBe(unfiltered);
  });

  it('keeps the security selectors on every class', async () => {
    // The M0 defect in its original form: a narrower block quietly dropping a ban it never
    // mentioned.
    const security = fragmentOf(SECURITY_RULES);
    for (const file of [
      'packages/engine/src/index.ts',
      'packages/storage/src/db/open.ts',
      'packages/storage/spike/bench.ts',
      'packages/storage/src/db/tx.ts',
      'packages/storage/spike/vec.spike.test.ts',
    ]) {
      expect(await selectorsFor(file), `${file} must keep the security bans`).toContain(security);
    }
  });
});

describe('the secret-comparison ban (08 §3.7.13)', { tags: ['slow'] }, () => {
  /** Lint a snippet with the plugin rule, and return whether it fired. */
  const fires = async (
    code: string,
    filePath = 'packages/engine/src/planted.ts',
  ): Promise<boolean> => {
    const eslint = new ESLint({
      cwd: REPO,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.{ts,tsx}'],
          languageOptions: { parser: tseslint.parser },
          plugins: { comvivo: comvivoPlugin },
          rules: { 'comvivo/no-secret-equality': 'error' },
        },
      ],
    });
    const [result] = await eslint.lintText(code, { filePath: `${REPO}/${filePath}` });
    const messages = result?.messages ?? [];
    const fatal = messages.find((message) => message.fatal === true);
    if (fatal !== undefined) throw new Error(`the snippet did not parse: ${fatal.message}`);
    return messages.some((message) => message.ruleId === 'comvivo/no-secret-equality');
  };

  it.each([
    [
      'a session token',
      'export const f = (a: string, b: string) => a === b || sessionToken === b;',
    ],
    ['a member expression', 'export const f = (r: {token: string}) => r.token === "x";'],
    ['a digest', 'export const f = (digest: string, other: string) => digest !== other;'],
    ['a MAC', 'export const f = (mac: string, other: string) => mac === other;'],
    ['a pairing code', 'export const f = (pairingCode: string, o: string) => pairingCode === o;'],
    ['a data key', 'export const f = (dataKey: string, o: string) => dataKey === o;'],
    ['a hard-coded secret', 'export const f = (apiSecret: string) => apiSecret === "hunter2";'],
    ['loose equality', 'export const f = (claimCode: string, o: string) => claimCode == o;'],
  ])('fires on %s', async (_label, code) => {
    expect(await fires(code)).toBe(true);
  });

  it.each([
    // The 23 comparisons on this tree that the spec's literal regex would have caught, in shape.
    ['an errno', 'export const f = (e: {code: string}) => e.code === "ENOENT";'],
    ['an exit code', 'export const f = (exitCode: number) => exitCode === 0;'],
    ['a map key', 'export const f = (key: string) => key === "labelId";'],
    [
      'a partition key',
      'export const f = (partitionKey: string, o: string) => partitionKey === o;',
    ],
    ['a key length', 'export const f = (k: Uint8Array) => k.length !== KEY_BYTES;'],
    ['a presence check', 'export const f = (token?: string) => token === undefined;'],
    ['a null check', 'export const f = (token: string | null) => token !== null;'],
    ['an emptiness check', 'export const f = (mac: string) => mac === "";'],
    ['a machine name', 'export const f = (machineId: string, o: string) => machineId === o;'],
  ])('stays quiet on %s', async (_label, code) => {
    expect(await fires(code)).toBe(false);
  });

  it('is wired everywhere except the two directories that implement the comparison', async () => {
    const applies = async (file: string): Promise<boolean> =>
      Object.hasOwn(await configuredRulesFor(file), 'comvivo/no-secret-equality');
    expect(await applies('packages/engine/src/index.ts')).toBe(true);
    expect(await applies('apps/server/src/index.ts')).toBe(true);
    expect(await applies('packages/shared/src/tokens/mac.ts')).toBe(true);
    expect(await applies('scripts/lint/rules.ts')).toBe(true);
    // `08` PSC-8's two crypto directories are where `secureEqual` and `timingSafeEqual` live, so
    // they are the two that cannot be told to use them.
    expect(await applies('packages/shared/src/crypto/equal.ts')).toBe(false);
    expect(await applies('packages/storage/src/crypto/key-service.ts')).toBe(false);
  });

  it('splits names into words, which is what keeps `machine` out of `mac`', () => {
    expect(words('sessionDigest')).toEqual(['session', 'digest']);
    expect(words('HMACKey')).toEqual(['hmac', 'key']);
    expect(words('token_digest')).toEqual(['token', 'digest']);
    expect(namesASecret('machineId')).toBe(false);
    expect(namesASecret('hashtag')).toBe(false);
    expect(namesASecret('code')).toBe(false);
    expect(namesASecret('claimCode')).toBe(true);
    expect(namesASecret('rootDataKey')).toBe(true);
  });
});
