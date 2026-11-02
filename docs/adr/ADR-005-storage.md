# ADR-005 — Storage

- **Status:** **Accepted (addendum pending SP-1)**
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A8** (synchronous repository ports, explicit SQLCipher configuration, interned labels, blob identity, libsodium binding, snapshot method); related: §14 **A7** (authoritative entity list), **A10** (backup format)

## Context

Village stores a group's entire life: messages, memories, labels, calendar, tasks, polls, plans, decisions, audit, traces, jobs and blobs. The storage choice is load-bearing for four separate promises.

- **"It's yours."** A self-hoster must be able to install with no database to operate, back it up by copying a file, and read it with standard tools if the project disappears (`00` §3.5).
- **It runs on a Raspberry Pi 5.** Cold start under 3 s, ingestion under 20 ms p95, context build under 150 ms p95 with 50k memories (`01` §11.10).
- **Encrypted at rest** is a stated feature, not an option (`01` §9).
- **IFC is never re-implemented in SQL.** Information-flow semantics have exactly one implementation, in pure `core`. The database may only filter on an eligible-label set that core computed (invariant I1, I4).

Two structural constraints follow from the driver rather than from taste:

1. better-sqlite3 is **synchronous**, and a transaction must never span an `await` (`01` §1). So repository ports are synchronous, and a turn cannot hold one transaction across model calls — hence the per-effect commit plus turn journal design.
2. Search must work over both keywords and vectors inside the same file, under the same encryption, with per-group isolation.

Nothing about this stack was taken on faith: `01` §2 ADR-005 required an M1 spike to prove the pieces compose, which is why this ADR ships with a status of *addendum pending*.

## Decision

**SQLite in WAL mode, encrypted, with Drizzle, FTS5 and sqlite-vec, behind synchronous repository ports.**

| Concern | Choice |
|---|---|
| Engine | **SQLite**, WAL mode, one file per instance, blobs on local disk |
| Driver and encryption | **`better-sqlite3-multiple-ciphers`** (pinned `13.0.3` for M1) configured **explicitly** as `cipher='sqlcipher', legacy=4` with a **raw 256-bit key** (`x'…'`) derived by HKDF from the root data key (A8; `02` §2 D8, §3.6.1; key tree owned by `08`) |
| Why a raw key | It skips SQLCipher's 256k-iteration PBKDF2 on every open, which is what keeps cold start under 3 s on a Pi. The `sqlcipher` cipher (not sqleet) is the default so standard SQLCipher tooling can open the file — the host's escape hatch (`02` §3.6.4) |
| Schema and migrations | **Drizzle ORM** (`drizzle-orm@0.45.4` / `drizzle-kit@0.31.11`, re-evaluated at M14) for the schema and generation, plus **our own forward-only migration runner**: checksummed, `foreign_keys` toggled outside transactions, `foreign_key_check` before commit, TS data migrations, a verified pre-migration backup, and `SCHEMA_TOO_NEW` refusal (`02` §2 D15, D16) |
| Keyword search | **FTS5**, contentless-delete tables synced by **triggers**: `messages_fts`, `memory_fts` (`unicode61 remove_diacritics 2`), `memory_fts_tri` (trigram, memories only), `entity_fts` (`02` §2 D6) |
| Vector search | **sqlite-vec** `vec0`, one table per embedding space, `group_id` as `PARTITION KEY`, metadata `label_id`, `kind`, `state`, `valid_to_ms`; unit-normalized vectors with the default L2 metric; `chunk_size=256`. **Memories only — raw messages are never embedded** (`02` §2 D7) |
| Labels | **Interned.** `labels` + `reader_sets` (+ `reader_set_members`) tables; every labeled row carries one `label_id INTEGER`. Eligibility is computed **once per distinct label by core `canRead`**, and SQL filters `label_id IN (eligible)` (A8; `02` §2 D4). Triggers abort if `labels.group_id ≠ row.group_id` (`02` §2 D5) |
| Repository ports | **Synchronous** in 1.0 (A8). `store.write(fn)` = `BEGIN IMMEDIATE`, `store.read(fn)` = `BEGIN DEFERRED`; `fn` is typed `NotPromise<T>`, runtime-checked and lint-banned from being `async` (`02` §2 D10). An async `Store` variant is a post-1.0 Postgres concern |
| Blobs | Identity is `(groupId, sha256(plaintext))`; the on-disk filename is a **keyed hash** (`HMAC-SHA256(K_blobid, …)`) and each blob has its **own DEK wrapped** by the blob KEK (A8; `02` §2 D13, D14) |
| Streaming encryption | libsodium secretstream XChaCha20-Poly1305 via **`libsodium-wrappers` (WASM) by default**, 64 KiB chunks. `sodium-native@5.2.0` (wire-identical) replaces it **only if SP-2 measures < 40 MB/s on a Raspberry Pi 5** (A8; `02` §2 D13) |
| Snapshot method | `VACUUM INTO` **or** the online backup API — **decided by SP-3** in `M1-T2` (A8). If `VACUUM INTO` output turns out to be plaintext, the online backup API is used, the snapshot is written to `data/backups/.tmp` (0600), immediately stream-encrypted into the `VBK1` archive (A10) and unlinked |
| Portability | Every repository sits behind a port defined in `core`, so Postgres can be added after 1.0 without touching the engine |

