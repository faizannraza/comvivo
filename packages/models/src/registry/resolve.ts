/**
 * Route resolution (`05` §3.5.2, ADR-014, `01` §14 A14; `M2-T2`).
 *
 * One function answers "which model serves this route, and may it?" — and it answers at **boot**,
 * for every route at once, because `05` §3.5.2 requires an unmet route requirement to fail with a
 * `doctor` hint rather than at the first turn. A host whose `guard` route points at a model with no
 * structured outputs should learn that while reading the startup log, not when the disclosure guard
 * is first asked to inspect a draft.
 *
 * ## Precedence, and the asymmetry that matters
 *
 * ADR-014: `env > DB settings > comvivo.yaml > preset > defaults`. **Except** for `01` §14 A14's
 * host-only keys — provider selection, endpoints and API keys — which read from env or YAML only
 * and ignore the DB entirely. The reason is a trust asymmetry, not tidiness: an admin with a
 * dashboard session is trusted to set quiet hours and **not** to redirect the instance to a
 * provider of their choosing (`08` PSC-11). A naive precedence rule that let DB settings win
 * everywhere would make a stolen admin session an egress decision.
 *
 * So `dbRoutes` can change *which model* a route uses within a provider the host already
 * configured, and cannot introduce a provider, a `baseUrl` or a key. That is narrower than "DB
 * settings lose for host-only keys" sounds, and it is the useful reading: a model id names its
 * provider (`anthropic/claude-haiku-5-5`), so accepting an arbitrary model id from the DB *would*
 * be accepting a provider from the DB.
 *
 * ## Nothing here reads the environment
 *
 * Every source arrives as an argument. `@comvivo/models` is allowed `process.env`, but a resolver
 * that read it could not be tested at the precedence boundaries — which is exactly where ADR-014
 * is worth testing, and where M0's config loader found its own bugs.
 */
import type { Effort, ModelFeatureSet, ModelRoute, RouteVariant } from '@comvivo/core';
import { BRAND } from '@comvivo/shared';
import {
  type CapabilityRegistry,
  lookupCapabilities,
  type ModelCapabilities,
  REGISTRY,
  type RegistryOverrides,
  toFeatureSet,
  withOverrides,
} from './capabilities.js';
import {
  type LocalModels,
  PRESETS,
  type PresetName,
  ROUTE_SLOTS,
  type RouteSlot,
  slotFor,
  substituteLocal,
} from './presets.js';

/** Every route `05` §2.1 defines, in the order a startup report prints them. */
export const MODEL_ROUTES: readonly ModelRoute[] = [
  'chat',
  'route',
  'extract',
  'declassify',
  'guard',
  'consolidate',
];

/**
 * What a resolved route carries into the gateway (`05` §3.5.1).
 *
 * `provider` is derived from the model id rather than configured separately: one string naming both
 * is one thing to get wrong instead of two, and it makes "the DB may not choose a provider" a
 * statement about model ids, which is what the check can actually enforce.
 */
export interface RouteBinding {
  readonly route: ModelRoute;
  readonly variant: RouteVariant;
  readonly slot: RouteSlot;
  readonly provider: string;
  /** The provider's own model id, with the `<provider>/` prefix removed. */
  readonly model: string;
  /** The registry key this resolved through — the exact id, or the `<provider>/*` family. */
  readonly capabilityKey: string;
  /**
   * The price-table row to charge this route against.
   *
   * `capabilities.priceKey` when the registry sets one, else `<provider>/<model>` — which is what
   * `lookupPrice` would have been given anyway, so the normal case is unchanged. The indirection
   * matters for a host who pins a dated snapshot through `models.registryOverrides`: the registry
   * answers through the provider family, the price table has no row for the dated id, and without
   * this the spend would be estimated at the fallback's rates (see `priceKey`'s doc comment).
   */
  readonly priceId: string;
  readonly capabilities: ModelCapabilities;
  readonly features: ModelFeatureSet;
  readonly effortDefault: Effort;
  readonly maxOutputTokens: number;
  readonly attemptTimeoutMs: number;
  readonly maxRetries: number;
  /** Host-only (`01` §14 A14): from env or YAML, never from the DB. */
  readonly baseUrl?: string;
}

