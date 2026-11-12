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
  /**
   * An `afterCommit` hook returned a promise.
   *
   * A bug, and one the type system cannot catch: TypeScript's void-return rule accepts an `async`
   * function wherever `() => void` is expected, so `afterCommit(async () => …)` compiles. The hook
   * then runs *after* the batch is considered finished, and a rejection becomes an unhandled
   * rejection — which on Node's default means the process exits, having already committed. So the
   * runner attaches a `catch` and logs this instead of relying on the hook being well-behaved.
   */
  'storage.after_commit_async': 'an afterCommit hook returned a promise',
  /**
   * The instance lock's heartbeat could not be written.
   *
   * At `warn`, because one failed tick is survivable — the lock only goes stale after several —
   * but a run of them means this process is about to lose a lock it still believes it holds.
   */
  'storage.heartbeat_failed': 'the instance lock heartbeat could not be written',
  /**
   * **Another process has taken the instance lock while this one still holds the database open.**
   *
   * The state `C1` forbids: two writers, one WAL. At `error` and never swallowed, because the
   * symptom a host sees — every reminder sent twice, two turns for one message — is otherwise
   * impossible to trace. Before the M1 exit gate both this and the failure above were discarded
   * inside the heartbeat's interval, so a two-writer instance produced no log line at all.
   */
  'storage.lock_lost': 'another process took the instance lock',

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
  /** `02` §3.10.3's dead letter. Visible in the dashboard and `comvivo doctor --check jobs`. */
  'job.dead': 'a job will not be retried',
  /**
   * The worker's own machinery threw, outside the handler.
   *
   * Everything a handler can do is already `job.failed`; this is the line for the cases that are
   * not the handler's fault — a payload column that is not JSON, or the database refusing the
   * write that records a failure. Before it existed those escaped as an unhandled rejection, and
   * on Node 26 an unhandled rejection **ends the process**: the lease then expired, the job was
   * re-claimed on the next boot and killed it again, which is a crash loop whose only visible
   * cause is a stack trace from `JSON.parse`. Found by the M1 exit gate's reviewer.
   */
  'job.crashed': 'the worker failed outside the handler',

  // --- Retention and deletion (`02` §3.13) -----------------------------------------------------
  /**
   * One retention pass finished. `count` is rows removed, `durationMs` how long it took.
   *
   * At `info`, because a host reading their log should be able to see that retention is running:
   * a sweep that silently stopped working looks exactly like a sweep with nothing to do, and the
   * difference is whether 90-day-old messages still exist.
   */
  'retention.swept': 'retention removed expired rows',
  /**
   * `02` §3.13.2's `RETENTION_UNEXTRACTED`: messages are being deleted that extraction never read.
   *
   * Retention wins over memory (`03`'s privacy posture), so this is a warning and not a refusal.
   * It means extraction was down for longer than the retention window, and the memories those
   * messages would have produced will never exist.
   */
  'retention.unextracted': 'expired messages were deleted before extraction read them',
  /** A group purge or a person erasure started (`02` §3.13.4, §3.13.5). */
  'deletion.started': 'a deletion job started',
  /** A group purge or a person erasure finished. `count` is rows removed. */
  'deletion.completed': 'a deletion job completed',
  /**
   * The audit chain was re-anchored because retention removed its oldest rows (`08` §3.16.2).
   *
   * At `warn` rather than `info`: `02` §3.13.1's default keeps audit events forever, so this only
   * happens on an instance whose host set a ceiling — and the line is the notice that verification
   * will now report a chain that starts somewhere other than `seq` 1.
   */
  'audit.reanchored': 'the audit chain was re-anchored after a retention purge',

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
