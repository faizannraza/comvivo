# Storage benchmarks

Measured numbers for the `02` §3.16.4 operations. **Every figure here was measured, never
estimated**, and every table says on what hardware and which Node — a throughput number without
those is decoration.

Reproduce with:

```sh
pnpm -F @comvivo/storage bench:storage
```

The script is `packages/storage/spike/bench.ts`. It is deliberately **not** a test: a benchmark
that fails CI because a laptop was busy teaches people to ignore CI. `M1-T32` builds the bench
infrastructure with a recorded baseline and a 20% regression gate; `M1-T33` measures the full
§3.16.4 table against the seed profiles.

## What M1-T2 measured, and the one result that changed a default

<!-- BEGIN:BENCH-M1-T2 -->
**Host:** darwin-arm64 · Apple M1 · 16 GiB · kernel 23.6.0
**Node:** v26.13.0

| Metric | Value | Notes |
|---|---|---|
| Insert throughput, plain (50000 rows, one transaction) | **1,097,203 rows/s** | 3.3 MiB on disk |
| Insert throughput, SQLCipher (50000 rows, one transaction) | **741,649 rows/s** | 3.4 MiB on disk · 68% of plain |
| KNN k=16 over 10,000 vectors (384d, SQLCipher, 8 MiB cache) | **p50 103.0 ms** | p95 105.4 ms · 16 MiB database · 15 queries · label filter applied |
| KNN k=16 over 10,000 vectors (384d, SQLCipher, 192 MiB cache) | **p50 1.0 ms** | p95 1.3 ms · 16 MiB database · 15 queries · label filter applied |
| KNN k=16 over 50,000 vectors (384d, SQLCipher, 8 MiB cache) | **p50 508.2 ms** | p95 517.4 ms · 77 MiB database · 15 queries · label filter applied |
| KNN k=16 over 50,000 vectors (384d, SQLCipher, 192 MiB cache) | **p50 5.0 ms** | p95 5.7 ms · 77 MiB database · 15 queries · label filter applied |
| FTS5 index build, 135,000 messages | **0.4 s** | 368,889 rows/s, one transaction |
| FTS5 query over 135,000 messages (scoped, bm25, limit 20) | **p50 13.83 ms** | p95 14.05 ms · 25 queries |
| libsodium-wrappers secretstream seal (SP-2) | **372.1 MB/s** | 1024 × 64 KiB chunks · gate is ≥ 40 MB/s **on a Pi 5** (owner ask H-10); this machine is not the gate |
<!-- END:BENCH-M1-T2 -->

### The page-cache cliff

The first run of this benchmark reported **507 ms p50** for a 50,000-vector KNN query and sent me
looking for a bug in the measurement. There was none.

With SQLCipher and a page cache smaller than the vector index, **every KNN query re-reads and
re-decrypts the whole partition.** The index is about 1.6 KiB per vector, so 50,000 × 384-d is
77 MiB — nearly ten times an 8 MiB cache. Raise the cache above the index and the same query takes
5 ms.

| 50k × 384-d, k=16, eligible-label filter | p50 |
|---|---|
| SQLCipher, 8 MiB page cache | **508 ms** |
| SQLCipher, 192 MiB page cache | **5 ms** |
| plaintext, either cache | 15 ms |

Three things follow, and they are now in `02` §3.6.2 rather than in this file alone:

1. **`cacheSizeKiB` defaults to 192 MiB.** It is not a tuning knob: the small-cache figure is 8×
   outside §3.16.4's 60 ms KNN budget, and the large-cache figure is twelve times inside it.
2. **`comvivo doctor` warns when the cache is smaller than the largest vector partition.** The
   symptom otherwise is "search feels slow", with nothing in the logs and nothing in a test.
3. **The encrypted build is *faster* than the plaintext one above the cliff** (5 ms against 15 ms),
   because a decrypted page stays in SQLite's cache while a plaintext page is re-read through the
   OS. Encryption at rest costs 32% of insert throughput and nothing at all on this read path.

### Substitutions, stated rather than glossed

- **No Raspberry Pi 5 numbers yet.** `02` §3.16.4's whole table is specified on a Pi 5, and the
  owner ask is **H-10** in `docs/plan/STATUS.md`. Until then every row here is darwin-arm64, which
  is faster than the target on single-core work and has far more memory bandwidth — so these
  numbers are a **ceiling**, not evidence that the budgets hold. `scripts/bench/pi.sh` is the
  one-command session when the hardware is available.
- **SP-2's gate is a Pi 5 gate.** The secretstream figure below is from this machine and is
  therefore not the measurement that decides `libsodium-wrappers` against `sodium-native`
  (`02` D13). It is recorded because a number three orders of magnitude above the threshold makes
  the switch unlikely, not because it settles it.
