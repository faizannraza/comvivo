/**
 * The per-route egress manifest, and the two privacy modes (`08` §3.11.1–§3.11.2; `M2-T16`).
 *
 * ## What this file is for
 *
 * `08` SD-15 promises a group **honest, configurable minimization**, and honesty here has a
 * specific meaning: a host can read, before installing, exactly what each model route sends and
 * whose data can be in it. That promise is only as good as the list staying true, so the list is
 * **data** that the wizard, `doctor`, the dashboard and the privacy disclosure all render from —
 * not four sentences written four times that drift apart.
 *
 * The rows are `08` §3.11.1's table, transcribed. A row is deliberately specific about **whose**
 * data can be included, because that is the question a member actually has: "does the bot send my
 * private notes anywhere?" has a different answer for `chat` in a group than for `chat` in a DM,
 * and a manifest that said "conversation data" for both would be true and useless.
 *
 * ## The two modes, and why one of them fails closed
 *
 *  - **Hybrid** (`privacy.sensitiveRoutesLocal`) moves `declassify`, `guard`, DM `extract` and
 *    `embed` onto the local model and leaves `chat` in the cloud. It is a *reduction*: the routes
 *    that see a member's own private items stop leaving the machine.
 *  - **Local-only** (`privacy.localOnly`) is a **promise**, which is why it fails closed. A host
 *    who turned it on and got a cloud route anyway would have been lied to, and would not know —
 *    there is no symptom. So boot refuses rather than degrades, and `localOnlyProblems` is what
 *    refuses.
 *
 * **Local-only means "no AI provider", not "offline".** Chat platforms still carry messages:
 * Telegram still sees the group's chat because Telegram *is* the group's chat. `08` §3.11.2 says
 * so plainly and so does the badge copy, because a host who read "Local-only" as "nothing leaves"
 * would be making a decision on a false premise.
 */
import type { ModelRoute, ProviderId } from '@comvivo/core';
import { isLoopbackHost } from '@comvivo/shared/net';
import type { RouteBinding } from './registry/resolve.js';

/** Every egress surface the manifest covers — model routes plus the non-route ones `08` lists. */
export const EGRESS_SURFACES = [
  'chat.group',
  'chat.dm',
  'route',
  'extract',
  'extract.dm',
  'declassify',
  'guard',
  'consolidate',
  'embed',
  'transcribe',
  'media',
  'web_search',
  'mcp_remote',
  'update_check',
] as const;

export type EgressSurface = (typeof EGRESS_SURFACES)[number];

/** Whether a surface sends anything by default, and what the host can do about it. */
export type EgressDefault =
  /** Sends to the configured provider under the default (Cloud) presets. */
  | 'cloud'
  /** Runs on this machine unless the host configures an API. */
  | 'local'
  /** Sends nothing unless the host turns it on. */
  | 'off';

/** One row of `08` §3.11.1. */
export interface EgressRow {
  readonly surface: EgressSurface;
  /** The human label, as the wizard and the dashboard print it. */
  readonly label: string;
  /** What is sent to the configured provider. `08` §3.11.1 column 2, verbatim in substance. */
  readonly sends: string;
  /**
   * **Whose** data can be in it.
   *
   * The column that matters to a member. `08` §3.11.1 column 3 — and the reason the group and DM
   * variants of `chat` are separate rows rather than one: the answers differ, and a manifest that
   * merged them would be true and useless.
   */
  readonly whose: string;
  /** `08` §3.11.1 column 4. What a host can switch to. */
  readonly localAlternative: string;
  readonly byDefault: EgressDefault;
  /** True when Hybrid (`sensitiveRoutesLocal`) moves this surface onto the local model. */
  readonly hybridMovesLocal: boolean;
  /** The model route this surface uses, when it is one. */
  readonly route?: ModelRoute;
}

/**
 * `08` §3.11.1, as data.
 *
 * In the table's own order, which groups the model routes before the non-route surfaces — that is
 * the order the wizard shows and the order a reader of `08` will be comparing against.
 */
