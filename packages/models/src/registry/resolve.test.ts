/**
 * Route resolution (`M2-T2`'s AC: "Resolution follows ADR-014 precedence, with tests per layer;
 * provider/endpoints/keys are host-only (A14). Unmet route requirements fail boot with a doctor
 * hint. `routeInfo()` implemented. The `economy` variant resolves").
 *
 * The per-layer tests are the point. A precedence rule is four statements — env beats DB, DB beats
 * YAML, YAML beats the preset, the preset beats nothing — and a test that only checked the end
 * result would pass with any two of them swapped. `08` PSC-11's host-only exception is the fifth,
 * and the only one where getting it wrong is a security bug rather than a surprise.
 */
import { describe, expect, it } from 'vitest';
import { REGISTRY, withOverrides } from './capabilities.js';
import { localDefaultsFor, PRESETS } from './presets.js';
import { bindingKey, resolveRoutes, resolveRoutesOrThrow } from './resolve.js';

const HAIKU = 'anthropic/claude-haiku-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const OPUS = 'anthropic/claude-opus-5-5';

describe('ADR-014 precedence, one layer at a time', () => {
  it('takes the preset when nothing else says anything', () => {
    const { bindings, problems } = resolveRoutes({ preset: 'best' });
    expect(problems).toEqual([]);
    expect(bindings.find((b) => b.route === 'chat' && b.variant === 'default')?.model).toBe(
      'claude-opus-5-5',
    );
    // And `balanced` is a different answer, so the preset is actually being read rather than a
    // default sitting underneath it.
    const balanced = resolveRoutes({ preset: 'balanced' });
    expect(balanced.byKey.get(bindingKey('chat'))?.model).toBe('claude-sonnet-5-5');
  });

  it('lets the config file beat the preset', () => {
    const { byKey, bindings } = resolveRoutes({ preset: 'best', yamlRoutes: { chat: SONNET } });
    expect(byKey.get(bindingKey('chat'))?.model).toBe('claude-sonnet-5-5');
    // The source is reported from `BRAND`, so a rename stays one edit and the brand guard stays
    // satisfied: the literal lives in `brand.ts` alone.
    expect(bindings).not.toHaveLength(0);
    // Only the slot it named: a YAML override is not a preset replacement.
    expect(byKey.get(bindingKey('consolidate'))?.model).toBe('claude-sonnet-5-5');
    expect(byKey.get(bindingKey('guard'))?.model).toBe('claude-haiku-5-5');
  });

  it('lets a dashboard setting beat the config file', () => {
    const { byKey } = resolveRoutes({
      preset: 'best',
      yamlRoutes: { chat: SONNET },
      dbRoutes: { chat: HAIKU },
    });
    expect(byKey.get(bindingKey('chat'))?.model).toBe('claude-haiku-5-5');
  });

  it('lets the environment beat everything', () => {
    const { byKey } = resolveRoutes({
      preset: 'best',
      yamlRoutes: { chat: SONNET },
      dbRoutes: { chat: HAIKU },
      envRoutes: { chat: OPUS },
    });
    expect(byKey.get(bindingKey('chat'))?.model).toBe('claude-opus-5-5');
  });

  it('resolves nothing for a custom preset with no routes, and says what to set', () => {
    // `custom` means "I will choose every route", so the absence of a row is the host's omission
    // rather than ours. The fix line has to name the key they are missing.
    const { bindings, problems } = resolveRoutes({ preset: 'custom' });
    expect(bindings).toEqual([]);
    expect(problems).toHaveLength(7);
    expect(problems[0]?.kind).toBe('unconfigured');
    expect(problems[0]?.fix).toContain('models.routes.chat');
  });

  it('resolves a custom preset from yaml alone', () => {
    const slots = {
      chat: OPUS,
      chatEconomy: HAIKU,
      route: HAIKU,
      extract: HAIKU,
      declassify: HAIKU,
      guard: HAIKU,
      consolidate: SONNET,
    } as const;
    const { problems, byKey } = resolveRoutes({ preset: 'custom', yamlRoutes: slots });
    expect(problems).toEqual([]);
    expect(byKey.size).toBe(7);
  });
});