### Why the status is "addendum pending SP-1"

**SP-1** (`M1-T2`) must prove that Drizzle + `better-sqlite3-multiple-ciphers` (SQLCipher v4 config) + sqlite-vec + FTS5 work **together** on Node 26 and Node 24, on darwin-arm64, linux/amd64 and linux/arm64, and in the `node:26-trixie-slim` image. Its procedure and pass criteria are fixed in `02` §3.6.3: open p50 < 20 ms, no plaintext canary in `village.db`/`-wal`/`-shm`, vec0 partition + metadata `IN` + range KNN, FTS5 contentless-delete and trigram, triggers firing under `trusted_schema=OFF`, Drizzle typing and `drizzle-kit generate` output, crash-safety under `kill -9`, and worker-thread connections. The addendum records the measured numbers and any sub-decision the matrix forces.

### Documented fallback if SP-1 fails

The fallback is not "ship unencrypted" and not "drop search". It is `02` §2 D9 / §3.6.5, with a **known, bounded loss**:

| Piece | Fallback |
|---|---|
| Driver | plain **`better-sqlite3@13.0.3`** |
| Content confidentiality | **XChaCha20-Poly1305 envelope encryption of content columns**, done in the repository **mappers** (not column types, because the AD binds the row id): `'v1:' + base64url(nonce24 ‖ ciphertext)` with `AD = table ‖ '.' ‖ column ‖ ':' ‖ id`. The encrypted-column list is fixed in `02` §3.6.5 |
| Keyword search | **Blind-token FTS**: tokens are produced in JS (`Intl.Segmenter`, NFKD, lowercase) and stored as `'t' + base32(HMAC-SHA256(fts_token_key, groupId ‖ 0 ‖ token)[0..10])` in the same contentless-delete tables, written by the repository rather than a trigger |
| Vector search | Vectors stored encrypted in `memory_embeddings`; an **in-process per-group flat index** (`InMemoryVectorIndex`, lazily loaded `Float32Array`, ≤ 64 MiB LRU) runs brute-force similarity with label and validity filters in JS |
| What is lost | Phrase, prefix and trigram queries (so `memory_fts_tri` is dropped); plaintext metadata (ids, timestamps, enums, label ids, sizes, FTS doclist structure) stays visible and must be documented in `08` |

