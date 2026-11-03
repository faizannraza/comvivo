/**
 * The metrics facade and the metric catalog.
 *
 * Metrics are **optional and off by default** (`11` §3.10.3). The default backend is a no-op, and
 * `/metrics` is served only when the host asks for it — on the dashboard listener, never on the
 * ingress listener, and never on a port of its own (`M9-T36`).
 *
 * ## Why the catalog is declarative
 *
 * Every metric in `11` §3.10.3 is declared here once, with its type, label names, help text and
 * histogram buckets, instead of being created at the call site. That buys three things:
 *
 *  1. **Labels are typed.** `metrics.counter('turns_total').inc({ status, trigger })` will not
 *     compile with a label the catalog does not list, or without one it does. A metric with a
 *     missing label is the classic Prometheus bug: the series silently splits and every dashboard
 *     built on it is quietly wrong.
 *  2. **Cardinality is reviewable.** `11` §8 budgets "≤ ~5k series worst case" and forbids
 *     per-member labels. With the labels declared in one table, that is a test (`metrics.test.ts`)
 *     rather than a code review promise — and `M9-T36`'s "no member or conversation label names"
 *     check reads the catalog instead of parsing a scrape.
 *  3. **The scrape is documented.** `M9` generates the metrics reference from this table, so the
 *     docs cannot drift from what the process actually exposes.
 *
 * Declaring a metric here does not emit it. Emission belongs to the subsystem that owns the number,
 * and each one arrives with its milestone.
 */
import { BRAND } from '../brand.js';
import { BugError } from '../errors.js';

/**
 * Histogram buckets.
 *
 * Bucket edges are chosen so that **every budget boundary in `01` §11.10 and `00` is itself an
 * edge**. That is not cosmetic: `histogram_quantile` interpolates linearly *inside* the bucket a
 * quantile falls in, so a p95 budget that lands mid-bucket is reported as a guess whose error
 * depends on bucket width. Put 0.02 and 4 and 10 on edges and "p95 reply ≤ 4 s" becomes a fact the
 * scrape can answer exactly.
 */
export const BUCKETS = {
  /** Ingestion: budget < 20 ms p95 (`01` §11.10). */
  INGEST: [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1] as const,
  /** Replies and turns: budget p50 ≤ 4 s, p95 ≤ 10 s (`00` §Performance). */
  REPLY: [0.5, 1, 2, 4, 6, 10, 20, 40, 60] as const,
  /** One model request. Long tail: a big Opus turn with adaptive thinking can run a minute. */
  MODEL: [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 60] as const,
  /** Job runs, from a 10 ms outbox send to a multi-minute consolidation batch. */
  JOB: [0.01, 0.05, 0.25, 1, 5, 30, 120, 600] as const,
  /** Queue lag and reminder fire lag. A reminder more than 5 minutes late is a product failure. */
  LAG: [0.1, 0.5, 1, 5, 30, 60, 300, 1800] as const,
} as const;

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricSpec {
  readonly type: MetricType;
  /** The `# HELP` line. Written for a host reading a scrape, not for us. */
  readonly help: string;
  readonly labels: readonly string[];
  readonly buckets?: readonly number[];
  /**
   * Whether a `group` label is added when `observability.metrics.perGroupLabels` is on.
   *
   * Off by default and only ever on the handful of metrics where per-group detail answers a real
   * question a host asks ("which group is burning the budget?"). Every other metric stays
   * group-free so cardinality cannot grow with the number of groups.
   */
  readonly groupLabel?: true;
}

/**
 * The metric catalog (`11` §3.10.3).
 *
 * Keys are the metric name without the brand prefix. `metricName()` adds it, so the rename codemod
 * (`13` §3.A.6) reaches every name from one place.
 */