export const EGRESS_MANIFEST: readonly EgressRow[] = Object.freeze([
  Object.freeze({
    surface: 'chat.group',
    label: 'Group replies',
    sends:
      'Charter, tool catalogue, constitution charter, group profile (names, roles, timezones), ' +
      'group story, audience-readable memories, typed constraints, recent window, trigger, tool results',
    whose: 'All members (group-labelled data), and the person who asked',
    localAlternative: 'Local preset',
    byDefault: 'cloud',
    hybridMovesLocal: false,
    route: 'chat',
  }),
  Object.freeze({
    surface: 'chat.dm',
    label: 'Direct-message replies',
    sends: 'The above, plus that member’s private memories and DM history',
    whose: 'That member only',
    localAlternative: 'Local preset',
    byDefault: 'cloud',
    hybridMovesLocal: false,
    route: 'chat',
  }),
  Object.freeze({
    surface: 'route',
    label: 'Deciding whether to reply',
    sends: 'The recent window (at most 12 messages) and the trigger',
    whose: 'Group members',
    localAlternative: 'Local',
    byDefault: 'cloud',
    hybridMovesLocal: false,
    route: 'route',
  }),
  Object.freeze({
    surface: 'extract',
    label: 'Learning from group conversations',
    sends: 'Batches of messages from one conversation, for members who consented',
    whose: 'Group members',
    localAlternative: 'Hybrid',
    byDefault: 'cloud',
    // Group extraction stays cloud in Hybrid; only the DM variant moves (`08` §3.11.2).
    hybridMovesLocal: false,
    route: 'extract',
  }),
  Object.freeze({
    surface: 'extract.dm',
    label: 'Learning from your direct messages',
    sends: 'Batches of messages from a direct conversation — **DM extraction sends DM text**',
    whose: 'The DM owner',
    localAlternative: 'Hybrid',
    byDefault: 'cloud',
    hybridMovesLocal: true,
    route: 'extract',
  }),
  Object.freeze({
    surface: 'declassify',
    label: 'Turning private notes into safe constraints',
    sends:
      'The owner’s private items marked `influence=constraints`, and a closed constraint schema',
    whose: 'The owner — possibly their most sensitive items',
    localAlternative: 'Hybrid',
    byDefault: 'cloud',
    hybridMovesLocal: true,
    route: 'declassify',
  }),
  Object.freeze({
    surface: 'guard',
    label: 'Checking a reply for private information',
    sends:
      'The draft reply and minimized candidate sealed items, when the deterministic checks cannot decide',
    whose: 'Owners of the sealed items',
    localAlternative: 'Hybrid',
    byDefault: 'cloud',
    hybridMovesLocal: true,
    route: 'guard',
  }),
  Object.freeze({
    surface: 'consolidate',
    label: 'Nightly tidying of what the bot remembers',
    sends: 'Group-readable memories and decisions, through the Batches API',
    whose: 'The group',
    localAlternative: 'Local',
    byDefault: 'cloud',
    hybridMovesLocal: false,
    route: 'consolidate',
  }),
  Object.freeze({
    surface: 'embed',
    label: 'Search indexing',
    sends: 'Nothing by default. If a host configures an API: memory texts, including private ones',
    whose: 'All members',
    localAlternative: 'Already the default',
    byDefault: 'local',
    hybridMovesLocal: true,
  }),
  Object.freeze({
    surface: 'transcribe',
    label: 'Voice notes',
    sends: 'Nothing by default. If a host configures an API: the audio of a voice note',
    whose: 'The sender',
    localAlternative: 'Already the default',
    byDefault: 'local',
    hybridMovesLocal: false,
  }),
  Object.freeze({
    surface: 'media',
    label: 'Pictures and PDFs',
    sends: 'Images and PDF text, to whichever provider serves `chat` or `extract`',
    whose: 'The sender, and the conversation’s audience',
    localAlternative: 'A local vision model, if configured',
    byDefault: 'cloud',
    hybridMovesLocal: false,
  }),
  Object.freeze({
    surface: 'web_search',
    label: 'Web search',
    sends: 'Nothing unless switched on. Then: the query strings',
    whose: 'The person who asked',
    localAlternative: '—',
    byDefault: 'off',
    hybridMovesLocal: false,
  }),
  Object.freeze({
    surface: 'mcp_remote',
    label: 'Remote MCP tools',
    sends: 'Tool arguments, within the server’s approved data ceiling',
    whose: 'Whatever the approval allowed',
    localAlternative: '—',
    byDefault: 'off',
    hybridMovesLocal: false,
  }),
  Object.freeze({
    surface: 'update_check',
    label: 'Update check',
    sends:
      'Nothing unless switched on. Then: a GET for a static JSON file with a generic User-Agent, ' +
      'which reveals this machine’s IP address and nothing else',
    whose: '—',
    localAlternative: '—',
    byDefault: 'off',
    hybridMovesLocal: false,
  }),
]);

