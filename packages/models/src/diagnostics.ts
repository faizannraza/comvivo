/**
 * The model layer's `doctor` checks (`05` §3.5; `09` §3.11.6; `M2-T18`).
 *
 * ## What this is, and where it runs
 *
 * `09` §3.11.6 has **one** check registry, in `apps/server/src/diagnostics/checks/`, which the CLI
 * imports for its offline subset and the server exposes at `/control/v1/doctor`. That registry
 * lands at `M9-T35`. This file is the model layer's contribution to it, in that registry's shape —
 * the same pattern every other M2 deliverable follows: the function exists now, typed to the
 * contract the consumer will have, so wiring it is an import rather than a translation.
 *
 * ## The one thing these checks are for
 *
 * A host whose bot is not working needs to know **which** of six things is wrong, and what to type.
 * Not "the model layer is unhealthy". So every check returns a `fix` with a literal command where
 * one exists, and the checks are separate rather than one "models" check — `09` §3.11.6's output
 * prints one line per check, and "✖ Models" would tell a host nothing they did not already know.
 *
 * ## Offline by default
 *
 * Five of the six run with no network at all: price coverage, estimator calibration, the local
 * ladder and the local context verdict all read what is already on disk or in a cached probe. Only
 * `models.key` and `models.betas` need a provider, and both are **skipped** rather than failed when
 * there is no key — a host running Local-only has no key by design, and reporting that as a failure
 * would make `doctor` red for a configuration that is correct.
 */

import { BRAND } from '@comvivo/shared';
import type { EstimatorCalibration } from './anthropic/count.js';
import { contextAdviceFor, toolFlagAdviceFor } from './openai-compatible/hints.js';
import { LEVEL_BEHAVIOUR, levelSummary } from './openai-compatible/ladder.js';
import type { LocalProbeResult } from './openai-compatible/probe.js';
import { isProbeFresh, PROBE_TTL_HOURS } from './openai-compatible/probe.js';
import { lookupPrice, PRICES, type PriceTable } from './pricing/index.js';
import type { RouteBinding } from './registry/resolve.js';

/** `09` §3.11.6's statuses. */
export type CheckStatus = 'pass' | 'info' | 'warn' | 'fail' | 'skip';

/** `09` §3.11.6's remediation block: what to read, and what to type. */
export interface CheckFix {
  readonly text: string;
  /** A literal command a host can paste. Omitted when there is nothing to run. */
  readonly command?: string;
  readonly docs?: string;
}

/** One check's outcome, in `09` §3.11.6's shape. */
export interface CheckResult {
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: CheckFix;
  /** True when `doctor --fix` can repair it without the host deciding anything. */
  readonly fixable?: boolean;
}

/** One check. `09` §3.11.6's registry entry, minus the `run` the registry supplies context to. */
export interface ModelCheck {
  readonly id: string;
  readonly title: string;
  readonly run: (context: DiagnosticsContext) => CheckResult;
}

/**
 * What the checks read.
 *
 * Deliberately all **values**, no ports: every one of these is something the composition root
 * already holds by the time `doctor` runs, and a check that fetched its own inputs would be a
 * check that behaves differently in `doctor` than at boot. The two live probes are passed in as
 * already-collected results for the same reason — `M9-T35` owns when they run, this file owns what
 * their results mean.
 */
export interface DiagnosticsContext {
  /** Every resolved route binding (`M2-T2`). */
  readonly bindings: readonly RouteBinding[];
  /** The price table in force today. */
  readonly prices?: PriceTable;
  /**
   * Whether each provider's key was accepted, when it was checked.
   *
   * `undefined` for a provider nobody asked about — which is the Local-only case, and why the key
   * check skips rather than fails.
   */
  readonly keyChecks?: Readonly<Record<string, KeyVerdict>>;
  /** Betas the probe found available, and the ones it asked for (`M2-T8`). */
  readonly betas?: { readonly requested: readonly string[]; readonly available: readonly string[] };
  /** The cached local-server probe (`M2-T12`), when a local model is configured. */
  readonly localProbe?: LocalProbeResult;
  /** The estimator calibration from `doctor --models` (`M2-T8`), by model. */
  readonly calibrations?: readonly CalibrationReading[];
  /** `Date.now()` at the time `doctor` ran, for probe freshness. */
  readonly nowMs: number;
}

