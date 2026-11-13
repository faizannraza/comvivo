/**
 * Shared fixtures for the Anthropic adapter's tests (`M2-T6`).
 *
 * A real `RouteBinding` built from the real registry row, not a hand-written object: the whole
 * question these tests answer is "does the adapter honour what `05` §3.5.2 says about this model",
 * and a fixture that invented its own capabilities would answer a different one. The
 * `adaptive_always` thinking mode is exactly the kind of value that got missed by reading.
 */
import type { Effort, ModelTurnRequest, ToolSpec } from '@comvivo/core';
import { lookupCapabilities, type ModelCapabilities, toFeatureSet } from '../../registry/index.js';
import type { RouteBinding } from '../../registry/resolve.js';

export const OPUS = 'claude-opus-5-5';

/** The registry's own row for Opus 5.5, so a capability change shows up in these tests. */
export function opusCapabilities(): ModelCapabilities {
  const found = lookupCapabilities(`anthropic/${OPUS}`);
  if (found === undefined) throw new Error(`the registry has no row for anthropic/${OPUS}`);
  return found;
}

export function bindingFor(overrides: Partial<RouteBinding> = {}): RouteBinding {
  const capabilities = overrides.capabilities ?? opusCapabilities();
  return {
    route: 'chat',
    variant: 'default',
    slot: 'chat',
    provider: 'anthropic',
    model: OPUS,
    capabilityKey: `anthropic/${OPUS}`,
    capabilities,
    features: toFeatureSet(capabilities),
    effortDefault: capabilities.defaultEffort,
    maxOutputTokens: 8000,
    attemptTimeoutMs: 30_000,
    maxRetries: 0,
    ...overrides,
  };
}

/** A minimal, valid turn request. Every test starts from this and changes one thing. */
export function turnRequest(overrides: Partial<ModelTurnRequest> = {}): ModelTurnRequest {
  const effort: Effort = 'medium';
  return {
    route: 'chat',
    purpose: 'turn.reply',
    system: [{ id: 'charter', text: 'be useful', cache: { ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: 'auto',
    effort,
    maxOutputTokens: 8000,
    correlation: {},
    ...overrides,
  };
}

/** A strict tool schema, as `M2-T4`'s converter emits one. */
export function toolSpec(name = 'get_forecast'): ToolSpec {
  return {
    name,
    description: 'Return a short weather summary for one city.',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  };
}
