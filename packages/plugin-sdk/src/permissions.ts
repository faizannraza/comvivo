/**
 * The permission algebra's **types** (`10` §3.3.1, §3.2.2).
 *
 * A plugin declares what it needs in its manifest. The host shows that declaration at approval,
 * stores its hash, and re-checks it at every process start. What this module adds is the half that
 * happens before any of that: the declaration is a **type parameter**, so an undeclared capability
 * is not a runtime denial but a compile error in the plugin author's own editor.
 *
 * That is `10` §3.2.2's "Type narrowing" bullet, and it is worth the type-level machinery below
 * because the alternative is a plugin that ships, gets approved, and fails on the one code path
 * that reaches for `ctx.http` — in somebody's family group, at the moment they needed it.
 *
 * `M12-T3` owns the **runtime** half: the manifest zod schema, the ⊆ check against the approved
 * permissions, the permission diff and the risk badges. The split is types here, validation there,
 * because `ToolContext` needs the types in `M2-T5` and the manifest does not exist yet.
 */
import type { Sensitivity } from '@comvivo/core';

/**
 * The domain entities a plugin may be granted a repository facade over (`10` §3.2.4).
 *
 * `memory` and `members` are read-only for every plugin, which is why `RepoAccessFor` exists
 * rather than a flat `'read' | 'write'` on all six: a plugin writing memory would bypass `04`'s
 * extraction, consolidation and consent machinery entirely, and a plugin writing the member
 * directory would be editing the group's own idea of who belongs to it.
 */
export const REPO_ENTITIES = [
  'calendar',
  'lists',
  'tasks',
  'reminders',
  'memory',
  'members',
] as const;

export type RepoEntity = (typeof REPO_ENTITIES)[number];

export type RepoAccess = 'read' | 'write';

export const READ_ONLY_REPO_ENTITIES = ['memory', 'members'] as const;

export type ReadOnlyRepoEntity = (typeof READ_ONLY_REPO_ENTITIES)[number];

/**
 * `'read'` for `memory` and `members`, `'write'` for `reminders`, both for the rest.
 *
 * `reminders` is write-only because `10` §3.2.4 gives it one method, `create`, and nothing to read:
 * a group's reminders are delivered, not browsed, and `07` owns the firing. Typing it as
 * `'read' | 'write'` would let a manifest declare `reminders: 'read'` and receive a facade with no
 * methods on it — a permission that reads as a grant and grants nothing.
 */
export type RepoAccessFor<E extends RepoEntity> = E extends ReadOnlyRepoEntity
  ? 'read'
  : E extends 'reminders'
    ? 'write'
    : RepoAccess;

export type RepoPermissions = { readonly [E in RepoEntity]?: RepoAccessFor<E> };

/**
 * The methods `network.methods` may list.
 *
 * No `CONNECT`, `TRACE` or `OPTIONS`: the first two are tunnelling verbs with no use for a plugin
 * fetching a forecast, and a preflight is the runtime's business rather than the plugin's.
 */
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface NetworkPermission {
  /**
   * Exact hostnames, `*.domain` wildcards, `${settings.instance.<key>}` placeholders, or `*`
   * (any public host, flagged red at approval). Resolved and re-approved when settings change.
   */
  readonly hosts: readonly string[];
  /** Private and loopback addresses. Off by default; flagged red at approval (`10` §3.3.3). */
  readonly private?: boolean;
  /** Raw sockets rather than HTTP. Off by default; flagged red. */
  readonly raw?: boolean;
  /** Defaults to `['GET', 'HEAD']` at the host, so a read-only plugin cannot POST by accident. */
  readonly methods?: readonly HttpMethod[];
}

export interface SecretPermission {
  readonly key: string;
  readonly scope: 'instance' | 'group';
  /** The host prompts for a required secret at install and refuses to enable the plugin without it. */
  readonly required?: boolean;
  /** The hosts this secret may be sent to. A `SecretRef` is refused for any other destination. */
  readonly boundHosts?: readonly string[];
  /**
   * May the plugin read the raw value (`secrets.reveal`)? Flagged red at approval.
   *
   * Without it a plugin can still *use* the secret — `ctx.secrets.ref(key)` yields a handle the
   * host substitutes at egress — it just never sees the bytes. That is the shape almost every
   * plugin wants, and the reason `reveal` is a separate, louder permission.
   */
  readonly reveal?: boolean;
  /** Shown at the install prompt, so the host knows which value to paste. */
  readonly description?: string;
}

