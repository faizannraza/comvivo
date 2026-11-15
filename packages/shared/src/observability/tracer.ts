/**
 * The tracing facade.
 *
 * Tracing is **optional and off by default** (`11` §3.10.2). With it off, nothing is loaded and
 * nothing is allocated: `getTracer()` returns a frozen no-op whose `startSpan` hands back a shared
 * singleton span. That matters more than it sounds — a turn creates a dozen spans, and a product
 * that runs on a Raspberry Pi 5 cannot spend anything on a feature nobody enabled.
 *
 * The OpenTelemetry SDK is loaded through `import()` only when the host enables it, so a disabled
 * OTel means the packages are never resolved, never parsed and never on the heap.
 *
 * ## Why a facade rather than `@opentelemetry/api` directly
 *
 * Three reasons, in order of how much they matter:
 *
 *  1. **Content cannot be attached.** `Span.setAttributes` takes our `Attributes` type, which makes
 *     `gen_ai.input.messages` a compile error (`attributes.ts`). OTel's own `SpanAttributes` is an
 *     open `Record`, so instrumenting against it directly would make the leak typecheck.
 *  2. **The dependency stays out of the graph.** `@comvivo/shared` is imported by every package
 *     including the pure ones; `01` §4 keeps it free of heavy runtime dependencies, and
 *     `.dependency-cruiser.cjs` enforces that.
 *  3. **Spans stay testable without an SDK.** `recordingTracer()` collects spans in memory, which
 *     is how the span-shape assertions in `M2-T15` run in the unit tier.
 */
import { BRAND } from '../brand.js';
import { AppError } from '../errors.js';
import { toLoggedError } from '../logger/index.js';
import { err, ok, type Result } from '../result.js';
import { type Attributes, type AttributeValue, sanitizeAttributes } from './attributes.js';

/** OTel span kinds, lower-cased so they survive a config round trip. */
export type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer';

export type SpanStatus = 'unset' | 'ok' | 'error';

/** Enough of a span context to link one span to another across a job boundary. */
export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  /** W3C trace flags; bit 0 is "sampled". */
  readonly traceFlags: number;
}

export interface SpanLink {
  readonly context: SpanContext;
  readonly attributes?: Attributes;
}

export interface SpanOptions {
  readonly kind?: SpanKind;
  readonly attributes?: Attributes;
  /**
   * Links to other spans. A job's span links to the span that enqueued it, because the enqueue and
   * the run can be hours apart and a parent-child edge would misrepresent that (`11` §3.10.2).
   */
  readonly links?: readonly SpanLink[];
}

export interface Span {
  /** Attributes are sanitized before they reach a backend, even though the type already refuses content. */
  setAttributes(attributes: Attributes): void;
  setStatus(status: SpanStatus, description?: string): void;
  /** Records an error and sets the status. The message is scrubbed and truncated by `toLoggedError`. */
  recordError(error: unknown): void;
  addLink(link: SpanLink): void;
  end(): void;
  /** `undefined` on a no-op span, so a caller can skip building a `traceparent` nobody will read. */
  readonly context: SpanContext | undefined;
  /** False when nothing is listening, so an expensive attribute can be skipped. */
  readonly isRecording: boolean;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
  /**
   * Run `fn` inside a span, ending it even if `fn` throws and recording the error.
   *
   * Sync and async are separate methods on purpose: one generic that accepted both would have to
   * inspect the return value for a `then`, which `@typescript-eslint/no-misused-promises` rightly
   * objects to and which hides a forgotten `await` at every call site.
   */
  withSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => T): T;
  withSpanAsync<T>(name: string, options: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T>;
}

/** What a backend must provide. Implemented by the OTel backend, and by `recordingTracer()` in tests. */
export interface TracerBackend {
  tracer(name: string): Tracer;
  /** Flush and stop. Called from the shutdown sequence so a crash report's last span is not lost. */
  shutdown(): Promise<void>;
}

// --- The no-op backend --------------------------------------------------------------------------

const NOOP_SPAN: Span = Object.freeze({
  setAttributes: (): void => {},
  setStatus: (): void => {},
  recordError: (): void => {},
  addLink: (): void => {},
  end: (): void => {},
  context: undefined,
  isRecording: false,
});