/** One row by surface. */
export function egressRow(surface: EgressSurface): EgressRow {
  const row = EGRESS_MANIFEST.find((entry) => entry.surface === surface);
  if (row === undefined) {
    // Unreachable while `EgressSurface` is derived from the list, and a real branch because the
    // list is data a future edit could leave incomplete.
    throw new Error(`the egress manifest has no row for "${surface}"`);
  }
  return row;
}

/** Which privacy mode a host is in. */
export type PrivacyMode = 'cloud' | 'hybrid' | 'local_only';

export interface PrivacySettings {
  readonly localOnly: boolean;
  readonly sensitiveRoutesLocal: boolean;
}

/**
 * The mode a settings pair means.
 *
 * `localOnly` wins over `sensitiveRoutesLocal`: it is the stronger promise, and a host who set
 * both meant the stronger one. Reporting `hybrid` for that pair would show a dashboard badge that
 * understated what the host had actually asked for.
 */
export function privacyModeOf(privacy: PrivacySettings): PrivacyMode {
  if (privacy.localOnly) return 'local_only';
  return privacy.sensitiveRoutesLocal ? 'hybrid' : 'cloud';
}

/**
 * Where a surface runs, in a given mode.
 *
 * This is the function the wizard and the dashboard render, and it is the reason the manifest is
 * data: "what does Hybrid actually change?" has a per-row answer, and a host deciding between the
 * modes needs to see it rather than be told "sensitive routes stay local".
 */
export function destinationOf(row: EgressRow, mode: PrivacyMode): 'provider' | 'local' | 'nothing' {
  if (row.byDefault === 'off') return 'nothing';
  if (mode === 'local_only') return 'local';
  if (row.byDefault === 'local') return 'local';
  return mode === 'hybrid' && row.hybridMovesLocal ? 'local' : 'provider';
}

/** The surfaces that still reach a provider in a mode. For the wizard's summary and for `doctor`. */
export function providerSurfaces(mode: PrivacyMode): readonly EgressRow[] {
  return EGRESS_MANIFEST.filter((row) => destinationOf(row, mode) === 'provider');
}

/**
 * Provider-specific hygiene (`08` §3.11.1's trailing list).
 *
 * Three claims a host can check, and each is enforced somewhere in code rather than only promised
 * here. The third is the one that is **not** enforceable by us and says so: prompt caches are
 * org-scoped by the provider, so one key per instance is advice, and sharing a key across
 * unrelated instances would let one group's cached prefix serve another's. `doctor` warns; nothing
 * can prevent it from inside the process.
 */
export const PROVIDER_HYGIENE: readonly {
  readonly claim: string;
  readonly enforcedBy: string | undefined;
}[] = Object.freeze([
  Object.freeze({
    claim: 'OpenAI Responses API calls set `store: false`, so nothing is retained on their disk.',
    enforcedBy: 'packages/models/src/openai/request.ts — assertWireInvariants',
  }),
  Object.freeze({
    claim: 'The Anthropic Files API is never used for a member’s content.',
    // Nothing calls it, which is the enforcement: the adapter has no Files code path at all.
    enforcedBy: 'packages/models/src/anthropic — no Files API call exists',
  }),
  Object.freeze({
    claim:
      'Use one API key per instance. Prompt caches are org-scoped by providers, so a key shared ' +
      'between unrelated instances lets one group’s cached prefix serve another’s.',
    // Honest: this cannot be checked from inside the process. `doctor` can only advise.
    enforcedBy: undefined,
  }),
]);