export const METRICS = {
  build_info: {
    type: 'gauge',
    help: 'Build information. Always 1; read the labels.',
    labels: ['version', 'node'],
  },

  // --- Ingestion ------------------------------------------------------------------------------
  inbound_messages_total: {
    type: 'counter',
    help: 'Messages received from a channel, by what we decided to do with them.',
    labels: ['channel', 'disposition'],
  },
  ingest_duration_seconds: {
    type: 'histogram',
    help: 'Time to record an inbound message and enqueue follow-up work. Budget: < 20 ms p95.',
    labels: ['channel'],
    buckets: BUCKETS.INGEST,
  },

  // --- Turns ----------------------------------------------------------------------------------
  turns_total: {
    type: 'counter',
    help: 'Agent turns, by final status and what triggered them.',
    labels: ['status', 'trigger'],
  },
  turn_duration_seconds: {
    type: 'histogram',
    help: 'Wall-clock time of an agent turn, from start to final disposition.',
    labels: ['trigger'],
    buckets: BUCKETS.REPLY,
  },
  reply_latency_seconds: {
    type: 'histogram',
    help: 'Inbound message received to outbound send acknowledged. Budget: p50 ≤ 4 s, p95 ≤ 10 s.',
    labels: ['channel'],
    buckets: BUCKETS.REPLY,
  },

  // --- Models ---------------------------------------------------------------------------------
  model_requests_total: {
    type: 'counter',
    help: 'Model requests, by route and outcome.',
    labels: ['route', 'provider', 'model', 'outcome'],
  },
  model_request_duration_seconds: {
    type: 'histogram',
    help: 'Model request duration, measured at our client.',
    labels: ['route', 'provider', 'model'],
    buckets: BUCKETS.MODEL,
  },
  model_tokens_total: {
    type: 'counter',
    help: 'Tokens billed, split by kind. Cache reads and writes are separate series.',
    labels: ['route', 'provider', 'model', 'type'],
  },
  model_cost_usd_total: {
    type: 'counter',
    help: 'Estimated spend in US dollars, from the provider price table.',
    labels: ['route', 'provider', 'model'],
    groupLabel: true,
  },

  // --- Policy, tools and the guard ------------------------------------------------------------
  tool_calls_total: {
    type: 'counter',
    help: 'Tool calls, by the policy decision that let them run or stopped them.',
    labels: ['tool', 'decision'],
  },
  policy_decisions_total: {
    type: 'counter',
    help: 'Policy decisions by kind.',
    labels: ['kind'],
  },
  guard_results_total: {
    type: 'counter',
    help: 'Outbound guard results, by stage. A rising block rate is worth looking at.',
    labels: ['result', 'stage'],
  },

  // --- Outbox ---------------------------------------------------------------------------------
  outbox_pending: {
    type: 'gauge',
    help: 'Messages waiting to be sent. Should sit near zero.',
    labels: ['channel'],
  },
  outbox_sends_total: {
    type: 'counter',
    help: 'Send attempts, by outcome.',
    labels: ['channel', 'outcome'],
  },
  duplicate_sends_suppressed_total: {
    type: 'counter',
    help: 'Sends the idempotency key stopped. Invariant I6 working, not a fault.',
    labels: ['channel'],
  },
  outbox_oldest_age_seconds: {
    type: 'gauge',
    help: 'Age of the oldest unsent message. The first number to look at when replies stop.',
    labels: ['channel'],
  },

  // --- Jobs -----------------------------------------------------------------------------------
  jobs_pending: {
    type: 'gauge',
    help: 'Queued jobs by kind.',
    labels: ['kind'],
  },
  job_runs_total: {
    type: 'counter',
    help: 'Job runs by kind and outcome.',
    labels: ['kind', 'outcome'],
  },
  job_duration_seconds: {
    type: 'histogram',
    help: 'How long a job took to run.',
    labels: ['kind'],
    buckets: BUCKETS.JOB,
  },
  job_lag_seconds: {
    type: 'histogram',
    help: 'How long a job waited between being enqueued and being picked up.',
    labels: ['kind'],
    buckets: BUCKETS.LAG,
  },
  reminder_fire_lag_seconds: {
    type: 'histogram',
    help: 'How late a reminder fired. A reminder people cannot rely on is worse than none.',
    labels: [],
    buckets: BUCKETS.LAG,
  },

  // --- Proactivity and budget -----------------------------------------------------------------
  proactive_messages_total: {
    type: 'counter',
    help: 'Unsolicited messages, by kind and whether they were sent, deferred or dropped.',
    labels: ['kind', 'outcome'],
    groupLabel: true,
  },
  budget_state: {
    type: 'gauge',
    help: 'Budget state: 0 normal, 1 economy, 2 proactivity paused, 3 exhausted.',
    labels: [],
    groupLabel: true,
  },

  // --- Runtime health -------------------------------------------------------------------------
  actor_mailbox_depth: {
    type: 'gauge',
    help: 'Deepest group mailbox. Rising means turns are queueing behind each other.',
    labels: [],
  },
  channel_connected: {
    type: 'gauge',
    help: 'Whether a channel is connected: 1 or 0.',
    labels: ['channel'],
  },
  channel_errors_total: {
    type: 'counter',
    help: 'Channel errors by kind.',
    labels: ['channel', 'kind'],
  },
  recovered_turns_total: {
    type: 'counter',
    help: 'Turns resumed from the journal after a restart, by outcome.',
    labels: ['outcome'],
  },

  // --- Storage --------------------------------------------------------------------------------
  db_busy_retries_total: {
    type: 'counter',
    help: 'SQLITE_BUSY retries. Sustained growth means a writer is holding the lock too long.',
    labels: [],
  },
  db_size_bytes: {
    type: 'gauge',
    help: 'Database file size.',
    labels: [],
  },
  data_dir_free_bytes: {
    type: 'gauge',
    help: 'Free space on the data directory. Falling toward zero loses messages.',
    labels: [],
  },

  // --- Backups --------------------------------------------------------------------------------
  backup_last_success_timestamp_seconds: {
    type: 'gauge',
    help: 'Unix time of the last successful backup. Stale means backups are silently broken.',
    labels: [],
  },
  backup_last_verify_timestamp_seconds: {
    type: 'gauge',
    help: 'Unix time of the last backup restore verification. A backup nobody restored is a hope.',
    labels: [],
  },
} as const satisfies Record<string, MetricSpec>;

