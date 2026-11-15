/**
 * Identifying a local model server (`05` §3.5.6 step 1; `M2-T12`).
 *
 * ## Why identify at all
 *
 * All four servers speak Chat Completions, so a request works without knowing which one answered.
 * What differs is everything around it: Ollama has no `tool_choice`, llama.cpp needs `--jinja`
 * before it will emit tool calls at all, vLLM needs two flags, and each exposes a **different**
 * endpoint that reports the loaded model's context length. A host whose server truncates at 8K
 * needs to be told which knob to turn, by name — `OLLAMA_CONTEXT_LENGTH` is useless advice to
 * somebody running llama.cpp.
 *
 * So identification exists to make `doctor`'s advice specific and to decide which static hints are
 * worth asking for. It is never used to *skip* an active probe: `05` §3.5.6 says the probes are
 * authoritative, and a server's own metadata has been wrong about tool support before.
 *
 * ## Through `safeFetch`, not `fetch`
 *
 * The base URL comes from a **host's config**, which makes this the one place in the model layer
 * where the destination is not a pinned vendor endpoint. A typo in `models.local.baseUrl` must not
 * become an SSRF probe of the host's LAN, and DNS rebinding against a long-lived base URL is a
 * real attack. `safeFetch` with the `local-model` purpose carries the timeouts, the redirect ban
 * and the rebinding check; the host's own `host:port` goes on `allowPrivate`, which is the
 * mechanism for "I meant this loopback address" (`08` §3.9).
 *
 * ## Endpoints, verified 2026-11-13
 *
 * | Server | Probe | Tell |
 * |---|---|---|
 * | Ollama | `GET {root}/api/version` | `{ version }` |
 * | llama.cpp | `GET {root}/props` | `default_generation_settings.n_ctx`, `model_path`, `build_info` |
 * | LM Studio | `GET {root}/api/v0/models` | `data[].{type, arch, quantization, max_context_length}` |
 * | vLLM | `GET {root}/v1/models` | `data[].owned_by === 'vllm'` |
 *
 * Three of those carry a **context length**, which `05` §3.5.6 does not mention and which matters:
 * where a static hint reports the window, the 16K needle probe can be skipped and a host who is
 * about to be truncated is told before a single turn runs.
 */

import type { Logger } from '@comvivo/shared';
import { type EgressPolicy, safeFetch } from '@comvivo/shared/net';

/** Which server answered. `generic` is a valid, fully usable answer. */
export type LocalServerKind = 'ollama' | 'lmstudio' | 'llama_cpp' | 'vllm' | 'generic';

/** Every kind, in probe order. Exported so a test cannot miss one. */
export const LOCAL_SERVER_KINDS: readonly LocalServerKind[] = [
  'ollama',
  'llama_cpp',
  'lmstudio',
  'vllm',
  'generic',
];

/**
 * What a server told us about itself.
 *
 * Every field is optional except `kind`, because a `generic` server tells us nothing and that is
 * still a server we can use.
 */
export interface ServerIdentity {
  readonly kind: LocalServerKind;
  /** The server's own version string, for the probe cache key and for `doctor`. */
  readonly version?: string;
  /** Model ids the server reports as available. */
  readonly models?: readonly string[];
  /**
   * The context window the server reports, when it reports one.
   *
   * A **hint**, not a measurement: `05` §3.5.6 says to treat these field names as hints, and the
   * GGUF metadata they come from varies by quantisation — a Q4_0 and a Q5_K_M of one base model can
   * report different numbers. The needle probe is what settles it.
   */
  readonly contextWindowHint?: number;
  /** Whether the server's metadata claims vision. A hint, for the same reason. */
  readonly visionHint?: boolean;
}

export interface IdentifyDeps {
  readonly logger: Logger;
  /**
   * The egress policy, which must list the local server's `host:port` under `allowPrivate`.
   *
   * Passed in rather than built here: a loopback allowlist entry is a host's decision and belongs
   * in config (`08` §3.9), not in a default an adapter invents for itself.
   */
  readonly policy: EgressPolicy;
  /** Injected so the probes are testable without a socket. Defaults to `safeFetch`. */
  readonly fetch?: typeof safeFetch;
}

/** `http://127.0.0.1:11434/v1` → `http://127.0.0.1:11434`. */
export function rootOf(baseUrl: string): string {
  const url = new URL(baseUrl);
  // Only the `/v1` suffix is stripped: anything else in the path is a host's reverse proxy prefix
  // and dropping it would probe the wrong place.
  const path = url.pathname.replace(/\/v1\/?$/, '');
  return `${url.origin}${path}`.replace(/\/$/, '');
}

/** `host:port`, the spelling `allowPrivate` uses. For the config loader and `doctor`. */
export function hostPortOf(baseUrl: string): string {
  const url = new URL(baseUrl);
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return `${url.hostname}:${port}`;
}

