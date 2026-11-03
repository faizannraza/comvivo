import { describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import { BugError } from '../errors.js';
import type { MetricSpec } from './metrics.js';
import {
  BUCKETS,
  FORBIDDEN_LABEL_NAMES,
  getMetrics,
  isForbiddenLabel,
  METRICS,
  type MetricKey,
  type MetricsBackend,
  metricName,
  metricsEnabled,
  noopMetrics,
  recordingMetrics,
  setMetricsBackend,
  shutdownMetrics,
} from './metrics.js';

const KEYS = Object.keys(METRICS) as MetricKey[];

describe('the catalog', () => {
  it('declares every metric in `11` §3.10.3', () => {
    // Keyed off the spec table. A metric dropped during a refactor is caught here, not by a host
    // noticing a gap in a dashboard.
    const expected = [
      'build_info',
      'inbound_messages_total',
      'ingest_duration_seconds',
      'turns_total',
      'turn_duration_seconds',
      'reply_latency_seconds',
      'model_requests_total',
      'model_request_duration_seconds',
      'model_tokens_total',
      'model_cost_usd_total',
      'tool_calls_total',
      'policy_decisions_total',
      'guard_results_total',
      'outbox_pending',
      'outbox_sends_total',
      'duplicate_sends_suppressed_total',
      'jobs_pending',
      'job_runs_total',
      'job_duration_seconds',
      'job_lag_seconds',
      'reminder_fire_lag_seconds',
      'proactive_messages_total',
      'budget_state',
      'actor_mailbox_depth',
      'channel_connected',
      'channel_errors_total',
      'recovered_turns_total',
      'db_busy_retries_total',
      'db_size_bytes',
      'data_dir_free_bytes',
      'outbox_oldest_age_seconds',
      'backup_last_success_timestamp_seconds',
      'backup_last_verify_timestamp_seconds',
    ];
    expect(KEYS.toSorted()).toEqual(expected.toSorted());
  });

  it('emits names that are valid Prometheus metric names', () => {
    for (const key of KEYS) {
      expect(metricName(key), key).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/);
    }
  });

  it('prefixes every name with the brand slug and no codename', () => {
    for (const key of KEYS) {
      const name = metricName(key);
      expect(name.startsWith(`${BRAND.slug}_`), name).toBe(true);
      // A hard-coded prefix would survive the rename drill (`13` §3.A.6) and surface in a host's
      // Prometheus a year later, where renaming a metric breaks their alerts.
      expect(name.includes('village'), name).toBe(false);
    }
  });

  it('follows the Prometheus naming conventions for type and unit', () => {
    for (const key of KEYS) {
      const spec: MetricSpec = METRICS[key];
      if (spec.type === 'counter') {
        expect(key.endsWith('_total'), `counter ${key} should end in _total`).toBe(true);
      } else {
        expect(key.endsWith('_total'), `${spec.type} ${key} must not end in _total`).toBe(false);
      }
      if (key.includes('duration') || key.includes('latency') || key.includes('lag')) {
        expect(key.endsWith('_seconds'), `${key} measures time and should end in _seconds`).toBe(
          true,
        );
      }
    }
  });

  it('gives every metric help text written for a host, not for us', () => {
    for (const key of KEYS) {
      const { help } = METRICS[key];
      expect(help.length, `${key} has no help`).toBeGreaterThan(15);
      expect(help.endsWith('.'), `${key} help should be a sentence`).toBe(true);
    }
  });

  it('gives every histogram ascending buckets and nothing else buckets', () => {
    for (const key of KEYS) {
      const spec: MetricSpec = METRICS[key];
      if (spec.type === 'histogram') {
        const buckets = spec.buckets ?? [];
        expect(buckets.length, `${key} has no buckets`).toBeGreaterThan(2);
        expect(buckets.toSorted((a, b) => a - b)).toEqual([...buckets]);
        expect(new Set(buckets).size, `${key} has duplicate bucket edges`).toBe(buckets.length);
      } else {
        expect(
          spec.buckets,
          `${key} is a ${spec.type} and should not declare buckets`,
        ).toBeUndefined();
      }
    }
  });

  it('puts every performance budget on a bucket edge', () => {
    // `histogram_quantile` interpolates inside a bucket, so a budget boundary that is not an edge
    // is reported as a guess whose error depends on bucket width. These four are the budgets in
    // `01` §11.10 and `00` §Performance that a histogram answers.
    expect(BUCKETS.INGEST).toContain(0.02); // ingestion < 20 ms p95
    expect(BUCKETS.REPLY).toContain(4); // p50 reply ≤ 4 s
    expect(BUCKETS.REPLY).toContain(10); // p95 reply ≤ 10 s
    expect(BUCKETS.LAG).toContain(300); // a reminder more than 5 minutes late
  });

  it('has no duplicate label names within a metric', () => {
    for (const key of KEYS) {
      const { labels } = METRICS[key];
      expect(new Set(labels).size, key).toBe(labels.length);
    }
  });
});