Partial outcomes have their own documented branches in the `02` §3.6.3 decision matrix — for example, if vec0 deletes inside triggers fail, SQLCipher is kept and vector deletes move to the repository with a nightly reconcile; if vec cannot load into multiple-ciphers at all, SQLCipher is kept and only the vector index falls back.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Postgres + pgvector** | Adds a service to operate, a second container, a connection pool and a backup story, for a workload whose largest realistic instance is a few hundred thousand rows. It would make "install in under 5 minutes on a Pi" much harder, and it is exactly what self-hosters complain about. Kept available as a post-1.0 option because repositories are ports. |
| **LanceDB** | Would split state across two stores: one for domain rows and one for vectors. That breaks the property we rely on most — vectors, labels and domain rows committing in **one** transaction — and would mean two encryption and backup stories. |
| **LibSQL** | Its value is the server/replica model we explicitly do not want, and at decision time the encryption-at-rest plus sqlite-vec plus FTS5 combination is less well-trodden than the SQLCipher-compatible path. We would gain remote replication and lose the "one file you can copy" promise. |

## Consequences

**Good**
- Zero operations: one file, `WAL`, copy it to back it up. This is the single biggest reason self-hosting works.
- Domain write + `AuditEvent` + `TurnEffect` + FTS + vector update commit **atomically**, which is what makes invariants I6 and I7 implementable at all.
- Interned labels make IFC filtering a single `IN (…)` over a few hundred distinct labels per group, so the eligible-label computation costs microseconds and the exact semantics stay in one pure function.
- Standard SQLCipher tooling can open the file with the raw key, so the project disappearing does not strand anyone's data.
- Per-group vec0 partitioning gives both isolation (I4) and speed.

**Bad / accepted costs**
- Native modules on every platform are a real fragility (`15` §3 R-4): three of them, two of which carry prebuilt binaries. The M1 spike and the M14 native matrix exist precisely for this.
- Synchronous ports mean the whole storage layer is blocking, so heavy operations (backup, export, purge scans, perf seeding) must each run on their own connection in a `worker_threads` worker (`02` §2 D22).
- A single-writer model: one server process, enforced by a lockfile; a multi-process split must use exactly one worker process in 1.0 (`01` §8).
- Drizzle's own migrator is unusable for us (it cannot back up first, cannot run TS data steps, and wraps `PRAGMA foreign_keys` inside a transaction where it is a no-op), so we maintain a migration runner.
- Vector search is brute-force within a partition. That is correct for group-sized data and would not be for a multi-tenant cloud.

**Follow-ups**
- `M1-T2` — SP-1 and SP-3; writes the addendum and the decision-matrix outcome.
- `M1-T4` — crypto primitives and SP-2 (the libsodium binding decision).
- `M1-T8`, `M1-T9` — `openDatabase`/`initDatabase`, `SqliteStore`, `NotPromise` and the no-`await`-in-transaction lint.
- `M1-T11`–`M1-T14` — schema parts A and B, the search/guard migration (FTS5, vec0, I4 triggers), and the migration runner.
- `M1-T16` — `LabelStore`, `computeEligible`, `EligibleLabelSet`.
- `M1-T25`, `M1-T27` — blob cipher and store; the backup library and `VBK1` envelope (A10).
- `M1-T33` — perf seed, benches and the Pi 5 run.
- `M6-T27` — re-embedding migration across embedding spaces.
- `M14-T1` — SP-11 native-module matrix for the production image.

## References
- `docs/plan/01-architecture.md` §2 ADR-005, §14 A7, A8, A10, §11.10
- `docs/plan/02-domain-model-and-storage.md` §2 D4–D10, D13–D16, D19, D22; §3.6 (connection, encryption, spike, fallback); §3.3 (physical schema); §3.7 (repositories and unit of work)
- `docs/plan/08-security-privacy.md` §12 PSC-3, PSC-4, PSC-5
- `docs/plan/15-risks-and-open-questions.md` §3 R-4, §4 SP-1, SP-2, SP-3