/** Whether a provider accepted its key. */
export type KeyVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'rejected'; readonly envVar: string }
  | { readonly kind: 'missing'; readonly envVar: string }
  | { readonly kind: 'unreachable'; readonly detail: string };

/**
 * What this check reads off a calibration.
 *
 * A `Pick` of `M2-T8`'s own `EstimatorCalibration` rather than a second interface: `doctor
 * --models` calls `calibrateEstimator` and hands the result straight here, so declaring a parallel
 * shape would be two definitions of one thing waiting to disagree. Narrowed to the two fields this
 * check actually reads, so a caller can pass the full calibration or the two numbers.
 */
export type CalibrationReading = Pick<EstimatorCalibration, 'model' | 'charsPerToken'>;

/**
 * The window the local estimator is trusted in.
 *
 * The estimator decides whether a prompt fits before a turn runs, so a ratio that is **too high**
 * under-counts tokens and lets an over-long prompt through to be truncated by the provider — the
 * expensive direction. Too low over-counts and trims context that would have fitted, which is the
 * safe direction but still degrades answers. Real ratios sit near 3.5–4 for English and lower for
 * CJK, so the window is generous on the low side and tight on the high.
 */
export const ESTIMATOR_MIN_CHARS_PER_TOKEN = 1.5;
export const ESTIMATOR_MAX_CHARS_PER_TOKEN = 6;

/** Providers whose key is checked. A local server needs none. */
const KEYED_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'google'];

/** The env var each provider's key comes from, for the `fix` command. */
const KEY_ENV_VARS: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
};

/**
 * `models.key` — does each configured provider accept its key?
 *
 * **Skips** when no provider needed one, which is the Local-only and Local-preset case. A host who
 * deliberately runs no cloud provider should not see a red line about a key they chose not to have.
 */
export const keyCheck: ModelCheck = {
  id: 'models.key',
  title: 'Provider API keys',
  run: (context) => {
    const providers = [
      ...new Set(
        context.bindings
          .map((binding) => binding.provider)
          .filter((p) => KEYED_PROVIDERS.includes(p)),
      ),
    ].toSorted();
    if (providers.length === 0) {
      return { status: 'skip', detail: 'no cloud provider is configured, so no key is needed' };
    }

    const verdicts = context.keyChecks;
    if (verdicts === undefined) {
      return {
        status: 'skip',
        detail: `${providers.join(', ')} configured; keys were not checked (offline run)`,
        fix: {
          text: 'Run doctor against a running instance to check the keys.',
          command: `${BRAND.cliName} doctor --models`,
        },
      };
    }

    const problems = providers.flatMap((provider) => {
      const verdict = verdicts[provider];
      if (verdict === undefined || verdict.kind === 'ok') return [];
      return [{ provider, verdict }];
    });
    if (problems.length === 0) {
      return { status: 'pass', detail: `${providers.join(', ')} accepted the configured key` };
    }

    // Narrowed to the three failing kinds by the filter above, which is why the switch below has
    // no `ok` arm — TypeScript refuses one, and an unreachable arm is a branch nobody tests.
    const first = problems[0];
    if (first === undefined) return { status: 'pass', detail: 'keys accepted' };
    const envVar = KEY_ENV_VARS[first.provider] ?? 'the provider key';
    switch (first.verdict.kind) {
      case 'rejected':
        return {
          status: 'fail',
          detail: `${first.provider} rejected the key in ${envVar}`,
          fix: {
            // `09` §3.11.6's own copy for this row, which is already in the host's voice.
            text: `${first.provider} rejected the key in ${envVar}. Create a new key and set it.`,
            command: `${BRAND.cliName} secrets set ${envVar}`,
          },
        };
      case 'missing':
        return {
          status: 'fail',
          detail: `${envVar} is not set, and ${first.provider} is configured`,
          fix: { text: `${envVar} isn't set.`, command: `${BRAND.cliName} secrets set ${envVar}` },
        };
      case 'unreachable':
        return {
          status: 'warn',
          detail: `${first.provider} could not be reached: ${first.verdict.detail}`,
          fix: {
            text: 'Check this machine’s internet connection. The key itself may be fine.',
          },
        };
    }
  },
};

/**
 * `models.betas` — which optional betas were available?
 *
 * A **warn**, never a fail. `05` §3.5.3.9 is explicit that an unavailable beta is disabled for the
 * process and the adapter keeps working: the refusal fallback not being available costs a safety
 * net, not the product. Failing here would stop a host whose account simply has not been enrolled.
 */