/** Why a route cannot be used in Local-only mode. */
export interface LocalOnlyProblem {
  readonly route: ModelRoute;
  readonly variant: string;
  readonly provider: string;
  readonly detail: string;
  /** What a host should do, in the words `doctor` prints. */
  readonly fix: string;
}

/**
 * Providers that are, by definition, not on this machine.
 *
 * A **denylist of the three cloud providers** rather than an allowlist of local ones, and the
 * direction is deliberate: a host can configure a provider id this build has never heard of
 * (`models.registryOverrides`), and an allowlist would refuse it. A cloud provider is a known,
 * closed set; "somewhere on my network" is not.
 *
 * `fake` is not here because it reaches no network at all — it is the eval gateway, and refusing it
 * would mean a Local-only instance could not run its own scenario suite.
 */
const CLOUD_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google'];

/** Whether a host name is this machine or a network the host explicitly allowlisted. */
export function isLocalDestination(
  baseUrl: string | undefined,
  allowPrivate: readonly string[],
): boolean {
  // No base URL means the provider's own default endpoint, which for a cloud provider is the
  // internet and for a local one is a misconfiguration the resolver already refuses.
  if (baseUrl === undefined || baseUrl === '') return false;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  // `isLoopbackHost` and **not** a regex here. The first version tested `/^127\./` against the
  // hostname, which matches `127.0.0.1.evil.example` — a name whose owner decides where it
  // resolves. A host who turned on `privacy.localOnly` would have had a route to it accepted as
  // this machine. Found by a test written for exactly that shape; the hardened check lives in
  // `shared/net` because answering it needs `node:net`'s `isIP`.
  if (isLoopbackHost(url.hostname)) return true;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  // A LAN or host-listed model host: allowed only because the host wrote down the exact
  // `host:port`, which is `08` §3.9's mechanism and the same one `safeFetch` reads.
  return allowPrivate.includes(`${url.hostname.toLowerCase().replace(/\.$/, '')}:${port}`);
}

export interface LocalOnlyInput {
  readonly bindings: readonly RouteBinding[];
  /** `network.egress.allowPrivate`. Exact `host:port` entries the host wrote down. */
  readonly allowPrivate: readonly string[];
  /** `search.enabled` — `08` §3.11.2 disables web search in Local-only. */
  readonly webSearchEnabled?: boolean;
  /** `update.checkEnabled` — off in Local-only. */
  readonly updateCheckEnabled?: boolean;
  /** Whether transcription is configured to use an API rather than a local model. */
  readonly transcribeUsesApi?: boolean;
  /** Whether embeddings are configured to use an API rather than a local model. */
  readonly embedUsesApi?: boolean;
  /** Remote MCP servers that are not on the allowlist (`08` §3.11.2). */
  readonly unallowlistedRemoteMcp?: readonly string[];
}

/**
 * Everything that makes a configuration fail `privacy.localOnly`.
 *
 * Returns every problem rather than the first, because a host fixing this is editing a config file
 * and deserves the whole list — `08` §3.11.2's fail-closed boot is a refusal, and a refusal that
 * reveals one problem per restart is five restarts.
 *
 * **Why this refuses rather than silently rewriting the routes to local.** A rewrite would need a
 * local model to rewrite *to*, and if one were reachable the host would have chosen the Local
 * preset. Guessing one would mean booting with a model nobody chose, answering a family's
 * questions with it, and reporting success. The refusal names the route and the fix.
 */
/**
 * The route half, with the all-cloud case collapsed to one sentence.
 *
 * **Found by running `14`'s M2 demo step 3.** The first version emitted one paragraph per route,
 * so a host on the default `best` preset got **seven** near-identical paragraphs whose real answer
 * was a single line: set the preset to `local`. `CLAUDE.md` §8 asks for a clear fix-it message for
 * every error, and seven copies of one message is not clearer than one — it is the same
 * information arranged to look like seven problems.
 *
 * So: every route on a cloud provider becomes **one** problem naming the preset; a mixture is
 * listed per route, because then the host really does have to change specific ones.
 */
