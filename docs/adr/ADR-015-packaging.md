# ADR-015 — Packaging and distribution

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A2** (naming and the thin-CLI / server-runtime split), **A1** (base image and runtime), **A17** (`@village/evals` is published), **A29** (appliance secrets); `12` §12 item 4 adds the `-ha` image variant and GHCR as the canonical registry. A2's **naming** half was **superseded on 2026-11-01** by [ADR-024](ADR-024-product-name.md), which answers owner decision **D-2** at M0; the distribution half stands unchanged

## Context

- "Install to first useful answer in under 5 minutes" is a measured success metric, not a slogan (A22: time-to-first-value over ≥ 40 fresh-user attempts, ≥ 95% success).
- Self-hosters already live somewhere: Docker Compose, a Raspberry Pi, Home Assistant, Umbrel, CasaOS, a systemd unit on a NAS. Meeting them there beats asking them to learn our preference.
- The server has heavy native dependencies (`better-sqlite3-multiple-ciphers`, `sqlite-vec`, `onnxruntime-node` — the ONNX tarball alone is ~113 MB). If the first command a user runs has to download all of that before asking a single question, the 5-minute target is gone.
- **A2 is a hard constraint, not a preference:** the unscoped npm package name in the plan's `npx … init` examples is **taken**, several "Village" AI products exist, and the obvious GitHub orgs are gone. "Village" was therefore only ever a **codename**, and every published name had to sit behind one constant from the first commit. (D-2 has since been answered at M0 — see [ADR-024](ADR-024-product-name.md) — which is why this ADR is Accepted rather than pending.)

## Decision

**Ship everywhere self-hosters already are, as one all-in-one process, behind a single brand constant.**

### Artifacts

| Artifact | Notes |
|---|---|
| **Multi-arch Docker image** (`linux/amd64` + `linux/arm64`) | Each architecture built on a **native runner** and merged by digest — no QEMU. Base `node:26-trixie-slim` pinned by digest (A1). ≤ 300 MB compressed per arch, hard CI gate (`12` §2 P1, P2, P6) |
| **`docker compose`** | The documented default path, with overlays (e.g. with Ollama, with signal-cli) |
| **A thin npm CLI package** (`BRAND.npmCliPackage`) | **Pure JS**, Node ≥ 22.12: CLI, init wizard and probes only |
| **A public server-runtime package** | Bundled server plus native dependencies, Node ≥ 24.11. Installed **on demand** by the CLI in native mode (`12` §2 P10) |
| **A Home Assistant app** | HA renamed "add-ons" to **"apps"**. Published from a **mirror repo**, with a `-ha` image variant (main image + `USER root` + `io.hass.*` labels), ingress-only |
| **Umbrel / CasaOS manifests** | Community app-store manifests, Umbrel pinned by digest |
| **systemd unit** | For bare-metal installs |
| **Registry** | **GHCR is canonical**; a Docker Hub mirror only if accepted into Docker-Sponsored OSS (`12` §2 P9) |

**Process model: a single all-in-one process by default** (adapters, actors, workers, HTTP, scheduler), with `--role=web|worker|all|drill` available for hosts who later want to split it (A15). One container, one port, one volume.

### The thin-CLI split (A2)

The CLI is pure JS so `npx <cli>` is fast. It then either pulls the Docker image or installs the server-runtime package, and **both downloads start in the background while the wizard is still asking questions** (`09` §2 D-26). That is what makes the 5-minute target realistic with 100+ MB of native dependencies in play.

### Naming (A2) — written to stay correct whatever the name becomes

- Every user-visible name lives behind a **single `BRAND` constant** (`packages/shared/src/brand.ts`) with an AST rename check in `pnpm verify`, a rename codemod and a weekly rename drill in CI. That holds whether or not the name ever changes again.
- This ADR refers to published names **only** through that constant — `BRAND.npmCliPackage`, `BRAND.npmScope`, `BRAND.displayName`, `BRAND.configFileName`, `BRAND.envPrefix` — and never by literal string. Documentation that shows a command uses the same constant through the docs build.
- `deploy/names.json` is the single source of truth for every distribution name (npm CLI, npm scope, `create-` package, image repositories, HA/Umbrel/CasaOS/Unraid ids, docs domain, release-manifest URL), with `pnpm names:check` failing CI on any mismatch and `pnpm names:apply` performing the final rename.
- Throughout the plan, `npx village@latest init` is a **placeholder** for `npx <BRAND.npmCliPackage>@latest init`.
- The name had to be free on unscoped npm, an npm scope, a GitHub org, GHCR and a domain. **D-2 was answered on 2026-11-01 (ADR-024)**, pulled forward from M8 exit to **M0** because the repository was already public and a later rename is expensive. `BRAND.legacy` carries the old `VILLAGE_` env prefix and `village.yaml` config name with a deprecation warning until 1.1.
- Nothing above depends on *which* name won: this ADR, the docs build, `deploy/names.json` and the rename drill all address published names through `BRAND` and the manifest, so a forced change stays a one-command operation (`13` §3.A.6).

