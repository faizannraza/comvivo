/**
 * A `Logger` that records nothing (`11` §3.1.7's test doubles).
 *
 * It lives here rather than beside the first test that wanted one. `Logger` is `shared`'s type, and
 * by `M2-T6` three packages needed the same double: `storage`'s repository harness (which had it
 * first, and now re-exports this one), the model adapter's contract tests, and `M2-T9`'s middleware.
 * Three copies of an eight-method stub is three places to forget a method when `Logger` grows.
 *
 * `recordingLogger` is the other half, for the tests that *are* about the lines: `01` §11.7 says
 * logs never carry message or memory content above `debug`, and the only way to assert that is to
 * capture what was written and look.
 */
import type { LogEvent, LogFields, Logger, LogLevel } from '../logger/index.js';

/** A logger whose every method is a no-op. Its `child` returns itself. */
export const silentLogger: Logger = ((): Logger => {
  const silent = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    content: () => {},
    child: () => silent,
  } as unknown as Logger;
  return silent;
})();

export interface RecordedLine {
  readonly level: LogLevel | 'content';
  readonly event: string;
  readonly fields: LogFields | undefined;
}

export interface RecordingLogger {
  readonly logger: Logger;
  /** Everything written, oldest first. */
  lines(): readonly RecordedLine[];
  clear(): void;
}

/**
 * A logger that keeps what was written, for the assertions that are about the lines themselves.
 *
 * The one that matters is the content check: a test can write a member's message through the
 * subsystem and then assert that no line above `debug` contains it. That is `01` §11.7 turned into
 * something a test can fail on, rather than a rule somebody remembers.
 */
export function recordingLogger(): RecordingLogger {
  const recorded: RecordedLine[] = [];
  const record =
    (level: LogLevel | 'content') =>
    (event: LogEvent, fields?: LogFields): void => {
      recorded.push({ level, event, fields });
    };
  const make = (): Logger =>
    ({
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      fatal: record('fatal'),
      content: record('content'),
      child: () => make(),
    }) as unknown as Logger;

  return {
    logger: make(),
    lines: () => [...recorded],
    clear: () => {
      recorded.length = 0;
    },
  };
}