/**
 * What a plugin declares it needs (`10` §3.3.1's `village.permissions`).
 *
 * Every field is optional and the absent form means "none" — a plugin that declares nothing gets
 * nothing, which is the only safe default for a manifest somebody else wrote.
 */
export interface PluginPermissions {
  /** May the plugin register tools at all? */
  readonly tools?: boolean;
  readonly repos?: RepoPermissions;
  /** The highest label sensitivity the plugin's reads may return. Defaults to `'normal'`. */
  readonly sensitivity?: Sensitivity;
  readonly network?: NetworkPermission | false;
  readonly secrets?: readonly SecretPermission[];
  readonly jobs?: boolean;
  readonly digestSections?: boolean;
  /** Channel ids this plugin provides (`10` §3.2.5). Empty means none. */
  readonly channels?: readonly string[];
  readonly skills?: boolean;
}

/*
 * ──────────────────────────────── The type-level narrowing ────────────────────────────────
 *
 * Three helpers, and they all answer the same question — "did `P` declare this?" — for the three
 * shapes a declaration takes. They are exported because `ToolContext` is not the only context
 * (`JobContext` and `DigestContext` land at `M12-T3`) and all of them narrow the same way.
 *
 * The `[X] extends [Y]` wrapping in each is deliberate: a bare `X extends Y` distributes over a
 * union, so `Exclude<P[K], false> extends never` would answer `never` for a union type rather than
 * `false`. Wrapping both sides in a tuple turns the check back into the single comparison it reads
 * as. Pinned by the `@ts-expect-error` cases in `context.types.test.ts`.
 */

/**
 * Did `P` declare permission `K` as something other than `false`?
 *
 * An absent key, `undefined` and `false` all answer `false`. The default `PluginPermissions`
 * answers `true` for everything, which is what makes the unparameterised `ToolContext` the full
 * surface — the host's own `ScopedRepositories` implementation is written against that one.
 */
export type Grants<
  P extends PluginPermissions,
  K extends keyof PluginPermissions,
> = K extends keyof P ? ([Exclude<P[K], false | undefined>] extends [never] ? false : true) : false;

/**
 * Did `P` declare a **non-empty** `secrets` list?
 *
 * Separate from `Grants` because `secrets: []` is a declaration with nothing in it, and
 * `10` §3.2.4 says `ctx.secrets` is present "iff permissions.secrets non-empty". `Grants` would
 * say `true` for an empty tuple, which is how a plugin would end up with a `secrets` object whose
 * every key is unreachable.
 */
export type GrantsSecrets<P extends PluginPermissions> = 'secrets' extends keyof P
  ? [Exclude<P['secrets'], undefined>] extends [never]
    ? false
    : [Exclude<P['secrets'], undefined>] extends [readonly []]
      ? false
      : true
  : false;

/** The access `P` declared for entity `E`, or `never` when it declared none. */
export type RepoGrant<P extends PluginPermissions, E extends RepoEntity> = 'repos' extends keyof P
  ? Exclude<P['repos'], undefined> extends infer R
    ? E extends keyof R
      ? Exclude<R[E], undefined>
      : never
    : never
  : never;

/** The secret keys `P` declared, as a union of literals when `P` is a `const` object. */
export type SecretKeyOf<P extends PluginPermissions> = 'secrets' extends keyof P
  ? Exclude<P['secrets'], undefined> extends readonly (infer S)[]
    ? S extends { readonly key: infer K extends string }
      ? K
      : never
    : never
  : never;

/**
 * The subset of `SecretKeyOf<P>` declared with `reveal: true`.
 *
 * `never` when there are none, which makes `secrets.reveal` uncallable at compile time rather than
 * a runtime `E_PERMISSION_DENIED` — the same denial, moved to where it costs nothing.
 */
export type RevealableSecretKeyOf<P extends PluginPermissions> = 'secrets' extends keyof P
  ? Exclude<P['secrets'], undefined> extends readonly (infer S)[]
    ? S extends { readonly key: infer K extends string; readonly reveal: true }
      ? K
      : never
    : never
  : never;
