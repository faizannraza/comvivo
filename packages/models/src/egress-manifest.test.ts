/**
 * The privacy modes (`08` §3.11.2; `M2-T16`).
 *
 * The manifest's agreement with `08` §3.11.1 is asserted in `test/plan/egress-manifest.test.ts`,
 * which can read the plan. This file is about **behaviour**, and the behaviour that matters is the
 * refusal: `privacy.localOnly` is a promise to a group, so a configuration that would break it has
 * to stop the boot rather than degrade — a host who turned it on and got a cloud route anyway
 * would have been lied to, and there is no symptom they could notice.
 */
import { describe, expect, it } from 'vitest';
import { bindingFor } from './anthropic/testing/fixtures.js';
import {
  assertPrivacyOrThrow,
  destinationOf,
  EGRESS_MANIFEST,
  egressRow,
  hybridExtractIsLocal,
  hybridProblem,
  isLocalDestination,
  LOCAL_ONLY_DISCLOSURE,
  localOnlyProblems,
  localOnlySettingsFrom,
  PrivacyModeError,
  privacyBadge,
  privacyModeOf,
  privacyProblems,
  providerSurfaces,
  routeRunsLocal,
} from './egress-manifest.js';
import { localBinding } from './openai-compatible/testing/fixtures.js';
import type { RouteBinding } from './registry/resolve.js';

/** A cloud binding for a slot, from the real Anthropic fixture. */
function cloud(slot: RouteBinding['slot'], route: RouteBinding['route'] = 'chat'): RouteBinding {
  return bindingFor({ slot, route });
}

/** The same binding with its base URL absent, which is what a provider with no endpoint looks like. */
function withoutBaseUrl(binding: RouteBinding): RouteBinding {
  const { baseUrl: _absent, ...rest } = binding;
  return rest;
}

/** A local binding pointed at an address. */
function local(slot: RouteBinding['slot'], baseUrl: string): RouteBinding {
  return localBinding({ slot, baseUrl });
}

describe('which mode a settings pair means', () => {
  it('reads the three combinations', () => {
    expect(privacyModeOf({ localOnly: false, sensitiveRoutesLocal: false })).toBe('cloud');
    expect(privacyModeOf({ localOnly: false, sensitiveRoutesLocal: true })).toBe('hybrid');
    expect(privacyModeOf({ localOnly: true, sensitiveRoutesLocal: false })).toBe('local_only');
  });

  it('lets localOnly win when a host set both', () => {
    // The stronger promise. Reporting `hybrid` would put a badge on the dashboard that understated
    // what the host actually asked for.
    expect(privacyModeOf({ localOnly: true, sensitiveRoutesLocal: true })).toBe('local_only');
  });

  it('badges Local-only and deliberately does not badge Hybrid', () => {
    expect(privacyBadge('local_only')).toBe('Local-only');
    // `08` §3.11.2 names a badge only for Local-only, and a "Hybrid" badge would read as a
    // stronger promise than it is: `chat`, which is most of what a group sends, still goes out.
    expect(privacyBadge('hybrid')).toBeUndefined();
    expect(privacyBadge('cloud')).toBeUndefined();
  });

  it('corrects the obvious misreading of Local-only', () => {
    // A host who read the badge as "nothing leaves this machine" would be deciding on a false
    // premise: Telegram still sees the group's chat, because Telegram *is* the group's chat.
    expect(LOCAL_ONLY_DISCLOSURE).toContain('No AI provider');
    expect(LOCAL_ONLY_DISCLOSURE).toContain('chat platform still carries');
    expect(LOCAL_ONLY_DISCLOSURE).toContain('offline');
  });
});

