/**
 * Shared fixtures for the Google adapter's tests (`M2-T13`).
 *
 * A real `RouteBinding` from the registry's own `google/*` row, so a capability change shows up
 * here rather than in production.
 */
import type { ModelTurnRequest } from '@comvivo/core';
import { lookupCapabilities, type ModelCapabilities, toFeatureSet } from '../../registry/index.js';
import type { RouteBinding } from '../../registry/resolve.js';

/** `gemini-3.8-flash`: the current stable flash model, which is the shape a host would route to. */
export const GOOGLE_MODEL = 'gemini-3.8-flash';

export function googleCapabilities(): ModelCapabilities {
  const found = lookupCapabilities(`google/${GOOGLE_MODEL}`);
  if (found === undefined) throw new Error('the registry has no row matching google/*');
  return found;
}

export function googleBinding(overrides: Partial<RouteBinding> = {}): RouteBinding {
  const capabilities = overrides.capabilities ?? googleCapabilities();
  // Annotated, or the literals widen to `string` and the spread below stops being a
  // `RouteBinding`. `priceId` is omitted because it is derived from this.
  const base: Omit<RouteBinding, 'priceId'> = {
    route: 'chat',
    variant: 'default',
    slot: 'chat',
    provider: 'google',
    model: GOOGLE_MODEL,
    capabilityKey: 'google/*',
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
    priceId: overrides.priceId ?? base.capabilities.priceKey ?? `google/${base.model}`,
  };
}

export function googleTurnRequest(overrides: Partial<ModelTurnRequest> = {}): ModelTurnRequest {
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
