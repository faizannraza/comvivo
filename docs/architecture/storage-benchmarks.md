# Storage benchmarks

What `packages/storage` actually costs, measured. `02` §3.16.2 and §3.16.4 carried estimates —
"the estimates here are only reachable on the right side of that cliff", in §3.16.4's own words —
and replacing them with arm64 measurements is `M1-T33`'s job. **U7 is narrower than this document**:
`02` §1's uncertainty list has it as "Pi 5 latencies in §3.16", and that one stays open until the
hardware exists (*What is not measured*, below). Both section headers in `02` now say which half is
measured and which is still an estimate.

Everything here is reproducible from the repository:

```bash
# the fixture plus every latency row, with each row checked against its budget
COMVIVO_BENCH_PROFILE=stress-50k-1m pnpm bench --filter storage/bench --gate

# the second KNN row: 50k vectors in one vec0 partition
COMVIVO_BENCH_PROFILE=knn-50k pnpm bench --filter storage/bench --gate

# `02` §3.16.2's per-row sizes, from `dbstat`
COMVIVO_BENCH_PROFILE=stress-50k-1m pnpm exec tsx packages/storage/bench/sizes.ts
```

Each benchmark declares its own budget, so `--gate` exits non-zero when a row misses one and there
is no table here for the code to drift from. A trend run stays non-gating, which is what `11`
§3.9.3 asks for: `main` records the series and the absolute budgets are hard gates on the reference
runners at release. **The third tier does not exist yet** — §3.9.3's interleaved A/B ratio on a
pull request needs the runner and the variance study that `14` assigns to `M13-T18`, as
`.github/workflows/bench.yml`'s own header says.

## The fixture

`packages/storage/src/perf/seed.ts` generates it from `02` §3.16.5's distributions — Zipf(1.1)
vocabulary, lognormal message length (median 8 tokens, σ = 0.8), a diurnal clock with peaks at
08:00 and 20:00, Zipf senders with one organizer carrying 30%, the 85/10/4/1 label mix, and vectors
clustered around 64 unit centroids per group with σ = 0.35 noise.

The distributions are the point. A million identical sentences give a different FTS query plan from
a million Zipf-distributed ones, and uniform random vectors in 384 dimensions are nearly
equidistant, which would make both KNN timing and recall meaningless.

| profile | messages | memories | vectors | generation | rows/s | database |
|---|---|---|---|---|---|---|
| `release-small` | 6,000 | 2,000 | 2,000 | 0.40 s | 20,048 | 10.5 MB |
| `knn-50k` | 5,000 | 50,000 | 50,000 | 6.1 s | 9,084 | 148.0 MB |
| `stress-50k-1m` | 1,000,000 | 50,000 | 50,000 | **33.7 s** | 31,156 | 686.7 MB |

One run each, and the precision to read them at is about ±5%: three runs of the same code on the
same machine gave 33.3 s, 33.9 s and 33.7 s for the stress profile and 5.7–6.1 s for `knn-50k`.
The row counts and the database sizes, by contrast, are exact and identical every time — the
fixture is seeded, and `seed.int.test.ts` pins a fingerprint of its contents.

`knn-50k` is slower per row because almost all of its rows are memories, and a memory costs a
vector insert and two FTS indexes where a message costs one.

`02` §3.16.5's target for the stress profile is "≤ 4 min on a GitHub `ubuntu-latest` runner and
≤ 15 min on a Pi 5". 33.7 s on the machine below leaves ample headroom for a slower runner.

### The machine

| | |
|---|---|
| CPU | Apple M1 (arm64) |
| Node | v26.13.0 |
| SQLite | 3.53.4 via `better-sqlite3-multiple-ciphers` 13.0.3, `sqlite-vec` 0.1.9 |
| Pragmas | `cache_size = -196608` (192 MiB), `journal_mode = wal`, `synchronous = NORMAL`, `page_size = 4096` |
| Encryption | off for these runs — see *What is not measured* |

The page cache matters more than anything else in this table. `02` §3.16.4's own note records a
100× difference on the same KNN query between an 8 MiB and a 192 MiB cache; every figure below is
on the right side of that cliff, which the pragma line above is evidence of rather than a claim.

## `02` §3.16.4 — latencies

Measured on `stress-50k-1m` (1M messages, 50k memories, 5 groups; the largest group holds 600k
messages and 30k memories), except the 50k-partition KNN row, which is `knn-50k` by definition.
`11` §3.9.2's protocol: a warm-up, then N iterations into an HDR histogram, then five
repetitions, reporting the median of the repetitions' percentiles. **N is per row, not 200 for all
of them** — a row declares its own count where 200 would mean minutes of fixture work rather than
a tighter percentile: 200 for the eight query rows, 100 for the job claim, 50 for the context-build
sequence, and 20 each for the cold open and the retention chunk (which deletes 1,000 messages per
iteration). The counts live on the benchmarks in `packages/storage/bench/storage.bench.ts`, beside
the budgets.