export type MetricKey = keyof typeof METRICS;

type SpecOf<K extends MetricKey> = (typeof METRICS)[K];

/**
 * Whether a metric accepts the optional `group` label.
 *
 * `?: never` rather than omitting the property: it makes `group` a compile error on the metrics
 * that do not declare one, instead of relying on excess-property checking, which disappears the
 * moment a caller passes a variable rather than an object literal.
 */
type GroupLabelOf<K extends MetricKey> =
  SpecOf<K> extends { groupLabel: true } ? { readonly group?: string } : { readonly group?: never };

/** The label bag a metric accepts: exactly the names the catalog declares, all required. */
export type LabelsOf<K extends MetricKey> = Readonly<Record<SpecOf<K>['labels'][number], string>> &
  GroupLabelOf<K>;

type KeysOfType<T extends MetricType> = {
  [K in MetricKey]: SpecOf<K>['type'] extends T ? K : never;
}[MetricKey];

export type CounterKey = KeysOfType<'counter'>;
export type GaugeKey = KeysOfType<'gauge'>;
export type HistogramKey = KeysOfType<'histogram'>;

/** The full metric name, with the brand prefix: `comvivo_turns_total`. */
export function metricName(key: MetricKey): string {
  return `${BRAND.slug}_${key}`;
}

/**
 * Label names that may never appear on a metric.
 *
 * `11` §8 bounds the scrape at about 5,000 series. A member id label breaks that by construction —
 * one series per member per metric, forever, including members who left — and a conversation id
 * breaks it faster. Beyond cardinality it is a privacy question: a scrape is usually the least
 * protected copy of a system's data, often sitting on a monitoring host nobody hardened, and
 * `comvivo_turns_total{member="…"}` is an activity log of a named person.
 */
export const FORBIDDEN_LABEL_NAMES: readonly string[] = [
  'member',
  'memberid',
  'member_id',
  'membername',
  'member_name',
  'user',
  'userid',
  'user_id',
  'username',
  'displayname',
  'display_name',
  'conversation',
  'conversationid',
  'conversation_id',
  'chat',
  'chatid',
  'chat_id',
  'thread',
  'threadid',
  'thread_id',
  'message',
  'messageid',
  'message_id',
  'text',
  'content',
  'body',
  'prompt',
  'email',
  'phone',
  'token',
];

export function isForbiddenLabel(name: string): boolean {
  return FORBIDDEN_LABEL_NAMES.includes(name.toLowerCase().replaceAll('-', '_'));
}

// --- The facade ---------------------------------------------------------------------------------

export interface Counter<K extends MetricKey> {
  inc(labels: LabelsOf<K>, value?: number): void;
}

export interface Gauge<K extends MetricKey> {
  set(labels: LabelsOf<K>, value: number): void;
  inc(labels: LabelsOf<K>, value?: number): void;
  dec(labels: LabelsOf<K>, value?: number): void;
}

export interface Histogram<K extends MetricKey> {
  observe(labels: LabelsOf<K>, value: number): void;
}

export interface Metrics {
  counter<K extends CounterKey>(key: K): Counter<K>;
  gauge<K extends GaugeKey>(key: K): Gauge<K>;
  histogram<K extends HistogramKey>(key: K): Histogram<K>;
}

/** What a backend implements. `prom-client` in `M9-T36`, OTel metrics when OTel is enabled. */
export interface MetricsBackend extends Metrics {
  /** Render the scrape body, or `undefined` for a backend that does not serve one. */
  scrape?(): Promise<string>;
  shutdown(): Promise<void>;
}

const NOOP_COUNTER: Counter<CounterKey> = Object.freeze({ inc: (): void => {} });
const NOOP_GAUGE: Gauge<GaugeKey> = Object.freeze({
  set: (): void => {},
  inc: (): void => {},
  dec: (): void => {},
});
const NOOP_HISTOGRAM: Histogram<HistogramKey> = Object.freeze({ observe: (): void => {} });

