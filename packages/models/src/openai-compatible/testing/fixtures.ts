/**
 * Fixtures for the local adapter's tests (`M2-T12`).
 *
 * The `local/*` registry row is a deliberately pessimistic wildcard — 8K context, no tools, no
 * vision — because it has to hold for *any* model a host loads. So these fixtures take the row and
 * let a test raise one field at a time, which is how the ladder's levels get exercised against
 * something that resembles a real server rather than against an invented capability set.
 */
import type { ModelTurnRequest, ToolSpec } from '@comvivo/core';
import { lookupCapabilities, type ModelCapabilities, toFeatureSet } from '../../registry/index.js';
import type { RouteBinding } from '../../registry/resolve.js';
import type { LocalServerFacade } from '../../testing/index.js';

/** A model id of the shape Ollama uses, so a test reading a log line sees something plausible. */
export const LOCAL_MODEL = 'gemma4:12b';

export function localCapabilities(): ModelCapabilities {
  const found = lookupCapabilities(`local/${LOCAL_MODEL}`);
  if (found === undefined) throw new Error('the registry has no row matching local/*');
  return found;
}

export function localBinding(overrides: Partial<RouteBinding> = {}): RouteBinding {
  const capabilities = overrides.capabilities ?? localCapabilities();
  // Annotated, or the literals widen to `string` and the spread below stops being a
  // `RouteBinding`. `priceId` is omitted because it is derived from this.
  const base: Omit<RouteBinding, 'priceId'> = {
    route: 'chat',
    variant: 'default',
    slot: 'chat',
    // What `resolveRoutes` actually produces: the provider is the **registry id's prefix**, so a
    // `local/qwen3` route gives `local`, not the adapter's `openai-compatible`. This fixture said
    // `openai-compatible` until the M2 review, which made it the one place where the two
    // namespaces looked identical and hid that the middleware was conflating them.
    provider: 'local',
    model: LOCAL_MODEL,
    capabilityKey: 'local/*',
    capabilities,
    features: toFeatureSet(capabilities),
    effortDefault: capabilities.defaultEffort,
    maxOutputTokens: 2_048,
    attemptTimeoutMs: 30_000,
    maxRetries: 0,
    ...overrides,
  };
  // Derived after the overrides, exactly as `resolveRoutes` derives it — `capabilities.priceKey`
  // when the registry sets one, else `<provider>/<model>`. A fixed literal here would have made
  // every `bindingFor({ model: … })` test price against the default model, which is the
  // fixture-versus-production gap the M2 review found in this file's `provider` field.
  return {
    ...base,
    priceId: overrides.priceId ?? base.capabilities.priceKey ?? `local/${base.model}`,
  };
}

/** A binding whose model claims vision, for the image-dropping tests. */
export function visionBinding(): RouteBinding {
  const base = localBinding();
  return { ...base, features: { ...base.features, vision: true } };
}

export function localTurnRequest(overrides: Partial<ModelTurnRequest> = {}): ModelTurnRequest {
  return {
    route: 'chat',
    purpose: 'turn.reply',
    system: [{ id: 'charter', text: 'be useful' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: 'auto',
    effort: 'medium',
    maxOutputTokens: 2_048,
    correlation: {},
    ...overrides,
  };
}

export function localToolSpec(name = 'reminder_create'): ToolSpec {
  return {
    name,
    description: 'Create a reminder for somebody in the group.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, at: { type: 'string' } },
      required: ['text', 'at'],
      additionalProperties: false,
    },
  };
}

/**
 * The four servers, as the fake can impersonate them.
 *
 * `05` §3.5.6's AC asks for fixtures for all four, and the point of having all four is that each
 * reports a **different** subset: Ollama needs a second request for its hints, llama.cpp and LM
 * Studio volunteer a context window during identification, and vLLM volunteers nothing but its
 * name. A test suite with one fixture would only ever exercise one of those paths.
 */
export const SERVER_FIXTURES = {
  ollama: {
    kind: 'ollama',
    version: '0.18.2',
    models: [LOCAL_MODEL],
    capabilities: ['completion', 'tools', 'thinking', 'vision'],
    contextWindow: 131_072,
  },
  /** The one whose metadata claims tools and whose server has not been started with `--jinja`. */
  llama_cpp: {
    kind: 'llama_cpp',
    version: 'b7421',
    models: ['/models/gemma4-12b-Q4_K_M.gguf'],
    contextWindow: 8_192,
    vision: false,
  },
  lmstudio: {
    kind: 'lmstudio',
    models: ['gemma4-12b'],
    contextWindow: 32_768,
    vision: true,
  },
  vllm: { kind: 'vllm', models: [LOCAL_MODEL] },
} satisfies Readonly<Record<string, LocalServerFacade>>;
