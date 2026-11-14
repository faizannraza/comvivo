/**
 * Shared fixtures for the OpenAI adapter's tests (`M2-T11`).
 *
 * A real `RouteBinding` built from the registry's own row, for the same reason the Anthropic
 * fixtures do it: the question these tests answer is "does the adapter honour what `05` §3.5.2 says
 * about this model", and a fixture that invented its own capabilities would answer a different one.
 */
import type { ModelTurnRequest } from '@comvivo/core';
import { lookupCapabilities, type ModelCapabilities, toFeatureSet } from '../../registry/index.js';
import type { RouteBinding } from '../../registry/resolve.js';

/**
 * The model the contract tests run against.
 *
 * `gpt-6.1-sol` rather than the flagship `gpt-6-astra`: it is the mid-tier reasoning model, which
 * is the shape a host would actually route `chat` to, and it has a priced row.
 */
export const OPENAI_MODEL = 'gpt-6.1-sol';

/** The registry's `openai/*` family row, so a capability change shows up in these tests. */
export function openaiCapabilities(): ModelCapabilities {
  const found = lookupCapabilities(`openai/${OPENAI_MODEL}`);
  if (found === undefined) throw new Error('the registry has no row matching openai/*');
  return found;
}

export function openaiBinding(overrides: Partial<RouteBinding> = {}): RouteBinding {
  const capabilities = overrides.capabilities ?? openaiCapabilities();
  // Annotated, or the literals widen to `string` and the spread below stops being a
  // `RouteBinding`. `priceId` is omitted because it is derived from this.
  const base: Omit<RouteBinding, 'priceId'> = {
    route: 'chat',
    variant: 'default',
    slot: 'chat',
    provider: 'openai',
    model: OPENAI_MODEL,
    capabilityKey: 'openai/*',
    capabilities,
    features: toFeatureSet(capabilities),
    effortDefault: capabilities.defaultEffort,
    maxOutputTokens: 8_000,
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
    priceId: overrides.priceId ?? base.capabilities.priceKey ?? `openai/${base.model}`,
  };
}

/** A minimal, valid turn request. Every test starts from this and changes one thing. */
export function openaiTurnRequest(overrides: Partial<ModelTurnRequest> = {}): ModelTurnRequest {
  return {
    route: 'chat',
    purpose: 'turn.reply',
    system: [{ id: 'charter', text: 'be useful', cache: { ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: 'auto',
    effort: 'medium',
    maxOutputTokens: 8_000,
    correlation: {},
    ...overrides,
  };
}
