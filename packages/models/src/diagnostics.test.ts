/**
 * The model layer's `doctor` checks (`05` §3.5; `09` §3.11.6; `M2-T18`).
 *
 * The AC asks for pass/warn/fail fixtures, and the fixtures are the point: a check is only useful
 * if its **status** is right, because `09` §3.11.6's output is a host scanning for the first red
 * line. A check that warned where it should fail buries the thing they need to act on; one that
 * failed where it should warn makes `doctor` red for a configuration that is correct, and a host
 * who sees that twice stops reading it.
 *
 * So every check is driven through all three outcomes, and the two asymmetries are asserted
 * explicitly: an unavailable beta is a **warn** (the product still works) and silent truncation is
 * a **fail** (the product looks broken in a way nobody can diagnose).
 */
import { BRAND } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { bindingFor } from './anthropic/testing/fixtures.js';
import {
  betasCheck,
  type CheckResult,
  contextCheck,
  type DiagnosticsContext,
  ESTIMATOR_MAX_CHARS_PER_TOKEN,
  estimatorCheck,
  keyCheck,
  localLevelCheck,
  MODEL_CHECKS,
  priceCoverageCheck,
  registryCoverageCheck,
  runModelChecks,
  summarise,
  worstStatus,
} from './diagnostics.js';
import { openaiBinding } from './openai/testing/fixtures.js';
import type { LocalProbeResult } from './openai-compatible/probe.js';
import { localBinding } from './openai-compatible/testing/fixtures.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');

function context(overrides: Partial<DiagnosticsContext> = {}): DiagnosticsContext {
  return { bindings: [bindingFor()], nowMs: NOW, ...overrides };
}

function probe(overrides: Partial<LocalProbeResult> = {}): LocalProbeResult {
  return {
    nativeTools: true,
    parallelTools: true,
    jsonSchema: true,
    jsonObject: true,
    reasoningEffort: false,
    serverKind: 'ollama',
    level: 'L1',
    truncates: false,
    contextWindowProven: 16_000,
    model: 'gemma4:12b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    probedAt: '2026-11-14T09:00:00.000Z',
    ...overrides,
  };
}

describe('models.key', () => {
  it('passes when every configured provider accepted its key', () => {
    expect(keyCheck.run(context({ keyChecks: { anthropic: { kind: 'ok' } } }))).toMatchObject({
      status: 'pass',
    });
  });

  it('fails with the env var and a command when a key is rejected', () => {
    const result = keyCheck.run(
      context({ keyChecks: { anthropic: { kind: 'rejected', envVar: 'ANTHROPIC_API_KEY' } } }),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ANTHROPIC_API_KEY');
    // A host reading this needs to know what to type, not that something is wrong.
    expect(result.fix?.command).toBe(`${BRAND.cliName} secrets set ANTHROPIC_API_KEY`);
  });

  it('fails when a configured provider has no key at all', () => {
    const result = keyCheck.run(
      context({ keyChecks: { anthropic: { kind: 'missing', envVar: 'ANTHROPIC_API_KEY' } } }),
    );
    expect(result.status).toBe('fail');
    expect(result.fix?.command).toContain('ANTHROPIC_API_KEY');
  });

  it('warns rather than fails when the provider could not be reached', () => {
    // The key may be perfectly good; this machine's network is the suspect. Failing would send a
    // host to regenerate a working key.
    const result = keyCheck.run(
      context({ keyChecks: { anthropic: { kind: 'unreachable', detail: 'ENOTFOUND' } } }),
    );
    expect(result.status).toBe('warn');
    expect(result.fix?.text).toContain('internet connection');
  });

  it('skips when no cloud provider is configured', () => {
    // The Local-only and Local-preset case. A red line about a key the host deliberately does not
    // have would make `doctor` wrong about a correct configuration.
    const result = keyCheck.run(context({ bindings: [localBinding()], keyChecks: {} }));
    expect(result.status).toBe('skip');
    expect(result.detail).toContain('no cloud provider');
  });

  it('skips with a command when the keys were not checked', () => {
    const result = keyCheck.run(context());
    expect(result.status).toBe('skip');
    expect(result.fix?.command).toBe(`${BRAND.cliName} doctor --models`);
  });
});

describe('models.betas', () => {
  it('passes when every requested feature is available', () => {
    expect(
      betasCheck.run(context({ betas: { requested: ['a', 'b'], available: ['a', 'b'] } })),
    ).toMatchObject({ status: 'pass' });
  });

  it('warns — never fails — when a feature is unavailable', () => {
    // `05` §3.5.3.9: an unavailable beta is disabled for the process and the adapter keeps
    // working. Failing here would stop a host whose account simply is not enrolled.
    const result = betasCheck.run(context({ betas: { requested: ['a', 'b'], available: ['a'] } }));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('b');
    // And it says which one is worth having, rather than listing opaque beta ids and stopping.
    expect(result.fix?.text).toContain('refusal fallback');
  });

  it('passes when nothing was requested', () => {
    expect(betasCheck.run(context({ betas: { requested: [], available: [] } }))).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('no optional features'),
    });
  });

  it('skips on an offline run', () => {
    expect(betasCheck.run(context()).status).toBe('skip');
  });
});

