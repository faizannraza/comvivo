/**
 * `defineAdapter` (`06` §4.1).
 *
 * Three lines of code and two tests that matter, both about third-party adapters: the config
 * schema travels **with** the adapter, and `create` keeps its `this`.
 */

import { BRAND } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChannelAdapter } from './contract.js';
import { defineAdapter, profiles } from './index.js';

function stubAdapter(): ChannelAdapter {
  return {
    id: 'simulator',
    capabilities: profiles.ideal,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    send: () => Promise.resolve({ parts: [], fellBackToPlain: false }),
    fetchAttachment: () => Promise.reject(new Error('not in this test')),
    describeSelf: () =>
      Promise.resolve({ platformUserId: 'self', displayName: BRAND.displayName, flags: {} }),
  };
}

describe('defineAdapter', () => {
  it('carries the config schema with the adapter, so boot validates against the right one', () => {
    // The point of the helper. A host's YAML is checked by the schema belonging to the adapter
    // that will consume it, rather than against a central list somebody has to remember to
    // update — so a misspelled setting fails at boot, named by the adapter that cares.
    const factory = defineAdapter({
      id: 'simulator',
      configSchema: z.strictObject({ token: z.string().min(1) }),
      create: () => stubAdapter(),
    });
    expect(factory.id).toBe('simulator');
    expect(factory.configSchema.safeParse({ token: 'abc' }).success).toBe(true);
    expect(factory.configSchema.safeParse({ token: '' }).success).toBe(false);
    expect(factory.configSchema.safeParse({ tokne: 'abc' }).success).toBe(false);
  });

  it('does not call `create` at definition time', () => {
    // Construction happens after validation, which is what lets an adapter's constructor assume
    // its config is already the right shape.
    let created = 0;
    const factory = defineAdapter({
      id: 'simulator',
      configSchema: z.unknown(),
      create: () => {
        created += 1;
        return stubAdapter();
      },
    });
    expect(created).toBe(0);
    factory.create(undefined);
    expect(created).toBe(1);
  });

  it('keeps `this` inside a `create` written as a method', () => {
    // The reason `create` is wrapped rather than passed by reference. An adapter author who
    // writes `create()` as a method on an object literal and reaches for `this.something` would
    // otherwise get `undefined` at construction — a crash at boot, in third-party code.
    const definition = {
      id: 'simulator' as const,
      configSchema: z.unknown(),
      marker: 'kept',
      create(): ChannelAdapter {
        if (this.marker !== 'kept') throw new Error('`this` was lost');
        return stubAdapter();
      },
    };
    const factory = defineAdapter(definition);
    expect(() => factory.create(undefined)).not.toThrow();
  });
});
