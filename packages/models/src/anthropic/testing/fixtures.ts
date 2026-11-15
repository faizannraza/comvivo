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
  // Annotated, or the literals widen to `string` and the spread below stops being a
  // `RouteBinding`. `priceId` is omitted because it is derived from this.
  const base: Omit<RouteBinding, 'priceId'> = {
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
  // Derived after the overrides, exactly as `resolveRoutes` derives it — `capabilities.priceKey`
  // when the registry sets one, else `<provider>/<model>`. A fixed literal here would have made
  // every `bindingFor({ model: … })` test price against the default model, which is the
  // fixture-versus-production gap the M2 review found in this file's `provider` field.
  return {
    ...base,
    priceId: overrides.priceId ?? base.capabilities.priceKey ?? `anthropic/${base.model}`,
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
