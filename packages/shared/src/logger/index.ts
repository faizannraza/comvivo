/**
 * The logger.
 *
 * A thin, deliberately narrow wrapper over pino (ADR-013). The narrowness is the feature: the only
 * way to write a log line is `log.info(event, fields)`, where `event` is a code from the catalog
 * and `fields` is the closed `LogFields` type. There is no `log.info(string)` escape hatch, because
 * that is the one signature through which content reliably reaches a log —
 * `log.info(\`replying to ${msg.text}\`)` is the single most natural mistake to make here, and the
 * only reliable fix is to make it not typecheck.
 *
 * Four layers, outermost first (`01` §11.7, `11` §3.10.1, `08` §3.10):
 *
 *   1. **The type** (`fields.ts`) — no field exists for content. Fails in the editor.
 *   2. **The content gate** — `log.content()` is a no-op unless content debugging is explicitly
 *      enabled, and enabling it prints a banner and keeps the output off the log file.
 *   3. **Redaction** (`redact.ts`) — pino removes credential- and content-shaped paths.
 *   4. **Scrubbing** (`scrub.ts`) — secret shapes are stripped from every string, because the one
 *      place a token really does appear is inside somebody else's error message.
 */
import pino from 'pino';
import { BRAND } from '../brand.js';
import { BugError } from '../errors.js';
import { SecretString } from '../secrets/secret-string.js';
import { type LogEvent, messageFor } from './events.js';
import {
  type FieldValue,
  FORBIDDEN_FIELD_NAMES,
  isSafeDetailValue,
  type LogFields,
  type LoggedError,
  MAX_DETAIL_LENGTH,
} from './fields.js';
import { redactOptions } from './redact.js';
import { type BufferedLine, LogRingBuffer } from './ring-buffer.js';
import { describeBytes, isBytes, scrubDeep, scrubErrorMessage } from './scrub.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Levels that reach the ring buffer, per `11` §3.10.1 ("the last 5,000 `info`+ lines"). */
const BUFFERED_LEVELS = new Set<LogLevel>(['info', 'warn', 'error', 'fatal']);

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly format?: 'pretty' | 'json';
  readonly instanceId?: string;
  readonly role?: 'web' | 'worker' | 'all';
  readonly version?: string;
  /**
   * Turn on content logging. Off unless the host sets `<PREFIX>DEBUG_CONTENT=1`; never a
   * configuration file or dashboard setting, because it is a host-only key (A14).
   */
  readonly debugContent?: boolean;
  /** Where lines go. Injected so tests can capture them without a transport. */
  readonly destination?: { write(line: string): void };
  readonly ringBuffer?: LogRingBuffer;
}

/**
 * Turn a thrown value into the allowlisted shape `11` §3.10.1 permits.
 *
 * A provider's error object is **never** logged raw (`08` §3.10 layer 3): its body can echo the
 * request, and for Telegram its URL *is* the bot token.
 */
export function toLoggedError(error: unknown): LoggedError {
  if (error instanceof Error) {
    const withExtras = error as Error & {
      code?: unknown;
      status?: unknown;
      requestId?: unknown;
      request_id?: unknown;
    };
    const requestId = withExtras.requestId ?? withExtras.request_id;
    return {
      type: error.name,
      ...(typeof withExtras.code === 'string' ? { code: withExtras.code } : {}),
      ...(typeof withExtras.status === 'number' ? { status: withExtras.status } : {}),
      ...(typeof requestId === 'string' ? { requestId } : {}),
      message: scrubErrorMessage(error.message),
    };
  }
  return { type: 'unknown', message: scrubErrorMessage(String(error)) };
}

export interface Logger {
  trace(event: LogEvent, fields?: LogFields): void;
  debug(event: LogEvent, fields?: LogFields): void;
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, fields?: LogFields): void;
  fatal(event: LogEvent, fields?: LogFields): void;
  /**
   * Log message or memory **content**.
   *
   * A no-op unless content debugging is on. When it is on, the line is written at `debug` with
   * `content: true`, goes to stdout only, and the startup banner has already told the host (and,
   * from `M5`, the group) that it is happening.
   */
  content(event: LogEvent, payload: Readonly<Record<string, unknown>>): void;
  /** A logger bound to a component, e.g. `engine.turn`. */
  child(fields: LogFields): Logger;
  readonly level: LogLevel;
  readonly contentEnabled: boolean;
  readonly ringBuffer: LogRingBuffer;
}

const FORBIDDEN = new Set(FORBIDDEN_FIELD_NAMES.map((name) => name.toLowerCase()));