function routeProblems(input: LocalOnlyInput): readonly LocalOnlyProblem[] {
  const cloudBindings = input.bindings.filter((binding) =>
    CLOUD_PROVIDERS.includes(binding.provider as ProviderId),
  );
  const first = cloudBindings[0];
  if (
    first !== undefined &&
    cloudBindings.length === input.bindings.length &&
    input.bindings.length > 1
  ) {
    const providers = [...new Set(cloudBindings.map((binding) => binding.provider))].toSorted();
    return [
      {
        route: first.route,
        variant: first.variant,
        provider: providers.join(', '),
        detail: `every model route resolves to a cloud provider (${providers.join(', ')})`,
        fix: 'Set models.preset to "local" and models.local.model to an installed model, then restart. privacy.localOnly refuses to start rather than send a group’s conversations to a provider.',
      },
    ];
  }

  const problems: LocalOnlyProblem[] = [];
  for (const binding of input.bindings) {
    const cloud = CLOUD_PROVIDERS.includes(binding.provider as ProviderId);
    const local = isLocalDestination(binding.baseUrl, input.allowPrivate);
    if (!cloud && local) continue;
    if (!cloud && binding.baseUrl === undefined) {
      // A non-cloud provider with no base URL: the resolver already refuses this, so reaching
      // here means a registry override introduced a provider with no endpoint.
      problems.push({
        route: binding.route,
        variant: binding.variant,
        provider: binding.provider,
        detail: `"${binding.slot}" uses provider "${binding.provider}" with no base URL, so there is no way to tell whether it is on this machine`,
        fix: `Set models.baseUrls.${binding.provider} to the server's address, or switch this route to a local model.`,
      });
      continue;
    }
    if (!cloud && !local) {
      problems.push({
        route: binding.route,
        variant: binding.variant,
        provider: binding.provider,
        detail: `"${binding.slot}" points at ${hostOf(binding.baseUrl)}, which is neither this machine nor an address you allowlisted`,
        fix: `Add "${hostPortOrBlank(binding.baseUrl)}" to network.egress.allowPrivate if that server is yours, or switch this route to a local model.`,
      });
      continue;
    }
    problems.push({
      route: binding.route,
      variant: binding.variant,
      provider: binding.provider,
      detail: `"${binding.slot}" resolves to ${binding.provider}, which is a cloud provider`,
      fix: `Set models.routes.${binding.slot} to a local model, then restart. privacy.localOnly refuses to start rather than send this route to a provider.`,
    });
  }
  return problems;
}

export function localOnlyProblems(input: LocalOnlyInput): readonly LocalOnlyProblem[] {
  const problems: LocalOnlyProblem[] = [...routeProblems(input)];

  if (input.webSearchEnabled === true) {
    problems.push(
      nonRouteProblem(
        'web search is enabled, and a query string is the member’s own words',
        'Set search.enabled to false, or turn off privacy.localOnly.',
      ),
    );
  }
  if (input.updateCheckEnabled === true) {
    problems.push(
      nonRouteProblem(
        'the update check is enabled, which reveals this machine’s IP address to the release host',
        'Set update.checkEnabled to false, or turn off privacy.localOnly.',
      ),
    );
  }
  if (input.transcribeUsesApi === true) {
    problems.push(
      nonRouteProblem(
        'transcription is configured to use an API, which would send the audio of a voice note',
        'Remove the transcription API configuration so the local model is used.',
      ),
    );
  }
  if (input.embedUsesApi === true) {
    problems.push(
      nonRouteProblem(
        'embeddings are configured to use an API, which would send memory texts including private ones',
        'Remove the embedding API configuration so the local model is used.',
      ),
    );
  }
  for (const server of input.unallowlistedRemoteMcp ?? []) {
    problems.push(
      nonRouteProblem(
        `the remote MCP server "${server}" is not allowlisted`,
        `Add "${server}" to the MCP allowlist if you trust it, or remove it.`,
      ),
    );
  }

  return problems;
}

/**
 * The non-route half of a Local-only check, read off a loaded config.
 *
 * Structurally typed rather than taking `Config`: `@comvivo/models` has no business depending on
 * the whole configuration surface to answer four questions, and a structural parameter cannot
 * drift from the schema without a compile error at the call site. The alternative — a caller
 * hand-translating `embeddings.provider !== 'local'` into `embedUsesApi` — is the drift this
 * avoids, because the translation would then live in however many call sites there are.
 *
 * `webSearchEnabled` is **not** derived here: the instance-level `web_search` tool is off by
 * default and its config key lands with the tool itself (`05` §3.6.7 row 13). Until then a caller
 * passes `false`, which is the truth, rather than reading a key that does not exist.
 */
