/**
 * The settings port (ADR-014, `02` §3.3.8, `01` §14 A14).
 *
 * `settings` is a `(scope, key) → JSON` table, and the two rules that shape this port are both
 * about what must *not* go in it:
 *
 *  - **Never host-only keys** (A14). A master key, a database passphrase, a platform token: those
 *    live in `08`'s keyfile layout and in the environment, because a value stored in the database
 *    is readable by anyone who can read the database — which includes a restored backup on another
 *    machine. `isPersistableSettingKey` below makes the rule checkable rather than remembered.
 *  - **Values are validated by the settings registry** (`09`), not here. This port moves JSON
 *    strings; the registry owns what a key means. A port that knew every key's schema would have to
 *    be edited by every feature that adds a setting, which is how a central registry becomes a
 *    merge conflict.
 *
 * Scopes are strings rather than a union because `02` §3.3.8 spells them as
 * `'_instance' | groupId | 'member:<id>' | 'person:<id>'` — a shape with a group id *inside* it.
 * `settingScope` builds them so the spelling exists in one place.
 */
import type { GroupId, MemberId, PersonId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { TxToken } from '../uow.js';

/** `02` §3.3.8's instance-wide scope. */
export const INSTANCE_SCOPE = '_instance';

/** A `settings.scope` value (`02` §3.3.8). */
export type SettingScope = string;

/**
 * Build a scope string.
 *
 * One function so `'member:'` is written once. A caller that spelled it `'members:'` would write
 * settings nobody reads and read defaults forever — a failure with no error.
 */
export function settingScope(
  target:
    | { readonly kind: 'instance' }
    | { readonly kind: 'group'; readonly groupId: GroupId }
    | { readonly kind: 'member'; readonly memberId: MemberId }
    | { readonly kind: 'person'; readonly personId: PersonId },
): SettingScope {
  switch (target.kind) {
    case 'instance':
      return INSTANCE_SCOPE;
    case 'group':
      return target.groupId;
    case 'member':
      return `member:${target.memberId}`;
    case 'person':
      return `person:${target.personId}`;
  }
}

/**
 * Whether a key may be stored in the database at all (`01` §14 A14).
 *
 * A denial **by shape**, not a list of forbidden names: a list only covers the secrets that
 * existed when it was written, and the next one gets stored. Anything whose key names a secret,
 * a credential, a token or a key is refused, and `08`'s keyfile layout is where it belongs.
 *
 * Returns the reason rather than a boolean, so the error a caller raises can say which word
 * tripped it — a developer who sees "contains 'token'" fixes it in one step.
 */
export function unpersistableSettingReason(key: string): string | undefined {
  const lowered = key.toLowerCase();
  for (const word of FORBIDDEN_KEY_WORDS) {
    if (lowered.includes(word)) return `setting keys may not contain ${JSON.stringify(word)}`;
  }
  return undefined;
}

/**
 * Words that mean "this is a credential" (`01` §14 A14, `08` §3.7).
 *
 * `passphrase` is listed separately from `password` because neither contains the other, and
 * `apikey` separately from `api_key` because the separator is a style choice a caller makes. The
 * list is deliberately broad: a false positive costs a developer one rename, and a false negative
 * puts a secret in a backup.
 */
const FORBIDDEN_KEY_WORDS = [
  'secret',
  'password',
  'passphrase',
  'token',
  'credential',
  'apikey',
  'api_key',
  'private_key',
  'privatekey',
  'keyfile',
] as const;

/** Whether a key may be stored in the database (`01` §14 A14). */
export function isPersistableSettingKey(key: string): boolean {
  return unpersistableSettingReason(key) === undefined;
}

export interface SettingsReader {
  /** The raw JSON string, or `undefined` when nothing is set. The registry (`09`) parses it. */
  get(scope: SettingScope, key: string): string | undefined;
  /** Every setting in one scope, for the dashboard's settings screen. */
  byScope(scope: SettingScope): readonly Setting[];
  /**
   * One key across a precedence chain, most specific first.
   *
   * Returns the first scope that has a value, so `09` does not implement the fallback four times.
   * The chain is the caller's to decide — a member-facing setting resolves member → group →
   * instance, and a group-facing one skips the member — because the precedence belongs to the
   * key's meaning, which lives in the registry.
   */
  resolve(scopes: readonly SettingScope[], key: string): Setting | undefined;
}

/** One row of `settings` (`02` §3.3.8). */
export interface Setting {
  readonly scope: SettingScope;
  readonly key: string;
  /** JSON, as stored. Parsed by the `09` registry against the key's schema. */
  readonly value: string;
  readonly updatedAt: Temporal.Instant;
  readonly updatedBy: string | undefined;
}

export interface SettingsRepository {
  /**
   * Upsert a setting.
   *
   * Throws `StorageError` for a key `isPersistableSettingKey` refuses — not a `WriteResult`,
   * because a caller cannot usefully branch on "you tried to store a credential". It is a bug in
   * the calling code, and the loud failure is the point.
   */
  set(uow: TxToken, scope: SettingScope, key: string, value: string, updatedBy?: string): Setting;
  /** Remove a setting, so the next read falls through to the scope behind it. */
  unset(uow: TxToken, scope: SettingScope, key: string): boolean;
  /** Remove every setting in a scope, for a member who left or a group being deleted. */
  clearScope(uow: TxToken, scope: SettingScope): number;
}
