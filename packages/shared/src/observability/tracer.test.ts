import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRAND } from '../brand.js';
import { GENAI, SPAN } from './semconv-genai.js';
import {
  type BackendLoader,
  enableOtelTracing,
  getTracer,
  noopSpan,
  noopTracer,
  type OtelTracingConfig,
  recordingTracer,
  resetTracingForTest,
  type Span,
  setTracerBackend,
  shutdownTracing,
  type TracerBackend,
  tracingEnabled,
} from './tracer.js';

afterEach(() => {
  resetTracingForTest();
});

const CONFIG: OtelTracingConfig = {
  endpoint: 'http://localhost:4318',
  serviceName: BRAND.slug,
  serviceVersion: '1.0.0',
  instanceId: 'test-instance',
  sampleRatio: 1,
};

describe('the no-op tracer', () => {
  it('is what you get when no backend is installed', () => {
    // Identity, not shape: a fresh object per call would allocate on a hot path for no gain.
    expect(getTracer('engine.turn')).toBe(noopTracer());
    expect(tracingEnabled()).toBe(false);
  });

  it('hands back a frozen singleton span that records nothing', () => {
    const span = noopTracer().startSpan(SPAN.INGEST, { kind: 'internal' });
    expect(span).toBe(noopSpan());
    expect(span.isRecording).toBe(false);
    // `undefined` context, so a caller can skip building a traceparent nobody will read.
    expect(span.context).toBeUndefined();
    expect(Object.isFrozen(span)).toBe(true);
  });

  it('accepts every call without throwing, so instrumentation needs no guard', () => {
    const span = noopTracer().startSpan('x');
    expect(() => {
      span.setAttributes({ [GENAI.REQUEST_MODEL]: 'claude-opus-5-5' });
      span.setStatus('ok');
      span.recordError(new Error('boom'));
      span.addLink({ context: { traceId: 'a', spanId: 'b', traceFlags: 1 } });
      span.end();
    }).not.toThrow();
  });

  it('still runs the function passed to withSpan', () => {
    expect(noopTracer().withSpan('x', {}, () => 42)).toBe(42);
  });

  it('still awaits the function passed to withSpanAsync', async () => {
    await expect(noopTracer().withSpanAsync('x', {}, async () => 42)).resolves.toBe(42);
  });

  it('propagates a throw rather than swallowing it', () => {
    expect(() =>
      noopTracer().withSpan('x', {}, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });
});

describe('the recording tracer', () => {
  it('records name, kind and attributes', () => {
    const tracer = recordingTracer();
    tracer
      .startSpan('chat claude-opus-5-5', {
        kind: 'client',
        attributes: { [GENAI.REQUEST_MODEL]: 'claude-opus-5-5', [GENAI.USAGE_INPUT_TOKENS]: 175 },
      })
      .end();

    const [span] = tracer.spans;
    expect(span?.name).toBe('chat claude-opus-5-5');
    expect(span?.kind).toBe('client');
    expect(span?.attributes).toEqual({
      'gen_ai.request.model': 'claude-opus-5-5',
      'gen_ai.usage.input_tokens': 175,
    });
    expect(span?.ended).toBe(true);
  });

  it('defaults the kind to internal', () => {
    const tracer = recordingTracer();
    tracer.startSpan(SPAN.CONTEXT_BUILD).end();
    expect(tracer.spans[0]?.kind).toBe('internal');
  });

  it('sanitizes attributes passed at start and later', () => {
    const tracer = recordingTracer();
    // Forbidden attributes throw in test mode, which is the behaviour a leaking test needs.
    expect(() =>
      // @ts-expect-error the type refuses this; the runtime must too, for untyped data
      tracer.startSpan('x', { attributes: { 'gen_ai.input.messages': 'private' } }),
    ).toThrow(/forbidden/);

    const span = tracer.startSpan('y');
    // @ts-expect-error same, on the later setter
    expect(() => span.setAttributes({ text: 'private' })).toThrow(/forbidden/);
  });

  it('merges later attributes into the span', () => {
    const tracer = recordingTracer();
    const span = tracer.startSpan('x', { attributes: { [GENAI.REQUEST_MODEL]: 'a' } });
    span.setAttributes({ [GENAI.RESPONSE_MODEL]: 'b' });
    span.end();
    expect(tracer.spans[0]?.attributes).toEqual({
      'gen_ai.request.model': 'a',
      'gen_ai.response.model': 'b',
    });
  });

  it('records an error with a scrubbed message and sets the status', () => {
    const tracer = recordingTracer();
    const token = `${'123456789'}:${'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'}`;
    const span = tracer.startSpan('x');
    span.recordError(new TypeError(`401 from /bot${token}/sendMessage`));
    span.end();

    const recorded = tracer.spans[0];
    expect(recorded?.status).toBe('error');
    expect(recorded?.error?.type).toBe('TypeError');
    expect(recorded?.error?.message).not.toContain(token);
  });

  it('keeps links, including ones added after the span started', () => {
    const tracer = recordingTracer();
    const context = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 };
    const span = tracer.startSpan('job', { kind: 'consumer', links: [{ context }] });
    span.addLink({ context: { ...context, spanId: 'c'.repeat(16) } });
    span.end();
    expect(tracer.spans[0]?.links).toHaveLength(2);
  });

  it('ends the span and marks it ok when withSpan returns', () => {
    const tracer = recordingTracer();
    const value = tracer.withSpan(SPAN.GUARD_CHECK, {}, (span: Span) => {
      expect(span.isRecording).toBe(true);
      return 'allow';
    });
    expect(value).toBe('allow');
    expect(tracer.spans[0]?.status).toBe('ok');
    expect(tracer.spans[0]?.ended).toBe(true);
  });

  it('ends the span and records the error when withSpan throws', () => {
    const tracer = recordingTracer();
    expect(() =>
      tracer.withSpan('x', {}, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(tracer.spans[0]?.status).toBe('error');
    expect(tracer.spans[0]?.error?.message).toContain('boom');
    // Ended even though the body threw: an unended span is a leak in every backend.
    expect(tracer.spans[0]?.ended).toBe(true);
  });

  it('ends the span and records the rejection when withSpanAsync rejects', async () => {
    const tracer = recordingTracer();
    await expect(
      tracer.withSpanAsync('x', {}, () => Promise.reject(new Error('nope'))),
    ).rejects.toThrow('nope');
    expect(tracer.spans[0]?.status).toBe('error');
    expect(tracer.spans[0]?.ended).toBe(true);
  });

  it('finds spans by name and resets', () => {
    const tracer = recordingTracer();
    tracer.startSpan(SPAN.INGEST).end();
    tracer.startSpan(SPAN.INGEST).end();
    tracer.startSpan(SPAN.OUTBOX_SEND).end();
    expect(tracer.named(SPAN.INGEST)).toHaveLength(2);
    expect(tracer.named(SPAN.OUTBOX_SEND)).toHaveLength(1);
    tracer.reset();
    expect(tracer.spans).toHaveLength(0);
  });
});

describe('the backend registry', () => {
  it('routes getTracer through an installed backend', () => {
    const recorder = recordingTracer();
    const backend: TracerBackend = {
      tracer: () => recorder,
      shutdown: () => Promise.resolve(),
    };
    setTracerBackend(backend);
    expect(tracingEnabled()).toBe(true);
    getTracer('engine.turn').startSpan(SPAN.INGEST).end();
    expect(recorder.spans).toHaveLength(1);
  });

  it('returns the previous backend so a test can restore it', () => {
    const first: TracerBackend = { tracer: () => noopTracer(), shutdown: () => Promise.resolve() };
    expect(setTracerBackend(first)).toBeUndefined();
    expect(setTracerBackend(undefined)).toBe(first);
  });

  it('flushes and clears on shutdown', async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    setTracerBackend({ tracer: () => noopTracer(), shutdown });
    await shutdownTracing();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(tracingEnabled()).toBe(false);
    expect(getTracer('x')).toBe(noopTracer());
  });
});

describe('lazy loading', () => {
  it('imports nothing while tracing is disabled', () => {
    // The contract `11` §3.10.2 states as "OTel disabled = no SDK loaded", asserted rather than
    // assumed: a loader that is never called cannot have resolved a package.
    const loader = vi.fn<BackendLoader>();
    getTracer('engine.turn').startSpan(SPAN.INGEST).end();
    expect(loader).not.toHaveBeenCalled();
  });

  it('imports exactly once when enabled', async () => {
    const recorder = recordingTracer();
    const backend: TracerBackend = { tracer: () => recorder, shutdown: () => Promise.resolve() };
    const loader = vi.fn<BackendLoader>(() =>
      Promise.resolve({ createOtelTracerBackend: () => Promise.resolve(backend) }),
    );

    const first = await enableOtelTracing(CONFIG, loader);
    expect(first.ok).toBe(true);
    const second = await enableOtelTracing(CONFIG, loader);
    expect(second.ok).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(tracingEnabled()).toBe(true);
  });

  it('passes the config through to the backend factory', async () => {
    const create = vi.fn(() =>
      Promise.resolve<TracerBackend>({
        tracer: () => noopTracer(),
        shutdown: () => Promise.resolve(),
      }),
    );
    await enableOtelTracing(CONFIG, () => Promise.resolve({ createOtelTracerBackend: create }));
    expect(create).toHaveBeenCalledWith(CONFIG);
  });

  it('returns a fix-it message when the backend is not installed', async () => {
    const result = await enableOtelTracing(CONFIG, () =>
      Promise.reject(new Error(`Cannot find module '${BRAND.npmScope}/observability-otel'`)),
    );
    expect(result.ok).toBe(false);
    if (result.ok) expect.unreachable('should have failed');

    // A host who switched tracing on and saw nothing would spend an hour on their collector
    // before suspecting us, so the message has to say what happened and what to do.
    const message = result.error.userMessage ?? '';
    expect(message).toContain('observability.otel.enabled');
    expect(message).toContain('not installed');
    // And it has to say the rest of the process is fine, because it is.
    expect(message).toMatch(/running normally/);
  });

  it('does not install a backend when loading fails', async () => {
    await enableOtelTracing(CONFIG, () => Promise.reject(new Error('nope')));
    expect(tracingEnabled()).toBe(false);
    expect(getTracer('x')).toBe(noopTracer());
  });

  it('does not retry a failed load', async () => {
    // Retrying on every span would turn a missing package into a per-turn resolution attempt.
    const loader = vi.fn<BackendLoader>(() => Promise.reject(new Error('nope')));
    await enableOtelTracing(CONFIG, loader);
    const second = await enableOtelTracing(CONFIG, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(second.ok).toBe(false);
  });
});