export function localOnlySettingsFrom(config: {
  readonly embeddings: { readonly provider: string };
  readonly transcription: { readonly provider: string };
  readonly updates: { readonly check: boolean };
}): Pick<LocalOnlyInput, 'embedUsesApi' | 'transcribeUsesApi' | 'updateCheckEnabled'> {
  return {
    embedUsesApi: !LOCAL_EMBEDDING_PROVIDERS.includes(config.embeddings.provider),
    transcribeUsesApi: !LOCAL_TRANSCRIPTION_PROVIDERS.includes(config.transcription.provider),
    updateCheckEnabled: config.updates.check,
  };
}

/**
 * Embedding providers that run on this machine.
 *
 * **`ollama` is one of them**, which is the whole reason this is a list rather than
 * `provider !== 'local'`. The config enum lists `ollama` beside the three cloud providers, and
 * treating "not the string `local`" as "remote" would refuse a Local-only instance embedding
 * through its own Ollama — which is precisely the configuration Local-only is for.
 */
const LOCAL_EMBEDDING_PROVIDERS: readonly string[] = ['local', 'ollama'];

/**
 * Transcription providers that run on this machine.
 *
 * Only `local` today: the config enum's other three (`openai`, `groq`, `deepgram`) are all APIs.
 * A list anyway, so adding a local runtime is a one-line change here rather than a condition
 * somebody has to notice is now wrong.
 */
const LOCAL_TRANSCRIPTION_PROVIDERS: readonly string[] = ['local'];

/** A problem that is not about a model route. `chat` stands in so the shape stays uniform. */
function nonRouteProblem(detail: string, fix: string): LocalOnlyProblem {
  return { route: 'chat', variant: 'default', provider: '—', detail, fix };
}

function hostOf(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return 'an unknown address';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'an unparseable address';
  }
}

function hostPortOrBlank(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return '';
  try {
    const url = new URL(baseUrl);
    const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
    return `${url.hostname}:${port}`;
  } catch {
    return '';
  }
}

/**
 * The routes Hybrid moves onto the local model (`08` §3.11.2).
 *
 * `extract` is **not** here even though DM extraction is: the move is per-*conversation-kind*, not
 * per route, and the resolver binds routes. So `extract` keeps its cloud binding and the engine
 * picks the local one for a DM — which is why `hybridExtractIsPerConversation` exists as a named
 * fact rather than a comment nobody reads.
 */
export const HYBRID_LOCAL_ROUTES: readonly ModelRoute[] = Object.freeze(['declassify', 'guard']);

/**
 * Hybrid's DM-extraction rule, stated as a function.
 *
 * `08` §3.11.2 moves "DM `extract`" local, which is a decision the **engine** makes per turn
 * because only it knows whether the conversation is a DM. The resolver cannot: it binds a route
 * once at boot. This function is where that asymmetry is written down, so `M6`'s extraction
 * scheduler reads a rule rather than re-deriving one.
 */
export function hybridExtractIsLocal(mode: PrivacyMode, conversation: 'group' | 'dm'): boolean {
  if (mode === 'local_only') return true;
  return mode === 'hybrid' && conversation === 'dm';
}

/** Whether a route's own binding should be the local one, before the per-turn rules apply. */
export function routeRunsLocal(mode: PrivacyMode, route: ModelRoute): boolean {
  if (mode === 'local_only') return true;
  return mode === 'hybrid' && HYBRID_LOCAL_ROUTES.includes(route);
}

/**
 * Hybrid's own boot requirement: a reachable local model (`08` §3.11.2).
 *
 * Returns a problem rather than throwing, so the caller composes it with the route problems and a
 * host sees one list. Hybrid without a local model is not a degraded Hybrid — it is Cloud with a
 * setting that reads as a privacy guarantee, which is the worst of the three outcomes.
 */