describe('01 §14 A14: provider, endpoints and keys are host-only', () => {
  it('refuses a dashboard setting that names an unconfigured provider', () => {
    // The security half of the precedence rule (`08` PSC-11): an admin with a dashboard session is
    // trusted to set quiet hours and not to redirect the instance to a provider of their choosing.
    // A model id names its provider, so accepting an arbitrary id from the DB *is* accepting a
    // provider from the DB.
    const { problems, byKey } = resolveRoutes({
      preset: 'best',
      dbRoutes: { chat: 'openai/gpt-x' },
    });
    const problem = problems.find((p) => p.slot === 'chat');
    expect(problem?.kind).toBe('db_chose_provider');
    expect(problem?.detail).toContain('openai');
    expect(problem?.fix).toContain('host-only');
    // And the route is left unbound rather than silently falling back to the preset: a refused
    // setting the host cannot see is worse than a boot failure they can.
    expect(byKey.get(bindingKey('chat'))).toBeUndefined();
  });

  it('allows a dashboard setting within a provider the host already uses', () => {
    const { problems, byKey } = resolveRoutes({ preset: 'best', dbRoutes: { chat: HAIKU } });
    expect(problems).toEqual([]);
    expect(byKey.get(bindingKey('chat'))?.model).toBe('claude-haiku-5-5');
  });

  it('counts a provider the host configured in yaml or an endpoint as configured', () => {
    // A host who set `models.routes.extract: openai/…` has chosen OpenAI; a dashboard setting may
    // then move another route onto it. So has a host who configured only a `baseUrl` for it.
    const viaYaml = resolveRoutes({
      preset: 'best',
      yamlRoutes: { extract: 'openai/gpt-x' },
      dbRoutes: { chat: 'openai/gpt-y' },
    });
    expect(viaYaml.problems.filter((p) => p.kind === 'db_chose_provider')).toEqual([]);

    const viaBaseUrl = resolveRoutes({
      preset: 'best',
      baseUrls: { openai: 'https://proxy.example' },
      dbRoutes: { chat: 'openai/gpt-y' },
    });
    expect(viaBaseUrl.problems.filter((p) => p.kind === 'db_chose_provider')).toEqual([]);
  });

  it('carries a host-configured baseUrl onto the binding', () => {
    const { byKey } = resolveRoutes({
      preset: 'best',
      baseUrls: { anthropic: 'https://proxy.example' },
    });
    expect(byKey.get(bindingKey('chat'))?.baseUrl).toBe('https://proxy.example');
    // Absent rather than `undefined`-valued, which `exactOptionalPropertyTypes` makes a real
    // distinction and an adapter would otherwise pass to an SDK as an empty override.
    const without = resolveRoutes({ preset: 'best' });
    expect('baseUrl' in (without.byKey.get(bindingKey('chat')) ?? {})).toBe(false);
  });
});