const NOOP_TRACER: Tracer = Object.freeze({
  startSpan: (): Span => NOOP_SPAN,
  withSpan: <T>(_name: string, _options: SpanOptions, fn: (span: Span) => T): T => fn(NOOP_SPAN),
  withSpanAsync: <T>(
    _name: string,
    _options: SpanOptions,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> => fn(NOOP_SPAN),
});

/** The tracer used when tracing is off. Exported so a test can assert identity rather than shape. */
export function noopTracer(): Tracer {
  return NOOP_TRACER;
}

export function noopSpan(): Span {
  return NOOP_SPAN;
}

// --- The recording backend (tests, and `M2-T15`'s span-shape assertions) ------------------------

export interface RecordedSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly attributes: Record<string, AttributeValue>;
  readonly links: SpanLink[];
  status: SpanStatus;
  statusDescription: string | undefined;
  error: { type: string; message: string } | undefined;
  ended: boolean;
}

export interface RecordingTracer extends Tracer {
  readonly spans: readonly RecordedSpan[];
  /** Spans with a given name, in start order. */
  named(name: string): readonly RecordedSpan[];
  reset(): void;
}

/**
 * A tracer that keeps spans in memory.
 *
 * This is the substitute for an OTel in-memory exporter, and a better one for our purposes: it
 * records what *we* asked for, so a test asserting the span shape in `11` §3.10.2 fails for the
 * reason it claims rather than because an SDK renamed a field. `M2-T15`'s span-shape and
 * no-content-attribute assertions run against it; see `packages/models/src/telemetry.test.ts`.
 */
export function recordingTracer(): RecordingTracer {
  const spans: RecordedSpan[] = [];

  const make = (name: string, options: SpanOptions = {}): Span => {
    const record: RecordedSpan = {
      name,
      kind: options.kind ?? 'internal',
      attributes: sanitizeAttributes(options.attributes ?? {}),
      links: [...(options.links ?? [])],
      status: 'unset',
      statusDescription: undefined,
      error: undefined,
      ended: false,
    };
    spans.push(record);

    return {
      setAttributes: (attributes) => {
        Object.assign(record.attributes, sanitizeAttributes(attributes));
      },
      setStatus: (status, description) => {
        record.status = status;
        record.statusDescription = description;
      },
      recordError: (error) => {
        const logged = toLoggedError(error);
        record.error = { type: logged.type, message: logged.message };
        record.status = 'error';
      },
      addLink: (link) => {
        record.links.push(link);
      },
      end: () => {
        record.ended = true;
      },
      // A deterministic fake id: real enough to propagate, obviously not from a real trace.
      context: {
        traceId: `00000000000000000000000000000${(spans.length % 1000).toString().padStart(3, '0')}`,
        spanId: `000000000000${(spans.length % 10000).toString().padStart(4, '0')}`,
        traceFlags: 1,
      },
      isRecording: true,
    };
  };

  const withSpan = <T>(name: string, options: SpanOptions, fn: (span: Span) => T): T => {
    const span = make(name, options);
    try {
      const value = fn(span);
      if (span.isRecording) span.setStatus('ok');
      return value;
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
    }
  };

  const withSpanAsync = async <T>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> => {
    const span = make(name, options);
    try {
      const value = await fn(span);
      span.setStatus('ok');
      return value;
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
    }
  };

  return {
    startSpan: make,
    withSpan,
    withSpanAsync,
    get spans() {
      return spans;
    },
    named: (name) => spans.filter((span) => span.name === name),
    reset: () => {
      spans.length = 0;
    },
  };
}

// --- The registry -------------------------------------------------------------------------------

let backend: TracerBackend | undefined;

/**
 * Install a backend. Called once at startup by the host, never by library code.
 *
 * Returns the previous backend so a test can restore it, which is what keeps a test that enables
 * tracing from leaking into the next one.
 */
export function setTracerBackend(next: TracerBackend | undefined): TracerBackend | undefined {
  const previous = backend;
  backend = next;
  return previous;
}

