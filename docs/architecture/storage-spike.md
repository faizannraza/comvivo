# The M1 storage spike (SP-1, SP-3, and the memory index)

`02` §3.6.3 specifies this spike and `02` §2 D8/D9 names the decision it settles: does the
encrypted-SQLite stack — SQLCipher v4 with a raw key, sqlite-vec, FTS5 and Drizzle, all at once —
actually work? If not, `02` §3.6.5's fallback replaces it with a plaintext database and
column-level encryption, which is a materially worse product.

**Outcome: ship D8.** Every criterion passes. The fallback is not needed, and `VACUUM INTO` can be
used for snapshots, so `01` §14 A8's online-backup-API alternative is not needed either.

Measured 2026-11-04 on darwin-arm64 (Apple M1, 16 GiB), on **Node 26.13.0 and Node 24.22.2** — the whole suite green on both, and `pnpm verify` green on both — with
`better-sqlite3-multiple-ciphers@13.0.3`, `sqlite-vec@0.1.9` (SQLite 3.53.4),
`drizzle-orm@0.45.4` and `drizzle-kit@0.31.11`.

The spike is **kept as a regression suite** at `packages/storage/spike/*.spike.test.ts`, **68 tests across 8 files**,
and runs in the `integration` project on every `pnpm verify`. That is deliberate: every fact below
is a fact about somebody else's native module, so any of them can change under us on an upgrade,
and a suite that runs is the difference between a failing test and a corrupted database.

## The decision matrix, resolved

| `02` §3.6.3 outcome | Result |
|---|---|
| All pass | **Ship D8** |
| Step 3 fails (plaintext leaks in WAL) → block, fall back to D9 | **Does not apply.** No canary in the database, the `-wal` or the `-shm`, in three encodings, including mid-transaction |
| Step 4 fails but vec loads → trigger-free vec deletes | **Does not apply.** vec0 DML inside a trigger works (with `trusted_schema` ON) |
| vec cannot load into multiple-ciphers → in-process index | **Does not apply.** `sqlite-vec` loads and serves KNN inside SQLCipher |
| Step 7: snapshot plaintext (SP-3) → online backup API | **Does not apply.** `VACUUM INTO` output is encrypted and opens only with the key |
| Step 10: secretstream < 40 MB/s on a Pi 5 (SP-2) → `sodium-native` | **Undecided — needs H-10.** 372 MB/s here; the gate is a Pi 5 |
| Native install fails on a target → block that target | **No failure on darwin-arm64.** linux-x64 runs in CI; linux-arm64 needs H-10 |

## U1–U7

| | Question | Answer |
|---|---|---|
| **U1** | Is `VACUUM INTO` output encrypted with the main key? | **Yes.** Not a SQLite header, no plaintext canary, opens with the same key, refuses no key |
| **U2** | Are WAL frames encrypted? | **Yes.** 10,000 canaries across a table, both FTS tokenizers and vec0 appear in no file, in UTF-8, lowercase or UTF-16 — *and* not in the `-wal` while the connection is still open, which is the window that matters |
| **U3** | Does vec0 support `UPDATE` of metadata columns? | **Yes** — better than `02` §3.5 assumed. Its update trigger deletes and reinserts to avoid depending on this; `M1-T18` can update in place instead and skip re-embedding on a label or validity change |
| **U4** | Does a raw `x'…'` key take the raw-key path? | **Yes.** 100 opens with a p50 far under the 20 ms threshold, so PBKDF2 is not running per connection |
| **U5** | Do the prebuilt sqlite-vec binaries enable NEON? | **Yes on darwin-arm64**: `vec_debug()` reports `Build flags: neon`. It reports per-binary, so the linux-arm64 answer comes from the Pi (H-10) |
| **U6** | Can a vec0 virtual table be the target of DML inside a trigger? | **Yes with `trusted_schema` ON; refused with it OFF.** See below — this settles a question `02` §3.6.2 had left open |
| **rekey** | Does `PRAGMA rekey` work in WAL mode (SQLite3MC ≥ 2.4.0)? | **Yes**, and so does `02` §3.6.2's `journal_mode=DELETE` → rekey → WAL sequence. After either one the old key is refused and no plaintext remains in the file. So the DELETE step is kept for the **fresh salt**, not for correctness — `M1-T5` should confirm the salt changes |
| **U7** | Pi 5 latencies (§3.16) | **Not measured — H-10.** `docs/architecture/storage-benchmarks.md` carries darwin-arm64 numbers and says plainly that they are a ceiling, not evidence |

## The five findings that changed something

### 1. A page cache smaller than the vector index costs 100×

The headline result, and it changed a default rather than a comment.

| 50k × 384-d vectors, k=16, eligible-label filter | p50 |
|---|---|
| SQLCipher, 8 MiB page cache | **508 ms** |
| SQLCipher, 192 MiB page cache | **5 ms** |
| plaintext, either cache | 15 ms |

With SQLCipher, a KNN query whose index does not fit in the page cache re-reads and **re-decrypts
the whole partition** every time. 50,000 × 384-d is 77 MiB at about 1.6 KiB per vector. The small
figure is 8× outside §3.16.4's 60 ms budget; the large one is twelve times inside it. `02` §3.6.2
now sets `cacheSizeKiB` to 192 MiB with that table next to it, and `comvivo doctor` warns when the
cache is smaller than the largest vector partition — because the symptom otherwise is "search feels
slow", with nothing in the logs and nothing in a test.

Worth saying plainly: above the cliff the **encrypted** build is faster than the plaintext one
(5 ms against 15 ms), because a decrypted page stays in SQLite's cache while a plaintext page is
re-read through the OS. Encryption at rest costs 32% of insert throughput and nothing on this read
path.

### 2. Drizzle cannot load against the fork without a dependency alias