describe('what each mode changes, per surface', () => {
  it('sends the cloud surfaces to a provider in Cloud mode', () => {
    expect(destinationOf(egressRow('chat.group'), 'cloud')).toBe('provider');
    expect(destinationOf(egressRow('declassify'), 'cloud')).toBe('provider');
    // The two the spec marks local by default stay local even in Cloud mode.
    expect(destinationOf(egressRow('embed'), 'cloud')).toBe('local');
    expect(destinationOf(egressRow('transcribe'), 'cloud')).toBe('local');
    // The three opt-ins send nothing at all until switched on.
    expect(destinationOf(egressRow('web_search'), 'cloud')).toBe('nothing');
  });

  it('moves exactly the four surfaces 08 §3.11.2 names in Hybrid', () => {
    const moved = EGRESS_MANIFEST.filter(
      (row) =>
        destinationOf(row, 'cloud') === 'provider' && destinationOf(row, 'hybrid') === 'local',
    ).map((row) => row.surface);
    // `declassify`, `guard` and DM `extract` — and `embed`, which is already local by default so
    // it does not appear here. That is the spec's list minus the one that never left.
    expect(moved).toEqual(['extract.dm', 'declassify', 'guard']);
  });

  it('leaves chat and group extraction with the provider in Hybrid', () => {
    // The honest limit of Hybrid: it is a reduction, not a guarantee. `chat` is most of what a
    // group sends.
    expect(destinationOf(egressRow('chat.group'), 'hybrid')).toBe('provider');
    expect(destinationOf(egressRow('chat.dm'), 'hybrid')).toBe('provider');
    expect(destinationOf(egressRow('extract'), 'hybrid')).toBe('provider');
  });

  it('sends nothing to a provider in Local-only', () => {
    expect(providerSurfaces('local_only')).toEqual([]);
    for (const row of EGRESS_MANIFEST) {
      expect(destinationOf(row, 'local_only'), row.surface).not.toBe('provider');
    }
  });

  it('shows a host how much Hybrid actually reduces', () => {
    // The number the wizard prints. A host choosing between the modes needs to see it rather than
    // be told "sensitive routes stay local".
    // Nine surfaces reach a provider under the default presets; Hybrid moves three of them, so
    // six still do. The gap is the honest size of what Hybrid buys — `chat` is not in it.
    expect(providerSurfaces('cloud')).toHaveLength(9);
    expect(providerSurfaces('hybrid')).toHaveLength(6);
  });

  it('refuses a surface it has no row for', () => {
    expect(() => egressRow('not_a_surface' as never)).toThrow(/no row/);
  });
});

describe('Hybrid’s per-conversation extraction rule', () => {
  it('moves DM extraction local and leaves group extraction cloud', () => {
    // The engine decides this per turn, because only it knows whether the conversation is a DM.
    // The resolver cannot: it binds a route once at boot.
    expect(hybridExtractIsLocal('hybrid', 'dm')).toBe(true);
    expect(hybridExtractIsLocal('hybrid', 'group')).toBe(false);
    expect(hybridExtractIsLocal('cloud', 'dm')).toBe(false);
    // Local-only moves everything, whatever the conversation.
    expect(hybridExtractIsLocal('local_only', 'group')).toBe(true);
  });

  it('binds declassify and guard local in Hybrid, and nothing else', () => {
    expect(routeRunsLocal('hybrid', 'declassify')).toBe(true);
    expect(routeRunsLocal('hybrid', 'guard')).toBe(true);
    expect(routeRunsLocal('hybrid', 'chat')).toBe(false);
    // `extract` keeps its cloud binding: the move is per conversation kind, not per route.
    expect(routeRunsLocal('hybrid', 'extract')).toBe(false);
    for (const route of [
      'chat',
      'route',
      'extract',
      'declassify',
      'guard',
      'consolidate',
    ] as const) {
      expect(routeRunsLocal('local_only', route), route).toBe(true);
    }
  });

  it('refuses to start Hybrid with no local model', () => {
    // Hybrid without a local model is not a degraded Hybrid — it is Cloud with a setting that
    // reads as a privacy guarantee, which is the worst of the three outcomes.
    expect(hybridProblem({ mode: 'hybrid', localModelReachable: false })?.detail).toContain(
      'no local model is reachable',
    );
    expect(hybridProblem({ mode: 'hybrid', localModelReachable: true })).toBeUndefined();
    expect(hybridProblem({ mode: 'cloud', localModelReachable: false })).toBeUndefined();
  });
});