| Operation | p50 | p95 | Budget | |
|---|---|---|---|---|
| Ingestion transaction (insert + FTS trigger + enqueue) | 0.65 ms | **0.93 ms** | ≤ 3 ms of the 20 ms spine budget | ✅ 31% |
| Recent window, 50 messages (Q-CTX-1) | 0.64 ms | **0.71 ms** | 5 ms | ✅ 14% |
| Memory FTS (Q-CTX-2), word mode | 0.15 ms | **0.16 ms** | 20 ms | ✅ 1% |
| Memory FTS, trigram mode | 1.37 ms | **1.49 ms** | 30 ms | ✅ 5% |
| Message FTS, group-scoped | 0.05 ms | **0.06 ms** | 50 ms (catch-up only) | ✅ <1% |
| KNN k=64, 384-d, 30k vectors in partition | 12.88 ms | **13.48 ms** | 60 ms | ✅ 22% |
| KNN k=64, 384-d, 50k vectors in one partition | 20.32 ms | **21.15 ms** | 60 ms | ✅ 35% |
| Hydrate 200 memories (zod-validated) | 2.30 ms | **3.19 ms** | 15 ms | ✅ 21% |
| Storage share of a context build | 14.84 ms | **16.14 ms** | ≤ 150 ms total (`01` §11.10) | ✅ 11% |
| Job claim (1 round), 10k queued | 2.18 ms | **2.39 ms** | 5 ms | ✅ 48% |
| Retention chunk (1,000 messages + FTS) | 12.19 ms | **20.92 ms** | 50 ms (`slowTxMs`) | ✅ 42% |
| Cold open + key check + migration check, 687 MB | 1.34 ms | **1.44 ms** | 300 ms of the 3 s cold start | ✅ <1% |

Every row is inside its budget, so there is no deviation to file in `15`. The percentage is the p95
against the budget.

The queue's own round trip is the one row whose budget is a **floor** rather than a ceiling:
`11` §3.9.1's `B4` asks for ≥ 500 jobs/s, and `micro:queue.roundtrip` measures the enqueue → claim
→ complete cycle at **2,260 ops/s** — the median of four runs on 2026-11-12 (2,187, 2,251, 2,268,
2,329), against 2,437 recorded at `M1-T32` and 2,386 earlier in `M1-T33`. Read it as **2.2k ops/s
±5% across six runs on two days**, which is the precision a micro-benchmark on a laptop has; the
number that matters is that it is four times the floor.

The share column **inverts a throughput row**, which is why the gate prints 21–23% here rather
than 450%: the share is "how much of the budget is used", so for a floor it is `floor / measured`.
That is `budgetShare()` in `packages/evals/src/perf/bench-result.ts`, the behaviour `11` §3.9.2
describes — not §3.9.1, which is the budget table itself and has no share column; the citation was
wrong here until the M1 exit gate. An earlier version of this paragraph also called the figure
"21% of that floor", which reads as the opposite of what it is.

### What the exercise was for: two query plans

Both findings are the same shape, and neither is visible to a correctness test, because the answer
is identical either way — only the work is different.

**1. A group predicate beats a 200-element id list.** `hydrate` of 200 memories measured 22.5 ms
p95 against a 15 ms budget on the first run. `EXPLAIN QUERY PLAN`:

```
WHERE id IN (<200 ids>) AND group_id = ?     → SEARCH USING memory_fingerprint_idx (group_id=?)
                                               17.0 ms p50
WHERE id IN (<200 ids>) AND +group_id = ?    → SEARCH USING memory_items_id_unique (id=?)
                                               0.438 ms p50
```

SQLite drove the query from the group index and filtered 30,000 rows. The unary `+` makes the group
term unusable as an index constraint while still evaluating it — so **`I4` is unchanged** and the id
index drives. 39× on the same 200 rows.

**2. An eligibility list beats the id list too, and the small group is the slow one.** Fixing the
group term exposed the same contest on the next predicate. Every IFC-filtered read carries
`label_id IN (<the audience's labels>)`, and how many labels that is depends on how many members
the group has:

| group | labels | `label_id IN (…)` | `+label_id IN (…)` |
|---|---|---|---|
| `knn-50k`, 20 members, 50k memories | 42 | 13.10 ms (`memory_label_idx`) | **0.206 ms** (id index) |
| `release-small`, 5 members, 2k memories | 12 | 0.415 ms (`memory_label_idx`) | **0.158 ms** (id index) |
| `stress-50k-1m`, 150 members, 30k memories | 302 | 0.210 ms (id index) | 0.215 ms (id index) |

