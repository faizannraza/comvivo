/**
 * The event-code catalog.
 *
 * `11` §3.10.1: every line carries a stable dotted `event`, and that code — not the human-readable
 * `msg` — is the grep and alert key. Keeping them in one place means an operator can be handed the
 * complete list of things this product says, and an alert rule written against a code keeps working
 * when the prose is reworded.
 *
 * `msg` is a **constant short string**, never interpolated with user data. That is not a style
 * preference: interpolation is the most common way content reaches a log, because it looks harmless
 * at the call site.
 *
 * Codes are added by the milestone that emits them. These are the ones that exist today; the
 * catalog grows with `M3` (ingestion, turns, outbox), `M6` (memory), `M7` (reminders) and `M8`
 * (proactivity).
 */

export const LOG_EVENTS = {
  // --- Process lifecycle -----------------------------------------------------------------------
  'server.starting': 'starting up',
  'server.ready': 'ready',
  'server.stopping': 'shutting down',
  'server.stopped': 'stopped',

  // --- Configuration ---------------------------------------------------------------------------
  'config.loaded': 'configuration loaded',
  'config.invalid': 'configuration is not valid',
  'config.warning': 'configuration warning',
  /** The database tried to set a host-only key (A14). A security event, not a nuisance. */
  'config.host_only_rejected': 'ignored a host-only setting from the database',

  // --- Secrets ---------------------------------------------------------------------------------
  'secret.loaded': 'secret loaded',
  'secret.missing': 'secret missing',

  // --- Storage ---------------------------------------------------------------------------------
  /**
   * A transaction held the write lock longer than `storage.slowTxMs` (`02` §3.7.2).
   *
   * `op` and a duration, never parameters. On a Pi the write lock is the one resource everything
   * else waits on, so this is the signal that separates "the Pi is slow" from "one transaction is
   * holding the database".
   */
  'storage.slow_tx': 'a transaction held the database longer than the threshold',
  /**
   * An `afterCommit` hook threw.
   *
   * The transaction already committed, so the hook's failure is logged and swallowed — reporting a
   * committed write as a failure would invite a retry of a change that already landed, which for
   * the outbox means sending twice (I6).
   */
  'storage.after_commit_failed': 'an afterCommit hook failed',

  // --- Job queue (`02` §3.10.4) ----------------------------------------------------------------
  /**
   * A job's payload no longer matches its kind's schema.
   *
   * A row can outlive the code that wrote it, so this is reachable by an upgrade rather than only
   * by a bug — and it is non-retryable (`02` §3.10.1: `JOB_PAYLOAD_INVALID ⇒ dead`), which makes
   * the log line the only notice anyone gets.
   */
  'job.payload_invalid': 'a job payload did not match its schema',
  /** A handler threw or timed out. `attempt` and `code` say whether it will be retried. */
  'job.failed': 'a job failed',
  /**
   * A worker's lease expired while its handler was still working.
   *
   * The handler's own transaction rolls back (`02` §3.10.4), so no work is lost — but a instance
   * seeing these regularly has handlers slower than their leases, which is a tuning problem rather
   * than an error.
   */
  'job.lease_lost': 'a job lease was lost before the handler finished',
  /** `02` §3.10.3's dead letter. Visible in the dashboard and `village doctor --check jobs`. */
  'job.dead': 'a job will not be retried',

  // --- Content debugging -----------------------------------------------------------------------
  /** Emitted once at startup when content logging is on, so it can never be on unnoticed. */
  'debug.content_enabled': 'content logging is ENABLED',
  'debug.content': 'content',
} as const satisfies Record<string, string>;

export type LogEvent = keyof typeof LOG_EVENTS;

/** The constant `msg` for an event. Never interpolated (`11` §3.10.1). */
export function messageFor(event: LogEvent): string {
  return LOG_EVENTS[event];
}

export function isKnownEvent(value: string): value is LogEvent {
  return Object.hasOwn(LOG_EVENTS, value);
}
