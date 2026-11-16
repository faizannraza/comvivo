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

  // --- Model calls (M2) ------------------------------------------------------------------------
  /**
   * A provider call failed, named by `ModelCallError.kind`.
   *
   * Content-free by construction (`01` §11.7): the kind, the route, the status and the request id,
   * never the prompt and never the provider's own message — provider error text has carried
   * prompt fragments before, which is why `ModelCallError` does not interpolate it either.
   */
  'model.call_failed': 'a model call failed',
  /**
   * A usage record could not be written, so the ledger is behind what the provider billed.
   *
   * Logged and swallowed rather than thrown (`05` §3.9.1): a usage write that propagated would
   * turn a successful turn into a failed one — a member seeing an error for a reply the model had
   * already produced and the provider had already charged for. This line is the evidence, and
   * `02` §3.3.7's reconciliation is the backstop.
   */
  'usage.record_failed': 'a usage record could not be written',
  /** The circuit breaker for a provider changed state (`05` §3.5.1). */
  'model.breaker_changed': 'a provider circuit breaker changed state',
  /**
   * One local-server capability probe finished (`05` §3.5.6; `M2-T12`).
   *
   * At `debug` because a failed probe is the **expected** case on three of the four servers — a
   * server that refuses `tools` is answering the question, not erring — and an `info` line per
   * probe would make a normal boot look like it was going wrong.
   */
  'model.local_probe': 'a local model capability probe finished',
  /** The degradation ladder level a local server was placed at (`05` §3.5.6). */
  'model.local_level': 'a local model server was placed on the degradation ladder',

  // --- HTTP (M3-T14) ---------------------------------------------------------------------------
  /**
   * A request ended in a failure nobody anticipated (`09` §3.2.1's `internal`).
   *
   * `error`, because the client got a 500 and the only explanation is this line: `09` §3.2.1
   * gives `internal` a fixed sentence and "No stack trace", so the `requestId` in the body and
   * the `requestId` here are the whole of what connects a host's complaint to the cause. The
   * error's **class and message** are logged and nothing else — `08` §3.10 layer 3 keeps a
   * provider's response body out of a log.
   */
  'http.request_failed': 'a request failed unexpectedly',
  /**
   * A request was refused for a reason the API has a code for (`09` §3.2.1).
   *
   * `debug`, not `warn`: a 404, a 412 or a 429 is the API working as specified, and a line per
   * one would bury the failures that are not. The path and the code, never the body.
   */
  'http.request_refused': 'a request was refused',

  // --- Turn traces (M3-T20) --------------------------------------------------------------------
  /**
   * A trace row was shortened to fit `02` §3.3.9's 512 KiB combined budget (`05` §3.10.1).
   *
   * `warn` because the caller's own observability is now incomplete and nothing else would say
   * so: `11`'s replay reads these rows as evidence, and a truncated `modelCalls` list must not be
   * read as "the turn made fewer calls than it did". Carries the turn id and which columns were
   * shortened, never their contents.
   */
  'trace.truncated': 'a turn trace was truncated to fit its budget',

  // --- Runtime copy (M3-T12) -------------------------------------------------------------------
  /**
   * A copy catalog entry could not be rendered, so English was used instead (`05` §3.11).
   *
   * `warn` rather than `debug`, because the only way a community translation gets fixed is that
   * somebody sees this. Carries the locale and the **key**, never the parameters: a parameter is
   * a handle, a title or a block of effect lines, which is message content (`01` §11.7).
   */
  'copy.fallback': 'a copy catalog entry could not be rendered',

  // --- RichText (06 §3.5.2; M3-T3) --------------------------------------------------------------
  /**
   * A reply's markup could not be parsed and was degraded to plain paragraphs (`06` §3.5.2).
   *
   * `warn`, because the member sees a reply that lost its formatting and the cause is ours: the
   * model wrote something the parser could not represent, or wrote more than the limits allow.
   * Carries the **reason** and the input's size, never the text — `01` §11.7, and this is the one
   * event whose temptation is to log the input that broke it. The input is available under
   * `COMVIVO_DEBUG_CONTENT` like every other piece of content.
   */
  'channel.richtext_degraded': 'model markup was degraded to plain paragraphs',
  /**
   * `@{mbr_…}` in model output named somebody who is not in this group (`06` §3.5.2).
   *
   * `warn` rather than `debug`: the member reads `@?` where a name should be, and the usual cause
   * is a prompt that offered the model a roster it then got wrong — which is a bug worth seeing.
   * Carries no id, because a member id in a log line is a handle to a person (`01` §11.7).
   */
  'channel.mention_unresolved': 'model output mentioned a non-member id',
  /**
   * A typing indicator could not be set (`06` §3.11; `M3-T8`).
   *
   * `debug`, and the level is the whole point of the entry. Typing is cosmetic, so a failure is not
   * news — but the usual cause is a missing permission, which fails identically every four seconds
   * for the sixty a turn may last. At `warn` that is fifteen lines about one thing, in a chat where
   * `06` §3.20.3's diagnostic is already reporting the real problem once. Carries the platform chat
   * id and the error's **class**, never its message: a platform's error text quotes what it was
   * asked to do.
   */
  'channel.typing_failed': 'a typing indicator could not be set',
  /**
   * An adapter's receive loop started or stopped (`06` §3.15; `M3-T9`).
   *
   * `info`, because a host reading a log wants to see the moment a channel came up and the moment
   * it went away — those two lines are the first thing anybody looks for when a group has gone
   * quiet. They carry the channel and nothing else: a chat id here would be the first chat the
   * adapter happened to touch, which is not information.
   *
   * `06` §3.25's C22 asserts that nothing at this level or above carries message text, and a
   * lifecycle line is the easiest place to get that wrong — "connected to Okafor family" is a
   * group's name in a log that ships to an operator.
   */
  'channel.connected': 'an adapter started its receive loop',
  'channel.disconnected': 'an adapter stopped its receive loop',

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
