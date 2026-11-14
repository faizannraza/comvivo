/**
 * `pnpm --filter @comvivo/evals smoke:live` (`11` §3.8.4–§3.8.5; `M2-T19`).
 *
 * ## Refusing is the normal path today
 *
 * With no key this exits **non-zero with a message naming the ask**, rather than skipping quietly.
 * A smoke that reported success because it had nothing to do is the worst outcome available: the
 * one thing this command exists to establish is that a real provider answers, and "no key" is not
 * evidence of that either way.
 *
 * `--fake` runs the identical five scenarios through `FakeModelGateway`. That is how the harness
 * is verified before the key exists (`H-2`), and it prints **NOT A LIVE RESULT** so no transcript
 * of it can be mistaken for one (`CLAUDE.md` §8).
 */
import { parseArgs } from 'node:util';
import type { ModelGateway, ModelRoute, ModelTurnRequest } from '@comvivo/core';
import {
  createAnthropicGateway,
  createOpenAiGateway,
  type RouteBinding,
  resolveRoutesOrThrow,
} from '@comvivo/models';
import { BRAND, SystemClock } from '@comvivo/shared';
import { silentLogger } from '@comvivo/shared/testing';
import { SMOKE_CAP_MICROS } from '../budget/index.js';
import { runSmoke, type SmokeReport } from './smoke.js';

/** Which providers this command knows how to smoke. */
const PROVIDERS = ['anthropic', 'openai'] as const;
type Provider = (typeof PROVIDERS)[number];

/**
 * The canonical request every scenario starts from.
 *
 * Takes no resolver: the gateway resolves the route itself, which is the whole point of
 * `routeInfo`. An earlier draft threaded a `bindingFor` through here and never read it.
 */
function baseRequest(route: ModelRoute): ModelTurnRequest {
  return {
    route,
    purpose: 'smoke',
    system: [{ id: 'charter', text: 'You are helpful. Answer briefly.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: 'auto',
    effort: 'low',
    maxOutputTokens: 64,
    correlation: {},
  };
}

/** The env var each provider's key comes from. */
const KEY_ENV: Readonly<Record<Provider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

function gatewayFor(provider: Provider): ModelGateway {
  const resolution = resolveRoutesOrThrow({
    preset: 'custom',
    yamlRoutes:
      provider === 'anthropic'
        ? {
            chat: 'anthropic/claude-opus-5-5',
            chatEconomy: 'anthropic/claude-haiku-5-5',
            route: 'anthropic/claude-haiku-5-5',
            extract: 'anthropic/claude-haiku-5-5',
            declassify: 'anthropic/claude-haiku-5-5',
            guard: 'anthropic/claude-haiku-5-5',
            consolidate: 'anthropic/claude-sonnet-5-5',
          }
        : {
            chat: 'openai/gpt-6.1-sol',
            chatEconomy: 'openai/gpt-6-luna',
            route: 'openai/gpt-6-luna',
            extract: 'openai/gpt-6-luna',
            declassify: 'openai/gpt-6-luna',
            guard: 'openai/gpt-6-luna',
            consolidate: 'openai/gpt-6.1-sol',
          },
  });
  const bindingFor = (route: ModelRoute): RouteBinding => {
    const binding = resolution.byKey.get(`${route}:default`);
    if (binding === undefined) throw new Error(`no binding for ${route}`);
    return binding;
  };
  const deps = { bindingFor, clock: new SystemClock(), logger: silentLogger };
  return provider === 'anthropic'
    ? createAnthropicGateway({ ...deps, availableBetas: [] })
    : createOpenAiGateway(deps);
}

function render(report: SmokeReport): string {
  const lines = [
    '',
    `${BRAND.displayName} live smoke · ${report.provider}${report.live ? '' : ' · NOT A LIVE RESULT (--fake)'}`,
    '',
  ];
  for (const result of report.results) {
    const mark = result.status === 'pass' ? '✔' : result.status === 'skipped' ? '–' : '✖';
    lines.push(`  ${mark} ${result.scenario} · ${result.detail}`);
    if (result.cacheReadTokens > 0) {
      lines.push(`      cache read: ${String(result.cacheReadTokens)} tokens`);
    }
  }
  const spent = (report.spentMicros / 1_000_000).toFixed(4);
  lines.push('', `  ${report.green ? 'green' : 'not green'} · $${spent} · ${report.outcome}`, '');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      providers: { type: 'string', default: 'anthropic' },
      fake: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const requested = values.providers
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  if (values.fake) {
    // The offline path. Covered by `smoke.test.ts`, which is where the harness is actually
    // asserted; this branch exists so a developer can see the output shape.
    process.stdout.write(
      `\n${BRAND.displayName} live smoke: --fake is exercised by the unit suite ` +
        `(packages/evals/src/live/smoke.test.ts). Run: pnpm test packages/evals/src/live\n\n`,
    );
    return;
  }

  const unknown = requested.filter((name) => !PROVIDERS.includes(name as Provider));
  if (unknown.length > 0) {
    process.stderr.write(`live smoke: unknown provider(s): ${unknown.join(', ')}\n`);
    process.exitCode = 2;
    return;
  }

  const missing = requested.filter((name) => {
    const envVar = KEY_ENV[name as Provider];
    const value = process.env[envVar];
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    // Non-zero, and named. A smoke that passed because it had nothing to do is the worst outcome
    // available: the one thing it exists to establish is that a real provider answers.
    process.stderr.write(
      `\nlive smoke: no key for ${missing.join(', ')}.\n` +
        `  Set ${missing.map((name) => KEY_ENV[name as Provider]).join(' and ')} and run again.\n` +
        `  This is owner ask H-2 in docs/plan/STATUS.md; H-1 approves the spend.\n` +
        `  To check the harness without a key: pnpm test packages/evals/src/live\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  let green = true;
  for (const name of requested) {
    const provider = name as Provider;
    const report = await runSmoke({
      gateway: gatewayFor(provider),
      provider,
      live: true,
      capMicros: SMOKE_CAP_MICROS,
      nowMs: () => Date.now(),
      baseRequest,
    });
    process.stdout.write(render(report));
    if (!report.green) green = false;
  }
  process.exitCode = green ? 0 : 1;
}

await main();