export const betasCheck: ModelCheck = {
  id: 'models.betas',
  title: 'Optional API features',
  run: (context) => {
    const betas = context.betas;
    if (betas === undefined) {
      return { status: 'skip', detail: 'betas were not probed (offline run)' };
    }
    const missing = betas.requested.filter((beta) => !betas.available.includes(beta));
    if (missing.length === 0) {
      return {
        status: 'pass',
        detail:
          betas.requested.length === 0
            ? 'no optional features are requested'
            : `all ${String(betas.requested.length)} requested features are available`,
      };
    }
    return {
      status: 'warn',
      detail: `${String(missing.length)} optional feature(s) are not available on this account: ${missing.join(', ')}`,
      fix: {
        text:
          `${BRAND.displayName} works without these. The refusal fallback is the one worth having — it lets a ` +
          'declined request be answered by a second model instead of failing. Ask your provider ' +
          'to enable it, or ignore this.',
      },
    };
  },
};

/**
 * `models.local` — which ladder level did the local server land on?
 *
 * Reports the level and, when it is below L1, **why** and which flag fixes it. `05` §3.5.6: a model
 * whose metadata claims `tools` can still fail the probe because tool calling depends on the chat
 * template, which is the common and confusing case — the host can see their model supports tools
 * and cannot see why the bot will not use them.
 */
export const localLevelCheck: ModelCheck = {
  id: 'models.local',
  title: 'Local model capabilities',
  run: (context) => {
    const probe = context.localProbe;
    if (probe === undefined) {
      return { status: 'skip', detail: 'no local model is configured' };
    }
    if (!isProbeFresh(probe, context.nowMs)) {
      return {
        status: 'warn',
        detail: `the capability probe is older than ${String(PROBE_TTL_HOURS)} hours (last run ${probe.probedAt})`,
        fix: {
          text: 'Re-run the probe so the ladder level reflects your current server.',
          command: `${BRAND.cliName} doctor --models`,
        },
      };
    }

    const behaviour = LEVEL_BEHAVIOUR[probe.level];
    const summary = levelSummary(probe.level);
    if (probe.level === 'L1') {
      return { status: 'pass', detail: `${probe.serverKind} at ${probe.level}: ${summary}` };
    }

    const flagAdvice = toolFlagAdviceFor(probe.serverKind);
    return {
      // L4 is a **fail**: `05` §3.5.6 has `doctor` refuse it for `chat` unless forced, because a
      // bot that can talk and cannot act — and cannot apply privacy constraints — is not the
      // product a host thinks they installed. L2 and L3 are warnings: every feature still works.
      status: behaviour.requiresForceForChat ? 'fail' : 'warn',
      detail: `${probe.serverKind} at ${probe.level}: ${summary}`,
      // No `command` at all: on Ollama, LM Studio and a generic server a failed tool probe means
      // the model or its chat template does not do tool calling, which no flag fixes — so there is
      // nothing honest to put there (`M2-T12`'s `toolFlagAdviceFor` returns `undefined` for those
      // three). A command field that sometimes held `undefined` would be a different thing from an
      // absent one under `exactOptionalPropertyTypes`, and neither is a command a host can run.
      fix: {
        text:
          flagAdvice ??
          `Try a model that supports tool calling. \`${BRAND.cliName} doctor --models\` lists what your server reports.`,
      },
    };
  },
};

/**
 * `models.context` — does the local server truncate?
 *
 * The check that earns its place. Silent truncation produces no error: the server accepts a long
 * prompt, drops the front of it, and answers confidently from what is left. A group experiences
 * that as a bot that ignores its own instructions, and nobody suspects the context window — so
 * this is the only place it is ever named.
 */
export const contextCheck: ModelCheck = {
  id: 'models.context',
  title: 'Local model context window',
  run: (context) => {
    const probe = context.localProbe;
    if (probe === undefined) {
      return { status: 'skip', detail: 'no local model is configured' };
    }
    if (!probe.truncates) {
      const proven = probe.contextWindowProven;
      return {
        status: 'pass',
        detail:
          proven === undefined
            ? 'the server held a long prompt without truncating'
            : `the server held a ${String(proven)}-token prompt without truncating`,
      };
    }
    return {
      status: 'fail',
      detail:
        'the server silently truncates long prompts — it drops the start of the conversation and ' +
        'answers from what is left, which looks like the bot ignoring its instructions',
      fix: { text: contextAdviceFor(probe.serverKind) },
    };
  },
};

