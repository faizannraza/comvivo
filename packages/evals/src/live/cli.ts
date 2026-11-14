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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ModelGateway, ModelRoute, ModelTurnRequest } from '@comvivo/core';
import {
  createAnthropicGateway,
  createLocalGateway,
  createOpenAiGateway,
  type RouteBinding,
  resolveRoutesOrThrow,
} from '@comvivo/models';
import { bindingFor as anthropicBinding, FakeModelGateway } from '@comvivo/models/testing';
import { BRAND, SystemClock } from '@comvivo/shared';
import { silentLogger, VirtualClock } from '@comvivo/shared/testing';
import { SMOKE_CAP_MICROS } from '../budget/index.js';
import { runSmoke, SMOKE_SCENARIOS, type SmokeReport } from './smoke.js';

/**
 * Which providers this command knows how to smoke.
 *
 * `ollama` is here because `11` §3.8.4's AC names three providers and the M2 independent review
 * found it missing from the harness while both this workflow and `STATUS.md` claimed it "runs
 * locally". A substitution that is stated and unavailable is worse than one that is absent.
 */
const PROVIDERS = ['anthropic', 'openai', 'ollama'] as const;
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

/**
 * The env var each provider's key comes from.
 *
 * `ollama` has none: a local server needs no credential, which is why it is the one leg a
 * developer can run today without the owner's asks.
 */
const KEY_ENV: Readonly<Record<Provider, string | undefined>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  ollama: undefined,
};

/**
 * Where `11` §3.8.4's artifact goes, and what `live-smoke.yml` uploads.
 *
 * Resolved from this module, **not** from `process.cwd()`. `pnpm --filter` runs the script with the
 * package as its working directory, so a relative path put the artifact in
 * `packages/evals/results/` while the workflow uploads `results/` from the repository root — the
 * upload would have warn-and-passed on an empty directory for a second reason.
 */
const RESULTS_DIR = fileURLToPath(new URL('../../../../results/live-smoke', import.meta.url));

function gatewayFor(provider: Provider): ModelGateway {
  if (provider === 'ollama') return localGateway();
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
  const deps = {
    bindingFor: bindingResolver(resolution),
    clock: new SystemClock(),
    logger: silentLogger,
  };
  return provider === 'anthropic'
    ? createAnthropicGateway({ ...deps, availableBetas: [] })
    : createOpenAiGateway(deps);
}

/**
 * The local leg.
 *
 * Identification and the capability probes are **not** run here: `05` §3.5.6 caches a probe for
 * 168 hours and `M2-T12`'s adapter consumes the verdict rather than probing lazily, because a
 * probe is four requests and a 16K prompt. So the smoke assumes **L1** and lets the scenarios
 * report the truth — a server that cannot call tools fails `tool-call`, which is exactly the
 * signal the smoke exists to produce, and is more informative than refusing to start.
 */
function localGateway(): ModelGateway {
  const baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://127.0.0.1:11434/v1';
  const model = process.env['OLLAMA_MODEL'] ?? 'gemma4:e4b';
  const resolution = resolveRoutesOrThrow({
    preset: 'local',
    local: { model, smallModel: model },
    baseUrls: { local: baseUrl },
  });
  return createLocalGateway({
    bindingFor: bindingResolver(resolution),
    clock: new SystemClock(),
    logger: silentLogger,
    baseUrl,
    serverKind: 'ollama',
    level: 'L1',
    reasoningEffortAccepted: false,
  });
}

function bindingResolver(
  resolution: ReturnType<typeof resolveRoutesOrThrow>,
): (route: ModelRoute) => RouteBinding {
  return (route) => {
    const binding = resolution.byKey.get(`${route}:default`);
    if (binding === undefined) throw new Error(`no binding for ${route}`);
    return binding;
  };
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

/**
 * Write the artifact `live-smoke.yml` uploads (`11` §3.8.4).
 *
 * The M2 review found the upload step pointing at a directory nothing ever created, so it would
 * always warn-and-pass on an empty artifact — and the `01` §11.7 care in `smoke.ts` (report by
 * error **kind**, never message) rested on a file that was never produced. It is produced now,
 * which is also what makes that care load-bearing rather than theoretical.
 */
async function writeReport(report: SmokeReport): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    join(RESULTS_DIR, `${report.provider}.json`),
    `${JSON.stringify(report, undefined, 2)}\n`,
    'utf8',
  );
}

/**
 * The `--fake` gateway.
 *
 * Answers every scenario the way a healthy provider would, so a `--fake` run is green and the
 * output shape is the real one. It is **not** a live result and `render` says so on the first line.
 */
function fakeGateway(): ModelGateway {
  const fake = new FakeModelGateway({
    clock: new VirtualClock('2026-11-14T10:00:00Z'),
    bindingFor: () => anthropicBinding(),
  });
  fake
    .when({})
    .respond((reply) => reply.text('smoke-7781 OK').toolCall('probe_echo', { value: 'v1' }))
    .times(SMOKE_SCENARIOS.length + 1);
  return fake;
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
    // Runs the **real five scenarios** through `FakeModelGateway`. An earlier version printed a
    // pointer to the unit suite and exited 0 having done nothing — which is precisely what this
    // file condemns a hundred lines below ("a smoke that reported success because it had nothing
    // to do is the worst outcome available"). Found by the M2 independent review.
    const report = await runSmoke({
      gateway: fakeGateway(),
      provider: 'fake',
      live: false,
      capMicros: SMOKE_CAP_MICROS,
      nowMs: () => Date.now(),
      baseRequest,
    });
    process.stdout.write(render(report));
    await writeReport(report);
    process.exitCode = report.green ? 0 : 1;
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
    // `ollama` has no env var, so it is never "missing a key" — a local server needs none, and
    // that is why it is the one leg runnable today without the owner's asks.
    if (envVar === undefined) return false;
    const value = process.env[envVar];
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    // Non-zero, and named. A smoke that passed because it had nothing to do is the worst outcome
    // available: the one thing it exists to establish is that a real provider answers.
    process.stderr.write(
      `\nlive smoke: no key for ${missing.join(', ')}.\n` +
        `  Set ${missing.map((name) => KEY_ENV[name as Provider] ?? name).join(' and ')} and run again.\n` +
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
    await writeReport(report);
    if (!report.green) green = false;
  }
  process.exitCode = green ? 0 : 1;
}

await main();
