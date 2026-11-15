/**
 * Static hints from a local server's own metadata (`05` §3.5.6 step 2; `M2-T12`).
 *
 * ## Hints, and why that word is in the spec
 *
 * `05` §3.5.6: "Treat the field names as hints and verify them." The reason is concrete. Ollama's
 * `/api/show` returns `capabilities: ["completion","tools","thinking","vision"]`, which is real
 * metadata from the model's GGUF — and a model whose metadata claims `tools` can still fail the
 * tool probe, because tool calling depends on the **chat template** the server applies, not only
 * on the weights. llama.cpp is the clearest case: the same GGUF with and without `--jinja` differs
 * on whether tool calls come out at all, and nothing in the model's metadata knows which way the
 * server was started.
 *
 * So a hint can **lower** the work the probes have to do and can never raise the answer:
 *
 *  - A `contextWindow` hint means the 16K needle probe can be skipped, and — more useful — a host
 *    whose window is 8K is told *before* a turn runs rather than after one is truncated.
 *  - A `tools: false` hint lets `doctor` print the right advice while the probe still runs.
 *  - A `vision` hint decides whether images are offered at all, because sending one to a text-only
 *    model is a wasted turn with a confusing failure.
 *
 * Verified 2026-11-13: Ollama `/api/show` carries `capabilities[]` and `model_info` with an
 * architecture-prefixed `<arch>.context_length`. The prefix varies by model and the value varies by
 * **quantisation** — a Q4_0 and a Q5_K_M of one base model can report different numbers — which is
 * the second reason this is a hint.
 */
import type { Logger } from '@comvivo/shared';
import { type EgressPolicy, safeFetch } from '@comvivo/shared/net';
import { type LocalServerKind, rootOf, type ServerIdentity } from './identify.js';

/** What a server's metadata claims. Every field absent means "it did not say". */
export interface StaticHints {
  readonly tools?: boolean;
  readonly thinking?: boolean;
  readonly vision?: boolean;
  readonly contextWindow?: number;
}

export interface HintsDeps {
  readonly logger: Logger;
  readonly policy: EgressPolicy;
  readonly fetch?: typeof safeFetch;
}

/**
 * The context length out of Ollama's `model_info`.
 *
 * The key is `<architecture>.context_length` and the architecture is whatever the GGUF says —
 * `gemma4`, `llama`, `qwen3`. So the lookup is by **suffix** rather than by a list of architecture
 * names we would have to keep current with every model release.
 */
export function contextLengthFromModelInfo(modelInfo: unknown): number | undefined {
  if (typeof modelInfo !== 'object' || modelInfo === null) return undefined;
  for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
    if (!key.endsWith('.context_length')) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** Ollama's `/api/show`. The only server that needs a second request for its hints. */
async function ollamaHints(
  deps: HintsDeps,
  root: string,
  model: string,
  signal: AbortSignal,
): Promise<StaticHints> {
  const request = deps.fetch ?? safeFetch;
  try {
    const response = await request(
      `${root}/api/show`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
        signal,
      },
      { purpose: 'local-model', policy: deps.policy, signal },
    );
    if (!response.ok) return {};
    const parsed: unknown = await response.json();
    if (typeof parsed !== 'object' || parsed === null) return {};
    const bag = parsed as Record<string, unknown>;

    const raw = bag['capabilities'];
    const capabilities = Array.isArray(raw)
      ? new Set(raw.filter((item): item is string => typeof item === 'string'))
      : undefined;
    const contextWindow = contextLengthFromModelInfo(bag['model_info']);

    return {
      // Absent when the server listed no capabilities at all, which is different from listing them
      // and omitting `tools` — the first is "it did not say" and the second is a real `false`.
      ...(capabilities === undefined ? {} : { tools: capabilities.has('tools') }),
      ...(capabilities === undefined ? {} : { thinking: capabilities.has('thinking') }),
      ...(capabilities === undefined ? {} : { vision: capabilities.has('vision') }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  } catch {
    // A server that will not answer `/api/show` is still usable; the probes decide. Nothing is
    // logged for a missing hint, because the absence is the normal case for three of four servers.
    return {};
  }
}

/**
 * Hints for whichever server answered.
 *
 * Only Ollama needs another request: llama.cpp and LM Studio already reported their context window
 * and vision support during identification, so re-asking would be a second round trip for data we
 * hold. vLLM and `generic` report neither, which is why the probes are authoritative rather than a
 * confirmation step.
 */
export async function staticHintsFor(
  deps: HintsDeps,
  identity: ServerIdentity,
  baseUrl: string,
  model: string,
  signal: AbortSignal,
): Promise<StaticHints> {
  const fromIdentity: StaticHints = {
    ...(identity.contextWindowHint === undefined
      ? {}
      : { contextWindow: identity.contextWindowHint }),
    ...(identity.visionHint === undefined ? {} : { vision: identity.visionHint }),
  };

  if (identity.kind !== 'ollama') return fromIdentity;
  return { ...fromIdentity, ...(await ollamaHints(deps, rootOf(baseUrl), model, signal)) };
}

/**
 * The server-specific sentence `doctor` prints when the context window is too small.
 *
 * Named knobs, because "raise the server context" is not actionable: a host running llama.cpp
 * cannot set `OLLAMA_CONTEXT_LENGTH`, and telling them to is worse than saying nothing. `05`
 * §3.5.6 asks for this advice; this is the table behind it.
 */
export function contextAdviceFor(kind: LocalServerKind): string {
  switch (kind) {
    case 'ollama':
      return 'Raise the server context with OLLAMA_CONTEXT_LENGTH (for example 32768) and restart Ollama, or switch to the compact prompt profile.';
    case 'llama_cpp':
      return 'Restart llama-server with a larger -c/--ctx-size (for example -c 32768), or switch to the compact prompt profile.';
    case 'lmstudio':
      return 'Raise the loaded model’s context length in LM Studio’s model settings, or switch to the compact prompt profile.';
    case 'vllm':
      return 'Restart vLLM with a larger --max-model-len (for example 32768), or switch to the compact prompt profile.';
    case 'generic':
      return 'Raise the model’s context window in your server’s configuration, or switch to the compact prompt profile.';
  }
}

/**
 * The flags a server needs before tools work at all.
 *
 * `05` §3.5.6's rationale list, turned into advice. Printed by `doctor` when the tool probe fails
 * on a server whose metadata claimed `tools` — which is the common case and the confusing one,
 * because the host can see their model supports tools and cannot see why the bot will not use them.
 */
export function toolFlagAdviceFor(kind: LocalServerKind): string | undefined {
  switch (kind) {
    case 'llama_cpp':
      return 'llama-server needs --jinja for tool calling. Restart it with that flag.';
    case 'vllm':
      return 'vLLM needs --enable-auto-tool-choice and --tool-call-parser <parser> for automatic tool calling. Restart it with both.';
    case 'ollama':
    case 'lmstudio':
    case 'generic':
      // Nothing to add: on these three a failed tool probe means the model or its chat template
      // does not do tool calling, which a flag cannot fix.
      return undefined;
  }
}