64× at 50k memories, and the plan flips on **group size**, not data size: a short eligibility list
looks cheaper to the planner than a 200-element id list, so the fast plan is the one a *large* group
gets. A family group is the common case and was getting the slow one. A database with no
`sqlite_stat1` — which is every fresh install — leaves the planner guessing, so this is not a
pathology of one dataset.

The same pair of hints belongs on the KNN hydration half, where the planner drove from the group
index on *every* profile: 4.65 ms on `knn-50k` and 2.76 ms on `stress-50k-1m` against **0.034 ms**
when the 64-element rid list drives. That was a fifth of the KNN row's latency, hidden inside a
60 ms budget — which is why the row moved from 26.30 ms to 21.15 ms (and 17.09 → 13.48 ms on the
stress profile) when the hints went in.

`messages.hydrate` has the same shape and needs no hint: measured, it drives from the id index on
both fixtures (0.137 ms against 0.140 ms with the hint), so there is nothing to steer.

`eqUnindexed` and `inArrayUnindexed` in `db/drizzle.ts` are the two hints, with the measurements on
them, and `db/plan-hints.int.test.ts` pins the **plan** — including the assertion that the form
without the hint still picks the index being steered away from, so that a future SQLite making
these hints unnecessary is noticed rather than carried forever.

This is what a measurement task is for. The estimates in §3.16.4 were 4/8 ms for hydrate and
12/25 ms for KNN, and nothing in the test suite could have noticed either plan: every correctness
test hydrates a handful of rows from a fixture of a dozen.

## `02` §3.16.2 — per-row sizes

From `dbstat`, on the same fixture. "Row" is the base table's pages; the rest is what hangs off it.

| | rows | row | indexes | FTS | vector | total | estimate |
|---|---|---|---|---|---|---|---|
| Message (avg text ≈ 96 B) | 1,000,000 | 0.33 KB | 0.17 KB | 0.06 KB | — | **0.55 KB** | ≈ 0.7 KB |
| Active memory | 50,000 | 0.74 KB | 0.17 KB | 0.43 KB | 1.62 KB | **2.97 KB** | ≈ 3.6 KB |

Both estimates were conservative, in the safe direction: the capacity figures in §3.16.3 (13 MB for
a family-year of messages, 27 MB for a busy year of memories) have about 20% more headroom than the
plan assumed.

The vector dominates a memory, at 1.62 KB for 384 float32 dimensions plus vec0's chunk metadata —
55% of the row's total cost. That is the number to remember when `04` §3.8.6 considers a second
embedding space: a space is a table, so two spaces is two copies.

## What is not measured, and why

- **The Raspberry Pi 5 column.** `14`'s M1 cut-line allows it to slip, in its own words: "`M1-T33`
  Pi numbers (to M6, but x64 numbers must land)". `11` §3.9.4 makes the Pi protocol a signed manual
  attestation at every release candidate from M13. It needs hardware this session does not have.
  Recorded as a `[human]` item in `STATUS.md` → *Owner asks*. The Pi *budgets* in §3.16.4 stay as
  estimates until then, clearly marked as such.
- **x64.** These numbers are arm64 (Apple M1). `.github/workflows/bench.yml` is wired to run the
  same suite on `ubuntu-24.04` and `ubuntu-24.04-arm` on every push to `main`, which **has not
  happened yet** — this branch is the one that adds the suite, so the first push to `main` after it
  merges is the first x64 run. The column will fill in from CI's own artefacts, in the same format
  and by the same code; until a run exists there is nothing here to publish.
- **Encryption on.** `02` §3.6.4 owns the SQLCipher comparison and `M1-T2`'s spike measured it;
  repeating it here would be a second source of truth for the same number. The fixture is
  unencrypted so these figures isolate the query plans and the page cache.
- **`B2`, `B3`, `B5` and `B6` of `11` §3.9.1.** Those are *engine* benchmarks — context build, the
  full hybrid retrieval, server cold start and RSS — and they need `M6`'s retrieval and `M3`'s
  server. The storage share of each is in the table above; the whole is measured by the milestone
  that owns it.
- **The message FTS reader.** `02` §3.16.4 marks that row "catch-up only", and catch-up is `M8`;
  the index exists and is trigger-maintained from `M1-T13`, but nothing queries it yet. The row
  measures the query `02` §3.4 specifies, built with the product's own `scopeToken` and label
  filter, and is labelled as such in the benchmark.
- **The attachment share of a retention chunk.** `02` §3.16.4's row says "1,000 messages + FTS +
  attachments"; `message_attachments` has no repository until `M6`, so the measured chunk is
  messages and their FTS postings, and the published row is a **lower bound on the spec's row**.
  The missing work is one row deleted per attachment plus the blob store's own file unlink, and
  **neither is measured anywhere** — an earlier version of this bullet credited `M1-T25` with
  measuring it in the blob store's suite, which has no timing assertions at all. It arrives with
  the repository in `M6`.