describe('label safety', () => {
  it('declares no forbidden label anywhere in the catalog', () => {
    // This is `M9-T36`'s "no member or conversation label names" check, answerable from the
    // catalog instead of by parsing a scrape — which means it holds for metrics that exist but
    // have not been emitted yet.
    for (const key of KEYS) {
      for (const label of METRICS[key].labels) {
        expect(isForbiddenLabel(label), `${metricName(key)} declares label "${label}"`).toBe(false);
      }
    }
  });

  it('recognises the identifier spellings people reach for', () => {
    for (const name of FORBIDDEN_LABEL_NAMES) {
      expect(isForbiddenLabel(name), name).toBe(true);
      expect(isForbiddenLabel(name.toUpperCase()), name).toBe(true);
    }
    for (const name of ['memberId', 'member_id', 'member-id', 'conversationId', 'chat_id']) {
      expect(isForbiddenLabel(name), name).toBe(true);
    }
  });

  it('allows the bounded labels the catalog uses', () => {
    for (const name of [
      'channel',
      'disposition',
      'status',
      'trigger',
      'route',
      'provider',
      'model',
      'outcome',
      'tool',
      'decision',
      'kind',
      'result',
      'stage',
      'group',
      'version',
      'node',
      'type',
    ]) {
      expect(isForbiddenLabel(name), name).toBe(false);
    }
  });

  it('puts the group label only where it answers a question a host asks', () => {
    // Every metric with `groupLabel` multiplies by the number of groups when the host turns it on,
    // so the set stays small and deliberate: spend, proactivity, and the budget state.
    const withGroup = KEYS.filter((key) => (METRICS[key] as MetricSpec).groupLabel === true);
    expect(withGroup.toSorted()).toEqual([
      'budget_state',
      'model_cost_usd_total',
      'proactive_messages_total',
    ]);
  });

  it('stays inside the ~5,000 series budget in `11` §8', () => {
    // Worst-case cardinality, with one subtlety that is the whole point of doing this as a test.
    //
    // `route`, `provider` and `model` are **correlated**: a model belongs to exactly one provider,
    // and a route uses one or two models. Multiplying their independent maxima gives 5 × 7 × 12 =
    // 420 combinations per model metric and lands at ~15,600 series in total — but those 420
    // combinations cannot occur, because `provider` is a function of `model`. The honest estimate
    // treats the three as a single composite dimension sized by how many (route, provider, model)
    // triples one instance actually produces over a retention window: one preset routes about five
    // route names across a handful of models, and a host who switches preset or provider adds
    // more.
    //
    // This is also a constraint on future label additions, which is why the number is asserted
    // rather than assumed: the model family is 1,280 of the budget on these figures, so adding one
    // more *independent* label to it with a dozen values would exceed 5,000 on its own.
    const TRIPLES = 40;
    const CARDINALITY: Record<string, number> = {
      channel: 6, // telegram, discord, slack, matrix, signal, simulator
      disposition: 5,
      status: 5,
      trigger: 5,
      outcome: 5,
      type: 4, // input, output, cache_read, cache_write
      tool: 30,
      decision: 5,
      kind: 20,
      result: 4,
      stage: 2, // deterministic, judge
      version: 1,
      node: 1,
      group: 10,
    };
    const CORRELATED = ['route', 'provider', 'model'];

    let total = 0;
    const perMetric: Record<string, number> = {};
    for (const key of KEYS) {
      const spec: MetricSpec = METRICS[key];
      const labels = [...spec.labels, ...(spec.groupLabel === true ? ['group'] : [])];
      const correlated = labels.filter((label) => CORRELATED.includes(label));
      const independent = labels.filter((label) => !CORRELATED.includes(label));

      // Either all three correlated labels are present or none is; a metric labelled by `model`
      // without `provider` would make the composite estimate wrong in the unsafe direction.
      expect(
        correlated.length === 0 || correlated.length === CORRELATED.length,
        `${key} uses some but not all of ${CORRELATED.join('/')}: ${correlated.join(', ')}`,
      ).toBe(true);

      let series = independent.reduce(
        (product, label) => {
          const size = CARDINALITY[label];
          expect(size, `no cardinality estimate for label "${label}"`).toBeDefined();
          return product * (size ?? 1);
        },
        correlated.length > 0 ? TRIPLES : 1,
      );

      // A histogram is one series per bucket edge, plus `_sum`, `_count` and the `+Inf` bucket.
      if (spec.type === 'histogram') series *= (spec.buckets?.length ?? 0) + 3;

      perMetric[metricName(key)] = series;
      total += series;
    }

    expect(total, `worst case ${String(total)} series: ${JSON.stringify(perMetric)}`).toBeLessThan(
      5000,
    );
  });

  it('keeps every label domain bounded by something other than user input', () => {
    // The budget above is only meaningful if each label's values come from a closed set. A label
    // whose values are a member name, a group title or a tool argument has no maximum, and the
    // estimate becomes fiction. These are the label names in use; each one is an enum, a channel
    // id, a model name or a configured tool name.
    const BOUNDED = new Set([
      'channel',
      'disposition',
      'status',
      'trigger',
      'route',
      'provider',
      'model',
      'outcome',
      'type',
      'tool',
      'decision',
      'kind',
      'result',
      'stage',
      'version',
      'node',
      'group',
    ]);
    for (const key of KEYS) {
      for (const label of METRICS[key].labels) {
        expect(
          BOUNDED.has(label),
          `${metricName(key)} uses the label "${label}", which is not in the bounded set. ` +
            'Add it with a cardinality estimate, or do not add the label.',
        ).toBe(true);
      }
    }
  });
});