describe('05 §3.5.2 route requirements', () => {
  it('refuses a chat route on a model with no tools', () => {
    const registry = withOverrides({ 'anthropic/claude-haiku-5-5': { tools: 'none' } });
    const { problems } = resolveRoutes({ preset: 'economy', registry });
    const chat = problems.find((p) => p.slot === 'chat');
    expect(chat?.kind).toBe('requirement_unmet');
    expect(chat?.detail).toContain('tools="none"');
  });

  it('refuses the four structured routes on a model with no structured outputs', () => {
    const registry = withOverrides({ 'anthropic/claude-haiku-5-5': { structured: 'none' } });
    const { problems } = resolveRoutes({ preset: 'economy', registry });
    expect(problems.map((p) => p.slot).toSorted()).toEqual([
      'declassify',
      'extract',
      'guard',
      'route',
    ]);
    // `chat`, `chatEconomy` and `consolidate` are *not* in that list, and asserting the complement
    // is what makes the list a statement: the two chat slots are checked against the **tools**
    // requirement (their route is `chat`), and `consolidate` requires nothing at all — it only
    // prefers Batches.
    expect(problems.some((p) => p.slot === 'consolidate')).toBe(false);
  });

  it('allows consolidate without Batches, because it only prefers them', () => {
    const registry = withOverrides({ 'anthropic/claude-sonnet-5-5': { batches: false } });
    const { problems, byKey } = resolveRoutes({ preset: 'best', registry });
    expect(problems).toEqual([]);
    expect(byKey.get(bindingKey('consolidate'))?.features.batches).toBe(false);
  });

  it('refuses a model the registry has never heard of', () => {
    const { problems } = resolveRoutes({ preset: 'best', yamlRoutes: { chat: 'anthropic/nope' } });
    const chat = problems.find((p) => p.slot === 'chat');
    expect(chat?.kind).toBe('unknown_model');
    // There is deliberately no `anthropic/*` family row: we know Anthropic's models exactly, and
    // inventing limits for one we have not checked is how a reply gets truncated at an
    // unpredictable length.
    expect(chat?.fix).toContain('registryOverrides');
  });

  it('accepts an unknown model in a family that has a wildcard', () => {
    const { problems, byKey } = resolveRoutes({
      preset: 'custom',
      yamlRoutes: {
        chat: 'local/qwen3-32b',
        chatEconomy: 'local/qwen3-32b',
        route: 'local/qwen3-32b',
        extract: 'local/qwen3-32b',
        declassify: 'local/qwen3-32b',
        guard: 'local/qwen3-32b',
        consolidate: 'local/qwen3-32b',
      },
    });
    // `local/*` reports `tools: 'probe'` and `structured: 'probe'` — "deferred", not "absent" — so
    // the requirements pass here and `M2-T12`'s ladder decides the truth at run time. Reading
    // §3.5.2's table literally made the `local` preset fail boot on every machine, which is how
    // this test found the gap.
    expect(problems).toEqual([]);
    expect(byKey.get(bindingKey('chat'))?.capabilityKey).toBe('local/*');
  });

  it('refuses a default effort outside the model’s own effort list', () => {
    const registry = withOverrides({
      'anthropic/claude-haiku-5-5': { effort: ['low', 'medium'], defaultEffort: 'max' },
    });
    const { problems } = resolveRoutes({ preset: 'economy', registry });
    expect(problems.some((p) => p.kind === 'effort_unsupported')).toBe(true);
  });
});

describe('the economy variant', () => {
  it('resolves as its own binding, validated like any other', () => {
    const { byKey } = resolveRoutes({ preset: 'best' });
    expect(byKey.get(bindingKey('chat', 'default'))?.model).toBe('claude-opus-5-5');
    expect(byKey.get(bindingKey('chat', 'economy'))?.model).toBe('claude-haiku-5-5');
    // A step-down onto an unvalidated model is a step-down into a failure at the moment a group is
    // already over budget, which is why it is resolved at boot and not when the guard fires.
    expect(byKey.get(bindingKey('chat', 'economy'))?.slot).toBe('chatEconomy');
  });

  it('exists for chat alone', () => {
    const { bindings } = resolveRoutes({ preset: 'best' });
    expect(bindings.filter((b) => b.variant === 'economy').map((b) => b.route)).toEqual(['chat']);
    expect(bindings).toHaveLength(7);
  });
});

describe('the local preset', () => {
  it('substitutes the configured model into every slot', () => {
    const { problems, byKey } = resolveRoutes({
      preset: 'local',
      local: { model: 'qwen3-32b' },
    });
    expect(problems).toEqual([]);
    expect(byKey.get(bindingKey('chat'))?.model).toBe('qwen3-32b');
    // `smallModel` falls back to `model`, which is `05` §3.5.2's "same, or smallModel if set".
    expect(byKey.get(bindingKey('guard'))?.model).toBe('qwen3-32b');
  });

  it('uses smallModel for the small routes when it is set', () => {
    const { byKey } = resolveRoutes({
      preset: 'local',
      local: { model: 'qwen3-32b', smallModel: 'qwen3-4b' },
    });
    expect(byKey.get(bindingKey('chat'))?.model).toBe('qwen3-32b');
    expect(byKey.get(bindingKey('guard'))?.model).toBe('qwen3-4b');
    expect(byKey.get(bindingKey('consolidate'))?.model).toBe('qwen3-32b');
  });

  it('says what is missing rather than routing to a literal placeholder', () => {
    // The failure this prevents: a route resolving to the text `local/${models.local.model}` and
    // failing at the provider with a model-not-found, three layers from the missing setting.
    const { problems } = resolveRoutes({ preset: 'local', local: { model: null } });
    expect(problems).toHaveLength(7);
    expect(problems[0]?.kind).toBe('unconfigured');
    expect(problems[0]?.detail).toContain('models.local.model');
  });
});

