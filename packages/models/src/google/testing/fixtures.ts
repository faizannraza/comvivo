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
  return {
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