describe('the no-op backend', () => {
  it('is the default', () => {
    expect(metricsEnabled()).toBe(false);
    expect(getMetrics()).toBe(noopMetrics());
  });

  it('accepts every operation without throwing or allocating a new handle', () => {
    const metrics = noopMetrics();
    expect(metrics.counter('turns_total')).toBe(metrics.counter('inbound_messages_total'));
    expect(() => {
      metrics.counter('turns_total').inc({ status: 'ok', trigger: 'mention' });
      metrics.gauge('outbox_pending').set({ channel: 'telegram' }, 3);
      metrics.gauge('outbox_pending').inc({ channel: 'telegram' });
      metrics.gauge('outbox_pending').dec({ channel: 'telegram' });
      metrics.histogram('ingest_duration_seconds').observe({ channel: 'telegram' }, 0.004);
    }).not.toThrow();
  });
});

describe('the registry', () => {
  it('routes getMetrics through an installed backend and clears on shutdown', async () => {
    const recorder = recordingMetrics();
    const backend: MetricsBackend = { ...recorder, shutdown: () => Promise.resolve() };
    setMetricsBackend(backend);
    expect(metricsEnabled()).toBe(true);
    getMetrics().counter('turns_total').inc({ status: 'ok', trigger: 'mention' });
    expect(recorder.observations).toHaveLength(1);

    await shutdownMetrics();
    expect(metricsEnabled()).toBe(false);
    expect(getMetrics()).toBe(noopMetrics());
  });
});