export function hybridProblem(input: {
  readonly mode: PrivacyMode;
  readonly localModelReachable: boolean;
}): LocalOnlyProblem | undefined {
  if (input.mode !== 'hybrid' || input.localModelReachable) return undefined;
  return nonRouteProblem(
    'privacy.sensitiveRoutesLocal is on, but no local model is reachable',
    'Start your local model server (or set models.local.baseUrl), then restart. Hybrid refuses to start rather than send these routes to a provider.',
  );
}

/** Raised when a configuration cannot honour the privacy mode it asked for. */
export class PrivacyModeError extends Error {
  readonly mode: PrivacyMode;
  readonly problems: readonly LocalOnlyProblem[];

  constructor(mode: PrivacyMode, problems: readonly LocalOnlyProblem[]) {
    const lines = problems.map((problem) => `  ${problem.detail}\n    → ${problem.fix}`);
    super(
      `${String(problems.length)} problem(s) prevent ${
        mode === 'local_only' ? 'privacy.localOnly' : 'privacy.sensitiveRoutesLocal'
      } from being honoured:\n${lines.join('\n')}`,
    );
    this.name = 'PrivacyModeError';
    this.mode = mode;
    this.problems = problems;
  }
}

export interface PrivacyCheckInput extends LocalOnlyInput {
  readonly privacy: PrivacySettings;
  /** Whether a local model answered its probe. Only read in Hybrid. */
  readonly localModelReachable?: boolean;
}

/**
 * Every problem with a configuration, for the mode it asked for.
 *
 * One entry point rather than three, because the mode decides which checks apply and a caller that
 * had to know that would eventually get it wrong. Cloud mode has nothing to check: it is the
 * default and makes no promise beyond the manifest.
 */
export function privacyProblems(input: PrivacyCheckInput): readonly LocalOnlyProblem[] {
  const mode = privacyModeOf(input.privacy);
  if (mode === 'cloud') return [];
  if (mode === 'hybrid') {
    const problem = hybridProblem({
      mode,
      localModelReachable: input.localModelReachable ?? false,
    });
    return problem === undefined ? [] : [problem];
  }
  return localOnlyProblems(input);
}

/**
 * Fail closed, or return.
 *
 * The function a boot calls. It exists now, before there is a boot to call it, for the same reason
 * `resolveRoutesOrThrow` did at `M2-T2`: when `M3` wires the composition root it calls **one**
 * function and fail-closed is automatic, rather than being a second step somebody has to remember
 * next to the route resolution. A privacy mode that silently degraded because a wiring step was
 * forgotten is exactly the failure `08` §3.11.2 is written to prevent — and it has no symptom a
 * host could notice.
 *
 * Throws with **every** problem, so a host editing a config file fixes them in one pass.
 */
export function assertPrivacyOrThrow(input: PrivacyCheckInput): void {
  const problems = privacyProblems(input);
  if (problems.length === 0) return;
  throw new PrivacyModeError(privacyModeOf(input.privacy), problems);
}

/**
 * The dashboard badge, if any (`08` §3.11.2).
 *
 * Hybrid has **no badge**, which is a deliberate asymmetry: `08` §3.11.2 names a badge only for
 * Local-only, and D-6 says Hybrid is not pre-selected anywhere. A badge saying "Hybrid" would read
 * as a stronger promise than it is — `chat`, which is most of what a group sends, still goes to a
 * provider.
 */
export function privacyBadge(mode: PrivacyMode): string | undefined {
  return mode === 'local_only' ? 'Local-only' : undefined;
}

/**
 * The sentence a Local-only host sees, which has to correct the obvious misreading.
 *
 * `08` §3.11.2: "Local-only means 'no AI provider', not 'offline'." A host who read the badge as
 * "nothing leaves this machine" would be making a decision on a false premise — Telegram still
 * sees the group's chat, because Telegram *is* the group's chat.
 */
export const LOCAL_ONLY_DISCLOSURE =
  'No AI provider sees your conversations: every model runs on this machine or on a server you ' +
  'listed. Your chat platform still carries your messages, because that is where your group talks. ' +
  'For a fully offline setup, use the web channel with a Matrix server on your own network.';