`drizzle-orm/better-sqlite3/driver.js` does a top-level `import 'better-sqlite3'`. With only
`better-sqlite3-multiple-ciphers` installed, the module fails before any type question arises:

```
Error: Cannot find package 'better-sqlite3' imported from
  …/drizzle-orm/better-sqlite3/driver.js
```

`02` §3.6.3 step 6 anticipated a *type* problem and said "a cast to `BetterSqlite3.Database` is
acceptable". The real problem is module resolution. `packages/storage/package.json` therefore
declares:

```json
"better-sqlite3": "npm:better-sqlite3-multiple-ciphers@13.0.3"
```

which makes Drizzle's import resolve to the fork — and, as a side effect, makes the two type names
the *same installed package*, so **no cast is needed at all**.

### 3. `trusted_schema` must stay ON, and now for a measured reason

With `trusted_schema=OFF`, SQLite permits a virtual table inside a trigger only if it is marked
`SQLITE_VTAB_INNOCUOUS`. vec0 is not. The `CREATE TRIGGER` is accepted and the **`DELETE` throws at
run time** — `unsafe use of virtual table "vm"` — so the trigger that removes a retracted memory's
vector would look installed and fail on the first retraction, leaving the vector findable by
similarity. FTS5 *is* innocuous and is unaffected, which is why this is one global switch over two
different answers. `02` §3.6.2 kept `trusted_schema` ON because this was unverified; it is now
verified, and ON is the only setting under which the delete path works.

### 4. Three vec0 constraints that shape the repository

- **A KNN query may only `ORDER BY distance`.** Anything else is rejected outright, so `M1-T18`
  never orders by `rowid` or recency in SQL and sorts afterwards when it needs to.
- **A rowid must bind as a SQLite integer.** better-sqlite3 binds a plain JavaScript `number` as a
  float, so `.run(1, embedding)` fails with `Only integers are allows for primary key values`.
  Every vec0 write binds a `BigInt`.
- **`better-sqlite3-multiple-ciphers@13.0.3` ships type declarations and hides them**:
  `"types": "index.d.ts"` plus an `exports` map with no `types` condition, so under `nodenext`
  every import is `TS7016`. esbuild ignores `exports` for types, so this surfaces only in `tsc` —
  it would have appeared first in CI. `tsconfig.base.json` maps the module to the shipped
  declarations; delete that entry when upstream adds the condition.

### 5. A trigram index cannot answer a query shorter than three characters

`02` §3.4 lists the ≥ 3-character limit as a weakness. It is sharper than that: `の夕食` matches and
**`夕食` does not**, and for CJK two characters is a whole word, so this is most short queries
rather than an edge case. `M6` retrieval must fall back to vector search below three characters
instead of returning an empty result and looking broken. The spec now says so.

Also measured: the trigram tokenizer accepts `remove_diacritics` 0, 1 **and** 2. 1 and 2 fold
identically; 0 does not fold at all (`jose` finds nothing in `José`). So the value that matters is
"not 0", and `02` §3.4's choice of 1 is right for the right reason rather than the only option.

## `04:M1-T61` — the memory index

`04` §10 asks for four checks and accepts "all 4 pass, or a documented fallback". **All four
pass**, in `packages/storage/spike/memory-index.spike.test.ts`, which runs them in the integrated
shape: one set of memory rows, an FTS index and a vector index over them, and the same
eligible-label filter applied to both.

| | Check | Result |
|---|---|---|
| (a) | Padded `label_id IN (?, …)` on INTEGER metadata during KNN | **Passes.** Also asserted in the direction that matters: an eligible set with no matching labels returns nothing, and padding does not change the result |
| (b) | `IN` + `state <=` + `valid_to_ms >` together | **Passes**, and each constraint is shown to drop exactly the row it should, so a query returning the right answer for the wrong reason would fail |
| (c) | FTS5 `secure-delete=1` on a contentless-delete table with a `{statement terms}:` column filter | **Passes.** The keyword side and the vector side agree on eligibility, which is what lets `04` §3.6.3 fuse them without re-filtering |
| (d) | Vector zeroing on delete | **Passes, with no explicit step.** With `secure_delete = ON` the raw float bytes are gone after a delete and a WAL truncate — checked on a **plaintext** database, because that is the D9 case where it would matter, and an embedding is a lossy but serviceable reconstruction of the sentence |

## Durability and concurrency

- **Twenty `SIGKILL`s mid-write loop** (`02` §3.6.3 step 8), each at a different point in the WAL:
  `PRAGMA integrity_check` is `ok` every time, and **no committed row is lost**. The child reports
  each commit on stdout and the parent checks every reported row afterwards, rather than assuming a
  count — under `synchronous = NORMAL` a process kill and a power cut have different guarantees,
  and conflating them would either hide a durability bug or invent one. Recovery needs no explicit
  step: a plain reopen is enough.
- **A worker-thread read connection** reads successive snapshots while the main thread writes, with
  no coordination beyond WAL (`02` §3.6.3 step 9). The extension loads in the worker too, so a KNN
  query is a read-path operation. The connection opens `readonly` and refuses a write, and the
  transferred copy of the key is zeroed once the connection holds it (`08` §3.7).

## What is still owed

| | |
|---|---|
| **H-10 — a Raspberry Pi 5 afternoon** | U7 (every §3.16.4 latency), SP-2's 40 MB/s gate, and the linux-arm64 legs of SP-1 and U5. `scripts/bench/pi.sh` is the one-command session |
| **linux-x64 and the Docker base** | CI covers linux-x64 on both Node versions. The `node:26-trixie-slim` base arrives with `12`'s image work in M14 |
| **ADR-005 addendum** | Written: `docs/adr/ADR-005-sqlite-and-encryption.md` |