describe('the recording backend', () => {
  it('records the full name, labels, value and operation', () => {
    const metrics = recordingMetrics();
    metrics
      .counter('model_tokens_total')
      .inc(
        { route: 'chat', provider: 'anthropic', model: 'claude-opus-5-5', type: 'cache_read' },
        11_400,
      );
    expect(metrics.observations[0]).toEqual({
      metric: 'model_tokens_total',
      name: `${BRAND.slug}_model_tokens_total`,
      labels: {
        route: 'chat',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        type: 'cache_read',
      },
      value: 11_400,
      op: 'inc',
    });
  });

  it('defaults a counter increment to 1', () => {
    const metrics = recordingMetrics();
    metrics.counter('db_busy_retries_total').inc({});
    expect(metrics.observations[0]?.value).toBe(1);
  });

  it('throws on a label the catalog does not declare', () => {
    const metrics = recordingMetrics();
    expect(() =>
      // @ts-expect-error `member` is not a declared label — and must not become one
      metrics.counter('turns_total').inc({ status: 'ok', trigger: 'mention', member: 'priya' }),
    ).toThrow(BugError);
  });

  it('names the undeclared label and what to do about it', () => {
    const metrics = recordingMetrics();
    try {
      // @ts-expect-error deliberately wrong
      metrics.counter('turns_total').inc({ status: 'ok', trigger: 'm', surprise: 'x' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('surprise');
      expect(message).toContain(`${BRAND.slug}_turns_total`);
      expect(message).toContain('cardinality');
    }
  });

  it('throws on a missing label, because a split series is silently wrong', () => {
    const metrics = recordingMetrics();
    expect(() =>
      // @ts-expect-error `trigger` is required
      metrics.counter('turns_total').inc({ status: 'ok' }),
    ).toThrow(/missing label\(s\): trigger/);
  });

  it('accepts the group label only on metrics that declare one', () => {
    const metrics = recordingMetrics();
    expect(() => metrics.gauge('budget_state').set({ group: 'grp_1' }, 1)).not.toThrow();
    expect(() =>
      // @ts-expect-error `turns_total` declares no group label
      metrics.counter('turns_total').inc({ status: 'ok', trigger: 'm', group: 'grp_1' }),
    ).toThrow(/does not declare/);
  });

  it('treats the group label as optional where it is declared', () => {
    const metrics = recordingMetrics();
    expect(() => metrics.gauge('budget_state').set({}, 0)).not.toThrow();
  });

  it('counts distinct series per metric', () => {
    const metrics = recordingMetrics();
    const counter = metrics.counter('outbox_sends_total');
    counter.inc({ channel: 'telegram', outcome: 'sent' });
    counter.inc({ channel: 'telegram', outcome: 'sent' });
    counter.inc({ channel: 'telegram', outcome: 'failed' });
    counter.inc({ channel: 'discord', outcome: 'sent' });
    expect(metrics.seriesCount()).toEqual({ [`${BRAND.slug}_outbox_sends_total`]: 3 });
  });

  it('filters by metric and resets', () => {
    const metrics = recordingMetrics();
    metrics.counter('turns_total').inc({ status: 'ok', trigger: 'mention' });
    metrics.gauge('db_size_bytes').set({}, 1024);
    expect(metrics.of('turns_total')).toHaveLength(1);
    expect(metrics.of('db_size_bytes')).toHaveLength(1);
    metrics.reset();
    expect(metrics.observations).toHaveLength(0);
  });

  it('records gauge set, inc and dec distinctly', () => {
    const metrics = recordingMetrics();
    const gauge = metrics.gauge('jobs_pending');
    gauge.set({ kind: 'digest.morning' }, 5);
    gauge.inc({ kind: 'digest.morning' });
    gauge.dec({ kind: 'digest.morning' }, 2);
    expect(metrics.of('jobs_pending').map((o) => o.op)).toEqual(['set', 'inc', 'dec']);
    expect(metrics.of('jobs_pending').map((o) => o.value)).toEqual([5, 1, 2]);
  });
});