describe('what counts as this machine', () => {
  it('accepts the whole loopback block, not just 127.0.0.1', () => {
    for (const url of [
      'http://127.0.0.1:11434/v1',
      'http://127.0.0.2:8080',
      'http://localhost:1234/v1',
      'http://[::1]:11434',
    ]) {
      expect(isLocalDestination(url, []), url).toBe(true);
    }
  });

  it('accepts a LAN address only when the host wrote down the exact host:port', () => {
    // `08` §3.9's mechanism, and the same allowlist `safeFetch` reads. No wildcards: a wildcard
    // allowlist is a deny list with extra steps.
    expect(isLocalDestination('http://gpu.lan:8000/v1', ['gpu.lan:8000'])).toBe(true);
    expect(isLocalDestination('http://gpu.lan:8000/v1', ['gpu.lan:9000'])).toBe(false);
    expect(isLocalDestination('http://gpu.lan:8000/v1', [])).toBe(false);
  });

  it('fills in the default port when the URL omits it', () => {
    expect(isLocalDestination('https://gpu.lan/v1', ['gpu.lan:443'])).toBe(true);
    expect(isLocalDestination('http://gpu.lan/v1', ['gpu.lan:80'])).toBe(true);
  });

  it('treats an absent or unparseable base URL as not local', () => {
    // No base URL means the provider's own default endpoint, which for a cloud provider is the
    // internet. Guessing "local" here is the unsafe direction.
    expect(isLocalDestination(undefined, [])).toBe(false);
    expect(isLocalDestination('', [])).toBe(false);
    expect(isLocalDestination('not a url', [])).toBe(false);
  });

  it('is not fooled by a hostname that merely starts with the loopback digits', () => {
    expect(isLocalDestination('http://127.0.0.1.evil.example:80', ['x:1'])).toBe(false);
  });
});

