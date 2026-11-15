/**
 * `10` §3.2.2's "Type narrowing" bullet, proved (`M2-T5`).
 *
 * > `ToolContext<P>` exposes `repos.calendar` only when `P['repos']['calendar']` is declared,
 * > `http` only when `P['network']` is declared, and so on. Undeclared capabilities are absent at
 * > type level and rejected at runtime with `E_PERMISSION_DENIED`.
 *
 * "Absent at type level" is a claim about what does **not** compile, so the assertions that matter
 * here are the `@ts-expect-error` ones: each fails the build if the error it names ever stops
 * happening. A positive assignment proves only that a shape compiles, so every negative below is
 * paired with the positive it is the mirror of.
 *
 * `.types.test.ts` for the same reason as `core/src/ports/model.types.test.ts`: nothing in this
 * repository checks a `.test-d.ts`, while a `.test.ts` is compiled by `pnpm typecheck` through
 * `tsconfig.test.json` and excluded from every package build.
 */
import { describe, expect, it } from 'vitest';
import type { ToolContext } from './context.js';
import type { Grants, GrantsSecrets, PluginPermissions, RepoGrant } from './permissions.js';

/**
 * A context for `P`, without building one: these assertions are about types, not behaviour.
 *
 * Every access below goes through a thunk that is never called, so the empty stand-in is never
 * dereferenced. `expect(typeof thunk)` is the statement Vitest needs; the assertion that matters
 * already happened in `tsc`.
 */
function contextOf<P extends PluginPermissions>(): ToolContext<P> {
  return {} as ToolContext<P>;
}

type NoPermissions = { readonly tools: true };
type NetworkGranted = {
  readonly tools: true;
  readonly network: { readonly hosts: readonly ['api.example.com'] };
};
type NetworkRefused = { readonly tools: true; readonly network: false };
type CalendarRead = { readonly repos: { readonly calendar: 'read' } };
type CalendarWrite = { readonly repos: { readonly calendar: 'write' } };
type OneSecret = {
  readonly secrets: readonly [{ readonly key: 'apiKey'; readonly scope: 'instance' }];
};
type RevealableSecret = {
  readonly secrets: readonly [
    { readonly key: 'apiKey'; readonly scope: 'instance'; readonly reveal: true },
  ];
};
type NoSecrets = { readonly secrets: readonly [] };

describe('http is present iff permissions.network is declared', () => {
  it('is absent when the manifest says nothing about the network', () => {
    const context = contextOf<NoPermissions>();
    // @ts-expect-error -- `network` was not declared, so there is no `http` to reach for.
    const reach = () => context.http;
    expect(typeof reach).toBe('function');
  });

  it('is absent when the manifest declares network: false', () => {
    const context = contextOf<NetworkRefused>();
    // @ts-expect-error -- an explicit `false` is a refusal, not a declaration.
    const reach = () => context.http;
    expect(typeof reach).toBe('function');
  });

  it('is present when hosts are declared', () => {
    const context = contextOf<NetworkGranted>();
    const fetcher: (url: string) => Promise<Response> = (url) => context.http.fetch(url);
    expect(typeof fetcher).toBe('function');
  });

  it('is present on the unparameterised context, which the host implements against', () => {
    const context = contextOf();
    const fetcher: (url: string) => Promise<Response> = (url) => context.http.fetch(url);
    expect(typeof fetcher).toBe('function');
  });
});

describe('secrets is present iff the list is non-empty', () => {
  it('is absent when no secrets are declared', () => {
    const context = contextOf<NoPermissions>();
    // @ts-expect-error -- nothing declared.
    const reach = () => context.secrets;
    expect(typeof reach).toBe('function');
  });

  it('is absent for an empty list, which declares nothing', () => {
    const context = contextOf<NoSecrets>();
    // @ts-expect-error -- `secrets: []` would otherwise produce an object whose every key is unreachable.
    const reach = () => context.secrets;
    expect(typeof reach).toBe('function');
  });

  it('accepts a declared key and refuses an undeclared one', () => {
    const context = contextOf<OneSecret>();
    const reference: (key: 'apiKey') => unknown = (key) => context.secrets.ref(key);
    expect(typeof reference).toBe('function');
    // @ts-expect-error -- `'other'` is not one of the manifest's keys.
    const wrong = () => context.secrets.ref('other');
    expect(typeof wrong).toBe('function');
  });

  it('makes reveal uncallable without reveal: true', () => {
    const context = contextOf<OneSecret>();
    // @ts-expect-error -- the parameter type is `never`, which is the permission denial moved to compile time.
    const revealer = () => context.secrets.reveal('apiKey');
    expect(typeof revealer).toBe('function');
  });

  it('allows reveal for the key that asked for it', () => {
    const context = contextOf<RevealableSecret>();
    const revealer: () => Promise<string> = () => context.secrets.reveal('apiKey');
    expect(typeof revealer).toBe('function');
  });
});