describe('resolveRoutesOrThrow', () => {
  it('returns the resolution when every route is usable', () => {
    expect(resolveRoutesOrThrow({ preset: 'balanced' }).bindings).toHaveLength(7);
  });

  it('names every problem at once, not the first', () => {
    // A host with two misconfigured routes should see both: fixing one at a time across two
    // restarts is how somebody gives up and switches preset.
    let message = '';
    try {
      resolveRoutesOrThrow({ preset: 'custom', yamlRoutes: { chat: OPUS } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('6 model route(s) cannot be used');
    for (const slot of ['route', 'extract', 'declassify', 'guard', 'consolidate']) {
      expect(message).toContain(slot);
    }
    // Each line carries its fix, because a startup log is where a host reads this.
    expect(message).toContain('→');
  });
});

describe('the binding a route resolves to', () => {
  it('carries the capability set, the registry key and the per-attempt limits', () => {
    const { byKey } = resolveRoutes({ preset: 'best', attemptTimeoutMs: 30_000, maxRetries: 1 });
    const chat = byKey.get(bindingKey('chat'));
    expect(chat?.provider).toBe('anthropic');
    expect(chat?.capabilityKey).toBe(OPUS);
    expect(chat?.effortDefault).toBe('medium');
    expect(chat?.maxOutputTokens).toBe(128_000);
    expect(chat?.attemptTimeoutMs).toBe(30_000);
    expect(chat?.maxRetries).toBe(1);
  });

  it('publishes only the feature subset core’s routeInfo exposes', () => {
    const { byKey } = resolveRoutes({ preset: 'best' });
    const features = byKey.get(bindingKey('chat'))?.features;
    // A port that exposed everything would invite the engine to make provider-shaped decisions, so
    // the pricing key, the prefill flag and the thinking mode stay inside this package.
    expect(features).toBeDefined();
    expect(Object.keys(features ?? {}).toSorted()).toEqual([
      'batches',
      'contextWindow',
      'countTokens',
      'defaultEffort',
      'effort',
      'maxBreakpoints',
      'maxOutput',
      'midConversationSystem',
      'minCacheableTokens',
      'parallelTools',
      'pdf',
      'perMessageEffort',
      'promptCaching',
      'structured',
      'tools',
      'vision',
    ]);
  });

  it('reports a developer-role system channel as supported', () => {
    // OpenAI's `developer` role is the same idea under another name, so `midConversationSystem` is
    // `true` in the feature set and the *how* stays in the adapter.
    const { byKey } = resolveRoutes({
      preset: 'custom',
      yamlRoutes: {
        chat: 'openai/gpt-x',
        chatEconomy: 'openai/gpt-x',
        route: 'openai/gpt-x',
        extract: 'openai/gpt-x',
        declassify: 'openai/gpt-x',
        guard: 'openai/gpt-x',
        consolidate: 'openai/gpt-x',
      },
    });
    expect(byKey.get(bindingKey('chat'))?.features.midConversationSystem).toBe(true);
    expect(byKey.get(bindingKey('chat'))?.capabilities.midConversationSystem).toBe(
      'developer_role',
    );
  });
});

describe('the shipped data files', () => {
  it('names a model the registry knows in every preset slot', () => {
    // The check that keeps the two files honest: a preset naming a model with no capability row
    // would fail at boot for every host who chose that preset, and nothing else compares them.
    for (const [name, row] of Object.entries(PRESETS.presets)) {
      for (const [slot, id] of Object.entries(row)) {
        const known =
          REGISTRY.models[id] !== undefined || id.startsWith('local/') || id.includes('${');
        expect(known, `${name}.${slot} = ${id}`).toBe(true);
      }
    }
  });

  it('declares a default effort each model actually supports', () => {
    for (const [id, capabilities] of Object.entries(REGISTRY.models)) {
      expect(capabilities.effort, id).toContain(capabilities.defaultEffort);
    }
  });

  it('keeps the Anthropic rows at the values the live API reports', () => {
    // Pinned because these are the numbers a wrong recollection gets wrong, and the ones whose
    // being wrong is most expensive. Verified against platform.claude.com/docs on 2026-11-12;
    // re-verify rather than "fix" this test if the API moves.
    const opus = REGISTRY.models[OPUS];
    expect(opus?.contextWindow).toBe(1_000_000);
    expect(opus?.maxOutput).toBe(128_000);
    expect(opus?.defaultEffort).toBe('medium');
    expect(opus?.thinking).toBe('adaptive_always');
    expect(opus?.serverFallback).toBe('default');

    const sonnet = REGISTRY.models[SONNET];
    expect(sonnet?.defaultEffort).toBe('high');
    expect(sonnet?.thinking).toBe('adaptive_no_disable');

    const haiku = REGISTRY.models[HAIKU];
    // Haiku 4.5 was 200K/64K; 5.5 is 1M/128K. A registry carrying the old numbers would leave most
    // of the window unused on the route that runs most often.
    expect(haiku?.contextWindow).toBe(1_000_000);
    expect(haiku?.maxOutput).toBe(128_000);
    expect(haiku?.defaultEffort).toBe('medium');

    for (const model of [opus, sonnet, haiku]) {
      expect(model?.effort).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(model?.minCacheableTokens).toBe(512);
      expect(model?.maxBreakpoints).toBe(4);
      expect(model?.midConversationSystem).toBe(true);
      expect(model?.perMessageEffort).toBe(true);
      expect(model?.prefill).toBe(false);
    }
  });
});

describe('the interim Local defaults (05 §3.5.6; M2-T12)', () => {
  it('ships a tier for every memory size 05 §3.5.6 names', () => {
    expect(PRESETS.localDefaults?.tiers.map((tier) => tier.minHostMemoryGb)).toEqual([
      32, 16, 12, 8,
    ]);
  });

  it('picks the highest tier a machine qualifies for', () => {
    expect(localDefaultsFor(64)?.model).toBe('qwen3.8:27b');
    expect(localDefaultsFor(32)?.model).toBe('qwen3.8:27b');
    expect(localDefaultsFor(24)?.model).toBe('gpt-oss:20b');
    expect(localDefaultsFor(16)?.model).toBe('gpt-oss:20b');
    expect(localDefaultsFor(12)?.model).toBe('gemma4:12b');
    expect(localDefaultsFor(8)?.model).toBe('gemma4:e4b');
  });

  it('gives a 4 GB host the smallest tier rather than nothing', () => {
    // The wizard's job on a machine too small for any of these is to say so with a concrete model
    // name and a size, which needs the comparison to be visible — `05` §3.5.6's own advice there is
    // a cloud preset or a separate GPU host.
    const tiny = localDefaultsFor(4);
    expect(tiny?.model).toBe('gemma4:e4b');
    expect(tiny?.note).toContain('Raspberry Pi');
  });

  it('names a download size for every tier, so the wizard can warn before an 18 GB pull', () => {
    for (const tier of PRESETS.localDefaults?.tiers ?? []) {
      expect(tier.approxDownloadGb, tier.model).toBeGreaterThan(0);
      expect(tier.note, tier.model).not.toBe('');
    }
  });

  it('keeps one small model across the tiers', () => {
    // The small routes are short, frequent and latency-sensitive, so the cheapest capable model
    // wins at every size — and a host who upgrades their chat model should not have their guard
    // route change underneath them.
    const small = new Set((PRESETS.localDefaults?.tiers ?? []).map((tier) => tier.smallModel));
    expect(small.size).toBeLessThanOrEqual(2);
  });

  it('returns nothing for a table that ships no defaults', () => {
    expect(localDefaultsFor(32, { version: 'x', presets: PRESETS.presets })).toBeUndefined();
  });
});
