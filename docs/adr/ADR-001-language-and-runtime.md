# ADR-001 — Language and runtime

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A1** (Node 26 primary, Node 24 ≥ 24.11 supported, base image, no Corepack); §14 **A2** touches the published artifacts (see ADR-015)

## Context

Village is one long-running service that has to do all of the following on a machine someone owns:

- Hold live outbound connections to six chat platforms (Telegram, Discord, Slack, Matrix, Signal, web).
- Call LLM providers and use provider-specific features: prompt caching, adaptive thinking with effort, structured outputs, Batches, `count_tokens` (ADR-006).
- Run **local** embeddings and transcription, so private memories never have to leave the host (ADR-007).
- Open an encrypted SQLite database with vector and full-text indexes (ADR-005).
- Serve a dashboard and HTTP API from the same process (ADR-008, ADR-009).
- Run third-party plugins with as little authority as the platform can enforce (`10` §2 X-1/X-2).

That combination sets hard constraints:

| Constraint | Consequence |
|---|---|
| Native modules must have prebuilds for linux/amd64, linux/arm64 and macOS | `better-sqlite3-multiple-ciphers`, `sqlite-vec`, `onnxruntime-node` are all N-API/napi-v6 with upstream prebuilds on Node, and nothing equivalent exists elsewhere (`12` §2 P3) |
| Self-hosters install on a Raspberry Pi 5 as well as on x86 | Cold start < 3 s and a ≤ 300 MB compressed image (`01` §11.10, `12` §2 P6) |
| Chat-SDK quality decides how good the adapters are | grammY, discord.js, `@slack/bolt`, matrix-bot-sdk are all TypeScript |
| One contributor should be able to change the server and the dashboard in one PR | One language, one type system, shared zod schemas (ADR-010) |
| Plugin network egress should be deniable by the runtime, not only by convention | Node's `--allow-net` exists from v25 only (`10` §2 X-2) |

The spine originally targeted Node 24 LTS. Node 26 became Active LTS on 2026-10-28, which moved Node 24 to Maintenance LTS and made `--allow-net` available on the primary target. `08` PSC-1, `10` and `12` all asked for the bump; §14 **A1** resolved it.

## Decision

**TypeScript 5.x in strict mode, ESM only, on Node.js LTS.**

| Item | Value |
|---|---|
| Language | TypeScript 5.x, `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; no `any` outside tests (`01` §11.1) |
| Module system | ESM only. No CommonJS build output |
| Primary runtime | **Node.js 26 LTS** — the target for all images, CI, and the Home Assistant / Umbrel / CasaOS packages |
| Also supported | **Node.js 24, ≥ 24.11** (Maintenance LTS) for native installs |
| Base image | **`node:26-trixie-slim`** (Debian 13, glibc 2.41), **pinned by digest**. It falls back to `node:24-trixie-slim` only if the native-module matrix in `M14-T1` (SP-11) fails on 26 (`12` §2 P1) |
| Package manager bootstrap | Corepack is **not** bundled in Node ≥ 25, so pnpm is pinned with the `packageManager` field in the root `package.json` and installed **explicitly** in CI. No `corepack enable` anywhere |
| Node floor per published package | Thin CLI: Node ≥ 22.12 (pure JS). Server runtime: Node ≥ 24.11 (native deps) (`12` §2 P10) |
| Bun | Not a target. The code stays Bun-compatible where that is free, and nothing in CI runs on Bun |

**Residual risk accepted on Node 24.** Plugin egress is brokered through the host's `ctx.http` (`safeFetch`) on every runtime, but on Node ≥ 25 the host additionally omits `--allow-net` so raw sockets are denied by the permission model. On Node 24 that denial is **not enforceable**. This is documented as a residual risk (risk register `15` §3 R-10) in the install docs, and Linux hosts may add the optional `bwrap --unshare-net` wrapper (`10` §2 X-2). Native installs on Node 24 are therefore a weaker-isolation configuration, never the recommended one.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Python** | Weaker official chat-platform SDK story for long-running bots across all six platforms, and the server/dashboard split would mean two languages and two schema definitions. The SQLite + vector + ONNX stack is available, but the contributor overlap with the dashboard half of the product is poor. |
| **Go** | No first-party provider SDK parity for the Anthropic features we depend on (caching, effort, structured outputs, Batches), and no shared types with a React dashboard. The chat-SDK ecosystem is thinner for Matrix and Slack Socket Mode. |
| **Rust** | Best runtime characteristics on a Pi, worst contributor funnel for a project whose growth depends on outside PRs, and the chat/provider SDK ecosystem would have to be written. |
| **Bun** | Native-module compatibility is the blocker: `better-sqlite3-multiple-ciphers`, `sqlite-vec` and `onnxruntime-node` are the three pieces we cannot lose, and Node is where their prebuilds are tested. Bun stays a "works if you want it" target, not a supported one. |
| **Node 24 as the primary target** (the pre-A1 plan) | `--allow-net` does not exist before v25, so the primary, documented, default configuration would be the one where plugin network isolation cannot be enforced. Node 24 also leaves security support earlier (Apr 2028 vs Apr 2029). |

## Consequences

**Good**
- One language and one validation library (ADR-010) from the SQLite row to the React component.
- The largest contributor pool of any option, which matters more than raw throughput for an OSS project (`15` §3 R-3).
- N-API native modules survive a Node major bump without a rebuild (`12` §2 P3), so a runtime upgrade is a base-image digest change, not a port.
- On the primary target, plugin raw-socket egress is denied by the runtime, not by review.

**Bad / accepted costs**
- Two supported runtimes mean a two-legged CI matrix (a `node24` job in `ci.yml`, `M0-T11`) and a documented capability difference between them.
- Node 24 native installs have weaker plugin isolation. This must be stated in the docs, not buried.
- glibc-only ONNX Runtime binaries and no musl build of `sqlite-vec` rule Alpine out, so the image is Debian-based and larger (`12` §2 P1).
- Dropping Corepack means every CI job and every contributor doc has to install pnpm explicitly; a missed job silently uses the wrong pnpm.
- TypeScript's strict flags (`exactOptionalPropertyTypes` in particular) cost real time in adapter code that mirrors loose platform payloads.

**Follow-ups**
- `M0-T2` — runtime pins and the pnpm supply-chain policy (`minimumReleaseAge`, `trustPolicy`, `allowBuilds`).
- `M0-T1` — monorepo scaffold on these pins.
- `M0-T11` — CI workflow including the `node24` leg.
- `M1-T2` — SP-1 must pass on **both** Node 26 and Node 24 (see ADR-005).
- `M12-T2` — records the Node 24 vs 26 `--permission` matrix for plugins and MCP.
- `M14-T1` — SP-11, the native-module matrix that confirms `node:26-trixie-slim` or triggers the documented fallback.

## References
- `docs/plan/01-architecture.md` §2 ADR-001, §14 A1, §11.1, §11.10
- `docs/plan/12-packaging-release-ops.md` §2 P1, P3, P6, P10
- `docs/plan/10-extensibility.md` §2 X-1, X-2
- `docs/plan/08-security-privacy.md` §12 PSC-1
- `docs/plan/15-risks-and-open-questions.md` §3 R-10, §4 SP-11