describe('Local-only fails closed (08 §3.11.2)', () => {
  it('collapses an all-cloud configuration to one problem and one fix', () => {
    // Found by running `14`'s M2 demo step 3: on the default `best` preset this emitted **seven**
    // near-identical paragraphs whose real answer was a single line. Seven copies of one message
    // is not clearer than one (`CLAUDE.md` §8) — it is the same information arranged to look like
    // seven problems.
    const problems = localOnlyProblems({
      bindings: [cloud('chat'), cloud('guard', 'guard'), cloud('extract', 'extract')],
      allowPrivate: [],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toBe('every model route resolves to a cloud provider (anthropic)');
    // A refusal that does not say what to do is a refusal a host cannot act on.
    expect(problems[0]?.fix).toContain('models.preset');
    expect(problems[0]?.fix).toContain('models.local.model');
  });

  it('lists a mixed configuration per route, because the host must change specific ones', () => {
    const problems = localOnlyProblems({
      bindings: [
        local('chat', 'http://127.0.0.1:11434/v1'),
        cloud('guard', 'guard'),
        cloud('extract', 'extract'),
      ],
      allowPrivate: [],
    });
    expect(problems).toHaveLength(2);
    // Per-route now, and the fix names the route rather than repeating the preset advice.
    expect(problems.map((problem) => problem.fix)).toEqual([
      expect.stringContaining('models.routes.guard'),
      expect.stringContaining('models.routes.extract'),
    ]);
  });

  it('names a single cloud route individually rather than claiming "every route"', () => {
    const problems = localOnlyProblems({ bindings: [cloud('chat')], allowPrivate: [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toContain('"chat" resolves to anthropic');
  });

  it('names every cloud provider when a configuration mixes them', () => {
    const problems = localOnlyProblems({
      bindings: [
        cloud('chat'),
        localBinding({ slot: 'guard', route: 'guard', provider: 'openai' }),
      ],
      allowPrivate: [],
    });
    expect(problems[0]?.detail).toBe(
      'every model route resolves to a cloud provider (anthropic, openai)',
    );
  });

  it('accepts a configuration where every route is on this machine', () => {
    const problems = localOnlyProblems({
      bindings: [
        local('chat', 'http://127.0.0.1:11434/v1'),
        local('guard', 'http://127.0.0.1:11434/v1'),
      ],
      allowPrivate: [],
    });
    expect(problems).toEqual([]);
  });

  it('accepts a LAN model host the host allowlisted, and refuses one they did not', () => {
    const allowed = localOnlyProblems({
      bindings: [local('chat', 'http://gpu.lan:8000/v1')],
      allowPrivate: ['gpu.lan:8000'],
    });
    expect(allowed).toEqual([]);

    const refused = localOnlyProblems({
      bindings: [local('chat', 'http://gpu.lan:8000/v1')],
      allowPrivate: [],
    });
    expect(refused).toHaveLength(1);
    expect(refused[0]?.detail).toContain('neither this machine nor an address you allowlisted');
    // The fix quotes the exact entry to add, so a host can paste it.
    expect(refused[0]?.fix).toContain('gpu.lan:8000');
  });

  it('refuses a provider with no endpoint rather than assuming it is local', () => {
    const problems = localOnlyProblems({
      // The key is **removed**, not set to `undefined`: `exactOptionalPropertyTypes` makes those
      // two different things, and the one under test is an absent base URL.
      bindings: [withoutBaseUrl(localBinding({ provider: 'some-proxy' }))],
      allowPrivate: [],
    });
    expect(problems[0]?.detail).toContain('no base URL');
  });

  it('refuses each non-route egress 08 §3.11.2 names', () => {
    const problems = localOnlyProblems({
      bindings: [],
      allowPrivate: [],
      webSearchEnabled: true,
      updateCheckEnabled: true,
      transcribeUsesApi: true,
      embedUsesApi: true,
      unallowlistedRemoteMcp: ['weather.example'],
    });
    expect(problems).toHaveLength(5);
    const dumped = JSON.stringify(problems);
    expect(dumped).toContain('web search');
    expect(dumped).toContain('IP address');
    expect(dumped).toContain('audio of a voice note');
    expect(dumped).toContain('memory texts');
    expect(dumped).toContain('weather.example');
  });

  it('reports every problem at once, not the first', () => {
    // A host fixing this is editing a config file. A refusal that revealed one problem per restart
    // is five restarts.
    const problems = localOnlyProblems({
      bindings: [cloud('chat'), cloud('guard', 'guard')],
      allowPrivate: [],
      webSearchEnabled: true,
      updateCheckEnabled: true,
    });
    // One collapsed route problem plus the two non-route ones.
    expect(problems).toHaveLength(3);
  });

  it('allows the fake gateway, so a Local-only instance can run its own evals', () => {
    // `fake` reaches no network at all. Refusing it would mean Local-only could not run the
    // scenario suite, which is the one way a host can check the thing works.
    const problems = localOnlyProblems({
      bindings: [localBinding({ provider: 'fake', baseUrl: 'http://127.0.0.1:1/v1' })],
      allowPrivate: [],
    });
    expect(problems).toEqual([]);
  });
});

describe('reading the non-route settings off a config', () => {
  const base = {
    embeddings: { provider: 'local' },
    transcription: { provider: 'local' },
    updates: { check: false },
  };

  it('treats a fully local configuration as clean', () => {
    expect(localOnlySettingsFrom(base)).toEqual({
      embedUsesApi: false,
      transcribeUsesApi: false,
      updateCheckEnabled: false,
    });
  });

  it('counts ollama embeddings as local, because they are', () => {
    // The config enum lists `ollama` beside the three cloud providers. Reading "not the string
    // local" as "remote" would refuse a Local-only instance embedding through its own Ollama —
    // which is precisely the configuration Local-only is for.
    expect(
      localOnlySettingsFrom({ ...base, embeddings: { provider: 'ollama' } }).embedUsesApi,
    ).toBe(false);
    expect(
      localOnlySettingsFrom({ ...base, embeddings: { provider: 'voyage' } }).embedUsesApi,
    ).toBe(true);
  });

  it('counts every non-local transcription provider as an API', () => {
    for (const provider of ['openai', 'groq', 'deepgram']) {
      expect(
        localOnlySettingsFrom({ ...base, transcription: { provider } }).transcribeUsesApi,
        provider,
      ).toBe(true);
    }
  });

  it('reads the update-check flag', () => {
    expect(localOnlySettingsFrom({ ...base, updates: { check: true } }).updateCheckEnabled).toBe(
      true,
    );
  });
});

describe('the one function a boot calls', () => {
  const clean = {
    bindings: [local('chat', 'http://127.0.0.1:11434/v1')],
    allowPrivate: [],
  };

  it('checks nothing in Cloud mode, which makes no promise', () => {
    expect(
      privacyProblems({
        ...clean,
        bindings: [cloud('chat')],
        privacy: { localOnly: false, sensitiveRoutesLocal: false },
      }),
    ).toEqual([]);
  });

  it('checks only the local model in Hybrid', () => {
    const missing = privacyProblems({
      ...clean,
      bindings: [cloud('chat')],
      privacy: { localOnly: false, sensitiveRoutesLocal: true },
      localModelReachable: false,
    });
    // A cloud `chat` binding is *correct* in Hybrid, so the only problem is the missing local model.
    expect(missing).toHaveLength(1);
    expect(missing[0]?.detail).toContain('no local model');

    expect(
      privacyProblems({
        ...clean,
        bindings: [cloud('chat')],
        privacy: { localOnly: false, sensitiveRoutesLocal: true },
        localModelReachable: true,
      }),
    ).toEqual([]);
  });

  it('treats an unstated local model as unreachable in Hybrid', () => {
    // The safe direction: a caller that forgot to probe must not be read as "a model is there".
    expect(
      privacyProblems({
        ...clean,
        privacy: { localOnly: false, sensitiveRoutesLocal: true },
      }),
    ).toHaveLength(1);
  });

  it('refuses the boot with every problem at once, and names the setting', () => {
    let thrown: unknown;
    try {
      assertPrivacyOrThrow({
        bindings: [cloud('chat'), cloud('guard', 'guard')],
        allowPrivate: [],
        webSearchEnabled: true,
        privacy: { localOnly: true, sensitiveRoutesLocal: false },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PrivacyModeError);
    const error = thrown as PrivacyModeError;
    expect(error.mode).toBe('local_only');
    // The two cloud routes collapse to one problem; web search is the second.
    expect(error.problems).toHaveLength(2);
    // The message is what a host reads on a failed boot, so it names the setting and every fix.
    expect(error.message).toContain('privacy.localOnly');
    expect(error.message).toContain('models.preset');
    expect(error.message).toContain('search.enabled');
  });

  it('returns quietly when the configuration honours the mode', () => {
    expect(() =>
      assertPrivacyOrThrow({ ...clean, privacy: { localOnly: true, sensitiveRoutesLocal: false } }),
    ).not.toThrow();
  });

  it('names sensitiveRoutesLocal when that is the mode that failed', () => {
    let thrown: unknown;
    try {
      assertPrivacyOrThrow({
        ...clean,
        privacy: { localOnly: false, sensitiveRoutesLocal: true },
        localModelReachable: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as PrivacyModeError).message).toContain('privacy.sensitiveRoutesLocal');
  });
});