/**
 * Remove any forbidden field name, at **any** depth.
 *
 * The third layer. The type (`fields.ts`) stops this at the call site and pino's `redact` covers
 * the top level and one below, but pino's `*` matches exactly one segment — so a content field
 * nested three deep inside a value that lost its type on the way in would survive both. This walks
 * the whole object, which makes `FORBIDDEN_FIELD_NAMES` enforcement rather than documentation.
 *
 * Found by a test rather than by reading: a top-level `text` field was reaching the output,
 * because `*.text` does not match the root.
 */
function stripForbiddenFields(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isBytes(value)) return describeBytes(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stripForbiddenFields(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN.has(key.toLowerCase())) continue;
    out[key] = stripForbiddenFields(item, seen);
  }
  return out;
}

/**
 * Enforce the `detail` and `err` guarantees that the type system cannot.
 *
 * Two holes the M0 independent review measured, both of which compiled and ran:
 *
 *  - `detail: { note: msg.text }` put a member's message in an `info` line. The key-name denylist
 *    could not help: the leak was in the value and the key was `note`. A `detail` string must now
 *    be token-shaped (`isSafeDetailValue`), so prose is refused.
 *  - `err: { type: 'E', message: userText }` built by hand skipped `toLoggedError`, which is the
 *    only place `scrubErrorMessage` was applied. The message is now scrubbed here, whatever route
 *    it arrived by, so the guarantee does not depend on the caller using the helper.
 *
 * Unsafe values are dropped in production and **throw** under `<PREFIX>TEST_MODE`, the same
 * asymmetry as `observability/attributes.ts`: a logging mistake must never take a group's bot
 * down, and a logging mistake that passes CI is worse than one that fails it.
 */
function enforceFieldGuarantees(fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields };
  const rejected: string[] = [];

  const detail = out['detail'];
  if (typeof detail === 'object' && detail !== null && !Array.isArray(detail)) {
    const safe: Record<string, FieldValue> = {};
    for (const [key, value] of Object.entries(detail as Record<string, FieldValue>)) {
      if (isSafeDetailValue(value)) safe[key] = value;
      else rejected.push(`detail.${key}`);
    }
    out['detail'] = safe;
  }

  const err = out['err'];
  if (typeof err === 'object' && err !== null && !Array.isArray(err)) {
    const shaped = err as { message?: unknown };
    if (typeof shaped.message === 'string') {
      out['err'] = { ...shaped, message: scrubErrorMessage(shaped.message) };
    }
  }

  if (rejected.length > 0 && process.env[`${BRAND.envPrefix}TEST_MODE`] === '1') {
    throw new BugError(
      `Log field(s) ${rejected.join(', ')} are not token-shaped, so they may be content. ` +
        'A `detail` string must be an identifier, enum value, path or version — no spaces, at ' +
        `most ${String(MAX_DETAIL_LENGTH)} characters (01 §11.7). If you need to log a message or ` +
        'a memory, use log.content(), which is off unless the host switches it on and announces it.',
    );
  }

  return out;
}

/**
 * Replace any `SecretString` with its name and fingerprint, never its value.
 *
 * Takes `LogFields` as well as a plain record. The cast inside is deliberate and belongs here:
 * `LogFields` has **no index signature**, which is precisely what makes
 * `log.info('x', { text: msg.text })` a compile error at the call site. Widening it once, in a
 * single audited helper, is the price of that guarantee — and the alternative (an index signature
 * on `LogFields`) would throw the guarantee away.
 */