### Published surface

Only a small set is published; everything else is private and bundled (`12` §2 P11): the thin CLI, the server runtime, `@village/plugin-sdk`, `@village/channel-sdk`, `@village/evals` (A17) and `@village/mcp-bridge`. Releases carry npm provenance via OIDC trusted publishing, cosign keyless image signatures, SLSA provenance and CycloneDX SBOM attestations (`12` §2 P13).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **k8s-first** | The target user is one household running one instance on hardware they own. A Helm chart as the primary path would add an operational model nobody in that audience has, while the appliance platforms (HA, Umbrel, CasaOS) that these users actually run would become second-class. Compose and the appliance manifests cover them; a chart can follow after 1.0 if anyone asks. |
| **One fat npm package** (rejected inside A2) | `npx` would have to download ~113 MB of ONNX Runtime plus the other native modules before the wizard could ask its first question, which makes the 5-minute time-to-first-value target unreachable. It also forces Docker-mode users to install native dependencies they will never execute. |

## Consequences

**Good**
- Users install the way they already install things, so the quickstart is short in every environment.
- The thin CLI keeps `npx` fast and lets the heavy download overlap with the wizard's questions.
- A single brand constant plus `deploy/names.json` makes the eventual rename a mechanical, CI-verified operation rather than a grep-and-pray exercise (`15` §3 R-9).
- One all-in-one process means one thing to start, monitor and restart — and a role flag for hosts who outgrow that.
- Signed images, npm provenance and SBOMs per release give verifiable artefacts (`15` §3 R-11).

**Bad / accepted costs**
- Six distribution channels is six things that can break per release; the nightly quickstart matrix and the upgrade matrix exist to catch that.
- Two npm packages mean a version-compatibility contract between the CLI and the runtime it installs.
- Every user-visible string must keep flowing through `BRAND` and `deploy/names.json` — including in docs and templates — or the rename drill stops being a drill. The published package names in `02`–`13` are still written `@village/*`; per A2 they are read as the scope in `BRAND.npmScope` (ADR-024), while package *directory* names are unchanged.
- The appliance paths need root-drop entrypoints and their own secret-entry flow (A29), which are genuinely different code paths from Compose.
- glibc-only native binaries rule out Alpine, so the image is Debian-based and larger than a minimal Node image would be (`12` §2 P1).

**Follow-ups**
- `M0-T5` — the `BRAND` constant and its AST guard in `pnpm verify`.
- `M0-T15` — the names manifest (`deploy/names.json`) with check/apply scripts.
- `M0-T19` — the rename codemod and the weekly drill.
- `M0-T22` — naming kickoff: longlist, scoring, shortlist, npm-scope availability.
- `M14-T1` — SP-11 native-module matrix and the production image.
- `M14-T7` — npm distribution, thin CLI and native mode.
- `M14-T3`, `M14-T4` — image signing, attestations, SBOM and the SLSA Build L3 reusable build.
- `M14-T11`, `M14-T27` — upgrade matrix and the nightly quickstart matrix.
- Owner decision **D-2** (final name) — **answered at M0**; recorded in [ADR-024](ADR-024-product-name.md), with the register searches and an optional attorney knockout opinion tracked as a `[human]` follow-up in `STATUS.md`.

## References
- `docs/plan/01-architecture.md` §2 ADR-015, §8, §14 A1, A2, A15, A17, A22, A29
- `docs/plan/12-packaging-release-ops.md` §2 P1, P2, P6, P9–P13, P17; §3.1 (distribution names and artifacts); §12 item 4
- `docs/plan/13-docs-launch-community.md` §3.A (naming and trademark), §3.A.5 (process and deadlines), §3.A.6 (rename readiness)
- `docs/plan/09-dashboard-api-cli.md` §2 D-26
- `docs/plan/15-risks-and-open-questions.md` §1 D-2 (answered), §3 R-9, R-11
- [`ADR-024`](ADR-024-product-name.md) — the product name, which resolves A2's naming half