/** Why a route could not be used. Each one is a line in the boot failure and a `doctor` check. */
export interface RouteProblem {
  readonly route: ModelRoute;
  readonly variant: RouteVariant;
  readonly slot: RouteSlot;
  readonly kind:
    | 'unconfigured'
    | 'unknown_model'
    | 'requirement_unmet'
    | 'effort_unsupported'
    | 'db_chose_provider';
  readonly detail: string;
  /** What a host should do, in the words `doctor` prints. */
  readonly fix: string;
}

/**
 * The inputs, one per ADR-014 source.
 *
 * `envRoutes` and `yamlRoutes` may name any model; `dbRoutes` may not introduce a provider. The
 * types are the same because the *restriction* is a check with a message, not a shape — a host
 * reading a `doctor` line that says "the dashboard cannot choose a provider" learns the rule, where
 * a type error in the DB layer would just look like a bug.
 */
export interface ResolveInput {
  readonly preset: PresetName;
  readonly envRoutes?: Readonly<Partial<Record<RouteSlot, string>>>;
  readonly dbRoutes?: Readonly<Partial<Record<RouteSlot, string>>>;
  readonly yamlRoutes?: Readonly<Partial<Record<RouteSlot, string>>>;
  readonly local?: LocalModels;
  readonly registryOverrides?: RegistryOverrides;
  readonly registry?: CapabilityRegistry;
  /** Host-only, per provider: `{ anthropic: 'https://proxy.example' }`. */
  readonly baseUrls?: Readonly<Record<string, string>>;
  readonly attemptTimeoutMs?: number;
  readonly maxRetries?: number;
}

export interface Resolution {
  readonly bindings: readonly RouteBinding[];
  readonly problems: readonly RouteProblem[];
  /** Every binding by `route:variant`, for `routeInfo`. */
  readonly byKey: ReadonlyMap<string, RouteBinding>;
}

/** `05` §3.5.1's defaults. A per-attempt timeout, which the turn's own deadline still bounds. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * `05` §3.5.2's route requirements.
 *
 * A total mapping over the routes, so adding one is a compile error here rather than a route that
 * is silently unvalidated. `consolidate` "prefers `batches`, else synchronous" — a preference, not
 * a requirement, so it has no entry and `prefersBatches` records it separately.
 */
const ROUTE_REQUIREMENT: Readonly<
  Record<ModelRoute, (c: ModelCapabilities) => string | undefined>
> = {
  // `05` §3.5.2's table says `tools ∈ {native_strict, native, envelope}`, and taken literally that
  // makes the **`local` preset unusable on every machine**: the `local/*` family reports
  // `tools: 'probe'`, because what a local server supports is not knowable until `M2-T12`'s ladder
  // asks it. `probe` therefore means "deferred", not "absent" — the requirement is enforced after
  // the probe, where the failure is actionable ("your server supports no tool mode we can use")
  // rather than at boot, where it would be wrong. Found by `M2-T2`'s own test for the local preset;
  // §3.5.2 amended in the same commit.
  chat: (c) =>
    ['native_strict', 'native', 'envelope', 'probe'].includes(c.tools)
      ? undefined
      : `the chat route needs tool support; this model reports tools="${c.tools}"`,
  route: (c) => requiresStructured(c, 'route'),
  extract: (c) => requiresStructured(c, 'extract'),
  declassify: (c) => requiresStructured(c, 'declassify'),
  guard: (c) => requiresStructured(c, 'guard'),
  consolidate: () => undefined,
};

function requiresStructured(c: ModelCapabilities, route: string): string | undefined {
  return c.structured === 'none'
    ? `the ${route} route needs structured outputs; this model reports structured="none"`
    : undefined;
}

/** Routes that would rather have Batches (`05` §3.5.2), and work without it. */
export const PREFERS_BATCHES: readonly ModelRoute[] = ['consolidate'];

/**
 * The model id a slot resolves to, following ADR-014's precedence.
 *
 * Returns the id and **which source won**, because the source is what makes a `doctor` line useful:
 * "chat = anthropic/claude-opus-5-5 (preset best)" and "chat = … (dashboard setting)" send a host
 * to different places when it is wrong.
 */
