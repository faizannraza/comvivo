/**
 * The **closed** set of fields a log line may carry.
 *
 * `11` §3.10.1 and `01` §11.7. This is the primary enforcement of "logs never contain message or
 * memory content above `debug`", and it works by omission: there is simply **no field** named
 * `text`, `content`, `prompt`, `messages`, `richText`, `raw`, `body`, `args` or `result`. Because
 * `LogFields` is a closed interface and TypeScript applies excess-property checking to object
 * literals, `log.info('turn.completed', { text: message.text })` does not compile.
 *
 * That ordering is deliberate. Redaction (`redact.ts`) and scrubbing (`scrub.ts`) are the layers
 * beneath, and both are *recovery* mechanisms — they assume a mistake already happened. A type
 * error happens before the code is ever run, in the editor, while the author still remembers what
 * they were trying to do.
 *
 * **Identifiers are allowed; names are not.** `memberId: 'mbr_01j…'` is fine and necessary for
 * debugging. `memberName: 'Ava'` is not, and has no field here: a display name in a log is personal
 * data about someone who never agreed to appear in the host's terminal, and the host-trust
 * disclosure in `03`/`08` (risk R-16) is narrow enough already.
 */
import type { SecretString } from '../secrets/secret-string.js';

/** Values a field may hold. No objects, so a whole payload cannot be smuggled in as one field. */
export type FieldValue = string | number | boolean | null | undefined;

/**
 * The error shape `11` §3.10.1 allows. `message` is scrubbed and truncated before it gets here;
 * nothing else from a foreign error survives, because a provider's error body can echo the request.
 */
export interface LoggedError {
  readonly type: string;
  readonly code?: string | undefined;
  readonly status?: number | undefined;
  /** The provider's request id. Worth keeping: it is how a support conversation gets anywhere. */
  readonly requestId?: string | undefined;
  /** Already scrubbed and truncated to 200 characters. */
  readonly message: string;
}

/**
 * Every field a log line may carry, from `11` §3.10.1's table.
 *
 * Adding a field here is a deliberate act and should be reviewed as one: it widens what can reach a
 * host's terminal, their log file, and the `doctor --bundle` they may paste into a public issue.
 */
export interface LogFields {
  // --- Identity --------------------------------------------------------------------------------
  /** Which part of the system. A child-logger binding, e.g. `engine.turn`, `channel.telegram`. */
  readonly component?: string;
  readonly instanceId?: string;
  readonly role?: 'web' | 'worker' | 'all';

  // --- Correlation: TypeIDs and enums only ------------------------------------------------------
  readonly groupId?: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly messageId?: string;
  readonly memberId?: string;
  readonly jobId?: string;
  readonly jobKind?: string;
  /**
   * `02` §3.10.4: "Logs carry job id, kind and partition, never the payload."
   *
   * A group id or `'_instance'`, so a host can see *whose* work is backed up. It is an
   * identifier, which is the line this interface draws — the payload it belongs to is not here
   * and has no field.
   */
  readonly partitionKey?: string;
  readonly channel?: string;

  // --- Tracing ---------------------------------------------------------------------------------
  readonly traceId?: string;
  readonly spanId?: string;

  // --- Measurements ----------------------------------------------------------------------------
  readonly durationMs?: number;
  readonly attempt?: number;
  readonly outcome?: string;
  readonly count?: number;
  readonly costMicros?: number;

  // --- Model and policy (shape only, never content) --------------------------------------------
  readonly provider?: string;
  readonly model?: string;
  readonly route?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly stopReason?: string;
  readonly disposition?: string;
  readonly policyDecision?: string;
  readonly guardResult?: string;
  readonly toolName?: string;
  readonly sensitivity?: string;
  readonly audienceSize?: number;

  // --- Diagnostics -----------------------------------------------------------------------------
  readonly err?: LoggedError;
  /** A secret's **name and fingerprint**, so "which key is in use" is answerable. Never the value. */
  readonly secretRef?: SecretString;
  /** Set only by `log.content()`, which is a no-op unless content debugging is explicitly enabled. */
  readonly content?: true;

  /**
   * Catch-all for a numeric or short enum field a subsystem needs before it has earned a named
   * one.
   *
   * **A string here must be token-shaped, not prose**, and that is checked at runtime by
   * `isSafeDetailValue`. The type alone is not enough: the M0 independent review showed that
   * `log.info('turn.completed', { detail: { note: msg.text } })` compiled, ran, and put a
   * member's message in an `info` line — a one-line, reviewer-invisible breach of `01` §11.7. The
   * key-name denylist could not help, because the leak is in the *value* and the key was `note`.
   *
   * Token-shaped means an identifier, an enum value, a path, a version, a duration — no spaces.
   * Prose needs spaces, so refusing them refuses sentences while keeping every legitimate use:
   * `disposition: 'replied'`, `channel: 'telegram'`, `path: '.env'`, `afterMs: 5000`.
   */
  readonly detail?: Readonly<Record<string, FieldValue>>;
}

/** Longest a `detail` string may be. A token is short; a sentence is not. */
export const MAX_DETAIL_LENGTH = 120;

/**
 * Whether a `detail` value is safe to log above `debug`.
 *
 * A number, boolean, `null` or `undefined` cannot carry a message. A string may, so it must be
 * token-shaped: no whitespace, at most `MAX_DETAIL_LENGTH`.
 *
 * **What this stops, and what it does not.** Messages and memories are prose, and prose has
 * spaces, so `detail: { note: msg.text }` now fails loudly instead of logging a member's message.
 * What still passes is a **whitespace-free** string under a key the denylist does not name — the
 * residual was measured, not assumed:
 *
 *   detail: { text: '…' }                -> removed by FORBIDDEN_FIELD_NAMES
 *   detail: { note: 'Ava said …' }       -> refused here (prose)
 *   detail: { nested_text_field: 'TOKEN' } -> still logged
 *
 * That residual is accepted on purpose. `01` §11.7 is about message and memory content, and a
 * single token is neither in practice; the names that would carry one — `text`, `content_text`,
 * `raw`, `body`, `memberName`, `displayName` — are already on the denylist. Closing it completely
 * would mean banning strings from `detail` outright, which would push `channel: 'telegram'` and
 * `path: '.env'` into either a named field for every one-off or into `log.content()`, where they
 * do not belong.
 *
 * The named fields on `LogFields` are the right place for anything that needs structure, and
 * `log.content()` is the right place for content itself — off unless the host switches it on, and
 * announced in the group when they do.
 */
export function isSafeDetailValue(value: FieldValue): boolean {
  if (typeof value !== 'string') return true;
  if (value.length > MAX_DETAIL_LENGTH) return false;
  return !/\s/.test(value);
}

/**
 * Field names that must never exist on `LogFields`.
 *
 * Exported so a test can assert the list rather than trusting a reviewer to notice one being added.
 * `11` §3.10.1 names these exactly.
 */
export const FORBIDDEN_FIELD_NAMES: readonly string[] = [
  'text',
  'content_text',
  'prompt',
  'messages',
  'richText',
  'rich_text',
  'raw',
  'body',
  'args',
  'result',
  'payload',
  'memberName',
  'displayName',
  'token',
  'apiKey',
  'password',
  'secret',
  'authorization',
  'headers',
  'cookie',
];
