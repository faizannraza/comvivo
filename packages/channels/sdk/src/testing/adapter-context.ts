/**
 * The `AdapterContext` the conformance kit hands an adapter (`06` §3.25; `M3-T9`).
 *
 * Every adapter under test gets this one, which is what makes the 24 cases comparable: the thing
 * being varied is the adapter, so the context must not be. It is also where several cases get their
 * evidence, and that is the design rather than a convenience —
 *
 * - **C05** needs the order of "the platform was acked" and "the ingest was acked". Neither is
 *   observable from outside the adapter unless something records both, and only the context sees
 *   one of them.
 * - **C22** needs every line the adapter logged, at its level, to assert that nothing above `debug`
 *   carries message text.
 * - **C18** needs the health reports, with timings.
 *
 * ## Why the ingest hook returns a real ack
 *
 * `ctx.ingest` answers `accepted`, `duplicate` or `dropped`, and `06` §3.24's gates mean an adapter
 * must behave differently for each — an unclaimed chat must not cause an attachment fetch (C19).
 * So the context takes a **binding view** the case can drive, and answers from it, rather than
 * always saying `accepted`: a kit whose ingest always accepted would make the gate cases
 * unwritable.
 */
import type { Logger, Rng } from '@comvivo/shared';
import type { VirtualClock } from '@comvivo/shared/testing';
import type {
  AdapterContext,
  AdapterHealth,
  AdapterStateStore,
  ChannelId,
  CommandSpec,
  Diagnostic,
  IngestAck,
  SentPart,
} from '../contract.js';
import type { IngestedItem, LoggedLine } from './harness.js';

export interface HealthReport {
  readonly status: AdapterHealth;
  readonly reason: string | undefined;
  readonly diagnostics: readonly Diagnostic[];
  readonly atMs: number;
}

export interface TestContextOptions {
  readonly channel: ChannelId;
  readonly clock: VirtualClock;
  readonly config?: unknown;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly commands?: readonly CommandSpec[];
  /** Drives `ctx.bindings`, so C19's unclaimed-chat gate is a case rather than a comment. */
  readonly binding?: (platformChatId: string) => 'bound' | 'unclaimed' | 'detached';
  /** `fetch`, for an adapter that uses it. Refuses by default: nothing here should reach a network. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface TestContext {
  readonly ctx: AdapterContext;
  readonly abort: AbortController;
  logs(): readonly LoggedLine[];
  ingested(): readonly IngestedItem[];
  health(): readonly HealthReport[];
  /** The interleaving of platform acks and ingest acks, in order, for C05. */
  trace(): readonly string[];
  /** Called by the fake platform so an ack lands in the same trace as the ingest. */
  notePlatformAck(detail: string): void;
  progress(): readonly { readonly idempotencyKey: string; readonly part: SentPart }[];
  readonly state: AdapterStateStore;
}

/** A deterministic `Rng`. Not `SeededRng`, to keep the kit free of a dependency on its internals. */
function countingRng(): Rng {
  let at = 0;
  const rng: Rng = {
    next: () => {
      at += 1;
      // A fixed low-discrepancy sequence: enough variation for a jitter, fully reproducible.
      return ((at * 2_654_435_761) % 1_000_000) / 1_000_000;
    },
    nextInt: (maxExclusive: number) => Math.floor(rng.next() * maxExclusive),
    fork: () => countingRng(),
  };
  return rng;
}

export function createTestContext(options: TestContextOptions): TestContext {
  const { clock } = options;
  const startedAt = clock.now().epochMilliseconds;
  const logs: LoggedLine[] = [];
  const ingested: IngestedItem[] = [];
  const health: HealthReport[] = [];
  const trace: string[] = [];
  const progress: { idempotencyKey: string; part: SentPart }[] = [];
  const store = new Map<string, unknown>();
  const abort = new AbortController();
  const now = (): number => clock.now().epochMilliseconds - startedAt;

  const record =
    (level: string) =>
    (event: string, fields?: unknown): void => {
      logs.push({ level, event, fields });
    };
  const logger = {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    content: record('content'),
    child: () => logger,
  } as unknown as Logger;

  const state: AdapterStateStore = {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
    delete: (key) => {
      store.delete(key);
    },
  };

  const ack = (platformChatId: string): IngestAck => {
    const status = options.binding?.(platformChatId) ?? 'bound';
    if (status === 'unclaimed') return { status: 'dropped', reason: 'unclaimed' };
    if (status === 'detached') return { status: 'dropped', reason: 'detached' };
    return { status: 'accepted' };
  };

  const ctx: AdapterContext = {
    channel: options.channel,
    config: options.config ?? {},
    secrets: { get: (name) => options.secrets?.[name] },
    logger,
    clock,
    timers: clock,
    rng: countingRng(),
    signal: abort.signal,
    fetch:
      options.fetch ??
      (() => Promise.reject(new Error('the conformance kit does not provide a network'))),
    dataDir: '/dev/null/conformance',
    ingest: (envelope) => {
      ingested.push({ kind: 'envelope', value: envelope, atMs: now() });
      trace.push(`ingest:${envelope.platformMessageId}`);
      return Promise.resolve(ack(envelope.platformChatId));
    },
    ingestEvent: (event) => {
      ingested.push({ kind: 'event', value: event, atMs: now() });
      trace.push(`ingestEvent:${event.type}`);
      return Promise.resolve({ status: 'accepted' });
    },
    state,
    health: {
      report: (status, detail) => {
        health.push({
          status,
          reason: detail?.reason,
          diagnostics: detail?.diagnostics ?? [],
          atMs: now(),
        });
      },
    },
    commands: options.commands ?? [],
    bindings: {
      status: (platformChatId) => options.binding?.(platformChatId) ?? 'bound',
      hasPendingClaim: () => false,
    },
    sendProgress: {
      record: (idempotencyKey, part) => {
        progress.push({ idempotencyKey, part });
      },
    },
    metrics: { counter: () => {}, histogram: () => {} },
  };

  return {
    ctx,
    abort,
    logs: () => [...logs],
    ingested: () => [...ingested],
    health: () => [...health],
    trace: () => [...trace],
    notePlatformAck: (detail) => {
      trace.push(`call:${detail}`);
    },
    progress: () => [...progress],
    state,
  };
}
