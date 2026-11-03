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
   * one. Typed as `FieldValue`, so a whole object still cannot be logged.
   */
  readonly detail?: Readonly<Record<string, FieldValue>>;
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