/**
 * The metrics used when the endpoint is off.
 *
 * The casts are the one place this file needs them: the no-op handles ignore their labels entirely,
 * so a single frozen object serves every key, and parameterising it per key would allocate on every
 * `metrics.counter(...)` call on a hot path for no behavioural difference.
 */
const NOOP_METRICS: Metrics = Object.freeze({
  counter: <K extends CounterKey>(): Counter<K> => NOOP_COUNTER as Counter<K>,
  gauge: <K extends GaugeKey>(): Gauge<K> => NOOP_GAUGE as Gauge<K>,
  histogram: <K extends HistogramKey>(): Histogram<K> => NOOP_HISTOGRAM as Histogram<K>,
});

export function noopMetrics(): Metrics {
  return NOOP_METRICS;
}

let backend: MetricsBackend | undefined;

export function setMetricsBackend(next: MetricsBackend | undefined): MetricsBackend | undefined {
  const previous = backend;
  backend = next;
  return previous;
}

export function getMetrics(): Metrics {
  return backend ?? NOOP_METRICS;
}

export function metricsEnabled(): boolean {
  return backend !== undefined;
}

export async function shutdownMetrics(): Promise<void> {
  const current = backend;
  backend = undefined;
  await current?.shutdown();
}

// --- A recording backend, for tests -------------------------------------------------------------

export interface RecordedObservation {
  readonly metric: MetricKey;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
  readonly op: 'inc' | 'dec' | 'set' | 'observe';
}

export interface RecordingMetrics extends Metrics {
  readonly observations: readonly RecordedObservation[];
  /** Observations for one metric, in order. */
  of(key: MetricKey): readonly RecordedObservation[];
  /** Distinct label combinations per metric — the cardinality a scrape would show. */
  seriesCount(): Record<string, number>;
  reset(): void;
}

/**
 * A metrics backend that records in memory and **validates as it goes**.
 *
 * The validation is the reason this exists rather than a bag of spies. An emitter that passes a
 * label the catalog does not declare, or omits one it does, is a bug Prometheus will not report —
 * it will happily serve two different series under one name. Here it throws, in the test that
 * emitted it.
 */
export function recordingMetrics(): RecordingMetrics {
  const observations: RecordedObservation[] = [];

  const check = (key: MetricKey, labels: Readonly<Record<string, string>>): void => {
    const spec: MetricSpec = METRICS[key];
    const expected = new Set<string>(spec.labels);
    if (spec.groupLabel === true) expected.add('group');
    const actual = Object.keys(labels);

    const unexpected = actual.filter((name) => !expected.has(name));
    if (unexpected.length > 0) {
      throw new BugError(
        `${metricName(key)} was given label(s) it does not declare: ${unexpected.join(', ')}. ` +
          `Declared: ${spec.labels.join(', ') || '(none)'}. Add the label to METRICS in ` +
          'observability/metrics.ts, with a note on what it does to cardinality (11 §8 budgets ' +
          'about 5,000 series).',
      );
    }

    const missing = spec.labels.filter((name) => !Object.hasOwn(labels, name));
    if (missing.length > 0) {
      throw new BugError(
        `${metricName(key)} is missing label(s): ${missing.join(', ')}. Every declared label must ` +
          'be set on every observation, or the series splits and any dashboard built on it is ' +
          'wrong in a way nothing reports.',
      );
    }
  };

  const record = (
    metric: MetricKey,
    labels: Readonly<Record<string, string>>,
    value: number,
    op: RecordedObservation['op'],
  ): void => {
    check(metric, labels);
    observations.push({ metric, name: metricName(metric), labels: { ...labels }, value, op });
  };

  return {
    counter: <K extends CounterKey>(key: K): Counter<K> => ({
      inc: (labels, value = 1) => {
        record(key, labels, value, 'inc');
      },
    }),
    gauge: <K extends GaugeKey>(key: K): Gauge<K> => ({
      set: (labels, value) => {
        record(key, labels, value, 'set');
      },
      inc: (labels, value = 1) => {
        record(key, labels, value, 'inc');
      },
      dec: (labels, value = 1) => {
        record(key, labels, value, 'dec');
      },
    }),
    histogram: <K extends HistogramKey>(key: K): Histogram<K> => ({
      observe: (labels, value) => {
        record(key, labels, value, 'observe');
      },
    }),
    get observations() {
      return observations;
    },
    of: (key) => observations.filter((entry) => entry.metric === key),
    seriesCount: () => {
      const seen = new Map<string, Set<string>>();
      for (const entry of observations) {
        const key = entry.name;
        const series = seen.get(key) ?? new Set<string>();
        series.add(JSON.stringify(entry.labels, Object.keys(entry.labels).sort()));
        seen.set(key, series);
      }
      return Object.fromEntries([...seen].map(([name, series]) => [name, series.size]));
    },
    reset: () => {
      observations.length = 0;
    },
  };
}
