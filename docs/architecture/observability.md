# Observability

How tracing and metrics work in Comvivo, and why they are shaped the way they are.

Specs: `11` §3.10.2–§3.10.3, `01` §11.7, `01` §14 **A32**. Built in `M0-T9`.

## The short version

Both are **off by default and cost nothing when off**. With tracing disabled the OpenTelemetry SDK
is never imported, so it is not resolved, not parsed and not on the heap. With metrics disabled
there is no registry and no endpoint. Turning either on points at a collector the **host** runs;
nothing is ever sent to us, which is ADR-017 and is not a setting.

**Content cannot reach either channel.** That is enforced by the type system, not by a default.

## Layout

| Module | What it holds |
|---|---|
| `shared/src/observability/semconv-genai.ts` | Every `gen_ai.*` name, pinned to a commit. Span-name builders. The Anthropic token sum rule. |
| `shared/src/observability/attributes.ts` | The `Attributes` type, the forbidden families, `sanitizeAttributes()`. |
| `shared/src/observability/tracer.ts` | The `Tracer`/`Span` facade, the no-op and recording backends, the lazy OTel loader. |
| `shared/src/observability/metrics.ts` | The 33-metric catalog from `11` §3.10.3, the `Metrics` facade, the no-op and recording backends. |

Imported as `@comvivo/shared/observability`, deliberately **not** from the main barrel: a package
that emits telemetry should say so in its imports.

## Why the semconv names are pinned to a commit

The GenAI semantic conventions are **Development** status. They live in
`open-telemetry/semantic-conventions-genai`, which has **zero tags** and publishes no versioned
artefact; the opentelemetry.io pages are stubs. There is nothing to add to `package.json` and
nothing that would tell us a name changed.

So every name is written out once in `semconv-genai.ts`, pinned to
`95aff9cdf605bbc7d7e8f7c4745a693bd0c4eea8` (2026-11-03), with the upgrade procedure in the file's
header. Instrumentation imports from there and never spells a `gen_ai.*` string inline. An upgrade
is a deliberate PR whose diff shows the span shape changing.

## Why content is denied by family rather than by name

`11` §3.10.2 originally listed six Opt-In content attributes. At the pinned commit there are
**fifteen** — nine were added in the two days between the plan being written and the task
implementing it, including `gen_ai.input.messages_ref`, `gen_ai.memory.records` and
`gen_ai.retrieval.documents`.

A hand-maintained list of exact names cannot keep up with that, and the failure is silent: the list
looks complete right up to the moment a new attribute makes a leak typecheck. So the denylist is a
list of **prefix families**, and `Attributes` encodes them as template-literal types:

```ts
span.setAttributes({ 'gen_ai.input.messages': text });        // does not compile
span.setAttributes({ 'gen_ai.input.attachments_v2': blob });  // also does not compile
```

The `_ref` variants matter as much as the direct ones. A URL pointing at the prompt is the prompt,
as far as `01` §11.7 is concerned — whoever reads the trace can follow it.

Families stay **narrow** on purpose. `gen_ai.output.type`, `gen_ai.tool.call.id` and
`gen_ai.memory.record.count` remain emittable, because a denylist that over-matches gets switched
off, and then it protects nothing.

Three layers, as with the logger:

1. **The type** — fails in the editor. Twelve `@ts-expect-error` assertions hold it shut.
2. **`sanitizeAttributes()`** — the same check at runtime, for bags assembled from `unknown` data.
3. **Loud in tests** — a forbidden key throws under `<PREFIX>TEST_MODE` and is dropped in
   production. A telemetry mistake must never take a group's bot down; a telemetry mistake that
   passes CI is worse.

## Anthropic token accounting

```
gen_ai.usage.input_tokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

Anthropic's `input_tokens` **excludes** cached tokens; the convention's includes them. Reading
Anthropic's figure directly under-reports input by the cache hit rate — roughly 60% on a warm
conversation (`11` §8) — in the direction that looks reassuring on a cost dashboard. `UsageRecord`
keeps the raw split; the conversion happens only at the telemetry boundary, in
`anthropicInputTokens()`.

## Why the metric catalog is declarative

All 33 metrics are declared in one table with their type, label names, help text and buckets. That
buys three things a call-site-created metric does not:

- **Labels are typed.** `metrics.counter('turns_total').inc({ status, trigger })` will not compile
  with a label the catalog does not declare or without one it does. A missing label is the classic
  Prometheus bug: the series silently splits and every dashboard built on it is quietly wrong.
- **Cardinality is reviewable.** `M9-T36`'s "no member or conversation label names" check reads the
  catalog instead of parsing a scrape, so it holds for metrics that exist but are not emitted yet.
- **The reference cannot drift.** `M9` generates the metrics docs from this table.

### Bucket edges carry the budgets

`histogram_quantile` interpolates linearly *inside* the bucket a quantile falls in. A budget
boundary that is not a bucket edge is therefore reported as a guess whose error depends on bucket
width. So the edges carry the budgets from `01` §11.10 and `00`: `0.02` (ingestion < 20 ms p95),
`4` and `10` (reply p50 ≤ 4 s, p95 ≤ 10 s), `300` (a reminder more than five minutes late).

### The cardinality budget depends on a correlation

`11` §8 budgets about **5,000 series** worst case. The catalog meets it — but only because `route`,
`provider` and `model` are **correlated**: a model belongs to exactly one provider, and a route uses
one or two models. Treating the three as independent gives roughly **15,600** series.

This is a standing constraint, not a one-off calculation. The model family accounts for about 1,280
of the budget, so **one more independent label on it with a dozen values would exceed 5,000 on its
own.** `metrics.test.ts` asserts the total and requires every label to come from a closed set, so
adding an unbounded label fails rather than quietly inflating a host's Prometheus.

## What is not built yet

The facades are complete and production-ready. The **backends** arrive with their first consumer:

| Backend | Task | Why there |
|---|---|---|
| OTel tracing (`@opentelemetry/sdk-node` + OTLP HTTP) | `M2-T15` | First consumer: it asserts model span shapes against a real exporter. |
| prom-client `/metrics` | `M9-T36` | Serves the endpoint on the dashboard listener, loopback or bearer token. |

Until the OTel backend exists, `observability.otel.enabled: true` is **refused at startup with a
fix-it message** rather than silently doing nothing — a host who turned tracing on and saw no traces
would spend an hour on their collector before suspecting us. The lazy-loading contract itself is
tested now: that nothing is imported while disabled, that enabling imports exactly once, that a
failed load does not retry, and that the failure names the switch to turn off.