export function getTracer(name: string): Tracer {
  return backend?.tracer(name) ?? NOOP_TRACER;
}

export function tracingEnabled(): boolean {
  return backend !== undefined;
}

export async function shutdownTracing(): Promise<void> {
  const current = backend;
  backend = undefined;
  await current?.shutdown();
}

// --- Lazy loading -------------------------------------------------------------------------------

export interface OtelTracingConfig {
  /** OTLP HTTP endpoint, e.g. `http://localhost:4318`. */
  readonly endpoint: string;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly instanceId: string;
  /** Parent-based sampler ratio. 1.0 by default: volume is low on a single host. */
  readonly sampleRatio: number;
}

/**
 * The module shape the OTel backend must export.
 *
 * Declared here rather than imported so this file has no dependency on the backend, which is the
 * whole point: the `import()` below is the only edge between them, and a bundler can see that it is
 * conditional.
 */
export interface TracerBackendModule {
  createOtelTracerBackend(config: OtelTracingConfig): Promise<TracerBackend>;
}

export type BackendLoader = () => Promise<TracerBackendModule>;

/**
 * The default loader.
 *
 * The OpenTelemetry SDK is not a dependency of `@comvivo/shared` and must not become one — `01` §4
 * keeps this package at the bottom of the graph, and every package imports it. The backend module
 * is installed alongside the server, and **`M9-T42`** is the task that adds it.
 *
 * `M2-T15` was originally named here as that task, on the reasoning that the first consumer should
 * bring the backend. That was wrong on inspection: the OTel backend is host infrastructure of
 * exactly the kind `11` §3.10.3 already assigns to `M9-T36` (the prom-client `/metrics` backend),
 * and `M2-T15` is a model-gateway task whose single listed file is `packages/models/src/telemetry.ts`.
 * Shipping a lazily-loaded OTLP exporter from inside the model package would put six runtime
 * dependencies in the wrong milestone and the wrong layer. So `M2-T15` instruments, `M9-T42`
 * exports, and `recordingTracer()` below is what the span-shape assertions run against — which is
 * the better substrate for them anyway, because it records what *we* asked for.
 *
 * Until `M9-T42`, `observability.otel.enabled` is refused at startup with the message below rather
 * than silently doing nothing. Refusing is the right behaviour: a host who turned tracing on and
 * saw no traces would spend an hour on their collector before suspecting us.
 */
const defaultLoader: BackendLoader = async () => {
  // Built at runtime so the bundler and `pnpm depcruise` do not treat this as a static edge to a
  // package that is deliberately absent.
  const specifier = [BRAND.npmScope, 'observability-otel'].join('/');
  return (await import(/* @vite-ignore */ specifier)) as TracerBackendModule;
};

let loadAttempted = false;

/**
 * Load and install the OTel backend. Idempotent.
 *
 * `loader` is injectable so the lazy-loading contract itself is testable: that nothing is imported
 * while tracing is disabled, that enabling imports exactly once, and that a missing package
 * produces a fix-it message rather than a stack trace.
 */
export async function enableOtelTracing(
  config: OtelTracingConfig,
  loader: BackendLoader = defaultLoader,
): Promise<Result<TracerBackend, AppError>> {
  if (backend !== undefined) return ok(backend);
  if (loadAttempted) {
    return err(
      new AppError('config.invalid', 'OpenTelemetry tracing already failed to load; not retrying', {
        userMessage: 'I could not start tracing.',
      }),
    );
  }
  loadAttempted = true;

  try {
    const module = await loader();
    const installed = await module.createOtelTracerBackend(config);
    backend = installed;
    return ok(installed);
  } catch (cause) {
    return err(
      new AppError('config.invalid', 'OpenTelemetry tracing could not be loaded', {
        userMessage:
          'Tracing is switched on but the OpenTelemetry backend is not installed, so I started ' +
          'without it. Set observability.otel.enabled to false to silence this, or install the ' +
          'tracing extra. Everything else is running normally.',
        cause,
      }),
    );
  }
}

/** Reset the load latch. Tests only; a process never re-enables tracing. */
export function resetTracingForTest(): void {
  loadAttempted = false;
  backend = undefined;
}
