/**
 * `M2-T5`: the capability and risk vocabulary.
 *
 * The capability tests are mostly about the *plugin* form, because the domain list is a
 * transcription of `03` §3.1.2 and the interesting failures are all in the syntax: a provider id
 * with a double hyphen, a tool name with a double underscore, a wildcard in the wrong position.
 * Each of those produces a capability string that looks plausible and matches nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  type Capability,
  capabilitySchema,
  DOMAIN_CAPABILITIES,
  isCapability,
  isDomainCapability,
  isPluginCapability,
  isProviderId,
  isToolLocalName,
  parsePluginCapability,
  pluginCapability,
  pluginWildcardCapability,
} from './capability.js';
import { atLeastRisk, maxRisk, RISK_LEVELS, type Risk, riskRank, riskSchema } from './risk.js';

describe('the domain catalog', () => {
  it('has no duplicates', () => {
    expect(new Set(DOMAIN_CAPABILITIES).size).toBe(DOMAIN_CAPABILITIES.length);
  });

  it('includes the additions 01 §14 A6 requires from 07, 09 and 10', () => {
    // A6 names these six specifically, and they are the ones most likely to be dropped in a
    // transcription because `01` §7.3's older list does not have them.
    for (const capability of [
      'audit.read',
      'usage.read',
      'dashboard.access',
      'extensions.manage',
      'mcp.connect',
      'participate',
    ] as const) {
      expect(isDomainCapability(capability)).toBe(true);
    }
  });

  it('includes the five Floor rights 03 §3.1.2 names', () => {
    // `FLOOR_CAPABILITIES` itself belongs to `M4-T1`; what matters here is that the ids it will
    // name all exist, because a Floor right missing from the union cannot be granted at all.
    for (const capability of [
      'constitution.read',
      'memory.forget.own',
      'profile.self',
      'export.self',
      'traces.read.own',
    ] as const) {
      expect(isDomainCapability(capability)).toBe(true);
    }
  });

  it('refuses a capability that is only nearly right', () => {
    for (const near of ['calendar.writes', 'memory.forget', 'tasks', 'Chat.ask', '']) {
      expect(isDomainCapability(near)).toBe(false);
      expect(isCapability(near)).toBe(false);
    }
  });
});

describe('provider ids and tool names', () => {
  it('accepts the shapes 10 §3.1 allows', () => {
    for (const id of ['weather', 'home-assistant', 'ab1', 'a'.repeat(32)]) {
      expect(isProviderId(id)).toBe(true);
    }
  });

  it('refuses a double hyphen, so the model-name mapping can never produce "__"', () => {
    // `10` §3.5.1 maps `-` to `_` in a model-facing name and uses `__` to separate the provider
    // from the tool. `home--assistant` would become `home__assistant` and split in the wrong place.
    expect(isProviderId('home--assistant')).toBe(false);
  });

  it('refuses ids that are too short, too long, or wrongly bounded', () => {
    for (const id of ['', 'a', 'ab-', '-ab', '1ab', 'A', 'a'.repeat(33), 'ab_cd']) {
      expect(isProviderId(id)).toBe(false);
    }
  });

  it('accepts snake_case tool names up to 48 characters', () => {
    for (const name of ['forecast', 'get_forecast', 'a', `a${'b'.repeat(47)}`]) {
      expect(isToolLocalName(name)).toBe(true);
    }
  });

  it('refuses a double underscore and an over-long name', () => {
    expect(isToolLocalName('get__forecast')).toBe(false);
    expect(isToolLocalName(`a${'b'.repeat(48)}`)).toBe(false);
    expect(isToolLocalName('GetForecast')).toBe(false);
    expect(isToolLocalName('_forecast')).toBe(false);
  });
});

describe('pluginCapability', () => {
  it('builds plugin:<id>:<tool>', () => {
    expect(pluginCapability('weather', 'get_forecast')).toBe('plugin:weather:get_forecast');
  });

  it('builds the wildcard form a group grant usually takes', () => {
    expect(pluginWildcardCapability('weather')).toBe('plugin:weather:*');
  });

  it('throws rather than returning a capability nothing will match', () => {
    expect(() => pluginCapability('home--assistant', 'x')).toThrow(/not a provider id/);
    expect(() => pluginCapability('weather', 'get__forecast')).toThrow(/not a tool name/);
    expect(() => pluginWildcardCapability('A')).toThrow(/not a provider id/);
  });
});

describe('parsePluginCapability', () => {
  it('reads all three forms', () => {
    expect(parsePluginCapability('plugin:weather')).toEqual({
      providerId: 'weather',
      toolName: undefined,
    });
    expect(parsePluginCapability('plugin:weather:*')).toEqual({
      providerId: 'weather',
      toolName: '*',
    });
    expect(parsePluginCapability('plugin:weather:get_forecast')).toEqual({
      providerId: 'weather',
      toolName: 'get_forecast',
    });
  });

  it('refuses a malformed id or tool, so a bad grant cannot widen by accident', () => {
    for (const bad of [
      'plugin:',
      'plugin:A',
      'plugin:home--assistant:x',
      'plugin:weather:Get',
      'plugin:weather:a__b',
      'plugin:weather:*:extra',
      'calendar.write',
      'plugins:weather',
    ]) {
      expect(parsePluginCapability(bad)).toBeUndefined();
      expect(isPluginCapability(bad)).toBe(false);
    }
  });

  it('treats every domain capability as not a plugin capability', () => {
    for (const capability of DOMAIN_CAPABILITIES) {
      expect(isPluginCapability(capability)).toBe(false);
    }
  });
});

describe('capabilitySchema', () => {
  it('parses both halves of the union', () => {
    for (const capability of ['calendar.write', 'plugin:weather:get_forecast'] as const) {
      expect(capabilitySchema.parse(capability)).toBe(capability);
    }
  });

  it('refuses a plugin capability with a malformed id, which a template literal would accept', () => {
    // This is the reason for `z.custom` over `z.templateLiteral`: `plugin:${string}` matches
    // `plugin:--bad`, and a schema that accepted it would store a grant nobody can ever satisfy.
    expect(capabilitySchema.safeParse('plugin:--bad').success).toBe(false);
    expect(capabilitySchema.safeParse(42).success).toBe(false);
  });

  it('is assignable to Capability after parsing', () => {
    const parsed: Capability = capabilitySchema.parse('plugin:weather');
    expect(parsed).toBe('plugin:weather');
  });
});

describe('risk', () => {
  it('ranks the three levels in array order', () => {
    expect(RISK_LEVELS.map(riskRank)).toEqual([0, 1, 2]);
  });

  it('takes the maximum, and low for nothing', () => {
    expect(maxRisk()).toBe('low');
    expect(maxRisk('low', 'high', 'medium')).toBe('high');
    expect(maxRisk('low', 'low')).toBe('low');
    expect(maxRisk('medium')).toBe('medium');
  });

  it('never composes downward — the property 10 §3.2.3 rule 1 depends on', () => {
    for (const a of RISK_LEVELS) {
      for (const b of RISK_LEVELS) {
        const combined: Risk = maxRisk(a, b);
        expect(riskRank(combined)).toBeGreaterThanOrEqual(riskRank(a));
        expect(riskRank(combined)).toBeGreaterThanOrEqual(riskRank(b));
      }
    }
  });

  it('raises to a floor and leaves anything above it alone', () => {
    expect(atLeastRisk('low', 'medium')).toBe('medium');
    expect(atLeastRisk('high', 'medium')).toBe('high');
  });

  it('validates with riskSchema', () => {
    expect(riskSchema.parse('medium')).toBe('medium');
    expect(riskSchema.safeParse('critical').success).toBe(false);
  });
});