/** One GET, parsed as JSON, or `undefined` for anything that is not a 2xx with a JSON body. */
async function getJson(
  deps: IdentifyDeps,
  url: string,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const request = deps.fetch ?? safeFetch;
  try {
    const response = await request(
      url,
      { method: 'GET', signal },
      { purpose: 'local-model', policy: deps.policy, signal },
    );
    if (!response.ok) return undefined;
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // A refusal, a timeout, a connection error, a non-JSON body: all mean "not this server".
    // Identification is a sequence of guesses and a failed guess is the normal case, so nothing is
    // logged here — the caller logs the one answer it settled on.
    return undefined;
  }
}

function stringAt(bag: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = bag?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberAt(bag: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = bag?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function objectAt(
  bag: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = bag?.[key];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `data` as an array of objects, which all four `/models`-shaped endpoints return. */
function dataRows(bag: Record<string, unknown> | undefined): readonly Record<string, unknown>[] {
  const data = bag?.['data'];
  if (!Array.isArray(data)) return [];
  return data.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  );
}

/**
 * Identify the server behind a base URL.
 *
 * Ordered most-specific first, and each probe is a separate request rather than one parallel
 * sweep. Sequential on purpose: four concurrent requests to a server that is *down* produce four
 * connection errors and four log lines for one fact, and a cold Ollama answering its first request
 * slowly would have the other three time out beside it.
 */
export async function identifyServer(
  deps: IdentifyDeps,
  baseUrl: string,
  signal: AbortSignal,
): Promise<ServerIdentity> {
  const root = rootOf(baseUrl);

  // One named reader per server, tried in order. Separate functions rather than one long chain:
  // each reads a different document and `noExcessiveCognitiveComplexity` is right that four
  // inlined shapes in one function is more than a reader can hold.
  const readers: readonly ((
    bag: Record<string, unknown> | undefined,
  ) => ServerIdentity | undefined)[] = [readOllama, readLlamaCpp, readLmStudio, readOpenAiModels];
  const paths = [
    `${root}/api/version`,
    `${root}/props`,
    `${root}/api/v0/models`,
    `${root}/v1/models`,
  ];

  for (const [index, path] of paths.entries()) {
    const bag = await getJson(deps, path, signal);
    const identity = readers[index]?.(bag);
    if (identity !== undefined) return identity;
  }

  // Nothing answered a recognised shape. Still a usable server as far as Chat Completions goes —
  // the probes decide that — so `generic` rather than a failure.
  return { kind: 'generic' };
}

/** `GET {root}/api/version` → `{ version }`. */
function readOllama(bag: Record<string, unknown> | undefined): ServerIdentity | undefined {
  const version = stringAt(bag, 'version');
  return version === undefined ? undefined : { kind: 'ollama', version };
}

/** `GET {root}/props` → the generation settings, the model alias and the build info. */
function readLlamaCpp(bag: Record<string, unknown> | undefined): ServerIdentity | undefined {
  if (bag === undefined) return undefined;
  const settings = objectAt(bag, 'default_generation_settings');
  const modality = objectAt(bag, 'modalities');
  const alias = stringAt(bag, 'model_alias') ?? stringAt(bag, 'model_path');
  const build = stringAt(bag, 'build_info');
  const nCtx = numberAt(settings, 'n_ctx');
  return {
    kind: 'llama_cpp',
    ...(build === undefined ? {} : { version: build }),
    ...(alias === undefined ? {} : { models: [alias] }),
    ...(nCtx === undefined ? {} : { contextWindowHint: nCtx }),
    ...(modality?.['vision'] === undefined ? {} : { visionHint: modality['vision'] === true }),
  };
}

/**
 * `GET {root}/api/v0/models` → LM Studio's own REST surface.
 *
 * Versioned separately from its OpenAI-compatible one and reports far more: a `type` of `vlm` is
 * the vision tell, and `max_context_length` is the loaded model's real window.
 */
function readLmStudio(bag: Record<string, unknown> | undefined): ServerIdentity | undefined {
  const rows = dataRows(bag);
  if (rows.length === 0) return undefined;
  const loaded = rows.find((row) => row['state'] === 'loaded') ?? rows[0];
  const window = numberAt(loaded, 'max_context_length');
  return {
    kind: 'lmstudio',
    models: rows.flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : [])),
    ...(window === undefined ? {} : { contextWindowHint: window }),
    ...(loaded?.['type'] === undefined ? {} : { visionHint: loaded['type'] === 'vlm' }),
  };
}

/** `GET {root}/v1/models` → vLLM when any row is `owned_by: 'vllm'`, otherwise generic. */
function readOpenAiModels(bag: Record<string, unknown> | undefined): ServerIdentity | undefined {
  const rows = dataRows(bag);
  if (rows.length === 0) return undefined;
  return {
    kind: rows.some((row) => row['owned_by'] === 'vllm') ? 'vllm' : 'generic',
    models: rows.flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : [])),
  };
}

/**
 * The flavour name `11` §3.10.2 wants on a span.
 *
 * `generic` has no `gen_ai.provider.name` of its own, so it maps to `undefined` and the telemetry
 * layer falls back to the provider id. Inventing a name for an unknown server would put a value in
 * a dashboard filter that means "we did not know".
 */
export function spanFlavourOf(kind: LocalServerKind): string | undefined {
  return kind === 'generic' ? undefined : kind;
}