function describeSecrets(
  fields: LogFields | Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields as Readonly<Record<string, unknown>>)) {
    out[key] =
      value instanceof SecretString
        ? { name: value.name, fingerprint: value.fingerprint(), length: value.length }
        : value;
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  const ringBuffer = options.ringBuffer ?? new LogRingBuffer();
  const contentEnabled = options.debugContent ?? false;

  const base: Record<string, unknown> = {
    svc: BRAND.slug,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
    ...(options.role === undefined ? {} : { role: options.role }),
  };

  const pinoOptions: pino.LoggerOptions = {
    level,
    base,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Pass `err` through untouched. pino's default error serializer would otherwise rewrite it:
    // it reported `type: "Object"` instead of the error's class name and appended an empty
    // `stack`. `toLoggedError` has already produced exactly the allowlisted shape `11` §3.10.1
    // specifies, with the message scrubbed and truncated — there is nothing left for a serializer
    // to add, and plenty it could leak.
    serializers: { err: (value: unknown) => value },
    redact: redactOptions(),
  };

  const root =
    options.destination === undefined
      ? pino(pinoOptions)
      : pino(pinoOptions, { write: (line: string) => options.destination?.write(line) });

  /**
   * A separate instance for `log.content()`, with **no redaction**.
   *
   * This is architecture, not a workaround. `11` §3.10.1 says the content channel "never writes to
   * the log file, only to stdout", so it is a different destination by specification — and it has
   * to be, because the redaction that protects the normal channel would otherwise strip the very
   * fields `content()` exists to show. Keeping them as two instances means the normal channel's
   * protections can never be loosened to accommodate the debug one.
   *
   * Built only when content logging is on, so a disabled gate costs nothing.
   */
  const contentRoot = !contentEnabled
    ? undefined
    : (() => {
        const contentOptions: pino.LoggerOptions = {
          level: 'debug',
          base: { ...base, content: true },
          timestamp: pino.stdTimeFunctions.isoTime,
          formatters: { level: (label) => ({ level: label }) },
        };
        return options.destination === undefined
          ? pino(contentOptions)
          : pino(contentOptions, { write: (line: string) => options.destination?.write(line) });
      })();

  const wrap = (instance: pino.Logger, bound: Readonly<Record<string, unknown>>): Logger => {
    const emit = (lvl: LogLevel, event: LogEvent, fields: LogFields | undefined): void => {
      const msg = messageFor(event);
      // Scrub before writing, not after: a shipper that reads stdout must never see the raw string.
      const payload = scrubDeep(
        stripForbiddenFields(enforceFieldGuarantees({ event, ...describeSecrets(fields ?? {}) })),
      ) as Record<string, unknown>;

      instance[lvl](payload, msg);

      if (BUFFERED_LEVELS.has(lvl)) {
        const line: BufferedLine = {
          time: Date.now(),
          level: lvl,
          event,
          msg,
          fields: { ...bound, ...payload },
        };
        ringBuffer.push(line);
      }
    };

    return {
      level,
      contentEnabled,
      ringBuffer,
      trace: (event, fields) => {
        emit('trace', event, fields);
      },
      debug: (event, fields) => {
        emit('debug', event, fields);
      },
      info: (event, fields) => {
        emit('info', event, fields);
      },
      warn: (event, fields) => {
        emit('warn', event, fields);
      },
      error: (event, fields) => {
        emit('error', event, fields);
      },
      fatal: (event, fields) => {
        emit('fatal', event, fields);
      },
      content: (event, payload) => {
        if (contentRoot === undefined) return;
        // Deliberately NOT scrubbed, NOT redacted and NOT ring-buffered: the whole point is to see
        // the content, and the ring buffer feeds `doctor --bundle`, which a host may paste into a
        // public issue.
        contentRoot.debug({ event, ...bound, ...payload }, messageFor(event));
      },
      child: (fields) => {
        const merged = { ...bound, ...describeSecrets(fields) };
        return wrap(instance.child(scrubDeep(describeSecrets(fields)) as pino.Bindings), merged);
      },
    };
  };

  const logger = wrap(root, base);

  if (contentEnabled) {
    // A banner, every time, at `warn`. `01` §11.7 requires it, and the reason is simple: content
    // logging must never be on without somebody noticing.
    // No prose in `detail`: a `detail` string must be token-shaped so a message cannot get in,
    // and our own warning text is not an exception worth carving — it is exactly the shape the
    // rule refuses. The full explanation lives in `contentWarningBanner()`, which the CLI prints
    // to stderr where a host will actually read it; `LOG_EVENTS` keeps its messages short by
    // design, asserted by its own test.
    logger.warn('debug.content_enabled', {
      detail: { envVar: `${BRAND.envPrefix}DEBUG_CONTENT` },
    });
  }

  return logger;
}

/**
 * The banner text, exported so the CLI can print it to stderr as well as logging it — a host
 * scrolling past JSON lines should not be able to miss this.
 */
export function contentWarningBanner(): string {
  const line = '─'.repeat(72);
  return [
    line,
    `  ${BRAND.envPrefix}DEBUG_CONTENT is ON.`,
    '',
    '  Message and memory content will be written to this log at debug level.',
    "  That includes other members' private messages.",
    '',
    '  Never leave this on for a real group.',
    line,
  ].join('\n');
}

export { isKnownEvent, LOG_EVENTS, type LogEvent, messageFor } from './events.js';
export {
  type FieldValue,
  FORBIDDEN_FIELD_NAMES,
  type LogFields,
  type LoggedError,
} from './fields.js';
export { REDACT_PATHS, redactOptions } from './redact.js';
export { type BufferedLine, LogRingBuffer } from './ring-buffer.js';
export {
  MAX_MESSAGE_LENGTH,
  SCRUBBED,
  SECRET_PATTERNS,
  scrubDeep,
  scrubErrorMessage,
  scrubSecretShapes,
} from './scrub.js';