/**
 * `models.prices` — is every routed model priced?
 *
 * A **warn**: the product still runs and the budget guard still counts. But the reason this is not
 * merely cosmetic is that `05` §3.9.2's fallback is only conservative *relative to the table* —
 * Opus is the dearest model we have prices for, not the dearest model that exists, and a model
 * dearer than Opus is under-reported. So the copy says the figures are unreliable rather than
 * promising they are high, which is what it said until the M2 review.
 */
export const priceCoverageCheck: ModelCheck = {
  id: 'models.prices',
  title: 'Cost estimates',
  run: (context) => {
    const table = context.prices ?? PRICES;
    // `binding.priceId`, not `provider/model`: a host who pinned a dated snapshot and mapped it
    // with `priceKey` in `models.registryOverrides` has priced it, and this check must agree.
    const models = [...new Set(context.bindings.map((binding) => binding.priceId))].toSorted();
    const unpriced = models.filter((id) => {
      const row = lookupPrice(id, table);
      return row === undefined || row === null;
    });
    if (unpriced.length === 0) {
      return {
        status: 'pass',
        detail: `all ${String(models.length)} routed model(s) are priced (table ${table.version})`,
      };
    }
    return {
      status: 'warn',
      detail: `${String(unpriced.length)} routed model(s) have no published price: ${unpriced.join(', ')}`,
      fix: {
        text:
          'Spend for these is estimated at the dearest rates we have prices for, so the figures on ' +
          'the Costs page are a guess — too high for a cheaper model, and too low for one dearer ' +
          'than any we know. ' +
          `Updating ${BRAND.displayName} usually brings a newer price table.`,
        command: `${BRAND.cliName} update`,
      },
    };
  },
};

/**
 * `models.registry` — is any routed model running on a provider family's guessed limits?
 *
 * The registry carries `openai/*`, `google/*` and `local/*` wildcard rows so a host can point at a
 * model we have never catalogued without editing anything (`05` §3.5.2's stated purpose for the
 * mechanism). The cost is that `lookupCapabilities` can no longer answer "I do not know this
 * model" for those three providers — a typo like `openai/gpt-6-astraa` resolves through the family
 * row and inherits its `contextWindow` and `maxOutput`.
 *
 * The M2 independent review found that this made `resolveRoutes`' `unknown_model` problem
 * unreachable for the three wildcard providers while its own `fix` text warned about exactly the
 * consequence — "routing to a model whose limits are unknown is how a reply gets truncated at an
 * unpredictable length". That is what happens, silently, and nothing said so.
 *
 * A **warn** rather than a failure: inheriting the family's limits is the wildcard working as
 * designed, and a host using a real model we have not catalogued should boot. What they must not
 * get is silence, because the symptom — replies truncated at an unpredictable length — looks like
 * the bot being unreliable rather than like a number that needs correcting.
 *
 * `local/*` is excluded and says why: the local probe (`M2-T12`) measures the real context window
 * at runtime, and `models.context` reports what it found. Guessing is only unobserved on the cloud
 * providers, where there is no probe that can tell us.
 */
export const registryCoverageCheck: ModelCheck = {
  id: 'models.registry',
  title: 'Model limits',
  run: (context) => {
    const byModel = new Map(
      context.bindings
        // Keyed on `capabilityKey`, which is the registry-side fact: it is `<prefix>/*` exactly
        // when the family row answered. Not on `binding.provider`, which is a **different
        // namespace** — the resolver sets it from the registry id's prefix (`local`) while the
        // adapter labels the same provider `openai-compatible` in spans and metrics. Either
        // string would work here today; the registry key is the one this check is actually about.
        .filter(
          (binding) => binding.capabilityKey.endsWith('/*') && binding.capabilityKey !== 'local/*',
        )
        .map((binding) => [`${binding.provider}/${binding.model}`, binding] as const),
    );
    if (byModel.size === 0) {
      return {
        status: 'pass',
        detail:
          context.bindings.length === 0
            ? 'no routes are configured'
            : `every routed cloud model has its own registry entry (${String(context.bindings.length)} route(s))`,
      };
    }
    const lines = [...byModel.entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([id, binding]) =>
          `${id} → ${binding.capabilityKey} (context ${String(binding.capabilities.contextWindow)}, ` +
          `max output ${String(binding.maxOutputTokens)})`,
      );
    return {
      status: 'warn',
      detail: `${String(byModel.size)} routed model(s) are using their provider family's limits: ${lines.join('; ')}`,
      fix: {
        text:
          'These numbers are a guess. If they are too high, a long reply is cut off mid-sentence; ' +
          'if too low, context is trimmed that would have fitted. Check the model name for a typo ' +
          'first — a misspelled id lands here rather than being rejected. If the name is right, ' +
          'set the real limits in models.registryOverrides.',
        docs: 'configuration/models#registryoverrides',
      },
    };
  },
};

