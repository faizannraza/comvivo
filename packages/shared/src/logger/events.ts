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
