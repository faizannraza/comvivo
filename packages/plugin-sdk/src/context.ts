/**
 * `ToolContext` — everything a tool is handed, and nothing more (`10` §3.2.4).
 *
 * The shape is a privacy decision as much as an API one. Two absences say the most:
 *
 *  - **`audience` carries a size, never a member list.** A tool that needs to know "is this a DM or
 *    the whole group, and roughly how many people" gets exactly that. A tool that wanted the roster
 *    has to ask `repos.members.directory()` and declare the permission, which shows up at approval.
 *  - **There is no database, no HTTP client and no secret value by default.** `repos`, `http` and
 *    `secrets` appear only when the manifest declared them, and they are absent *at type level* —
 *    see `permissions.ts`.
 *
 * Every member is `readonly` and the context is created per invocation, so a tool cannot stash one
 * and use it after the turn ended: `signal` is already aborted and the host has dropped the
 * capability token behind it (`10` §3.6.1, P6).
 *
 * `M12-T7` implements this in `plugin-host/src/ctx-host/`. `M7-T6` makes the built-ins take it.
 */
import type { Audience, GroupArchetype, Label, MemberRole, Sensitivity } from '@comvivo/core';
import type { CanonicalValue, GroupId, MemberId, TimeZoneId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type {
  Grants,
  GrantsSecrets,
  HttpMethod,
  PluginPermissions,
  RevealableSecretKeyOf,
  SecretKeyOf,
} from './permissions.js';
import type { ScopedRepositories } from './repos.js';

/**
 * Who asked.
 *
 * `system` exists for the scheduled and proactive paths (a digest, a reminder sweep), where there
 * is no member in the loop. `onBehalfOf` is the delegation (`03` §3.3.11): a system action carries
 * the authority of the member who set it up, and loses it if that member leaves.
 */
export type Requester =
  | {
      readonly kind: 'member';
      readonly memberId: MemberId;
      readonly displayName: string;
      readonly role: MemberRole;
      readonly locale: string;
      readonly timeZone: TimeZoneId;
    }
  | { readonly kind: 'system'; readonly onBehalfOf?: MemberId };

/** Where the reply goes, and how many people will read it. No member list — data minimization. */
export interface ToolAudience {
  readonly kind: 'dm' | 'group';
  readonly size: number;
}

export interface GroupInfo {
  readonly name: string;
  readonly timeZone: TimeZoneId;
  readonly locale: string;
  readonly archetype: GroupArchetype;
}

/**
 * The clock, injected.
 *
 * A plugin reading `Date.now()` is a plugin whose behaviour cannot be replayed in the simulator or
 * stepped through 30 virtual days in a test, which is how `07`'s recurrence, quiet hours and
 * rotation bugs get found. `zonedNow` is here because almost every question a plugin asks about
 * time is a wall-clock question in somebody's zone, and converting by hand is where DST bugs live.
 */
export interface PluginClock {
  now(): Temporal.Instant;
  /** Defaults to the group's zone. Pass a member's zone for a per-member wall time. */
  zonedNow(timeZone?: TimeZoneId): Temporal.ZonedDateTime;
}

/**
 * Structured log fields.
 *
 * Scalars only: an object would be serialised by the host's redactor without it knowing what is
 * inside, and `01` §11.7 forbids message or memory content above `debug`. The host also redacts
 * known secret values and rate-limits to 100 lines per minute per plugin, so a chatty plugin
 * degrades rather than filling the disk.
 */
export type PluginLogFields = Readonly<Record<string, string | number | boolean>>;

export interface PluginLogger {
  debug(message: string, fields?: PluginLogFields): void;
  info(message: string, fields?: PluginLogFields): void;
  warn(message: string, fields?: PluginLogFields): void;
  error(message: string, fields?: PluginLogFields): void;
}

/**
 * Label helpers — pure, and re-validated by the host.
 *
 * Pure because a plugin building a label is doing arithmetic on a lattice, not asking permission;
 * re-validated because a plugin could compute a label that widens its readers, and the host clamps
 * every requested label to `join(requested, inputProvenanceLabels, { untrusted: true })` before a
 * write. A write-down (I2) is rejected there, not here — the helper's job is to make the *correct*
 * label easy to construct.
 */
export interface LabelsHelper {
  /** Readable by every current member. The default for anything a tool writes on the group's behalf. */
  forGroup(): Label;
  /** Readable only by the requester. `kind: 'system'` requesters have no private label; this throws. */
  forRequesterPrivate(): Label;
  withSensitivity(label: Label, sensitivity: Sensitivity): Label;
  /** Readers intersect, sensitivity takes the maximum, `untrusted` is sticky (`01` §7.2). */
  join(...labels: readonly Label[]): Label;
  /** Is `a` at least as restrictive as `b`? The comparison a plugin needs before reusing a label. */
  isRestrictive(a: Label, b: Label): boolean;
  /** The invocation's own audience, so a plugin can ask what it is allowed to say out loud. */
  readonly audience: Audience;
}

/**
 * A secret the plugin may **use** without seeing.
 *
 * `handle` is opaque and host-issued: the host substitutes the real value at egress, only toward
 * the hosts that secret is bound to, and only for the invocation that was handed the ref. A plugin
 * can of course construct this object shape — it cannot construct a handle the host will honour,
 * which is where the security actually lives.
 */
export interface SecretRef {
  readonly key: string;
  readonly handle: string;
}

/**
 * A request body with secrets substituted at egress.
 *
 * `10` §3.2.4 describes body templates as `{secret}` placeholders. Named refs rather than an
 * implicit scan, because a scan over an arbitrary body would rewrite a literal `{apiKey}` that
 * happened to appear in somebody's JSON, and the host's redactor would have to guess which braces
 * it had replaced when scrubbing the log. Logged as a plan change.
 */
export interface SecretTemplate {
  /** `{key}` placeholders are replaced with the value of the ref registered under that key. */
  readonly template: string;
  readonly secrets: readonly SecretRef[];
}

export interface SecretsAccess<P extends PluginPermissions> {
  ref(key: SecretKeyOf<P>): SecretRef;
  /**
   * The raw value. Requires `reveal: true` on that secret in the manifest, which is flagged red at
   * approval — so the parameter type is `never` for a plugin that did not ask, and the call cannot
   * be written at all.
   */
  reveal(key: RevealableSecretKeyOf<P>): Promise<string>;
}

export interface EgressRequestInit {
  readonly method?: HttpMethod;
  /** A header value may be a `SecretRef`; the host substitutes it at egress. */
  readonly headers?: Readonly<Record<string, string | SecretRef>>;
  readonly body?: string | Uint8Array | SecretTemplate;
  /** Defaults to `ctx.signal`, so a cancelled turn cancels the request. */
  readonly signal?: AbortSignal;
}

/**
 * `fetch` through the host's `SafeFetch` (`10` §3.4.6, `08` PSC-8).
 *
 * Present only when `permissions.network` is declared. The allowlist, the private-IP block, and
 * the size, time and rate caps are applied below this call, which is what makes invariant **I5
 * (guarded egress)** structural rather than a convention. There are no cookies and no redirects to
 * hosts outside the allowlist.
 */
export interface EgressHttp {
  fetch(url: string, init?: EgressRequestInit): Promise<Response>;
}

/** The plugin's private key–value store (`10` §3.2.4): caches and sync cursors, never domain data. */
export interface PluginStore {
  /** Which scope this store is: a `ToolContext` is handed the group scope. */
  readonly scope: 'instance' | 'group';
  /**
   * `undefined` when the key is absent.
   *
   * `unknown` rather than a generic, so the plugin parses what comes back. The store survives
   * plugin upgrades: the value a previous version wrote is a boundary, and `01` §2 says boundaries
   * are validated with zod.
   */
  get(key: string): Promise<unknown>;
  set(key: string, value: CanonicalValue): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<readonly string[]>;
}

/** `10` §3.2.4's per-value and per-scope quotas, exported so a plugin can check before it writes. */
export const PLUGIN_STORE_MAX_VALUE_BYTES = 64 * 1024;

export const PLUGIN_STORE_MAX_SCOPE_BYTES = 5 * 1024 * 1024;

/**
 * The validated, non-secret settings a plugin was configured with.
 *
 * `10` §3.2.4 writes these as `InferInstance<P>` / `InferGroup<P>`, which cannot work: the schemas
 * live on `definePlugin`'s `settingsSchema`, and `P` is the *permissions* type, which carries no
 * schema at all. So settings get their own type parameter, defaulting to an unknown-valued record.
 * `M12-T3`'s `definePlugin` threads the inferred shape through. Logged as a plan change.
 */
export interface PluginSettingsShape {
  readonly instance: Readonly<Record<string, unknown>>;
  readonly group: Readonly<Record<string, unknown>>;
}

export interface PluginSettings<S extends PluginSettingsShape = PluginSettingsShape> {
  readonly instance: S['instance'];
  readonly group: S['group'];
}

/** The members every invocation has, whatever the manifest says. */
export interface ToolContextBase<S extends PluginSettingsShape = PluginSettingsShape> {
  readonly groupId: GroupId;
  /** Stable for the life of this call; the id every log line and audit row is correlated by. */
  readonly invocationId: string;
  readonly requester: Requester;
  readonly audience: ToolAudience;
  readonly group: GroupInfo;
  readonly settings: PluginSettings<S>;
  /** Aborted when the turn's deadline passes, the requester cancels, or the host shuts down. */
  readonly signal: AbortSignal;
  readonly clock: PluginClock;
  readonly logger: PluginLogger;
  readonly labels: LabelsHelper;
  readonly store: PluginStore;
}

/**
 * What a tool's `execute` receives.
 *
 * An intersection rather than an interface with optional members, because optional members would
 * still exist: `ctx.http?.fetch(…)` would compile for a plugin that never declared `network`, and
 * fail at runtime with `E_PERMISSION_DENIED` on somebody else's instance. The conditional arms
 * remove the key entirely, so the mistake is a red squiggle in the plugin author's editor.
 *
 * `unknown` is the "adds nothing" arm, because `T & unknown` simplifies to `T`. `{}` would mean
 * "any non-nullish value" and `Record<never, never>` resolves to exactly that — which is why
 * `@typescript-eslint/no-generated-empty-object-type` is right to refuse it.
 */
export type ToolContext<
  P extends PluginPermissions = PluginPermissions,
  S extends PluginSettingsShape = PluginSettingsShape,
> = ToolContextBase<S> & {
  readonly repos: ScopedRepositories<P>;
} & (Grants<P, 'network'> extends true ? { readonly http: EgressHttp } : unknown) &
  (GrantsSecrets<P> extends true ? { readonly secrets: SecretsAccess<P> } : unknown);