function pickModel(
  slot: RouteSlot,
  input: ResolveInput,
): { readonly id: string | undefined; readonly source: string } {
  const env = input.envRoutes?.[slot];
  if (env !== undefined) return { id: env, source: 'environment' };
  const db = input.dbRoutes?.[slot];
  if (db !== undefined) return { id: db, source: 'dashboard setting' };
  const yaml = input.yamlRoutes?.[slot];
  if (yaml !== undefined) return { id: yaml, source: BRAND.configFileName };
  if (input.preset === 'custom') return { id: undefined, source: 'preset custom' };
  const fromPreset = PRESETS.presets[input.preset][slot];
  const substituted =
    input.preset === 'local'
      ? substituteLocal(fromPreset, input.local ?? { model: null })
      : fromPreset;
  return { id: substituted, source: `preset ${input.preset}` };
}

/** Split `anthropic/claude-haiku-5-5` into its provider and the provider's own id. */
function splitModelId(id: string): { readonly provider: string; readonly model: string } {
  const slash = id.indexOf('/');
  if (slash <= 0) return { provider: '', model: id };
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

/**
 * Which providers a host has configured, for the host-only check.
 *
 * Derived from the sources the DB cannot write: env, YAML and the preset. A DB setting naming a
 * provider outside that set is refused — that is `01` §14 A14 enforced where it can be, rather than
 * restated in a comment.
 */
function hostConfiguredProviders(input: ResolveInput): ReadonlySet<string> {
  const providers = new Set<string>();
  for (const slot of ROUTE_SLOTS) {
    for (const id of [input.envRoutes?.[slot], input.yamlRoutes?.[slot]]) {
      if (id !== undefined) providers.add(splitModelId(id).provider);
    }
    if (input.preset !== 'custom') {
      const fromPreset = PRESETS.presets[input.preset][slot];
      providers.add(splitModelId(fromPreset).provider);
    }
  }
  for (const provider of Object.keys(input.baseUrls ?? {})) providers.add(provider);
  return providers;
}

/** Resolve one slot into a binding, or into the problem that stopped it. */
function resolveSlot(
  route: ModelRoute,
  variant: RouteVariant,
  input: ResolveInput,
  registry: CapabilityRegistry,
  allowedProviders: ReadonlySet<string>,
): { readonly binding?: RouteBinding; readonly problem?: RouteProblem } {
  const slot = slotFor(route, variant);
  const { id, source } = pickModel(slot, input);
  const base = { route, variant, slot } as const;

  if (id === undefined) {
    return {
      problem: {
        ...base,
        kind: 'unconfigured',
        detail:
          input.preset === 'local'
            ? 'the local preset needs models.local.model (and models.local.smallModel for the small routes)'
            : `no model is configured for ${slot} and preset "${input.preset}" provides none`,
        // The two branches test **different** things, deliberately: only `custom` and `local` can
        // reach here, and each needs a different instruction. A single condition would send a
        // `custom` host to `models.local.model`.
        fix:
          input.preset === 'local'
            ? `Set models.local.model in ${BRAND.configFileName} to the model your local server serves.`
            : `Set models.routes.${slot} in ${BRAND.configFileName}, or choose a preset.`,
      },
    };
  }

  const { provider, model } = splitModelId(id);
  if (source === 'dashboard setting' && !allowedProviders.has(provider)) {
    return {
      problem: {
        ...base,
        kind: 'db_chose_provider',
        detail: `a dashboard setting named provider "${provider}", which the host has not configured`,
        fix:
          'Provider selection, endpoints and API keys are host-only (01 §14 A14): set them in ' +
          `${BRAND.configFileName} or the environment. A dashboard setting may change the model ` +
          'within a provider the host already uses.',
      },
    };
  }

  const capabilities = lookupCapabilities(id, registry);
  if (capabilities === undefined) {
    return {
      problem: {
        ...base,
        kind: 'unknown_model',
        detail: `"${id}" (from ${source}) is in neither the capability registry nor a known provider family`,
        fix:
          'Use a model the registry knows, or describe yours in models.registryOverrides — ' +
          'routing to a model whose limits are unknown is how a reply gets truncated at an ' +
          'unpredictable length.',
      },
    };
  }

  const unmet = ROUTE_REQUIREMENT[route](capabilities);
  if (unmet !== undefined) {
    return {
      problem: {
        ...base,
        kind: 'requirement_unmet',
        detail: `${unmet} ("${id}" from ${source})`,
        fix: `Point the ${route} route at a model that supports it, or choose a different preset.`,
      },
    };
  }

  if (!capabilities.effort.includes(capabilities.defaultEffort)) {
    return {
      problem: {
        ...base,
        kind: 'effort_unsupported',
        detail: `"${id}" declares defaultEffort "${capabilities.defaultEffort}", which is not in its own effort list`,
        fix: 'Fix the registry entry or the override: a default outside the supported set is a 400 on every call.',
      },
    };
  }

  const exact = registry.models[id] !== undefined;
  const baseUrl = input.baseUrls?.[provider];
  return {
    binding: {
      ...base,
      provider,
      model,
      capabilityKey: exact ? id : `${provider}/*`,
      priceId: capabilities.priceKey ?? `${provider}/${model}`,
      capabilities,
      features: toFeatureSet(capabilities),
      effortDefault: capabilities.defaultEffort,
      maxOutputTokens: capabilities.maxOutput,
      attemptTimeoutMs: input.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    },
  };
}

/** `route:variant`, the key `routeInfo` looks up. */
export function bindingKey(route: ModelRoute, variant: RouteVariant = 'default'): string {
  return `${route}:${variant}`;
}

/**
 * Resolve every route, collecting problems rather than throwing at the first.
 *
 * All of them, because a host with two misconfigured routes should see both: fixing one at a time
 * across two restarts is how somebody gives up and switches preset. `05` §3.5.2's boot step turns a
 * non-empty `problems` into a failure; `doctor` prints the same list without failing.
 */
export function resolveRoutes(input: ResolveInput): Resolution {
  const registry =
    input.registryOverrides === undefined
      ? (input.registry ?? REGISTRY)
      : withOverrides(input.registryOverrides, input.registry ?? REGISTRY);
  const allowedProviders = hostConfiguredProviders(input);

  const bindings: RouteBinding[] = [];
  const problems: RouteProblem[] = [];
  const byKey = new Map<string, RouteBinding>();

  for (const route of MODEL_ROUTES) {
    // `chat` resolves twice: the cost guard's `economy` variant is a binding of its own, validated
    // against the same requirements. A step-down onto an unvalidated model is a step-down into a
    // failure at the moment a group is already over budget.
    const variants: RouteVariant[] = route === 'chat' ? ['default', 'economy'] : ['default'];
    for (const variant of variants) {
      const { binding, problem } = resolveSlot(route, variant, input, registry, allowedProviders);
      if (problem !== undefined) problems.push(problem);
      if (binding !== undefined) {
        bindings.push(binding);
        byKey.set(bindingKey(route, variant), binding);
      }
    }
  }

  return { bindings, problems, byKey };
}

/**
 * `05` §3.5.2's boot validation: the resolution, or a failure naming every problem.
 *
 * Throws a plain `Error` rather than a `StorageError`-style code: this is configuration, the caller
 * is `apps/server`'s boot, and `12` §3.8.1 maps a configuration failure to exit code 78. The
 * message is the whole list because that is what a host needs in a startup log.
 */
export function resolveRoutesOrThrow(input: ResolveInput): Resolution {
  const resolution = resolveRoutes(input);
  if (resolution.problems.length === 0) return resolution;
  const lines = resolution.problems.map(
    (problem) => `  ${problem.slot}: ${problem.detail}\n    → ${problem.fix}`,
  );
  throw new Error(
    `${String(resolution.problems.length)} model route(s) cannot be used:\n${lines.join('\n')}`,
  );
}

/** Whether this route would rather have Batches than send one request per item. */
export function prefersBatches(route: ModelRoute): boolean {
  return PREFERS_BATCHES.includes(route);
}