describe('repos carries only the entities the manifest declared', () => {
  it('omits an entity that was not declared', () => {
    const context = contextOf<CalendarRead>();
    // @ts-expect-error -- `lists` was not declared, so the key does not exist.
    const reach = () => context.repos.lists;
    expect(typeof reach).toBe('function');
  });

  it('omits every entity when `repos` is absent', () => {
    const context = contextOf<NoPermissions>();
    // @ts-expect-error -- no `repos` key was declared at all.
    const reach = () => context.repos.calendar;
    expect(typeof reach).toBe('function');
  });

  it('gives a read grant the reader and not the writer', () => {
    const context = contextOf<CalendarRead>();
    const reader: () => unknown = () => context.repos.calendar.list({ from: 'a', to: 'b' });
    expect(typeof reader).toBe('function');
    // @ts-expect-error -- `create` needs `repos.calendar: 'write'`.
    const writer = () => context.repos.calendar.create({ title: 'x', startLocal: 'y' });
    expect(typeof writer).toBe('function');
  });

  it('gives a write grant both halves', () => {
    const context = contextOf<CalendarWrite>();
    const both: () => unknown = async () => {
      await context.repos.calendar.list({ from: 'a', to: 'b' });
      return context.repos.calendar.create({ title: 'x', startLocal: '2026-11-10T18:00' });
    };
    expect(typeof both).toBe('function');
  });

  it('refuses a write grant on a read-only entity, in the permissions type itself', () => {
    // `memory` and `members` are read-only for every plugin: a plugin writing memory would bypass
    // `04`'s extraction, consolidation and consent machinery entirely. The assertion has to go
    // through `PluginPermissions` — a bare type alias is not checked against the constraint, which
    // is how the first version of this test passed while enforcing nothing.
    // @ts-expect-error -- `RepoAccessFor<'memory'>` is `'read'`.
    const declared: PluginPermissions = { repos: { memory: 'write' } };
    expect(declared.repos?.memory).toBe('write');
  });

  it('refuses a read grant on reminders, which has nothing to read', () => {
    // @ts-expect-error -- `RepoAccessFor<'reminders'>` is `'write'`; a read grant would be an empty facade.
    const declared: PluginPermissions = { repos: { reminders: 'read' } };
    expect(declared.repos?.reminders).toBe('read');
  });
});

describe('the narrowing helpers themselves', () => {
  it('answers false for absent, undefined and false, and true otherwise', () => {
    const absent: Grants<NoPermissions, 'network'> = false;
    const refused: Grants<NetworkRefused, 'network'> = false;
    const granted: Grants<NetworkGranted, 'network'> = true;
    // The default `PluginPermissions` grants everything, which is what makes the unparameterised
    // `ToolContext` the full surface the host's own implementation is written against.
    const unconstrained: Grants<PluginPermissions, 'network'> = true;
    expect([absent, refused, granted, unconstrained]).toEqual([false, false, true, true]);
  });

  it('distinguishes an empty secrets list from a populated one', () => {
    const none: GrantsSecrets<NoSecrets> = false;
    const one: GrantsSecrets<OneSecret> = true;
    const unconstrained: GrantsSecrets<PluginPermissions> = true;
    expect([none, one, unconstrained]).toEqual([false, true, true]);
  });

  it('reports the access level per entity, and never for an undeclared one', () => {
    const read: RepoGrant<CalendarRead, 'calendar'> = 'read';
    const write: RepoGrant<CalendarWrite, 'calendar'> = 'write';
    // `never` has no values, so the only way to name one is a cast — which is the proof that the
    // mapped type's `as` clause removes the key rather than widening it.
    const missing = undefined as unknown as RepoGrant<CalendarRead, 'lists'>;
    expect([read, write, missing]).toEqual(['read', 'write', undefined]);
  });
});