describe('models.local', () => {
  it('passes at L1', () => {
    const result = localLevelCheck.run(context({ localProbe: probe() }));
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('L1');
  });

  it('warns at L2 and L3, where every feature still works', () => {
    for (const level of ['L2', 'L3'] as const) {
      const result = localLevelCheck.run(context({ localProbe: probe({ level }) }));
      expect(result.status, level).toBe('warn');
    }
  });

  it('fails at L4, because the bot can talk and cannot act', () => {
    // `05` §3.5.6 has `doctor` refuse L4 for `chat` unless forced. A bot with no tools — and no
    // declassification, so no privacy constraints — is not the product a host thinks they
    // installed, and a warning would let it pass unread.
    const result = localLevelCheck.run(context({ localProbe: probe({ level: 'L4' }) }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('privacy constraints');
  });

  it('names the flag that fixes it on the two servers where one does', () => {
    expect(
      localLevelCheck.run(context({ localProbe: probe({ level: 'L2', serverKind: 'llama_cpp' }) }))
        .fix?.text,
    ).toContain('--jinja');
    expect(
      localLevelCheck.run(context({ localProbe: probe({ level: 'L2', serverKind: 'vllm' }) })).fix
        ?.text,
    ).toContain('--enable-auto-tool-choice');
  });

  it('offers no flag where none would help', () => {
    // On Ollama a failed tool probe means the model or its template does not do tool calling.
    // Inventing advice would send a host chasing a setting that does not exist.
    const result = localLevelCheck.run(
      context({ localProbe: probe({ level: 'L2', serverKind: 'ollama' }) }),
    );
    expect(result.fix?.text).toContain('supports tool calling');
    expect(result.fix?.command).toBeUndefined();
  });

  it('warns when the cached probe has gone stale', () => {
    const result = localLevelCheck.run(
      context({ localProbe: probe({ probedAt: '2026-10-01T00:00:00.000Z' }) }),
    );
    expect(result.status).toBe('warn');
    expect(result.fix?.command).toBe(`${BRAND.cliName} doctor --models`);
  });

  it('skips when there is no local model', () => {
    expect(localLevelCheck.run(context()).status).toBe('skip');
  });
});

describe('models.context', () => {
  it('passes and names the window it proved', () => {
    const result = contextCheck.run(context({ localProbe: probe() }));
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('16000');
  });

  it('fails on silent truncation, and says what it looks like', () => {
    // The whole reason this check exists: truncation produces no error, so this is the only place
    // a host is ever told the symptom they are seeing has a cause.
    const result = contextCheck.run(context({ localProbe: probe({ truncates: true }) }));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('ignoring its instructions');
    expect(result.fix?.text).toContain('OLLAMA_CONTEXT_LENGTH');
  });

  it('names the right knob for each server', () => {
    const advice = (serverKind: LocalProbeResult['serverKind']): string =>
      contextCheck.run(context({ localProbe: probe({ truncates: true, serverKind }) })).fix?.text ??
      '';
    expect(advice('llama_cpp')).toContain('--ctx-size');
    expect(advice('vllm')).toContain('--max-model-len');
    expect(advice('lmstudio')).toContain('LM Studio');
  });

  it('skips when there is no local model', () => {
    expect(contextCheck.run(context()).status).toBe('skip');
  });
});

describe('models.prices', () => {
  it('passes when every routed model is priced', () => {
    const result = priceCoverageCheck.run(context());
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('priced');
  });

  it('warns — not fails — for an unpriced model, and does not promise the estimate is high', () => {
    // `05` §3.9.2 costs an unknown model at Opus rates. The copy used to say "your budget is
    // protected but the figures will be high", which is true only while no model costs more than
    // Opus — and `openai/gpt-6-astra` costs 2.5× Opus on the same tokens, so for a model dearer
    // than any we price the estimate is **low**. Corrected at the M2 review; the wording now says
    // the figures are a guess in both directions, which is what a host can act on.
    const result = priceCoverageCheck.run(
      // `priceId` explicitly, not just `model`: the fixture derives `priceId` the way
      // `resolveRoutes` does, and the Anthropic registry rows set `priceKey`, so overriding only
      // the model would keep Opus's price row — which is also what production would do, because a
      // model id the registry does not know never gets Opus's capabilities in the first place.
      context({
        bindings: [
          bindingFor({
            model: 'claude-not-a-real-model',
            priceId: 'anthropic/claude-not-a-real-model',
          }),
        ],
      }),
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('claude-not-a-real-model');
    expect(result.fix?.text).toContain('too low for one dearer');
    expect(result.fix?.text).not.toContain('budget is protected');
  });
});

describe('models.registry', () => {
  it('passes when every routed cloud model has its own registry entry', () => {
    // `bindingFor()` is Anthropic's Opus row — an exact `capabilityKey`, not a family.
    const result = registryCoverageCheck.run(context());
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('own registry entry');
  });

  it('warns, naming the inherited numbers, when a model resolved through a family row', () => {
    // The gap the M2 review found: `openai/*` means `lookupCapabilities` never returns undefined
    // for an `openai/` id, so `resolveRoutes` cannot report `unknown_model` and the host is given
    // the family's `contextWindow` and `maxOutput` with no indication that they are a guess.
    const result = registryCoverageCheck.run(context({ bindings: [openaiBinding()] }));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('openai/*');
    // The actual numbers, because "check your limits" is not actionable and these are.
    expect(result.detail).toMatch(/max output 8000/);
    // And the first thing to check, since a misspelled id lands here instead of being rejected.
    expect(result.fix?.text).toContain('typo');
  });

  it('says nothing about a local model, because the probe measures it', () => {
    // `local/*` is a family row too, but `M2-T12`'s probe proves the real context window at
    // runtime and `models.context` reports it. Warning here as well would be two lines about one
    // thing, one of which is wrong.
    const result = registryCoverageCheck.run(context({ bindings: [localBinding()] }));
    expect(result.status).toBe('pass');
  });

  it('reports one line per model, not one per route', () => {
    const chat = openaiBinding();
    const route = openaiBinding({ route: 'route', slot: 'route' });
    const result = registryCoverageCheck.run(context({ bindings: [chat, route] }));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('1 routed model(s)');
  });

  it('passes with no routes at all rather than claiming coverage it did not check', () => {
    const result = registryCoverageCheck.run(context({ bindings: [] }));
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('no routes are configured');
  });
});

describe('models.estimator', () => {
  it('passes on a plausible ratio', () => {
    expect(
      estimatorCheck.run(context({ calibrations: [{ model: 'm', charsPerToken: 3.8 }] })),
    ).toMatchObject({ status: 'pass' });
  });

  it('reports an uncalibrated estimator as info, not a problem', () => {
    // The built-in default is fine. This is an offer, not a fault.
    const result = estimatorCheck.run(context());
    expect(result.status).toBe('info');
    expect(result.fix?.command).toBe(`${BRAND.cliName} doctor --models`);
  });

  it('warns on a ratio outside the plausible range, in either direction', () => {
    // Too high under-counts tokens and lets an over-long prompt reach the provider to be
    // truncated — the expensive direction. Too low trims context that would have fitted.
    for (const charsPerToken of [0.2, ESTIMATOR_MAX_CHARS_PER_TOKEN + 1, Number.NaN]) {
      const result = estimatorCheck.run(context({ calibrations: [{ model: 'm', charsPerToken }] }));
      expect(result.status, String(charsPerToken)).toBe('warn');
    }
  });
});

describe('the registry', () => {
  it('registers the AC’s six checks plus models.registry, in reading order', () => {
    // `models.registry` is the seventh, added at the M2 review: `05` §3.5.2's wildcard rows made
    // `resolveRoutes`' `unknown_model` unreachable for openai/google/local, so a typo'd model id
    // inherited the family's limits in silence. The AC named six because the seventh gap had not
    // been found yet; `14` M2-T18 is amended to seven.
    expect(MODEL_CHECKS.map((check) => check.id)).toEqual([
      'models.key',
      'models.betas',
      'models.local',
      'models.context',
      'models.prices',
      'models.registry',
      'models.estimator',
    ]);
  });

  it('gives every check a title and a dotted id, as 09 §3.11.6 requires', () => {
    for (const check of MODEL_CHECKS) {
      expect(check.id, check.id).toMatch(/^models\.[a-z]+$/);
      expect(check.title, check.id).not.toBe('');
    }
  });

  it('carries a fix on every non-pass result', () => {
    // `09` §3.11.6's output prints the fix under the line. A warning with nothing to do is a line
    // a host learns to scroll past.
    const results = runModelChecks(
      context({
        bindings: [bindingFor({ model: 'unpriced-model' })],
        keyChecks: { anthropic: { kind: 'rejected', envVar: 'ANTHROPIC_API_KEY' } },
        betas: { requested: ['a'], available: [] },
        localProbe: probe({ level: 'L4', truncates: true }),
        calibrations: [{ model: 'm', charsPerToken: 99 }],
      }),
    );
    for (const result of results) {
      if (result.status === 'pass') continue;
      expect(result.fix, result.id).toBeDefined();
      expect(result.fix?.text, result.id).not.toBe('');
    }
  });

  it('summarises and ranks the statuses for an exit code', () => {
    const results: readonly CheckResult[] = [
      { status: 'pass', detail: '' },
      { status: 'warn', detail: '' },
      { status: 'fail', detail: '' },
      { status: 'skip', detail: '' },
    ];
    expect(summarise(results)).toMatchObject({ pass: 1, warn: 1, fail: 1, skip: 1 });
    expect(worstStatus(results)).toBe('fail');
    expect(
      worstStatus([
        { status: 'pass', detail: '' },
        { status: 'warn', detail: '' },
      ]),
    ).toBe('warn');
    // A skipped check is not a problem: a Local-only host would otherwise get a non-zero exit for
    // configuring exactly what they meant to.
    expect(
      worstStatus([
        { status: 'skip', detail: '' },
        { status: 'pass', detail: '' },
      ]),
    ).toBe('pass');
    expect(worstStatus([{ status: 'skip', detail: '' }])).toBe('skip');
    expect(
      worstStatus([
        { status: 'skip', detail: '' },
        { status: 'info', detail: '' },
      ]),
    ).toBe('info');
  });

  it('is all green on a healthy cloud instance', () => {
    const results = runModelChecks(
      context({
        keyChecks: { anthropic: { kind: 'ok' } },
        betas: { requested: ['a'], available: ['a'] },
        calibrations: [{ model: 'claude-opus-5-5', charsPerToken: 3.8 }],
      }),
    );
    // The two local checks skip, because there is no local model. Everything else passes.
    expect(summarise(results)).toMatchObject({ fail: 0, warn: 0, skip: 2 });
    expect(worstStatus(results)).toBe('pass');
  });

  it('is all green on a healthy Local-only instance', () => {
    const results = runModelChecks(
      context({
        bindings: [localBinding({ baseUrl: 'http://127.0.0.1:11434/v1' })],
        keyChecks: {},
        localProbe: probe(),
        calibrations: [{ model: 'gemma4:12b', charsPerToken: 3.6 }],
      }),
    );
    // No key and no betas to check; the ladder and the context probe pass. A host who chose
    // Local-only must not be shown a failure for it.
    expect(worstStatus(results)).not.toBe('fail');
    expect(results.filter((result) => result.status === 'fail')).toEqual([]);
  });
});