/**
 * `models.estimator` — is the local token estimator calibrated plausibly?
 *
 * The estimator decides whether a prompt fits **before** a turn runs (`05` §3.5.3.8 keeps the real
 * `count_tokens` off the hot path), so a bad ratio has asymmetric consequences: too high
 * under-counts and lets an over-long prompt reach the provider to be truncated, which is the
 * expensive direction, while too low trims context that would have fitted.
 */
export const estimatorCheck: ModelCheck = {
  id: 'models.estimator',
  title: 'Token estimator',
  run: (context) => {
    const calibrations = context.calibrations;
    if (calibrations === undefined || calibrations.length === 0) {
      return {
        status: 'info',
        detail: 'the token estimator is using its built-in default ratio',
        fix: {
          text: 'Calibrating it makes prompt-size estimates more accurate. It costs a fraction of a cent.',
          command: `${BRAND.cliName} doctor --models`,
        },
      };
    }
    const implausible = calibrations.filter(
      (entry) =>
        !Number.isFinite(entry.charsPerToken) ||
        entry.charsPerToken < ESTIMATOR_MIN_CHARS_PER_TOKEN ||
        entry.charsPerToken > ESTIMATOR_MAX_CHARS_PER_TOKEN,
    );
    if (implausible.length === 0) {
      return {
        status: 'pass',
        detail: `calibrated for ${String(calibrations.length)} model(s)`,
      };
    }
    return {
      status: 'warn',
      detail: `the calibration for ${implausible.map((entry) => entry.model).join(', ')} is outside the plausible range`,
      fix: {
        text:
          `${BRAND.displayName} will use its built-in ratio instead. Re-run the calibration; if it keeps ` +
          'reporting an odd number, the provider may have returned a token count for a different ' +
          'request.',
        command: `${BRAND.cliName} doctor --models`,
      },
    };
  },
};

/**
 * Every model check, in the order `doctor` prints them.
 *
 * Keys first (nothing else matters if the provider will not talk to us), then capability, then the
 * two cost-accuracy checks — which is roughly severity order, and matches how a host reads the
 * output: the first red line is the one they act on.
 */
export const MODEL_CHECKS: readonly ModelCheck[] = Object.freeze([
  keyCheck,
  betasCheck,
  localLevelCheck,
  contextCheck,
  priceCoverageCheck,
  registryCoverageCheck,
  estimatorCheck,
]);

/** Run them all. `M9-T35`'s registry calls this and merges the results with its own. */
export function runModelChecks(
  context: DiagnosticsContext,
): readonly (CheckResult & { readonly id: string; readonly title: string })[] {
  return MODEL_CHECKS.map((check) => ({
    id: check.id,
    title: check.title,
    ...check.run(context),
  }));
}

/** The counts `09` §3.11.6's summary line prints. */
export function summarise(results: readonly CheckResult[]): Readonly<Record<CheckStatus, number>> {
  const counts: Record<CheckStatus, number> = { pass: 0, info: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

/**
 * The worst status in a set, for an exit code.
 *
 * `fail` beats `warn` beats everything else, and `skip` is **not** a problem: a skipped check is
 * one that did not apply, and a host running Local-only would otherwise get a non-zero exit for
 * configuring exactly what they meant to.
 */
export function worstStatus(results: readonly CheckResult[]): CheckStatus {
  if (results.some((result) => result.status === 'fail')) return 'fail';
  if (results.some((result) => result.status === 'warn')) return 'warn';
  if (results.some((result) => result.status === 'pass')) return 'pass';
  return results.some((result) => result.status === 'info') ? 'info' : 'skip';
}
