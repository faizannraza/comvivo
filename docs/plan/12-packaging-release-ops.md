# 12 — Packaging, Release Engineering & Operations

> Status: **draft for review**. This doc elaborates `01-architecture.md` ADR-015 (packaging), ADR-017 (telemetry), §3 `deploy/`, §8 (process/shutdown), §10 (config) and milestone M14.
> Facts were verified on **2026-11-01**; sources are at the end. Items marked **[verify Mx]** must be re-checked by the implementing task, because upstream specs move.
> Placeholders: `ORG` is the GitHub org / GHCR namespace, `DOCS_DOMAIN` is the docs site's apex domain (Cloudflare Pages, `13` D5), and `village` is the codename used for the CLI/npm names (`npx village@latest init` stands for `npx <cli>@latest init`, 01 §14 A2). All are finalized by `13` (naming; owner decision D-2), and §3.1 makes the rename a one-file change.

---

## 1. Purpose & scope

This doc specifies how Village is **built, shipped, installed, upgraded, backed up and operated**: (A) Docker image; (B) compose variants; (C) npm CLI and native mode; (D) Home Assistant app; (E) Umbrel, CasaOS, Unraid, TrueNAS, systemd and launchd; (F) data-dir layout, upgrades and backup operations; (G) release engineering; (H) operations guide and runbooks; (I) release-readiness checklists.

**Not owned here:** backup archive format, online backup, schema/migrations and the retention sweep (`02`); key hierarchy, SQLCipher keying, rotation crypto and supply-chain *policy* (`08`); CLI UX, `init` wizard screens, HTTP server, auth and the env→config mapping (`09`); plugin installs (`10`); CI test content, metrics catalogue and perf harness (`11`); docs site, naming and launch (`13`); transcription/embedding provider code (`05`/`04`). This doc defines the **ops-facing contracts** those docs must honor (§4).

---

## 2. Key decisions

| # | Decision | Choice | Rationale / alternatives rejected |
|---|---|---|---|
| P1 | Base image | **`node:26-trixie-slim`** (Debian 13, glibc 2.41), pinned by digest (01 §14 A1). Fallback to `node:24-trixie-slim` only if the M14-T1 native-module matrix fails on 26 | onnxruntime-node ships **glibc-only** Linux binaries, and sqlite-vec has **no musl** package, so Alpine is out. Distroless has no `sh`/`setpriv`/`tini`, which breaks the root-drop entrypoint needed by HA and CasaOS. Bookworm's regular security support ended 2026-07-12 |
| P2 | Architectures | `linux/amd64` + `linux/arm64`. Each is built on a **native runner** (`ubuntu-24.04`, `ubuntu-24.04-arm`), pushed by digest, then merged. No QEMU | arm64 runners are GA and free for public repos. Emulated C++ builds are 5–10× slower. armv7 is dropped upstream (better-sqlite3-mc v13) and deprecated by HA |
| P3 | Native modules | Use upstream prebuilds: better-sqlite3-mc v13 (N-API, bundled), onnxruntime-node (napi-v6, bundled), sqlite-vec (per-platform npm). Prune non-target binaries. **Skip ORT's CUDA postinstall** | N-API means no rebuild on a Node major bump. Pruning saves ~190 MB |
| P4 | Speech-to-text | **whisper.cpp `whisper-cli`** (pinned tag), built in a builder stage and run as a subprocess. A **static, decode-only, LGPL FFmpeg** converts OGG/Opus, AAC/M4A, MP3 and WebM to 16 kHz WAV | Process isolation for untrusted media, no Node-ABI coupling, ~10 MB. Debian's `ffmpeg` is ~300 MB |
| P5 | Models | **Bake** the default embedding model (`Xenova/multilingual-e5-small` q8, ~135 MB, read-only) into the image. Whisper and other models are **downloaded on first use** with SHA-256 verification into `/data/models` | Embeddings are core and must work offline and on first boot. Voice is optional and the model choice belongs to the host |
| P6 | Size budget | ≤ **300 MB compressed per arch** (hard CI gate), target ≤ 260 MB. ≤ 700 MB uncompressed | Pi / SD-card users; HA users |
| P7 | Init & user | **tini** is PID 1 → POSIX `sh` entrypoint → `exec node`. `USER 1000:1000`. A root-start mode (`PUID`/`PGID`) drops privileges with `setpriv` | Reaps whisper/ffmpeg/MCP children and delivers SIGTERM correctly. Works on platforms that start containers as root |
| P8 | Filesystem | Read-only rootfs. All state lives in **`/data`**, which must be a mount or the container refuses to start. `/tmp` is tmpfs | Prevents silent data loss into the container layer |
| P9 | Registry | **GHCR is canonical** (`ghcr.io/ORG/village`, `ghcr.io/ORG/village-ha`). Docker Hub mirror only if accepted into Docker-Sponsored OSS | No pull limits for public GHCR. Docker Hub rate-limits anonymous pulls |
| P10 | npm | **Thin CLI `village`** (pure JS, Node ≥ 22.12) plus a **runtime `@comvivo/server`** (bundled server and native deps, Node ≥ 24.11) that is installed on demand for native mode | Keeps `npx` fast, and Docker mode doesn't need a new Node. The 113 MB ORT tarball is only fetched for native installs |
| P11 | Public packages | `village` (thin CLI), `@comvivo/server` (server runtime), `@comvivo/plugin-sdk`, `@comvivo/channel-sdk`, **`@comvivo/evals`** (published so plugin authors can use the simulator kit; the CLI's `village eval` imports it dynamically as an optional dependency, 01 §14 A17) and **`@comvivo/mcp-bridge`** (the small stdio bridge members install for Claude Desktop and other local MCP clients, `10` §3.7). **Everything else is private and bundled**, including `@comvivo/mcp`. Names are placeholders until D-2 | Smallest semver-stable surface |
| P12 | Versioning | **Changesets v3 + `changesets/action` v2** sub-actions (`select-mode` → `version` / `pack` → `publish`). Not release-please | Mandated by the spine (§11.9). Supports a fixed app group with independent SDKs, author-written notes, pre mode, and a pack/publish split for OIDC |
| P13 | Provenance | npm **trusted publishing** (OIDC, automatic provenance, tokens disallowed). Images get a **cosign keyless** signature (v3 bundles, OCI referrers) plus **GitHub artifact attestations** (SLSA provenance + CycloneDX SBOM), pushed to the registry | No long-lived publish secrets. Verifiable with `cosign verify`, `gh attestation verify` and `npm audit signatures` |
| P14 | Channels | **stable** (`latest`), **beta** (`X.Y.Z-beta.N`, `beta`), **edge** (every `main` commit) | Matches the 0.1 / 0.5 / 1.0 release train |
| P15 | Upgrades | Migrate on boot after a **verified pre-migration backup**. Migrations are forward-only. Start is **refused** if the DB contains migrations unknown to the build. Downgrade = `--allow-downgrade --restore` | "Upgrades without drama", and no silent data loss |
| P16 | Offsite | `backups.offsite.command` (an **argv hook**) plus a documented **rclone sidecar** overlay. rclone is not in the image | Neutral and small. Archives are already encrypted |
| P17 | Home Assistant | A mirror repo `ORG/village-home-assistant` with apps `village` and `village_beta`. Image `village-ha` = main image + `USER root` + `io.hass.*` labels. Ingress only, custom AppArmor, `hot` backup with a pre-hook snapshot | The Supervisor scans repos at any depth (a monorepo is unsafe) and starts containers as root on a root-owned `/data` |
| P18 | Update check | **Off by default**. When enabled it GETs one static `release-manifest.json` with a generic User-Agent and no identifiers. It never auto-updates | ADR-017 |
| P19 | LTS (≥ 1.0) | Only the latest minor of the current major is supported. When a new major ships, the previous major's last minor gets **12 months** of security and data-integrity fixes | Minors are non-breaking and migrate automatically |

---

## 3. Detailed design

### 3.1 Distribution names & artifacts

`deploy/names.json` is the single source of truth for every distribution name. `pnpm names:check` fails CI on any mismatch in `deploy/**`, workflows or package names. `pnpm names:apply` performs the final rename.

```json
{ "productName": "Village", "org": "ORG", "repo": "ORG/village",
  "npm": { "cli": "village", "scope": "@village", "createPackage": "create-village" },
  "images": { "main": "ghcr.io/ORG/village", "ha": "ghcr.io/ORG/village-ha", "dockerHub": null },
  "ha": { "repo": "ORG/village-home-assistant", "slug": "village", "betaSlug": "village_beta" },
  "umbrel": { "communityStoreRepo": "ORG/village-umbrel-store", "storeId": "ORG", "officialAppId": "village", "port": 7777 },
  "casaos": { "storeRepo": "ORG/village-casaos-store", "appId": "org.ORG.village" },
  "unraid": { "templateRepo": "ORG/unraid-templates" },
  "docsUrl": "https://DOCS_DOMAIN", "releaseManifestUrl": "https://ORG.github.io/village/release-manifest.json" }
```

- **Docs site:** Cloudflare Pages at the apex `DOCS_DOMAIN`, built and deployed by `13`'s workflows (`13` D5, §3.C.2).
- **Release manifest:** served from the main repo's **GitHub Pages**, which hosts only `release-manifest.json`. GitHub Pages gives maintainers no request logs or counts, so update checks can never be counted (`13` §3.G, §12 P6; ADR-017).

> **Blocking finding:** the unscoped npm package **`village` is taken** (v0.8.0, "The official TypeScript library for the Village API", modified 2026-05-06). As a result, `npx village@latest init` cannot ship under the codename (§12-2). `create-village` and `@comvivo/*` were unpublished on 2026-11-01; ownership of the scope is unverified.

| Artifact per release `X.Y.Z` | Where | Integrity |
|---|---|---|
| `village`, `@comvivo/server`, SDKs (SDKs use their own versions) | npm | provenance via OIDC trusted publishing |
| `ghcr.io/ORG/village:X.Y.Z` and `village-ha:X.Y.Z` (index: amd64 + arm64) | GHCR | cosign keyless (`--recursive`) + SLSA provenance + CycloneDX SBOM attestations |
| GitHub Release `vX.Y.Z` | GitHub | assets: `SHA256SUMS` (attested), SBOMs, `compose-bundle.tar.gz`, `release-compat.json`, `upgrade-fixture-X.Y.Z[-dirty].tar.zst`, `ffmpeg-<v>-source.tar.xz` (LGPL source offer) |
| HA, Umbrel, CasaOS and Unraid manifest bumps | mirror repos | committed by the release-bot GitHub App; Umbrel pins by digest |
| `release-manifest.json` | main repo GitHub Pages (manifest only) | TLS (§11 Q9) |

### 3.2 Docker image

#### 3.2.1 Base image choice

| Option | Native deps | ≈ compressed | Shell | Verdict |
|---|---|---|---|---|
| `node:26-alpine` (musl) | ✗ ORT has no musl build; ✗ sqlite-vec has no musl package | 55 MB | ✓ | rejected |
| `gcr.io/distroless/nodejs26-debian13` | ✓ | 45 MB | ✗ | rejected for 1.0 (§11 Q15) |
| `node:26-bookworm-slim` | ✓ glibc 2.36 | 75 MB | ✓ | rejected (Debian 12 regular security EOL 2026-07-12) |
| **`node:26-trixie-slim`** | ✓ glibc 2.41 (better-sqlite3-mc v13 needs ≥ 2.35) | 80 MB | ✓ | **chosen** (01 §14 A1); digest-pinned, Renovate bumps it weekly with a size diff |
| `node:24-trixie-slim` | ✓ glibc 2.41 | 80 MB | ✓ | **fallback** only if the M14-T1 native matrix fails on Node 26 |

#### 3.2.2 Native dependency matrix (checked 2026-11-01)

| Dependency | Version | amd64 | arm64 | musl | Delivery |
|---|---|---|---|---|---|
| better-sqlite3-multiple-ciphers | 13.0.3 (SQLite 3.53.4, SQLite3MC 2.4.0) | ✓ bundled N-API | ✓ | ✓ | npm; prune other platforms |
| sqlite-vec | 0.1.9 (0.1.10 alpha exists) | ✓ `sqlite-vec-linux-x64` | ✓ `-linux-arm64` | ✗ | npm optional dep (loadable extension, ABI-free) |
| onnxruntime-node (via `@huggingface/transformers` 4.3.2 → ORT 1.30.0) | 1.30.0 | ✓ (46 MB `.so`) | ✓ (25 MB) | ✗ | npm. **Its postinstall downloads the CUDA 12 EP from NuGet on linux/x64.** Set `ONNXRUNTIME_NODE_INSTALL=skip` and leave it off the pnpm build allowlist. Prune `win32/`, `darwin/` and the other arch (~190 MB) |
| sharp | 0.35.x | ✓ | ✓ | ✓ | npm optional platform packages |
| @matrix-org/matrix-sdk-crypto-nodejs | 0.6.x | ✓ | ✓ | ✓ | npm; the **postinstall download** is allowlisted |
| whisper.cpp `whisper-cli` | **v1.9.5** (commit pinned) | built | built | — | `native` stage |
| FFmpeg | latest 8.x tarball, SHA-256 + GPG verified | built | built | — | `native` stage |

ORT 1.30 ships **no `darwin/x64` binary**, so Intel Macs use Docker or API embeddings.

#### 3.2.3 Dockerfile (`deploy/docker/Dockerfile`)

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:26-trixie-slim@sha256:<pinned>   # fallback node:24-trixie-slim only per P1
ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:<pinned>

# pnpm is pinned to the packageManager field; Corepack is not bundled from Node 25 on
FROM ${NODE_IMAGE} AS base
RUN npm i -g pnpm@<pinned>
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm fetch --frozen-lockfile
FROM deps AS build
COPY . .
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN pnpm install --offline --frozen-lockfile \
 && pnpm turbo run build --filter=@comvivo/server... --filter=village... --filter=@comvivo/dashboard \
 && pnpm --filter @comvivo/server deploy --prod /out/server && pnpm --filter village deploy --prod /out/cli \
 && node scripts/docker/prune-native.mjs /out --os linux --arch "$(node -p process.arch)"

FROM ${DEBIAN_IMAGE} AS native
# [verify M11] FFMPEG_VERSION = latest 8.x release
ARG WHISPER_CPP_REF=v1.9.5 WHISPER_CPP_SHA=<commit> FFMPEG_VERSION=8.0.1
COPY deploy/docker/ffmpeg.sha256 /ffmpeg.sha256
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates nasm pkg-config xz-utils curl
RUN git clone --depth 1 --branch ${WHISPER_CPP_REF} https://github.com/ggml-org/whisper.cpp /src/w \
 && test "$(git -C /src/w rev-parse HEAD)" = "${WHISPER_CPP_SHA}" \
 && cmake -S /src/w -B /b/w -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF \
      -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF \
      -DCMAKE_INSTALL_PREFIX=/opt/village/whisper -DCMAKE_INSTALL_RPATH='$ORIGIN/../lib' \
 && cmake --build /b/w -j"$(nproc)" --target whisper-cli && cmake --install /b/w
RUN curl -fsSLO https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz && sha256sum -c /ffmpeg.sha256 \
 && tar xf ffmpeg-${FFMPEG_VERSION}.tar.xz && cd ffmpeg-${FFMPEG_VERSION} \
 && ./configure --prefix=/opt/village/ffmpeg --enable-static --disable-shared --enable-small --disable-everything \
      --disable-autodetect --disable-network --disable-doc --disable-programs --enable-ffmpeg --enable-protocol=file,pipe \
      --enable-demuxer=ogg,matroska,mov,mp3,wav,flac,aac --enable-decoder=opus,vorbis,aac,mp3float,flac,pcm_s16le,pcm_f32le \
      --enable-parser=opus,vorbis,aac,mpegaudio,flac --enable-encoder=pcm_s16le --enable-muxer=wav --enable-swresample \
      --enable-filter=aresample,aformat,anull,abuffer,abuffersink \
 && make -j"$(nproc)" && make install && strip /opt/village/ffmpeg/bin/ffmpeg

# fetch.mjs fails the build on any size/sha256 mismatch
FROM base AS models
COPY deploy/models/models.lock.json scripts/models/fetch.mjs /m/
RUN node /m/fetch.mjs --lock /m/models.lock.json --bake --out /opt/village/models

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/* \
 && usermod -l village node && groupmod -n village node && usermod -d /home/village -m village \
 && install -d -o 1000 -g 1000 -m 0700 /data            # new empty named volumes inherit 1000:1000
COPY --from=build  --chown=root:root /out/server /app/server
COPY --from=build  --chown=root:root /out/cli    /app/cli
COPY --from=native /opt/village/whisper /opt/village/whisper
COPY --from=native /opt/village/ffmpeg/bin/ffmpeg /opt/village/bin/ffmpeg
COPY --from=models /opt/village/models /opt/village/models
COPY deploy/docker/entrypoint.sh /usr/local/bin/village-entrypoint
COPY deploy/docker/healthcheck.mjs /app/healthcheck.mjs
COPY deploy/docker/third-party/ /usr/share/doc/village/third-party/
RUN ln -s /app/cli/dist/bin.mjs /usr/local/bin/village && ln -s /opt/village/whisper/bin/whisper-cli /usr/local/bin/whisper-cli \
 && ln -s /opt/village/bin/ffmpeg /usr/local/bin/ffmpeg
ENV NODE_ENV=production COMVIVO_RUNTIME=container COMVIVO_RUNTIME_PATH=/app/server COMVIVO_DATA_DIR=/data \
    COMVIVO_DASHBOARD_BIND=0.0.0.0 COMVIVO_DASHBOARD_PORT=7777 COMVIVO_LOG_FORMAT=json HOME=/home/village \
    COMVIVO_MODELS_PATH=/opt/village/models:/data/models COMVIVO_WHISPER_BIN=/usr/local/bin/whisper-cli \
    COMVIVO_FFMPEG_BIN=/usr/local/bin/ffmpeg COMVIVO_SCRATCH_DIR=/tmp
ARG COMVIVO_VERSION VCS_REF BUILD_DATE
LABEL org.opencontainers.image.title="Village" org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${COMVIVO_VERSION}" org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" org.opencontainers.image.source="https://github.com/ORG/village"
EXPOSE 7777
USER 1000:1000
WORKDIR /app
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["node","/app/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/village-entrypoint"]
CMD ["start"]
```

**`prune-native.mjs`** removes non-target prebuilds of onnxruntime-node (`bin/napi-v6/{win32,darwin,linux/<other>}`), better-sqlite3-mc and sqlite-vec, plus third-party `*.map`, `*.md`, `test/` and `docs/`, and emits a size report. It prunes `onnxruntime-web` WASM files only if `selftest` still passes **[verify M14]**. **`.dockerignore`:** `**/node_modules`, `.git`, `fixtures/`, `apps/docs`, `**/*.test.*`, `data/`, `.env*`. **Reproducibility:** `SOURCE_DATE_EPOCH` = commit time with `rewrite-timestamp=true`; BuildKit `provenance`/`sbom` are off because attestations come from §3.10.4 (this avoids `unknown/unknown` index entries that confuse Unraid and old clients). **Notes:** `GGML_CPU_ALL_VARIANTS` + `GGML_BACKEND_DL` let one binary pick AVX2/AVX-512 on x86 and dotprod/i8mm on ARM (Pi 5 = Cortex-A76) at runtime **[verify M11]**; `setpriv` comes from util-linux **[verify M3]**.

#### 3.2.4 Model weights (`deploy/models/models.lock.json`, schema §4.6)

| Model id | Files (sha256) | Size | Policy |
|---|---|---|---|
| `embeddings/multilingual-e5-small-q8`: HF `Xenova/multilingual-e5-small@761b726d…`, MIT | `onnx/model_quantized.onnx` (`f80102d3…c193`), `tokenizer.json` (`0b44a9d7…4c39`), plus 3 small JSON files | ~135 MB | **baked** at `/opt/village/models/hf/Xenova/multilingual-e5-small/` |
| `whisper/base-q5_1`: HF `ggerganov/whisper.cpp@5359861c…`, MIT | `ggml-base-q5_1.bin` (`422f1ae4…8898`) | 59.7 MB | downloaded on first voice note or `village models pull`; default |
| `whisper/small-q5_1` | `ggml-small-q5_1.bin` (`ae85e4a9…11bb`) | 190 MB | opt-in, hosts with ≥ 8 GB |
| `whisper/tiny-q5_1` | `ggml-tiny-q5_1.bin` (`81871056…d3c7`) | 32 MB | `low-memory` profile |

In the image, transformers.js runs with `env.allowRemoteModels=false` and `env.localModelPath=<first entry of COMVIVO_MODELS_PATH>`. The fetcher writes to `/data/models/.partial/`, verifies size and SHA-256, then `rename()`s into place. `COMVIVO_MODEL_MIRROR` (an `HF_ENDPOINT`-style URL) serves restricted networks; air-gapped hosts copy files in and run `village models verify`. A weekly CI job HEAD-checks every URL. Changing the embedding model is an explicit config change that triggers `04`'s re-embed flow.

#### 3.2.5 Runtime contract

- **Filesystem.** `/app`, `/opt/village` and the OS are root-owned and read-only. `/data` must be a writable mount; `/tmp` is a 256 MiB tmpfs for media scratch. Blob and backup temp files go to **`/data/tmp`**, so `rename()` stays on one filesystem.
- **Entrypoint** (`deploy/docker/entrypoint.sh`; POSIX sh; shellcheck-clean):
  1. `umask 0077`.
  2. **Root mode** (uid 0 and `COMVIVO_ALLOW_ROOT≠1`). With `PUID`/`PGID` (default 1000): if ownership differs, run `find /data -xdev \( ! -user $PUID -o ! -group $PGID \) -exec chown $PUID:$PGID {} +`; copy root-only inputs (HA options, `/config/comvivo.yaml`) to `/tmp/village/`; then `exec setpriv --reuid=$PUID --regid=$PGID --clear-groups --inh-caps=-all --bounding-set=-all -- "$0" "$@"`.
  3. **Data guard.** Exit 78 if `/data` is not a mount point (checked via `/proc/self/mountinfo`; `COMVIVO_ALLOW_EPHEMERAL_DATA=1` overrides for demos) or is not writable. The message includes the exact `chown` fix.
  4. **HA mode** (`/data/options.json` + `SUPERVISOR_TOKEN`). `node /app/server/dist/platform/ha.mjs render` writes `/tmp/village/{ha.env,village.ha.yaml}` with mode 0600; the entrypoint sources the env and sets `COMVIVO_CONFIG`.
  5. **Dispatch.** `start` → `exec node --enable-source-maps /app/server/dist/main.mjs start "$@"`; `ha-backup-pre|post` → the Control API on loopback (`POST`/`DELETE /control/v1/backups/ha-snapshot`, bearer from `keys/control.token`; `09` D-04); an absolute path → `exec "$@"`; anything else → `exec node /app/cli/dist/bin.mjs "$@"`, so `docker run … village backup list` works.
- **Signals.** tini runs **without `-g`**, so SIGTERM reaches only Node, which stops its own children (whisper, ffmpeg, MCP stdio) during shutdown. The budget `COMVIVO_SHUTDOWN_GRACE_MS` (30 s) must be below the orchestrator's kill timeout: compose `stop_grace_period: 45s`, HA `timeout: 60`, systemd `TimeoutStopSec=60`, `docker run --stop-timeout 45`. Order: stop intake → stop leasing jobs → let in-flight tool transactions commit → abort model calls at `grace − 5 s` (the turn journal recovers them) → flush the outbox → `wal_checkpoint(TRUNCATE)` → close the DB, release the lock, exit 0. A second SIGTERM exits 130; SIGHUP is logged and ignored.
- **Health.** `healthcheck.mjs` GETs `http://127.0.0.1:$PORT/healthz` with a 4 s timeout and passes on HTTP 200 (`ok`, `starting` or `degraded`); `draining` and `fail` return 503. It never depends on external networks (§4.3; the same contract as `09` §3.8).
- **Clock sanity.** If the clock is behind the build timestamp (a Pi without RTC before NTP sync), the scheduler waits up to 120 s, then starts as `degraded: clock`, so missed reminders don't fire en masse.

#### 3.2.6 Annotations & tags

OCI annotations (`title`, `description`, `version`, `revision`, `created`, `source`, `url`, `documentation`, `licenses`, `vendor`, `base.name`, `base.digest`) are applied at **manifest and index** level (`DOCKER_METADATA_ANNOTATIONS_LEVELS=manifest,index`). Tags come from `docker/metadata-action` v6 plus `scripts/release/tags.mjs`:

| Event | Tags on `village` (and `village-ha`) |
|---|---|
| Stable `X.Y.Z`, X ≥ 1 | `X.Y.Z`, `X.Y`; `X` and `latest` **only if** this is the highest stable semver (hotfixes to old minors never move them) |
| Stable `0.Y.Z` | `0.Y.Z`, `0.Y`, `latest` (only if highest). No `0` tag |
| Beta `X.Y.Z-beta.N` | `X.Y.Z-beta.N`; `beta` → the higher of newest beta and newest stable |
| Edge (push to `main`) | `edge`, `sha-<7>` (pruned to the last 50) |

Release tags are **immutable**: the merge job fails if `X.Y.Z` already exists with a different digest.

#### 3.2.7 Size budget (gate `image:size`)

| Component | amd64 (uncompressed, est.) | arm64 |
|---|---|---|
| node:26-trixie-slim | ~230 MB | ~220 MB |
| server + CLI production node_modules (pruned) | ~160 MB | ~135 MB |
| Embedding model | 135 MB | 135 MB |
| whisper-cli + ggml CPU variants + ffmpeg-mini | ~15 MB | ~12 MB |
| Dashboard | ~5 MB | ~5 MB |
| **Total** | **~545 MB (≈ 250 MB compressed)** | **~505 MB** |

The gate fails above 300 MB compressed or 700 MB uncompressed. A growth of more than 10% posts a PR comment.

### 3.3 Compose variants (`deploy/compose/`)

`village init` generates **one merged `compose.yaml`** (§3.4.2). The repo also ships modular overlays for manual installs (`docker compose -f compose.yaml -f compose.ollama.yaml up -d`). The minimum is Compose v2.24 (`!reset` support), checked by init and doctor.

| File | Adds |
|---|---|
| `compose.yaml` | Village only; dashboard published on host loopback |
| `compose.ollama.yaml` (+ `.nvidia.yaml`, `.amd.yaml`) | Ollama + one-shot model pull; GPU reservations |
| `compose.signal.yaml` | `bbernhard/signal-cli-rest-api` in JSON-RPC mode |
| `compose.caddy.yaml` + `Caddyfile` | HTTPS reverse proxy for remote dashboard access |
| `compose.offsite-rclone.yaml` | rclone sidecar copying `data/backups` offsite |
| `.env.example` | every variable, commented |

```yaml
# compose.yaml
name: village
services:
  village:
    image: ghcr.io/ORG/village:${COMVIVO_VERSION:?set COMVIVO_VERSION in .env}
    container_name: village
    restart: unless-stopped
    user: "${COMVIVO_UID:-1000}:${COMVIVO_GID:-1000}"    # init writes the invoking user's ids
    read_only: true
    tmpfs: ["/tmp:size=256m,mode=1777"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    env_file: [.env]
    environment: { COMVIVO_CONFIG: /etc/village/comvivo.yaml, TZ: "${TZ:-UTC}" }
    volumes:
      - ./data:/data                                    # Windows/WSL2 on /mnt/c: init uses a named volume
      - ./comvivo.yaml:/etc/village/comvivo.yaml:ro
    ports: ["127.0.0.1:${COMVIVO_DASHBOARD_PORT:-7777}:7777"]   # spine §9: loopback only by default
    stop_grace_period: 45s
    logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }
    deploy: { resources: { limits: { memory: "${COMVIVO_MEMORY_LIMIT:-1536m}" } } }
x-village: { generatedBy: "village init", version: "1.0.0" }
```

```yaml
# compose.ollama.yaml
services:
  ollama:
    image: ollama/ollama:${OLLAMA_VERSION:-0.40.13}     # pinned; Renovate bumps
    restart: unless-stopped
    volumes: ["ollama:/root/.ollama"]
    environment: { OLLAMA_KEEP_ALIVE: "24h", OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1" }
  ollama-pull:
    image: ollama/ollama:${OLLAMA_VERSION:-0.40.13}
    entrypoint: ["ollama", "pull", "${COMVIVO_LOCAL_MODEL:?choose a model}"]
    environment: { OLLAMA_HOST: "http://ollama:11434" }
    depends_on: [ollama]
    restart: "no"
  village:
    environment: { COMVIVO_MODELS_PRESET: local, COMVIVO_LOCAL_BASE_URL: "http://ollama:11434/v1", COMVIVO_LOCAL_MODEL: "${COMVIVO_LOCAL_MODEL}" }
    depends_on: { ollama: { condition: service_started } }
volumes: { ollama: {} }
```

**GPU notes.** NVIDIA (`.nvidia.yaml`): `deploy.resources.reservations.devices: [{driver: nvidia, count: all, capabilities: [gpu]}]`, which needs the NVIDIA Container Toolkit. AMD (`.amd.yaml`): image tag `${OLLAMA_VERSION}-rocm`, `devices: [/dev/kfd, /dev/dri]`, `group_add: [video, render]`. Apple Silicon: Docker has no Metal access, so run Ollama natively and set `COMVIVO_LOCAL_BASE_URL=http://host.docker.internal:11434/v1` without the overlay. Pi: CPU only (§3.11.1).

```yaml
# compose.signal.yaml (Signal is experimental; registration and linking are 06's flow)
services:
  signal-cli:
    image: bbernhard/signal-cli-rest-api:${SIGNAL_CLI_REST_VERSION:-0.101}
    restart: unless-stopped
    environment: { MODE: json-rpc, JSON_RPC_TRUST_NEW_IDENTITIES: on-first-use }   # json-rpc-native: ~300 MB less RAM, less stable
    volumes: ["./signal-cli:/home/.local/share/signal-cli"]   # holds the Signal account keys; back it up
    ports: ["127.0.0.1:8081:8080"]                             # only for QR linking; remove afterwards
  village:
    environment: { COMVIVO_SIGNAL_CLI_URL: "http://signal-cli:8080" }
```

```yaml
# compose.caddy.yaml (remote dashboard; the docs recommend Tailscale or an SSH tunnel first)
services:
  caddy:
    image: caddy:${CADDY_VERSION:-2.11.7}
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data", "caddy-config:/config"]
    environment: { COMVIVO_DOMAIN: "${COMVIVO_DOMAIN:?}", ACME_EMAIL: "${ACME_EMAIL:?}" }
  village:
    ports: !reset []                                       # reachable only via caddy
    environment: { COMVIVO_PUBLIC_URL: "https://${COMVIVO_DOMAIN}", COMVIVO_TRUST_PROXY: "172.16.0.0/12" }
volumes: { caddy-data: {}, caddy-config: {} }
```
```caddyfile
{
	email {$ACME_EMAIL}
}
{$COMVIVO_DOMAIN} {
	encode zstd gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy village:7777 {
		flush_interval -1
	}
}
```

```yaml
# compose.offsite-rclone.yaml (archives are encrypted by 02, so the remote sees ciphertext only)
services:
  backup-offsite:
    image: rclone/rclone:${RCLONE_VERSION:?pin}             # [verify M14] current release
    restart: unless-stopped
    volumes: ["./data/backups:/backups:ro", "./rclone:/config/rclone:ro"]
    environment: { RCLONE_REMOTE: "${RCLONE_REMOTE:?e.g. b2:bucket/village}", NOTIFY_URL: "${BACKUP_NOTIFY_URL:-}" }
    entrypoint: ["/bin/sh","-c","while true; do rclone copy /backups \"$$RCLONE_REMOTE\" --max-age 72h --exclude 'ha-snapshot/**' && { [ -z \"$$NOTIFY_URL\" ] || wget -qO- \"$$NOTIFY_URL\" >/dev/null; }; sleep 3600; done"]
```

```dotenv
# .env.example — secrets live only here (mode 0600, written by init) or in *_FILE Docker secrets
COMVIVO_VERSION=1.0.0            # exact; `village update` bumps it
COMVIVO_UID=1000
COMVIVO_GID=1000
TZ=Europe/Berlin
COMVIVO_DASHBOARD_PORT=7777
ANTHROPIC_API_KEY=               # at least one provider, or the Ollama overlay
OPENAI_API_KEY=
GEMINI_API_KEY=                  # name per 05 (Google adapter)
TELEGRAM_BOT_TOKEN=
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
MATRIX_ACCESS_TOKEN=
COMVIVO_IMAP_PASSWORD=           # name per 08 §3.10
# COMVIVO_MODELS_PRESET=best      # best|balanced|economy|local|custom (Best is pre-selected, 01 §14 A3)
# COMVIVO_PUBLIC_URL=  COMVIVO_LOCAL_MODEL=qwen3:4b  COMVIVO_DOMAIN=  ACME_EMAIL=  RCLONE_REMOTE=  BACKUP_NOTIFY_URL=
# COMVIVO_UPDATE_CHECK=false      # opt-in (ADR-017)
# COMVIVO_PROFILE=default         # default|low-memory
# COMVIVO_MEMORY_LIMIT=1536m
```

### 3.4 npm distribution & native mode

#### 3.4.1 Packages & command routing

| Package | Contents | Engines | Native deps |
|---|---|---|---|
| `village` (`apps/cli`) | launcher, `init`, Docker orchestration, update notifier, command router; embeds the `deploy/compose` templates | `node >=22.12.0` | none (CI-enforced) |
| `@comvivo/server` (`apps/server`) | tsdown bundle of the server plus every private `@comvivo/*` package (`noExternal`), dashboard assets, `ops` commands (`backup`, `restore`, `migrate`, `keys`, `export`, `selftest`, `recovery`); bin `village-server` | `node >=24.11.0` | better-sqlite3-mc, sqlite-vec, transformers.js/ORT, sharp, matrix crypto |

The CLI resolves a runtime in this order: (1) `COMVIVO_RUNTIME_PATH` (set in the image); (2) the managed native runtime `$XDG_DATA_HOME/village/runtime/current` (macOS: `~/Library/Application Support/village/runtime/current`); (3) a compose project found from cwd or `--dir` (its `compose.yaml` has an `x-village` key). In case 3, online commands proxy via `docker compose exec village village <cmd>`, and offline ones (`restore`, `migrate`) stop the service and use `docker compose run --rm --no-deps village <cmd>`. `apps/cli` imports **types only** from `@comvivo/server/ops` and loads the implementation with `import()` from the resolved path.

#### 3.4.2 `npx village@latest init`

1. **Preflight** (pure JS, < 1 s): Node, OS/arch, `docker version --format json`, `docker compose version` ≥ 2.24, free disk ≥ 3 GB, RAM. It detects a **32-bit userspace on a 64-bit Pi kernel** (`dpkg --print-architecture` = `armhf`) and asks for 64-bit Raspberry Pi OS.
2. **Mode:** Docker (default) or Native (offered only if §3.4.3 passes).
3. **Wizard** (`09`; Telegram setup in `06`), then extras: Ollama, Signal, Caddy domain, offsite.
4. **Docker mode** writes `<dir>/compose.yaml` (merged), `.env` (0600), `comvivo.yaml` and `data/` (0700, owned by the invoking user). It runs `docker compose pull && docker compose up -d`, polls `/readyz` for up to 180 s (`09` §3.11.5 step 8) and prints next steps. On **Windows/WSL2 with a target under `/mnt/c`** it uses a named volume `village-data`, because drvfs/9p breaks SQLite locking.
5. **No-Node path:** `docker run --rm -it -v "$PWD:/work" ghcr.io/ORG/village:latest init /work --mode docker` writes the same files and prints the `up` command (this is the README's Docker quickstart, `13` §3.B.3).
6. **Non-interactive:** `--non-interactive --yes --mode docker|native [dir] --preset --from-env --restore <file>` (flags owned by `09` §3.11.3), for CI and docs dry-runs.

#### 3.4.3 Native mode

Supported in 1.0: linux-x64-gnu and linux-arm64-gnu with glibc ≥ 2.35 (Debian 12+, Ubuntu 22.04+; read from `process.report.getReport().header.glibcVersionRuntime`), and darwin-arm64. Not supported: darwin-x64 (no ORT binary), musl, and Windows (use Docker Desktop or WSL2).

`village runtime install [version]`:
1. Writes `<runtimeRoot>/<version>/package.json` = `{"private":true,"dependencies":{"@comvivo/server":"<version>"},"allowScripts":{"@matrix-org/matrix-sdk-crypto-nodejs":true}}`. npm ≥ 12 denies dependency scripts by default; npm 11 runs them, hence the ORT env skip.
2. Runs `npm install --omit=dev --no-audit --no-fund` with `ONNXRUNTIME_NODE_INSTALL=skip` and `npm_config_onnxruntime_node_install=skip`.
3. Runs `npm audit signatures` (registry signatures + provenance). Failure aborts unless `--no-verify`.
4. Atomically flips the `current` symlink. `runtime prune` keeps `current` and the previous version.

On first start, the embedding model is fetched into `<dataDir>/models` and verified. Local transcription needs `whisper-cli` and `ffmpeg` on PATH (macOS: `brew install whisper-cpp ffmpeg`) or `COMVIVO_WHISPER_BIN`/`COMVIVO_FFMPEG_BIN`; otherwise doctor suggests API transcription or Docker. `npm i -g village` installs only the thin CLI, and `village start` offers to install the matching runtime (CLI and runtime versions must be equal). `village service install` writes a systemd unit (§3.6.5) or a launchd agent (§3.6.6).

#### 3.4.4 Node checks & update notifications

- `bin.mjs` uses Node-18-safe syntax and checks `process.versions.node` before importing anything else. If Node is too old, it prints fix steps (fnm/nvm/volta, or Docker mode) and exits 1.
- **Update checks are opt-in.** `init` asks "Check for new versions? (downloads a public file from ORG.github.io; nothing about you is sent)", default **No**, stored as `updates.check`. When on, the CLI checks at most once per 24 h (cached in `run/update-check.json` or `~/.cache/village`) and the server daily, using an HTTPS `GET releaseManifestUrl` with `User-Agent: village-update-check` and no version, IDs, query string or cookies. Results: a CLI notice, a dashboard banner, and one host DM for `security: true` releases.
- **`village update` never runs automatically.** It shows the release-notes delta, pre-pulls the image or installs the runtime (nothing changes if that fails), takes a manual backup, bumps `COMVIVO_VERSION` or flips the runtime symlink, restarts, and waits for `/readyz`. Migration then follows §3.8.

### 3.5 Home Assistant app (`deploy/home-assistant/`)

HA renamed **add-ons to "apps" in 2026.2**: the docs moved to contributors.home-assistant.io/apps, `app_config` replaces `addon_config`, `build.yaml` is deprecated, and the builder labels images `io.hass.type=app`. The Supervisor discovers `config.yaml` **at any depth**, so the release job **mirrors** this folder to `ORG/village-home-assistant`.

```
deploy/home-assistant/            → repo root of ORG/village-home-assistant
├─ repository.yaml                # name, url, maintainer
├─ README.md                      # My Home Assistant "add repository" badge
├─ village/                       # slug == folder name
│  ├─ config.yaml  DOCS.md  README.md  CHANGELOG.md  icon.png (128×128)  logo.png (~250×100)  apparmor.txt
│  └─ translations/en.yaml        # names/descriptions for every option
├─ village_beta/                  # same files; stage: experimental; beta channel
└─ image/Dockerfile               # CI-only: builds village-ha FROM the per-arch main digest
```
```dockerfile
ARG BASE
FROM ${BASE}
ARG BUILD_ARCH BUILD_VERSION
USER root
ENV COMVIVO_PLATFORM=home-assistant PUID=1000 PGID=1000
LABEL io.hass.type="app" io.hass.arch="${BUILD_ARCH}" io.hass.version="${BUILD_VERSION}" io.hass.name="Village"
```

**`village/config.yaml`:**
```yaml
name: Village
version: "1.0.0"                 # bumped by the release bot only after the image tag is public
slug: village
description: "Your family's AI, in the group chats you already use — private by design."
url: https://github.com/ORG/village
arch: [aarch64, amd64]           # armhf/armv7/i386 are deprecated by HA and unsupported upstream
image: ghcr.io/ORG/village-ha    # multi-arch index; Supervisor pulls tag == version
init: false                      # the image ships tini
startup: application
boot: auto
stage: stable
homeassistant: "2026.2.0"        # apps panel, app_config map type
timeout: 60
ingress: true
ingress_port: 8099                # dedicated ingress listener (09 D-19, §3.9.10)
ingress_stream: true
panel_icon: mdi:home-group
panel_title: Village
panel_admin: true
watchdog: "http://[HOST]:[PORT:8099]/healthz"     # [verify M14] for an unmapped ingress port; fallback tcp:// (15 SP-11)
tmpfs: true
apparmor: true
hassio_api: false
homeassistant_api: false
map: [{ type: app_config, read_only: false }]      # /config: optional advanced comvivo.yaml
backup: hot
backup_pre: /usr/local/bin/village-entrypoint ha-backup-pre
backup_post: /usr/local/bin/village-entrypoint ha-backup-post
backup_exclude: ["tmp/*", "models/*", "logs/*", "backups/daily/*", "backups/weekly/*", "backups/monthly/*"]
breaking_versions: []            # bridge releases (§3.8.2)
options: { config_mode: options, instance_name: "Our Village", model_preset: best, message_retention_days: 90,
           backups_keep: 3, log_level: info, update_check: false }   # Best pre-selected; budget unset = per-preset default (01 §14 A3, D-1)
schema:
  config_mode: list(options|file)
  instance_name: str(1,80)
  model_preset: list(best|balanced|economy|local|custom)
  anthropic_api_key: password?
  openai_api_key: password?
  gemini_api_key: password?
  local_base_url: url?
  local_model: str?
  telegram_bot_token: password?
  discord_bot_token: password?
  slack_bot_token: password?
  slack_app_token: password?
  matrix_homeserver_url: url?
  matrix_access_token: password?
  signal_cli_url: url?
  public_url: url?
  message_retention_days: int(1,365)   # host ceiling privacy.maxMessageRetentionDays (08 §3.16.2)
  monthly_budget_usd: float(0,10000)?
  backups_keep: int(1,60)
  log_level: list(trace|debug|info|warn|error)
  update_check: bool
```

**Options → Village** (`apps/server/src/platform/ha.ts`). The renderer re-validates `options.json` with zod. Non-secrets go to the yaml; secrets go to the env file. Both are written to tmpfs with mode 0600.

| HA option | Target |
|---|---|
| `instance_name`, `model_preset`, `local_base_url`, `local_model`, `public_url` | `instance.name`, `models.preset`, `models.local.{baseUrl,model}`, `instance.publicUrl` |
| `*_api_key`, `*_token` | env `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `MATRIX_ACCESS_TOKEN`; a non-empty token sets `channels.<x>.enabled` |
| `matrix_homeserver_url`, `signal_cli_url` | `channels.matrix.homeserverUrl`, `channels.signal.{cliUrl,enabled}` |
| `message_retention_days`, `monthly_budget_usd`, `backups_keep`, `log_level`, `update_check` | `privacy.messageRetentionDays`, `budgets.monthlyUsd` (unset → `budgets.preset: auto`, 01 §10/§14 A3), `backups.keep`, `logging.level`, `updates.check` |
| implicit | `instance.dataDir=/data`, `dashboard.{bind: 127.0.0.1, port: 7777}` (main listener: loopback only, for the CLI and healthcheck), `dashboard.ingress.{enabled: true, port: 8099, allowFrom: [172.30.32.2]}` (`09` §3.9.10), `logging.format=json`, timezone from `TZ` |
| `config_mode: file` | `/config/comvivo.yaml` is the base; options supply secrets only |

**Ingress & base path** (requirements on `09`). In HA mode the server accepts dashboard and API traffic **only from `172.30.32.2`** on the ingress listener (8099), plus loopback on the main listener for the CLI and healthcheck; everything else is refused. Each request's `X-Ingress-Path` is injected into `index.html` as `<base href="{path}/">`. The SPA builds with **relative asset URLs** (Vite `base: './'`), derives TanStack Router's `basepath` from `document.baseURI`, makes API and SSE calls relative, scopes cookies with `Path={basePath}`, and never emits absolute redirects. The same mechanism implements `dashboard.basePath` for reverse proxies. **Auth** (01 §14 A9; `09` §3.9.10): HA users are not Village members, and `X-Remote-User-*` headers alone **never** authenticate. On first visit the panel shows "Link your Home Assistant account": the HA user sends the displayed **pairing code** to Village in a private chat and approves it there (or, only while the instance is unclaimed, enters the console host claim code). After that one-time link the header identifies the linked person, with no second login (§11 Q4). Magic links are never used on the ingress listener.

**Backups.** `backup: hot` would otherwise tar a live SQLite DB. `ha-backup-pre` asks the server through the Control API (`POST /control/v1/backups/ha-snapshot`) for a consistent snapshot (`02` online backup, sealed in `VBK1`) at `backups/ha-snapshot/village.vbak` within `timeout`; `ha-backup-post` deletes it. The live `db/` is **not** excluded, so it serves as a fallback if the pre-hook fails. On restore, the entrypoint prefers `ha-snapshot/*.vbak` if it is newer than the last clean shutdown (`run/last-boot.json`) and passes verification; it moves the snapshot into place and deletes it. HA backups therefore contain the **master key**. DOCS.md says so plainly and recommends HA's encrypted backups.

**AppArmor** (`apparmor.txt`). Developed in `complain` mode on an HAOS VM, then enforced (M14-T9):
```
#include <tunables/global>
profile village flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>
  #include <abstractions/openssl>
  capability chown, capability dac_override, capability fowner, capability setuid, capability setgid,
  network inet stream, network inet6 stream, network inet dgram, network inet6 dgram, network unix stream,
  /usr/bin/tini ix, /{usr/,}bin/{sh,dash} ix, /usr/bin/{setpriv,find,chown,id,mkdir,stat,cat,rm,mv,cp} ix,
  /usr/local/bin/{village-entrypoint,node} ix, /opt/village/whisper/bin/whisper-cli ix, /opt/village/bin/ffmpeg ix,
  /app/** r, /app/**.node mr, /opt/village/** r, /opt/village/**.so* mr, /etc/** r,
  /data/ r, /data/** rwk, /config/ r, /config/** rw, /tmp/** rwk, /dev/{null,urandom,random} rw,
  @{PROC}/@{pid}/** r, @{PROC}/{cpuinfo,meminfo,stat} r, /sys/fs/cgroup/** r, /sys/devices/system/cpu/** r,
  deny mount, deny ptrace, deny /proc/sys/kernel/** w,
}
```

**DOCS.md (Documentation tab) outline:**
1. What Village is, and what leaves the house: messages go to the chosen cloud model unless the preset is Local; embeddings and voice transcription run locally.
2. Requirements: HA OS or Supervised; aarch64/amd64 (Pi 4/5 64-bit, NUC, VM); ≥ 2 GB free RAM; SSD recommended.
3. Install: repository badge → Install → Configuration → Start → **Open Web UI**.
4. First run: BotFather token, preset and API key, or Local via the community Ollama app (`local_base_url`).
5. Options table with examples and a "secret?" column.
6. Dashboard login: open Village from the sidebar → "Link your Home Assistant account" → send the code shown to Village in a private chat and tap Approve (once per HA user).
7. Backups: HA backups include the DB **and its key** (keep them encrypted); what is excluded; how restore works.
8. Advanced: `config_mode: file`.
9. Troubleshooting, with links to runbooks R1 and R7 and to support.
10. Limitations: ingress only; no 32-bit ARM; Signal needs an external signal-cli.
11. License and third-party notices.

### 3.6 Other platforms

#### 3.6.1 Umbrel

Umbrel ships via a **community store** first (`ORG/village-umbrel-store`, from `getumbrel/umbrel-community-app-store`: `umbrel-app-store.yml {id: ORG, name: Village}`, app folder `ORG-village/`). An **official store** PR follows after 1.0.

Rules followed: images pinned as `tag@sha256:<index digest>`; state under `${APP_DATA_DIR}/data/…`, with `.gitkeep` in committed dirs; `app_proxy` with `APP_HOST=<app-id>_<service>_1`; Umbrel auth on; no Docker socket; `restart: on-failure`; a web-only first run, because the store requires a useful browser UI without SSH.

```yaml
# ORG-village/umbrel-app.yml
manifestVersion: 1
id: ORG-village
storage: { dataRoot: data }
category: ai                     # [verify M14] current taxonomy
name: Village
version: "1.0.0"
tagline: The AI that belongs to your group chat
description: >-
  Village joins your family's Telegram, Discord or Slack group as a helpful member. First run: open the app
  and enter the app password shown by Umbrel as the setup code (COMVIVO_SETUP_TOKEN, 09 §3.9.4).
releaseNotes: ""
developer: Village contributors
website: https://DOCS_DOMAIN
dependencies: []
repo: https://github.com/ORG/village
support: https://github.com/ORG/village/discussions
port: 7777                       # must be unique in the store [verify at submission]
gallery: []
path: ""
deterministicPassword: true      # APP_PASSWORD is the one-time web setup token
defaultUsername: ""
defaultPassword: ""
backupIgnore: ["data/village/tmp/*", "data/village/models/*", "data/village/logs/*"]
submitter: Village contributors
submission: ""
```
```yaml
# ORG-village/docker-compose.yml
services:
  app_proxy:
    environment: { APP_HOST: ORG-village_server_1, APP_PORT: 7777, PROXY_AUTH_WHITELIST: "/healthz,/ics/*,/mcp" }
  server:
    image: ghcr.io/ORG/village:1.0.0@sha256:<index-digest>
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 45s
    environment:
      COMVIVO_PLATFORM: umbrel
      COMVIVO_SETUP_TOKEN: ${APP_PASSWORD}
      COMVIVO_PUBLIC_URL: "http://${DEVICE_DOMAIN_NAME}:${APP_PROXY_PORT}"
    volumes: ["${APP_DATA_DIR}/data/village:/data"]
```
Non-owner admins can reach the dashboard only if the owner turns off "Require Umbrel login" (umbrelOS 2.0); this is documented. ICS feeds are whitelisted because their URLs carry unguessable tokens (`07`/`09`). `/mcp` is whitelisted because it authenticates every request with a member's bearer token (`10` §3.7.3) and is not mounted unless the host enables the MCP server; it lives on the main port (no separate MCP port, `10` §3.7.2).

#### 3.6.2 CasaOS / ZimaOS (AppStore v2)

The app ships through our own third-party store `ORG/village-casaos-store` (`store-config.json`, `supported-languages.json`, `Apps/Village/{docker-compose.yml, icon.svg}`, built with the official action). Upstream submission follows after 1.0. `/DATA/AppData/$AppID` is root-owned, so the app uses **root-start + drop**.
```yaml
name: village
services:
  village:
    image: ghcr.io/ORG/village:1.0.0
    user: "0:0"
    environment: { PUID: "1000", PGID: "1000", TZ: $TZ, COMVIVO_PLATFORM: casaos }
    ports: [{ target: 7777, published: "7777", protocol: tcp }]
    volumes: [{ type: bind, source: /DATA/AppData/$AppID/data, target: /data }]
    restart: unless-stopped
    stop_grace_period: 45s
x-casaos:
  id: org.ORG.village
  main: village
  index: /
  port_map: "7777"
  scheme: http
  icon: https://DOCS_DOMAIN/brand/icon.svg
  title: { en_US: Village }
  tagline: { en_US: The AI that belongs to your group chat }
  description: { en_US: "…" }
  tips: { before_install: { en_US: "After start, open the app and enter the setup code printed in the app's logs." } }
  author: Village contributors
  developer: Village contributors
  category: Productivity
  architectures: [amd64, arm64]
  version: "1.0.0"
```

#### 3.6.3 Unraid (Community Applications)

The template is `ORG/unraid-templates/village.xml`, submitted via ca.unraid.net/submit with a forum support thread. It follows the Unraid convention of `99:100`.
```xml
<?xml version="1.0"?>
<Container version="2">
  <Name>Village</Name>
  <Repository>ghcr.io/ORG/village:1</Repository>
  <Registry>https://github.com/ORG/village/pkgs/container/village</Registry>
  <Network>bridge</Network>
  <Support>https://github.com/ORG/village/discussions</Support>
  <Project>https://github.com/ORG/village</Project>
  <Overview>Open-source AI that belongs to your group chat. Private by design.</Overview>
  <Category>Productivity: Tools:</Category>
  <WebUI>http://[IP]:[PORT:7777]/</WebUI>
  <TemplateURL>https://raw.githubusercontent.com/ORG/unraid-templates/main/village.xml</TemplateURL>
  <Icon>https://DOCS_DOMAIN/brand/icon-256.png</Icon>
  <ExtraParams>--user 99:100 --stop-timeout 45 --read-only --tmpfs /tmp:size=256m</ExtraParams>
  <Config Name="Data" Target="/data" Default="/mnt/user/appdata/village" Mode="rw" Type="Path" Display="always" Required="true"/>
  <Config Name="Dashboard port" Target="7777" Default="7777" Mode="tcp" Type="Port" Display="always" Required="true"/>
  <Config Name="Anthropic API key" Target="ANTHROPIC_API_KEY" Default="" Type="Variable" Display="always" Required="false" Mask="true"/>
  <Config Name="Telegram bot token" Target="TELEGRAM_BOT_TOKEN" Default="" Type="Variable" Display="always" Required="false" Mask="true"/>
</Container>
```

#### 3.6.4 TrueNAS SCALE (cheap path)

A docs page, "Install via YAML" (TrueNAS 24.10+ is Docker-based; 25.10 requires a top-level `services:` key), covers:
- The default compose with `user: "568:568"` (the TrueNAS `apps` user).
- A host-path dataset `/mnt/<pool>/apps/village` owned by `apps`.
- A note that ixVolumes are for testing only.

Catalog submission (`truenas/apps`) is post-1.0.

#### 3.6.5 systemd (`deploy/systemd/village.service`)

`village service install` renders this unit and prints the `sudo` steps; it never runs sudo itself without `--yes`. The runtime lives in `/opt/village/runtime`, and `/usr/local/bin/village` links to it.
```ini
[Unit]
Description=Village — group AI agent
Documentation=https://DOCS_DOMAIN/operate/
After=network-online.target time-sync.target
Wants=network-online.target

[Service]
Type=exec
User=village
Group=village
EnvironmentFile=/etc/village/village.env
Environment=COMVIVO_CONFIG=/etc/village/comvivo.yaml COMVIVO_DATA_DIR=/var/lib/village COMVIVO_LOG_FORMAT=json
ExecStart=/usr/local/bin/village start
StateDirectory=village
StateDirectoryMode=0700
UMask=0077
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
TimeoutStopSec=60
KillMode=mixed
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/village
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
CapabilityBoundingSet=
# MemoryDenyWriteExecute stays off: V8's JIT needs it. Tuning: MemoryHigh=1G MemoryMax=1536M CPUQuota=200%

[Install]
WantedBy=multi-user.target
```
`/etc/village/village.env` is mode 0640, `root:village`. A `--user` variant is installed into `~/.config/systemd/user/` with `loginctl enable-linger`.

#### 3.6.6 launchd (`deploy/launchd/dev.village.server.plist`)

- `village service install` writes the plist to `~/Library/LaunchAgents` with `RunAtLoad`, `KeepAlive={SuccessfulExit:false}` and `ProcessType=Background`.
- Secrets live in `~/.config/village/village.env` (0600), which the CLI reads.
- Logs go to `~/Library/Logs/Village/` through in-process rotation (§3.11.3).

### 3.7 Data directory layout & permissions

```
<dataDir>/      0700  (container /data · systemd /var/lib/village · native ./data)
├─ FORMAT       0600  data-dir marker (§4.5)
├─ db/          0700  comvivo.db (+ -wal, -shm) 0600 — schema/encryption: 02/08
├─ blobs/       0700  content-addressed encrypted blobs — layout: 02
├─ keys/        0700  master.key · keyring.json (+ .prev) · vault.enc (08 §3.7) · control.token (09 D-04) · secrets.enc (appliance installs only; 01 §14 A29, format 08 §3.10), all 0600
├─ backups/     0700  daily/ weekly/ monthly/ pre-migrate/ manual/ ha-snapshot/  (*.vbak 0600 + *.vbak.json sidecar)
├─ models/      0700  downloaded models, .partial/
├─ plugins/     0700  owned by 10
├─ logs/        0700  only if logging.file.enabled
├─ run/         0700  comvivo.lock · last-boot.json · update-check.json · setup-token (hashed)
└─ tmp/         0700  same-filesystem temp for atomic renames; swept on boot
```

- **Permission audit** (boot and `doctor`): a group- or world-*writable* `dataDir`, `keys/` or `master.key` → refuse to start (78); a group- or world-*readable* `keys/` directory or key file (`master.key`, `keyring.json`, `vault.enc`, `secrets.enc`, `control.token`) → refuse to start (78) unless `--insecure-permissions` (08 §3.7.3); other group- or world-readable paths → auto-tighten and warn; owner mismatch → 78 with a `chown` hint.
- **Instance lock** (`run/comvivo.lock`; one writer per data dir, spine §8). Created with `O_EXCL`; holds `{pid, hostname, bootId, version, startedAt, heartbeatAt}`; heartbeat every 10 s. Takeover happens if the heartbeat is older than 60 s, or the hostname matches and the PID is dead. Otherwise the second process exits 75 with "another Village (pid, host, version) uses this data dir". `--role=web` processes take `run/web.<pid>.lock`.
- **Filesystem check.** `statfs` types `nfs`, `cifs`/`smb2`, `9p` and `fuse.*` give a boot warning and a doctor error, because SQLite WAL locking is unreliable there. `fuse.virtiofs` (Docker Desktop) only warns. Doctor also detects `.stfolder`/`.dropbox` sync markers.

### 3.8 Upgrades

#### 3.8.1 Boot sequence (`apps/server/src/lifecycle/boot.ts`)

1. Load config; run the permission and FS audit; acquire the lock.
2. Read `FORMAT`. Missing with an empty `db/` → fresh install (create the layout). Missing with a non-empty `db/` → exit 65.
3. Open the DB with the master key. Mismatch → exit 78, "master key does not match this database". **A key is never generated while a DB exists.**
4. `PRAGMA quick_check`. Failure → **recovery mode** (§3.8.5).
5. Compare applied migrations with `release-compat.json`. Unknown IDs (DB newer than the build) → 78. `FORMAT.lastBoot.version < minUpgradeFrom` → 78 with "upgrade to bridge B first" and the commands. Pending migrations → step 6; none → step 8.
6. **Pre-migration backup.** Require free space ≥ 2.2× the DB size (else 75). Write `backups/pre-migrate/<ts>_<from>_to_<to>.vbak` (`02` online backup) and **verify** it: decrypt, `integrity_check`, row counts against the sidecar. Prune beyond `keepPreMigrate`, never the newest. `--skip-pre-migrate-backup` exists only as a typed-confirmation emergency flag.
7. **Migrate.** One transaction per migration (drizzle), then `foreign_key_check` and the migration's `verify()`. Long non-transactional work (FTS rebuild, re-embed, blob re-wrap) becomes **idempotent post-migration jobs**. On failure: rollback (the DB stays at the last good migration), then exit 65 with "migration <id> failed; data intact at <id-1>; backup at <path>; retry, report, or `village restore --pre-migrate latest`".
8. Write `FORMAT.lastBoot {version, schemaHead, at}` and `run/last-boot.json`.
9. Run turn and outbox recovery; start actors and adapters; `/readyz` → 200.

During steps 6–9, `/healthz` reports `starting` with `phase: migrating|backing-up|recovering`, so watchdogs don't kill long migrations.

#### 3.8.2 Compatibility matrix (enforced via `release-compat.json`, §4.7)

| Running | Direct upgrade from | CI coverage (§3.8.6) |
|---|---|---|
| `0.1`–`0.4` (alpha) | the previous release (N-1). One "export → re-init → import" break is allowed **once**, announced ≥ 14 days ahead, before 0.5 | N-1 on every PR |
| `0.5`–`0.8` (beta) | releases ≥ the previous **3 minors** | N-3 minors nightly |
| `0.9.x` | **bridge**: any 0.5+ data dir | full beta matrix |
| `1.x` | **any 1.x** and the `0.9` bridge | every 1.x minor's latest patch + bridge, nightly |
| `2.0` | the last 1.x minor (LTS) | — |

Releases that tighten `minUpgradeFrom` are listed in HA `breaking_versions` and carry an `upgrade:` note. `dataDirFormat` and `backupFormat` (`02`) are versioned separately; a build reads backup formats `[current-1, current]`.

#### 3.8.3 Downgrades

- **Same schema** (e.g. 1.4.3 → 1.4.2, no new migrations): allowed, with a warning.
- **The DB has unknown migrations:** refused (78).
- **`village start --allow-downgrade --restore <file|pre-migrate:latest>`** requires a backup with `schemaHead` ≤ the build's head. It moves the current `db/` to `backups/manual/pre-downgrade-<ts>/` (never deleted), restores, and boots. Data written after that backup is lost; the command shows the window and needs `--yes` or an interactive confirm.

#### 3.8.4 Rollback & upgrade canary

**Rollback runbook (automated in CI):** (1) stop the service; (2) pin the previous version (`.env` `COMVIVO_VERSION=<prev>` or `village runtime use <prev>`); (3) `docker compose run --rm --no-deps village start --allow-downgrade --restore pre-migrate:latest --yes --exit-after-restore`; (4) start, then `village doctor`; (5) file an issue (the pre-downgrade copy is kept).

**`village upgrade check [--to X.Y.Z]`** is a canary for careful hosts. It restores the latest verified backup into a temp dir and runs the **target** version's migrations there (the target image via `docker run --rm`, or the target runtime) with `--role=drill` (no channels, outbox or jobs), then reports. Live data is untouched.

#### 3.8.5 Recovery mode

Entered on a quick_check failure, after a failed migration on the previous boot (marker in `run/`), or via `village start --recovery`. Only the recovery surface runs: channels, jobs and outbox stay off. CLI: `village recovery status|restore <backup>|export-raw`. Web: `/recovery` lists verified backups and offers one-click restore. It is gated by a one-time code printed in the logs (rotated each boot) plus any platform proxy auth, so appliances without SSH (Umbrel, CasaOS, HA) can recover. `/healthz` reports **200 `degraded`** with `phase: recovery` (a restart cannot help, so watchdogs must not restart-loop the recovery UI), and `/readyz` returns 503.

#### 3.8.6 Upgrade testing in CI (with `11`)

- **Fixtures.** The release job `fixtures` runs the released image with `COMVIVO_FIXTURE_MODE=1`, the simulator channel, the deterministic fake model, a fixed clock and `fixtures/upgrade/TEST-ONLY-master.key`, executing `fixtures/upgrade/scenario.yaml`. The scenario covers: 2 groups (family, team) plus DMs with private items of every label kind; memories in every status; recurring events across DST; future reminders; a mid-cycle rotation; an open poll; an amendment proposal; an audit chain; image and PDF blobs; a pending outbox row; and a turn with committed effects but **no completion**. It produces a **clean** fixture (graceful stop) and a **dirty** one (`kill -9` mid-turn), uploaded as release assets with SHA-256.
- **Matrix** (`upgrade-matrix.yml`; PRs run N-1, nightly runs the full policy set). It boots the candidate on a copy and asserts `fixtures/upgrade/assertions.yaml`:
  - migrations applied, `quick_check` ok, and the audit hash chain verifies;
  - counts unchanged and IFC labels byte-identical;
  - reminders fire at identical instants under a simulated clock;
  - the dirty turn's effects are acknowledged **exactly once**;
  - catch-up for a non-owner audience shows no private items (an I1 spot check);
  - downgrade is refused (78), and the `--allow-downgrade --restore pre-migrate:latest` round-trip works.
- Before the first release exists, PRs generate a fixture on the fly from the merge-base commit.

### 3.9 Backups — operations side

The archive format, encryption and online backup belong to `02`. Ops adds scheduling, retention, offsite copies, verification, drills and reminders.

**Schedule & GFS retention.** `backup.snapshot` runs on `backups.schedule` (default `30 3 * * *`, instance timezone). It keeps `keep` dailies (spine default 14), `keepWeekly` (4; first of each ISO week), `keepMonthly` (6; first of each month) and `keepPreMigrate` (5); manual backups are kept forever. Promotion uses hardlinks (copy fallback).
- **Free-space guard:** prune first; if space is still below 2.2× the expected size, fail with `backup.failed{reason: disk}`. Never delete the newest verified backup.
- **Alerts:** host DM (plus admins if the constitution allows), a dashboard banner, and `/healthz` `degraded: backups` when the last success is more than 36 h old.

**Offsite** (`backups.offsite.command`): an **argv array** (never a shell string) run after each successful snapshot, with a timeout (900 s). `{file}` and `{sidecar}` are substituted. The env contains only `COMVIVO_BACKUP_FILE`, `COMVIVO_BACKUP_SIDECAR`, `COMVIVO_BACKUP_SHA256`, `COMVIVO_BACKUP_TIER` and `COMVIVO_INSTANCE_NAME` (no provider keys or tokens). A failure alerts but does not fail the local backup. Recipes: `["rclone","copy","{file}","b2:bucket/village/"]`, `restic backup {file}`, `scp`; in Docker, the rclone sidecar (§3.3).

**Heartbeat.** `backups.notifyUrl` (Uptime Kuma push, healthchecks.io) gets a GET after each success. It is off by default, and it is the host's own endpoint, not telemetry.

**Verification & drills.**
- The weekly `backup.verify` job (Sun 04:00) decrypts the newest backup of each tier into `tmp/`, runs `integrity_check`, compares row counts with the sidecar, verifies the audit chain and blob references, then deletes the copy.
- `village backup verify [file|--latest|--all]` does the same on demand.
- `village restore --drill <file|latest>` restores into a temp dir, boots `--role=drill`, runs the post-migration assertions and a read-only simulator "catch me up", then reports and cleans up. Recommended quarterly; the dashboard shows "last drill: N days ago".

**Recovery-key reminders.** Every `VBK1` backup can be restored with the printed recovery key alone (01 §14 A10; 08 §3.7.6). After `init`, after the first backup, after every `keys rotate-recovery`, and whenever the recovery key has never been verified or was last verified more than 180 days ago (08 D-05), the host gets a DM and a banner: "Keep your recovery key safe: it is the only way to restore your backups on a new machine. Check it with `village keys verify-recovery`." `doctor` warns (`keys.recovery`) until it is verified.

**Platform backups** all include the master key and keyring: HA (§3.5); Umbrel app-data backups with `backupIgnore`; the Unraid appdata-backup plugin; TrueNAS dataset snapshots (crash-consistent, which is acceptable because SQLite WAL is crash-safe). Docs rule: **point host backup tools at `backups/` (restorable with the recovery key), or snapshot the dataset atomically; never copy a live `db/` file by file.**

### 3.10 Release engineering

#### 3.10.1 Versioning & packages

- **Product version:** one semver for `village`, `@comvivo/server`, the image tags, the HA/Umbrel/CasaOS/Unraid manifests and GitHub Release `vX.Y.Z`. It is a Changesets **fixed** group; pre-1.0, a minor is breaking. `apps/cli/CHANGELOG.md` is the product changelog.
- **SDKs:** `@comvivo/plugin-sdk` and `@comvivo/channel-sdk` are versioned independently (0.x until the app's 1.0). The server declares supported SDK ranges in `release-compat.json` (checks live in `10`). SDKs must be **stateless** (no singletons, no cross-copy `instanceof`) because the server bundles its own copy; `zod` is a peer dependency.
- **Private:** all other workspaces. Changesets v3's `privatePackages: false` gives them no versions, tags or changelogs.

```json
{ "$schema": "https://unpkg.com/@changesets/config@4/schema.json",
  "changelog": ["./tools/changelog/index.mjs", { "repo": "ORG/village" }],
  "commit": false, "access": "public", "baseBranch": "main", "fixed": [["village", "@comvivo/server"]], "linked": [],
  "updateInternalDependencies": "patch", "privatePackages": false, "format": "auto" }
```

**Changeset rule.** A PR that changes shipped behavior (`apps/**`, `packages/**`, `deploy/**`, excluding tests and docs) needs a changeset on `village` or an SDK, or the `no-changeset` label; `changesets/action/pr-status` plus a script enforce this. Summaries start with a type (`feat:`, `fix:`, `perf:`, `security:`, `breaking:`, `upgrade:`, `docs:`), which the custom formatter groups by.

#### 3.10.2 Changesets vs release-please

| Criterion | Changesets v3 + action v2 | release-please v17 |
|---|---|---|
| Spine §11.9 | ✓ mandated | ✗ |
| Fixed app group + independent SDKs | ✓ `fixed` + per-package | possible via manifest config; awkward |
| Notes quality | author-written, user-facing | commit subjects |
| Long beta trains | `pre enter beta` (v3 keeps pre changesets in `.changeset/pre/`) | prerelease config |
| OIDC publish split | ✓ `select-mode` → `pack` (no perms) → `publish` (`id-token`) | DIY |
| Edge snapshots | ✓ `version --snapshot edge` | ✗ |

**Decision: Changesets.** Conventional Commits remain for commit hygiene only.

#### 3.10.3 Channels

| Channel | Version | npm dist-tag | Docker | HA app | Cadence |
|---|---|---|---|---|---|
| stable | `X.Y.Z` | `latest` | `X.Y.Z`, `X.Y`, `X`, `latest` | `village` | minor every ~4–6 weeks; patches as needed |
| beta | `X.Y.Z-beta.N` (pre mode) | `beta` (re-pointed to stable when stable is newer) | `X.Y.Z-beta.N`, `beta` | `village_beta` | weekly during a train |
| edge | `0.0.0-edge-<yyyymmddHHMM>-<sha7>` | `edge` (nightly, if changed) | `edge`, `sha-<7>` (every `main` push) | — | continuous |

"0.1 alpha" and "0.5 beta" (`00` §8) are **stable-channel `0.Y` versions** that the docs label alpha or beta. `1.0.0-rc.N` uses pre mode `rc` on the `beta` dist-tag.

#### 3.10.4 Workflows (`.github/workflows/`)

**Hardening.** Top-level `permissions: {}` with minimal per-job grants; actions pinned by SHA (Renovate updates them); `concurrency: release-${{ github.ref }}`. Rulesets protect the `v*`, `village@*` and `@comvivo/*@*` tags and the `main` and `release/*` branches. Environments: `release` (stable publishes need 1 maintainer approval), `npm` (trusted publisher) and `downstream` (GitHub App token for the mirror repos). Current majors on 2026-11-01, still SHA-pinned: `docker/setup-buildx-action` v4, `docker/build-push-action` v7, `docker/metadata-action` v6, `actions/attest` v4 (`attest-build-provenance` v4 is now a wrapper around it), `sigstore/cosign-installer` v4 (cosign v3.1), `anchore/sbom-action` v0.24, `changesets/action` v2.1, `pnpm/action-setup` v6.

| Workflow | Trigger | Content |
|---|---|---|
| `ci.yml` (owned by `11`; job list in `11` §3.8.2) | PR, push, `merge_group` | lint, typecheck, test, build, depcruise, evals-smoke, `changeset-status`, and the `packaging` job owned here: `names:check`, `compose:validate`, hadolint/shellcheck, amd64 image build + `selftest`, upgrade N-1 (actionlint runs in `static`; zizmor is `08`'s `zizmor.yml`) |
| `release.yml` | push to `main` or `release/*` | the graph below; it calls `11`'s `quality-gates.yml` and `security-dast.yml` |
| `build-reusable.yml` | `workflow_call` from `release.yml`/`edge.yml` | the `image` and `npm-pack` builds, isolated from the caller for **SLSA Build L3** (`08` SD-19, M14-T82) |
| `repro.yml` | release, weekly | builds npm tarballs twice with `SOURCE_DATE_EPOCH` and requires identical output; image diff reported, non-gating (`08` M14-T83) |
| `edge.yml` | push to `main`; nightly | signed multi-arch `edge` image; nightly npm `edge` snapshot if HEAD changed |
| `upgrade-matrix.yml` | nightly; called by release | §3.8.6 |
| `platform-smoke.yml` | nightly; pre-release | compose overlays e2e; native install on `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15`; HA, Umbrel and CasaOS lint; read-only/PUID tests; egress test |
| `ghcr-cleanup.yml` | weekly | prune `sha-*` beyond 50 |

```
mode (select-mode) ─► version-pr (version sub-action)                                       [mode=version]
                   └► verify (ci.yml) ─► image[amd64|arm64] ─► image-merge ─► image-sign-attest ─┐
                                     └► npm-pack (no perms) ─► npm-publish (env npm, id-token) ─┴► fixtures ─► github-release ─► downstream ─► docs-deploy
```

**`image` job.** The matrix is `{amd64: ubuntu-24.04, arm64: ubuntu-24.04-arm}`.
```yaml
- uses: docker/build-push-action@<sha>   # v7
  id: build
  with:
    file: deploy/docker/Dockerfile
    platforms: linux/${{ matrix.arch }}
    build-args: |
      COMVIVO_VERSION=${{ needs.mode.outputs.version }}
      VCS_REF=${{ github.sha }}
      BUILD_DATE=${{ env.BUILD_DATE }}
      SOURCE_DATE_EPOCH=${{ env.SOURCE_DATE_EPOCH }}
    outputs: type=image,name=ghcr.io/ORG/village,push-by-digest=true,name-canonical=true,push=true,rewrite-timestamp=true
    provenance: false
    sbom: false
    cache-from: type=gha,scope=village-${{ matrix.arch }}
    cache-to: type=gha,mode=max,scope=village-${{ matrix.arch }}
- run: docker run --rm --read-only --tmpfs /tmp -v st:/data ghcr.io/ORG/village@${{ steps.build.outputs.digest }} selftest --json
- run: scripts/release/image-size-gate.sh ghcr.io/ORG/village@${{ steps.build.outputs.digest }}
# then build village-ha FROM that digest (BUILD_ARCH=amd64|aarch64), push by digest, upload both digests
```

**`image-merge`** runs `docker buildx imagetools create` for `village` and `village-ha`, with tags from metadata-action plus `tags.mjs` (highest-semver logic) and `--annotation index:…`. It also pushes to Docker Hub when `names.images.dockerHub` is set, and refuses an existing release tag with a different digest.

**`image-sign-attest`** (`id-token`, `packages`, `attestations` and `artifact-metadata`: write):
```bash
cosign sign --yes --recursive ghcr.io/ORG/village@${INDEX_DIGEST}       # keyless; v3 bundle stored as an OCI referrer
cosign sign --yes --recursive ghcr.io/ORG/village-ha@${HA_INDEX_DIGEST}
```
Then:
- `actions/attest` records provenance (`subject-name`, `subject-digest`, `push-to-registry: true`).
- `anchore/sbom-action` produces a CycloneDX SBOM per platform digest. It is merged with `deploy/sbom/extra-components.cdx.json` (whisper.cpp MIT; FFmpeg LGPL-2.1-or-later plus configure flags; the baked model as a `machine-learning-model` component) and attested via `actions/attest` with `sbom-path`.
- `anchore/scan-action` (Grype) **fails the release on a critical vulnerability with a fix available** (policy `08`).

Verification block for the docs and release notes:
```bash
cosign verify ghcr.io/ORG/village:1.0.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/ORG/village/\.github/workflows/release\.yml@refs/heads/(main|release/.+)$'
gh attestation verify oci://ghcr.io/ORG/village:1.0.0 --repo ORG/village
npm audit signatures
```

**npm.** `npm-pack` (`changesets/action/pack`, no permissions) fails if any packed manifest contains `workspace:`. `npm-publish` (`changesets/action/publish` with `pack-dir-artifact-id`) runs in environment `npm` with `id-token: write`, npm ≥ 11.5.1 and Node ≥ 22.14 (the trusted-publishing requirements), **no `NPM_TOKEN` anywhere**, automatic provenance, and `create-github-releases: false`. One-time setup per public package (M12-T90): an npmjs.com trusted publisher `{repo: ORG/village, workflow: release.yml, environment: npm}` plus "Require 2FA and disallow tokens". The first publish must happen within 2 days of configuring it.

**`github-release`.** `tools/release/notes.ts` composes the `vX.Y.Z` notes:
- optional highlights (`.changeset/highlights/X.Y.md`);
- grouped changes;
- **upgrade notes** (`upgrade:`/`breaking:` entries, the compat-matrix row, `minUpgradeFrom`);
- security fixes with GHSA links;
- SDK bumps;
- image digests with the verification block;
- contributors.

It then creates the annotated tag and runs `gh release create` with the assets (`--prerelease` for betas). SDK tags get short releases of their own.

**`downstream`** (GitHub App token scoped to the mirror repos):
- HA: rsync `deploy/home-assistant/`; set `version` for `village` or `village_beta` **after** the image is public; generate `CHANGELOG.md`.
- Umbrel community store: version and digest.
- CasaOS and Unraid: version bumps (Unraid tracks `:1`).
- Official Umbrel and CasaOS PRs are opened manually from a generated branch.

**`docs-deploy`** calls `13`'s workflow (docs on Cloudflare Pages) and publishes `release-manifest.json` (§4.8), built from release tags and GHSAs, to the main repo's GitHub Pages (§3.1). A new GHSA re-publishes the manifest without a release.

**Idempotency.** Re-runs are safe: image tags are skipped when the digest is identical and fail otherwise; npm skips versions already published; `downstream` runs only after both image and npm publishing succeed.

#### 3.10.5 Hotfix & security releases

1. Fix on `main` first, with a `fix:` or `security:` changeset.
2. If `main` has moved past the affected minor: `git switch -c release/X.Y vX.Y.Z && git cherry-pick -x <fix-sha> && pnpm changeset`, then open a PR to `release/X.Y`. Merging runs `release.yml` there.
3. `X.Y.(Z+1)` always gets `X.Y`. It gets `X` and `latest` **only if** it is the highest version; otherwise npm publishes with `--tag maint-X.Y` (`scripts/release/dist-tag.mjs`).
4. The release script asserts that every `-x` cherry-pick SHA is reachable from `main`.

**Security releases.** The fix is developed in a GHSA private fork (`08`). At disclosure: merge to `main` and the affected `release/*` branches, release immediately, publish the GHSA, set `security: true` in the manifest, and announce. Fix targets are `08` §3.18's (Critical 7 days, High 30 days, Medium 90 days; a mitigation advisory within 24 h for Critical or exploited-in-the-wild issues).

#### 3.10.6 Support & LTS (from 1.0)

| Line | Fixes | Duration |
|---|---|---|
| Latest minor of the current major | all | until the next minor |
| Older minors of the current major | none (upgrade; minors are non-breaking) | — |
| Last minor of the previous major ("LTS") | security + data integrity | 12 months after the next major's `.0` |

**Node policy.** The 1.0 image starts on Node 26 (01 §14 A1; P1). After that, the image moves to a new Node LTS in a **minor** release, once that line has been Active LTS for ≥ 1 month and the native matrix is green. Native `engines` minimums rise only in a minor, after one minor of deprecation warnings, and never past the line's EOL. Today Node 24 is Maintenance LTS (since 2026-10-20, EOL 2028-04-30) and Node 26 is Active LTS (since 2026-10-28, EOL 2029-04-30). Node 27 starts the one-major-per-year scheme (April 2027, LTS October 2027).

### 3.11 Operations guide (content for `apps/docs/ops/*`, written in M14)

#### 3.11.1 Hardware sizing

These are estimates until M14-T14 replaces them with measurements.
- **Village itself:** idle RSS ~180–260 MB with embeddings unloaded (spine target ≤ 300 MB); +150 MB while the embedding session is loaded; whisper-cli peaks at +200 MB (base) or +550 MB (small); idle CPU < 2% of a core; the image takes ~0.55 GB on disk.
- **Data:** ~0.2–1 GB/year for a typical family **excluding media** (media-heavy groups add 2–10 GB/year). Backups take ≈ DB size × retained archives × compression ratio.

| Host | Cloud presets | Local embeddings | Local voice | `Local` LLM preset | Notes |
|---|---|---|---|---|---|
| Raspberry Pi 5 **4 GB** | ✓ | ✓ | ✓ tiny/base | ✗ | 64-bit OS; **SSD/NVMe strongly recommended** (WAL wear on SD cards) |
| Raspberry Pi 5 **8 GB** | ✓ | ✓ | ✓ base/small | ⚠ 1–4B models only, 3–8 tok/s; **prefilling Village's ~6–10k-token prompt takes minutes** | experiments only |
| **$5 VPS** (1 vCPU / 1 GB) | ✓ with `profile: low-memory` + 1 GB swap | ✓ (slow batches) | ⚠ use API | ✗ | 512 MB VPS unsupported |
| ARM VPS 2 vCPU / 4 GB (e.g. Hetzner CAX11) | ✓ | ✓ | ✓ | ✗ | best-value cloud host |
| NAS x86 (Celeron/N100, 4–16 GB) | ✓ | ✓ | ✓ | ⚠ N100 + 16 GB: 3–4B | Container Manager / compose |
| Mac mini M-series 16 GB | ✓ | ✓ | ✓ | ✓ 7–8B via **native** Ollama (Metal); cold prefill ~10–20 s, then cached | give Docker Desktop ≥ 4 GB |
| Mac mini 32–64 GB | ✓ | ✓ | ✓ | ✓ 14–32B q4 | — |

#### 3.11.2 Resource tuning knobs (defaults live in the owner docs)

| Knob | Env / config | Default | Notes |
|---|---|---|---|
| Profile | `COMVIVO_PROFILE` / `instance.profile` | `default` | `low-memory`: model calls 2, media 1, embeddings unload after 60 s, SQLite cache 8 MiB, whisper tiny, heap 384 MB |
| Container memory | `COMVIVO_MEMORY_LIMIT` | 1536m | keep ≥ 768m |
| V8 heap | `COMVIVO_HEAP_MB` → `--max-old-space-size` | auto | set on hosts with ≤ 1 GB |
| Concurrency | `runtime.concurrency.{modelCalls,media,embeddings}` (spine §8 / `05`) | 4 / 2 / 1 | Pi: media 1 |
| Embeddings | `embeddings.threads`, `embeddings.idleUnloadSeconds` (`04`) | min(2, cores) / 600 | — |
| Whisper | `transcription.{threads,model}` (`05`) | min(4, cores) / base | — |
| SQLite | `storage.sqlite.{cacheSizeMiB,mmapSizeMiB}` (`02`) | 32 / 128 | — |
| Shutdown | `COMVIVO_SHUTDOWN_GRACE_MS` | 30000 | must be < the orchestrator kill timeout |
| Backups | `backups.schedule` | 03:30 | avoid NAS/HA backup windows |

#### 3.11.3 Logs & rotation

pino writes JSON to stdout in containers and under systemd, and pretty output in a foreground TTY (spine §10).
- Docker: `json-file`, 10 MB × 5.
- systemd: journald (`SystemMaxUse=`); query with `journalctl -u village -o cat | jq`.
- `logging.file` (launchd, WSL): in-process rotation, 10 MiB × 5, in `<dataDir>/logs/`.
- `village logs [-f] [--since 1h] [--level warn]` wraps the right backend.
- Content is never logged above debug (spine §11.7); `doctor` flags `COMVIVO_DEBUG_CONTENT=1`.

#### 3.11.4 Monitoring

- `/healthz` and `/readyz`: see §4.3. **`/metrics`** (Prometheus, owned by `11` §3.10.3) is off by default; when enabled it is served on the dashboard listener at `/metrics` and answers loopback requests or `Authorization: Bearer $COMVIVO_METRICS_TOKEN` (there is no separate metrics port; in Docker, scrape with the token).
- Series ops needs from `11` (all in `11` §3.10.3): `village_build_info`, `village_channel_connected{channel}`, `village_outbox_pending`, `village_outbox_oldest_age_seconds`, `village_job_lag_seconds{kind}`, `village_backup_last_success_timestamp_seconds`, `village_backup_last_verify_timestamp_seconds`, `village_db_size_bytes`, `village_data_dir_free_bytes`, `village_model_cost_usd_total{route}`, `village_turns_total{status,trigger}`.
- **Uptime Kuma:**
  1. a JSON-query HTTP monitor on `/healthz` with `status = "ok"`, plus a keyword monitor for `degraded`;
  2. a **Push** monitor whose URL is `backups.notifyUrl` (26 h interval);
  3. a Docker container monitor to catch restart loops.

  Monitor remote hosts via Caddy or Tailscale, and never expose `/metrics` publicly.

#### 3.11.5 Runbooks (`apps/docs/ops/runbooks/R*.md`; each is dry-run in M14)

**R1 — Bot stopped responding.**
1. Run `village doctor`. It checks the process, readyz, channels, model auth, budgets, outbox and job lag.
2. Restarting? Check `docker compose ps` and `village logs --since 30m --level warn`. Exit 137 = OOM, so switch to `low-memory`. Exit 78 = config, key or downgrade problem; read the first error. Exit 75 = lock held.
3. A channel shows `auth_failed` → R7. Telegram **409 Conflict** means another instance is polling with this token; stop it.
4. Budget reached → raise `budgets.*` or switch preset (R6).
5. Outbox growing → a platform outage or rate limit; it self-heals.
6. Silent in a group → check Telegram privacy mode or the Discord Message Content intent (`doctor --check channels`; `06`).
7. Still stuck → `village doctor --bundle` writes a **redacted** bundle (no content, no secrets).

**R2 — "database is locked" / SQLITE_BUSY.**
1. Make sure only one instance runs: check `run/comvivo.lock`, `docker ps` and `systemctl status` on every host sharing the path.
2. Run `lsof <data>/db/comvivo.db` to find other holders: backup agents, `sqlite3` shells, sync clients. **Never sync the live `db/`.**
3. Data dir on NFS, SMB or 9p → move it to a local disk.
4. WAL over 1 GB → `village db checkpoint`.
5. Persists after a restart → `village backup verify --latest`, then R3.

**R3 — Restore from backup.**
1. `village backup list` shows verified status. Make sure you have a matching unlock key: the `keys/` directory of that instance, or the printed recovery key (`--recovery-key-file`).
2. Docker: `docker compose stop village && docker compose run --rm --no-deps village restore <file|latest> --yes && docker compose up -d`. Native: `village service stop && village restore … && village service start`.
3. The current `db/` moves to `backups/manual/pre-restore-<ts>/`. Older backups migrate on boot; newer ones are refused.
4. Check `village doctor` and Dashboard → Backups, then send a test message.

**R4 — Rotate keys.**
- **Keys** (`08` §3.7.7 is normative): `village keys rotate-master` (cheap rewrap of the keyring slot), `village keys rotate-data [--reencrypt-blobs]` (new data-key generation; take a backup first), `village keys rotate-recovery` then `village backup rewrap --all`. Retired generations stay in `keyring.json` until `village keys purge-retired`, which refuses while a retained backup still needs them.
- **Provider or channel tokens:** edit `.env` or the HA options, run `docker compose up -d`, then `village doctor --check channels,models`.
- **Dashboard sessions:** `village sessions revoke --all` or `village keys rotate-sessions` (`09`, `08`).

**R5 — Move to a new machine.**
1. On the old host, run `village backup create --label move`. Copy the newest `.vbak` + sidecar, `comvivo.yaml`, `.env`, and `signal-cli/` if used. Bring the printed recovery key (or copy `keys/`).
2. **Stop and disable the old instance** (`docker compose down` or `systemctl disable --now village`). Two instances on one token fight each other.
3. On the new host, install the **same or a newer** version and run `village init --restore <file>` (skips the wizard; it asks for the recovery key unless `keys/` was copied).
4. Run `village doctor` and `/status` in each group. Keep the old data for 14 days, then wipe it (`shred` the keys).

**R6 — Change model provider or preset.**
1. Add the key (`.env`/options, then restart), or pick the preset in Dashboard → Settings (a DB setting; no restart).
2. **Local:** use the Ollama overlay or native Ollama, `ollama pull <model>`, and set `COMVIVO_LOCAL_MODEL`. `doctor --check models` runs a structured-output smoke test. Expect slower replies.
3. Changing the **embedding** model triggers a re-embed job (`04`) with progress and an estimated cost. API embeddings send memory text off-host, and the wizard warns about this.
4. Watch Dashboard → Costs for 48 h.

**R7 — Channel token revoked.**
- **Symptoms:** the adapter reports `auth_failed` (Telegram 401, Discord `TokenInvalid`, Slack `invalid_auth`/`token_revoked`, Matrix `M_UNKNOWN_TOKEN`); `/healthz` is degraded; the host gets a DM on another linked channel plus a banner. The adapter stops retrying, to avoid platform bans (`06`).
- **Fix:** reissue the token (BotFather `/revoke` → `/token`; Discord "Reset Token"; Slack reinstall; Matrix re-login), update `.env`/options, run `docker compose up -d`, then `village doctor --check channels`.
- **If the token leaked:** review Dashboard → Audit for the exposure window, and rotate the other secrets in the same `.env`.

### 3.12 Release-readiness checklists

The checklists live in `.github/ISSUE_TEMPLATE/release-checklist-{alpha,beta,ga}.md`. A stable publish requires the linked checklist issue to be closed; the gate is enforced through `release` environment reviewers.

**0.1 alpha (end of M8; maintainers + ~10 groups)**
- [ ] Multi-arch `0.1.0` images are signed, and `selftest` is green on amd64 and arm64.
- [ ] The compose quickstart works on a clean Ubuntu 24.04 VM and a Pi 5 (64-bit) in ≤ 15 min.
- [ ] Data guard, permission audit, lock and `FORMAT` work. Graceful SIGTERM causes 0 duplicate sends in 20 forced restarts.
- [ ] Daily backups, `backup list|verify` and a manual restore are tested; the recovery-key reminder is shown.
- [ ] Migrate-on-boot with a pre-migration backup and downgrade refusal work; the N-1 upgrade test is in CI.
- [ ] The egress test shows only configured endpoints. The alpha data-compat policy and known issues are published.

**0.5 beta (end of M12; ~100 groups)**
- [ ] Everything from 0.1. The beta and edge channels are live. The six public npm packages (P11) are published via OIDC with provenance, and token publishing is disabled.
- [ ] `init` works in Docker and native mode on linux x64/arm64 and macOS arm64; platform-smoke is green 7 nights in a row.
- [ ] The Ollama, Signal, Caddy and rclone overlays pass e2e.
- [ ] HA `village_beta` installs from the custom repo on HAOS (aarch64 Pi + amd64 VM); the ingress dashboard works; a backup/restore round-trip passes; AppArmor complain mode shows no denials.
- [ ] The Umbrel community store install works, and recovery is reachable from the web.
- [ ] The upgrade matrix (N-3 minors) is green, and the rollback runbook is rehearsed. The image is ≤ 300 MB per arch with no fixable criticals.
- [ ] Runbooks R1–R7 are drafted. Sizing is measured on a Pi 5 8 GB and a 1 GB VPS.

**1.0 (end of M15)**
- [ ] Everything from 0.5. The `0.9` bridge is tested against every 0.5+ fixture, clean and dirty.
- [ ] `cosign verify`, `gh attestation verify` and `npm audit signatures` pass against the published artifacts in CI.
- [ ] HA `village` (stable) ships with **enforced** AppArmor and a complete DOCS.md. The CasaOS store is live, the Unraid CA template is accepted, and the TrueNAS page, systemd and launchd units are tested.
- [ ] Final names are applied, and the CLI install path is secured (§12-2).
- [ ] Ops docs are complete, runbooks are dry-run by non-authors, and the time-to-first-value gate passes: ≥ 95% success over ≥ 40 fresh-user attempts, median ≤ 5 min (01 §14 A22; `13` gate G1).
- [ ] The support/LTS policy, security policy and cadence are published. `release-manifest.json` is live, and update checks are verified off by default.
- [ ] A non-author restores from an offsite copy on a fresh host.

---

## 4. Interfaces

### 4.1 Ops commands (UX and help text owned by `09`; these semantics are normative)

| Command | Semantics |
|---|---|
| `init [dir] [--mode docker\|native] [--non-interactive] [--yes] [--from-env] [--restore <file>]` | §3.4.2 |
| `start [--role web\|worker\|all\|drill] [--recovery] [--allow-downgrade --restore <x>] [--exit-after-restore]` (foreground by default) | §3.8 |
| `update [--to X.Y.Z] [--channel stable\|beta] [--check]` (`--check` = the upgrade canary) | §3.4.4 / §3.8.4 |
| `backup create [--label] \| list \| verify [file\|--latest\|--all] \| prune [--before <date>] [--dry-run] \| rewrap [--all]` | §3.9 |
| `restore <file\|latest\|pre-migrate:latest> [--drill] [--recovery-key-file <path>] [--yes-i-understand]` | §3.9, R3 |
| `keys status \| verify-recovery \| rotate-master \| rotate-data \| rotate-recovery \| rotate-sessions \| recover \| add-passphrase \| remove-slot \| purge-retired` | normative in `08` §3.7.6–3.7.7 |
| `models list \| pull <id> \| verify` | §3.2.4 |
| `runtime install [ver] \| use <ver> \| list \| prune` | native only |
| `service install \| uninstall \| status \| start \| stop` | §3.6.5–3.6.6 |
| `selftest [--json]` | Loads native libs: opens an encrypted DB, loads sqlite-vec, embeds a canary string and checks the vector hash within tolerance, runs `whisper-cli --help`, decodes fixtures with ffmpeg, and checks non-root, writable `/data` and read-only `/` |
| `doctor [--check <ids>] [--deep] [--bundle [path]]` / `db checkpoint` / `logs` | §3.7, §3.9, §3.11 (flags owned by `09` §3.11.3) |

### 4.2 Exit codes

These are the **server process** exit codes (`village start` in the foreground, the container's `start`, systemd); orchestrators rely on them (01 §14 A15). Other CLI commands use `09` §3.11.2's table (CLI usage errors exit 2 there, so 64 is not used).

| Code | Meaning | Orchestrator behavior |
|---|---|---|
| 0 | clean shutdown | — |
| 1 | crash (bug) | restart |
| 65 | data error (corrupt DB, failed migration, `FORMAT` missing alongside existing data) | restart → recovery mode |
| 75 | temporary (lock held, no space for the pre-migration backup) | restart with backoff |
| 78 | configuration (bad config, key mismatch, downgrade refused, data dir not mounted/writable, unsupported upgrade path) | systemd: no restart (`RestartPreventExitStatus`); Docker: restart with backoff |
| 130 | forced shutdown (second signal) | — |

### 4.3 Health endpoints (on `09`'s HTTP server)

- `GET /healthz` (liveness; makes no network calls; the same contract as `09` §3.8, 01 §14 A15). Unauthenticated callers get `{"status":"ok"|"starting"|"degraded"|"draining"|"fail"}`. Loopback, the trusted ingress source, or `COMVIVO_METRICS_TOKEN` holders also get `version`, `phase`, `uptimeS` and `checks: {db, migrations, lock, clock, backups:{lastSuccessAt,lastVerifyAt}, channels:{<id>: connected|connecting|auth_failed|disabled}, outbox:{pending,oldestAgeS}, jobs:{maxLagS}}` (served from cached state). Returns 200 for ok/starting/degraded (including recovery mode, `phase: recovery`) and 503 for draining/fail.
- `GET /readyz` returns 200 only after boot step 9 (§3.8.1). It is independent of channel connectivity.

### 4.4 Environment variables recognized by the image and runtime

The `09`/`shared` config loader must implement these. Each variable also accepts a `*_FILE` variant for Docker secrets.

| Variable | Maps to |
|---|---|
| `COMVIVO_CONFIG`, `COMVIVO_DATA_DIR` | config path, `instance.dataDir` |
| `COMVIVO_DASHBOARD_BIND`, `COMVIVO_DASHBOARD_PORT`, `COMVIVO_PUBLIC_URL`, `COMVIVO_TRUST_PROXY`, `COMVIVO_BASE_PATH`, `COMVIVO_INGRESS` | `dashboard.*` (incl. `dashboard.trustProxy`, `dashboard.ingress.enabled`), `instance.publicUrl` (names per `09` §5.2) |
| `COMVIVO_LOG_LEVEL`, `COMVIVO_LOG_FORMAT` | `logging.*` |
| `COMVIVO_MODELS_PRESET`, `COMVIVO_LOCAL_BASE_URL`, `COMVIVO_LOCAL_MODEL`, `COMVIVO_SIGNAL_CLI_URL` | `models.*`, `channels.signal.*` |
| `COMVIVO_PROFILE`, `COMVIVO_HEAP_MB`, `COMVIVO_SHUTDOWN_GRACE_MS`, `COMVIVO_UPDATE_CHECK` | §3.11.2, `updates.check` |
| `COMVIVO_MODELS_PATH`, `COMVIVO_MODEL_MIRROR`, `COMVIVO_WHISPER_BIN`, `COMVIVO_FFMPEG_BIN`, `COMVIVO_SCRATCH_DIR` | model and binary locations |
| `COMVIVO_MASTER_KEY_FILE`, `COMVIVO_SETUP_TOKEN`, `COMVIVO_PLATFORM` (`docker\|home-assistant\|umbrel\|casaos\|unraid\|truenas\|native`) | `08` key path; web-setup token; doctor hints and defaults |
| `PUID`, `PGID`, `COMVIVO_ALLOW_ROOT`, `COMVIVO_ALLOW_EPHEMERAL_DATA` | entrypoint |
| Secrets: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `MATRIX_ACCESS_TOKEN`, `COMVIVO_IMAP_PASSWORD`, `COMVIVO_METRICS_TOKEN` | spine §10; names per `05` and `08` §3.10 |

### 4.5 `FORMAT`

Written atomically (`tmp/` + `rename`):
```json
{ "format": "comvivo-data-dir", "formatVersion": 1, "instanceId": "inst_01j…", "createdAt": "2026-11-01T10:00:00Z", "createdBy": "0.1.0",
  "lastBoot": { "version": "1.2.3", "schemaHead": "0057_poll_quorum", "at": "2026-11-01T10:00:05Z" }, "lastCleanShutdownAt": "2026-11-01T09:59:00Z" }
```

### 4.6 `models.lock.json`

```json
{ "schema": 1, "models": [
  { "id": "embeddings/multilingual-e5-small-q8", "kind": "embeddings", "license": "MIT", "bake": true,
    "source": { "type": "huggingface", "repo": "Xenova/multilingual-e5-small", "revision": "761b726dd34fb83930e26aab4e9ac3899aa1fa78" },
    "localPath": "hf/Xenova/multilingual-e5-small",
    "files": [ { "path": "onnx/model_quantized.onnx", "size": 118308185, "sha256": "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193" },
               { "path": "tokenizer.json", "size": 17082730, "sha256": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39" },
               { "path": "tokenizer_config.json", "size": 443, "sha256": "<computed in M6>" } ] },
  { "id": "whisper/base-q5_1", "kind": "transcription", "license": "MIT", "bake": false,
    "source": { "type": "huggingface", "repo": "ggerganov/whisper.cpp", "revision": "5359861c739e955e79d9a303bcbc70fb988958b1" },
    "localPath": "whisper",
    "files": [ { "path": "ggml-base-q5_1.bin", "size": 59707625, "sha256": "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898" } ] } ] }
```
`config.json` and `special_tokens_map.json` are added the same way in M6.

### 4.7 `release-compat.json` (embedded in `@comvivo/server` and published as a release asset)

```json
{ "version": "1.3.0", "schemaHead": "0057_poll_quorum", "knownMigrations": ["0001_init", "…", "0057_poll_quorum"],
  "dataDirFormat": 1, "minUpgradeFrom": "0.9.0", "backupFormat": { "read": [1, 2], "write": 2 }, "configSchema": 3,
  "node": ">=24.11.0", "supportedPluginSdk": "^1.0.0", "supportedChannelSdk": "^1.0.0" }
```

### 4.8 `release-manifest.json` (static; used by opt-in update checks)

```json
{ "schema": 1, "generatedAt": "2026-11-01T00:00:00Z",
  "channels": { "stable": { "version": "1.2.3", "releasedAt": "…", "notesUrl": "…", "security": false },
                "beta": { "version": "1.3.0-beta.2", "releasedAt": "…", "notesUrl": "…", "security": false } },
  "supported": { "minSupported": "1.0.0", "lts": [{ "line": "0.9", "until": "2027-12-31" }] },
  "advisories": [{ "id": "GHSA-xxxx-xxxx-xxxx", "severity": "high", "affected": "<1.2.3", "fixed": "1.2.3", "url": "…" }] }
```

### 4.9 Control channel

There is **no control socket**. All local ops calls use `09`'s Control API (`/control/v1` on the loopback main listener, bearer token from `keys/control.token`, 0600; `09` D-04, §3.5): `POST /backups {tier,label}`, `POST`/`DELETE /backups/ha-snapshot`, `POST /db/checkpoint`, `GET /status`, `POST /shutdown {drainSeconds}`. A Unix socket was rejected because it does not cross Docker Desktop's VM boundary.

---

## 5. Configuration

These are additions to spine §10; keys marked *(spine)* are unchanged.

```yaml
instance:
  dataDir: ./data                    # (spine)
  profile: default                   # default | low-memory
  timezone: null                     # tz for ops schedules; default $TZ or UTC
dashboard:
  bind: 127.0.0.1                    # (spine) the image sets 0.0.0.0 internally + host-loopback publish
  port: 7777                         # (spine)
  basePath: /                        # reverse-proxy subpath; HA ingress overrides per request
  trustProxy: false                  # false | true | CIDRs whose X-Forwarded-* headers are honored (key owned by 09 §5.1)
backups:
  enabled: true                      # (spine)
  keep: 14                           # (spine) daily snapshots
  schedule: "30 3 * * *"
  keepWeekly: 4
  keepMonthly: 6
  keepPreMigrate: 5
  dir: null                          # default <dataDir>/backups; may be another local disk
  verify: { schedule: "0 4 * * 0" }
  offsite: { command: null, timeoutSeconds: 900 }   # argv array, e.g. ["rclone","copy","{file}","b2:bkt/village/"]
  notifyUrl: null                    # heartbeat GET after success
updates:
  check: false                       # ADR-017 opt-in
  channel: stable                    # stable | beta
  manifestUrl: https://ORG.github.io/village/release-manifest.json
logging:
  level: info                        # (spine)
  format: pretty                     # (spine) json in docker
  file: { enabled: false, maxSizeMiB: 10, maxFiles: 5 }
```

Everything is validated by zod in `@comvivo/shared` (`09` owns reference generation). Platform default overrides: HA uses `backups.keep: 3`; the Docker image uses `logging.format: json`; the `low-memory` profile applies the values in §3.11.2.

---

## 6. Failure modes & edge cases

| # | Situation | Behavior |
|---|---|---|
| F1 | `/data` not mounted | refuse with 78 and a fix message (demo override available) |
| F2 | `/data` not writable / wrong owner | 78 with the exact `chown`; root mode fixes it automatically |
| F3 | Two processes on one data dir | lock; the second exits 75; stale takeover after 60 s or when the PID is dead |
| F4 | Two hosts using one bot token | adapter detects Telegram 409 and reports "another instance" (`06`); see R5 |
| F5 | Disk full | backup prunes first, then fails loudly; SQLITE_FULL → `02` degraded mode; no pre-migration backup possible → 75 and no migration |
| F6 | Migration fails | per-migration rollback → 65 → recovery mode; the pre-migration backup is referenced |
| F7 | SIGKILL during a migration or backup | migrations are atomic per step; `.partial` files are swept on boot |
| F8 | DB is newer than the build | 78; `--allow-downgrade --restore` path |
| F9 | Upgrade from too old a version | 78 with "go via bridge B" and the exact commands |
| F10 | Master key missing or wrong | 78 "key mismatch"; **never** auto-generate a key while a DB exists |
| F11 | quick_check fails | recovery mode (web + CLI) |
| F12 | Clock at 1970 / large time jump | scheduler waits for a sane clock (120 s), then starts degraded; forward jumps follow `07` (summarize instead of flooding missed reminders) |
| F13 | 32-bit Pi userspace | init and doctor explain the 64-bit OS requirement (otherwise Docker says "no matching manifest") |
| F14 | Native mode on glibc < 2.35, musl or an Intel Mac | native refused with the reason; Docker suggested |
| F15 | ORT CUDA download | prevented by `ONNXRUNTIME_NODE_INSTALL=skip` (npm 11) and the `allowScripts` default-deny (npm 12); CI asserts the files are absent |
| F16 | Model download blocked or tampered | retry → mirror → manual copy; checksum mismatch → delete and error; embeddings unavailable → FTS-only retrieval with a warning (`04`) |
| F17 | Network down at boot | server starts; `/readyz` 200; channels reconnect with backoff |
| F18 | HA `backup_pre` fails | live `db/` is still in the HA backup; restore uses the snapshot only if it is newer and verifies |
| F19 | Non-ingress source in HA mode | 403; missing `X-Ingress-Path` → base `/` |
| F20 | Offsite hook hangs | killed at the timeout and alerted; next run unaffected |
| F21 | Retired key generation needed by a backup | `backup verify` flags it; `keys purge-retired` refuses while dependencies remain (or `backup rewrap --all` first) |
| F22 | OOM (137) | restart; doctor suggests `low-memory`, swap and a heap cap |
| F23 | Config-error restart loop | Docker restart backoff with the error as the first log line; systemd stops on 78 |
| F24 | Registry outage during `update` | pull happens before stop, so nothing changes |
| F25 | Hotfix to an older minor | never moves `latest`/`X` or the npm `latest` tag |
| F26 | Partially failed release | re-runs are idempotent (§3.10.4) |
| F27 | Windows `/mnt/c` bind mount | init uses a named volume; doctor warns on 9p/drvfs |
| F28 | Appliance user without a CLI needs recovery | `/recovery` with a code from the logs |
| F29 | Sync tool on the data dir | doctor detects the markers and warns; see R2 |

---

## 7. Security & privacy

- **Container.** Non-root, read-only rootfs, `cap_drop: [ALL]`, `no-new-privileges`, Docker's default seccomp. Root mode exists only to fix ownership; it clears all capabilities and the bounding set via `setpriv` before Node starts, and the server refuses uid 0 unless `COMVIVO_ALLOW_ROOT=1`. whisper and ffmpeg parse **untrusted media**, so they run as subprocesses with a timeout (60 s + 2× audio duration), `prlimit` caps (1.5 GB address space, CPU time), file-path input only, and an FFmpeg built with `--disable-network`.
- **Secrets.** Env or `*_FILE` only (ADR-014); `.env` is 0600. Secrets never appear in `comvivo.yaml`, compose files, logs or `doctor --bundle` (redacted by allowlist). HA secrets stay in the Supervisor-managed `options.json` and are rendered only to tmpfs. Offsite hooks get a scrubbed env.
- **Exposure.** The dashboard is published on host loopback by default. Remote access is via Caddy (TLS) or tunnels, and the docs list Tailscale and SSH first. HA is ingress-only with a source-IP check; Umbrel keeps proxy auth on; unauthenticated `/healthz` is minimal. The MCP server (when enabled) is the `/mcp` path on the same port (`10` §3.7.2); hosts who want members' agents to reach it remotely without exposing the dashboard forward only `/mcp` (and `/ics/v1/*` for feeds) in their tunnel or proxy rule.
- **Backups & keys.** Archives are encrypted (`02`/`08`), so offsite targets see only ciphertext. Platform backups (HA, Umbrel, NAS snapshots) contain the key alongside the data; this is documented plainly, with a recommendation to encrypt them. The host can always read everything (spine §9, boundary 5).
- **No telemetry.** Outbound calls go only to configured providers and channels, pinned model downloads and, if opted in, the update manifest. A CI egress test behind an allowlist proxy fails on any other host.
- **Supply chain** (policy `08`). Digest-pinned bases, `--frozen-lockfile`, SHA-pinned actions. npm OIDC publishing with tokens disallowed, plus `npm audit signatures` on native installs. cosign signatures with SLSA provenance and CycloneDX SBOM attestations. A Grype gate. Renovate with a 3-day minimum release age for non-security updates. Protected environments and repo-scoped GitHub App tokens. Model files pinned by revision and SHA-256, with remote loading disabled.
- **Licensing.** FFmpeg is built **LGPL-only** (no `--enable-gpl`/`--enable-nonfree`); its configure flags, LICENSE and source tarball ship as a release asset and under `/usr/share/doc/village/third-party/`. `THIRD_PARTY_NOTICES` is generated from the SBOM.

---

## 8. Performance & cost

| Item | Budget / estimate |
|---|---|
| Image | ≤ 300 MB compressed per arch (gate); ~250 MB expected |
| Cold start (Pi 5 container, no migrations) | < 3 s to `/readyz` (spine §11.10); embeddings load lazily (~1–2 s on first use) |
| Pre-migration backup | ~10–30 s per GB on Pi 5 + NVMe, including verify; progress shown in `/healthz` |
| Release pipeline | ~25–35 min (verify ~12; images ~10 per arch in parallel when warm; whisper/ffmpeg stages cached, ~8 min cold on native arm) |
| CI cost | free GitHub-hosted runners for a public repo (including arm64); nightly smoke + matrix ≈ 60–90 runner-minutes |
| Registry | GHCR is free for public packages; edge tags pruned to 50 |
| First-run network | Docker: image only. Native: 135 MB of embeddings. First voice note: 60 MB |

---

## 9. Testing & evals (run in `11`'s CI; owned here)

| Test | Where | Asserts |
|---|---|---|
| hadolint, shellcheck, actionlint, zizmor | `ci.yml` | clean |
| `compose:validate`, `names:check` | `ci.yml` | `docker compose config -q` for every overlay combination |
| `selftest` amd64/arm64 | `ci.yml` / `release.yml` | §4.1 |
| Container contract (testcontainers + vitest) | `ci.yml` | non-root; read-only boot; F1/F2 guards; root-drop with `PUID=1234`; SIGTERM mid-turn → exit 0 in < 30 s with no duplicate sends; second signal → 130; healthcheck states; F3 lock |
| Image size gate | release, PR comment | §3.2.7 |
| Upgrade N-1 / full / dirty / downgrade / rollback | `ci.yml`, `upgrade-matrix.yml` | §3.8.6 |
| Backup ops | integration + fast-check | GFS invariants over random date sequences (newest never deleted, tier counts hold); offsite argv substitution, env scrub and timeout; a bit-flipped archive is detected; drill boots `--role=drill` |
| HA renderer | unit + property | mapping table round-trips; secrets never written to yaml; unknown options rejected |
| HA app | `platform-smoke.yml` | app linter (`frenck/action-addon-linter` or its successor) [verify M14]; install, ingress load under a base path, backup/restore round-trip |
| Base path | Playwright (`09`) | dashboard works under `/api/hassio_ingress/abc/` and `/village/`; a static scan finds no absolute asset URLs |
| Umbrel / CasaOS | `platform-smoke.yml` | manifest checks, digest pin, app_proxy wiring, CasaOS `build_dist.sh` |
| Native install | `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15` | `init --mode native --yes --from-env`; ORT CUDA files **absent**; `npm audit signatures`; simulator turn; `systemd-analyze verify` on the rendered unit |
| Docker init | `platform-smoke.yml` | `init --mode docker --yes` → `/readyz` 200 |
| Egress | `platform-smoke.yml` | allowlist proxy; only fake provider/channel hosts are contacted |
| Release dry run | `release.yml` `workflow_dispatch` | full graph with dry-run publish to `ghcr.io/ORG/village-dryrun` |
| Published artifacts | post-release | `cosign verify`, `gh attestation verify`, `npm audit signatures` |
| Runbooks | M14 manual | R1–R7 on a Pi 5 and a VPS, with timings recorded |

---

## 10. Implementation tasks

To avoid ID collisions with other docs, tasks in shared milestones use **T90+**; `14-milestones.md` may renumber them.

| ID | Task | Files | Acceptance criteria | Depends on |
|---|---|---|---|---|
| **M0-T90** | CI/release skeleton | `.github/workflows/{ci,release,edge}.yml` (stubs), `.github/actions/setup/`, `renovate.json5` (policy per `08` M0-T83), `CODEOWNERS`, `docs/architecture/release.md` | `permissions: {}`, SHA pins, actionlint and zizmor clean; `select-mode` and the version-PR path run in dry-run; Node 26 (primary, 01 §14 A1) and Node 24.11 (native support) both required green | `11` CI |
| **M0-T91** | Changesets | `.changeset/config.json`, `tools/changelog/index.mjs`, `scripts/release/{changeset-policy,changeset-required}.ts` | fixed group set; a PR touching `packages/**` without a changeset fails unless labeled; formatter grouping unit-tested | M0-T90 |
| **M0-T92** | Names manifest | `deploy/names.json`, `scripts/names/{check,apply,names-policy}.ts` | `check` fails on a planted mismatch; `apply` is idempotent; an issue is filed to reserve the npm scope, CLI/`create-` names and GHCR org (`13`) | — |
| **M0-T93** | Runtime pins | `.node-version` (26), root `engines` (`>=24.11.0`), `packageManager` (pnpm ≥ 11; installed explicitly, no Corepack), `pnpm-workspace.yaml` build allowlist exactly as `08` §3.15 (matrix crypto only; ORT denied) | a fresh install has no ORT CUDA files; `docs/architecture/native-deps.md` exists | — |
| **M1-T90** | Data-dir primitives | `packages/storage/src/datadir/{layout,format,lock,perms,fstype}.ts` | §3.7 layout and modes; atomic `FORMAT`; lock heartbeat and stale takeover tested with a fake clock; FS-type check on Linux and macOS (macOS recognises local filesystems by `statfs` type index and warns `unknown` for anything else, since there is no readable mount table and `child_process` is restricted by `08` PSC-8) | `02` M1 |
| **M3-T90** | Minimal Dockerfile | `deploy/docker/{Dockerfile,entrypoint.sh,healthcheck.mjs}`, `.dockerignore`, `scripts/docker/prune-native.mjs` | stages `base/deps/build/runtime`; tini, `USER 1000`, `/data` guard, root-drop, dispatch; amd64 and arm64 built on native runners; `selftest` covers DB and sqlite-vec; Telegram e2e passes | M1-T90, M3 server |
| **M3-T91** | Health & lifecycle | `apps/server/src/http/health.ts`, `apps/server/src/lifecycle/{boot,shutdown}.ts` | §4.2–4.3; boot steps 1–4 and 8–9; 0 duplicate sends in 20 forced restarts | `09` HTTP, `05` |
| **M3-T92** | Alpha compose | `deploy/compose/{compose.yaml,.env.example}` | a clean VM reaches `/readyz`; loopback publish; read-only rootfs | M3-T90 |
| **M3-T93** | Edge pipeline | `.github/workflows/edge.yml` | each `main` push yields a signed multi-arch `edge` and `sha-*`; `cosign verify` passes in CI | M3-T90 |
| **M6-T90** | Baked model + verified fetcher | `deploy/models/models.lock.json`, `scripts/models/fetch.mjs`, `packages/models/src/local/model-files.ts`, Dockerfile `models` stage | all SHA-256 values filled; `allowRemoteModels=false` in the image; a tampered byte fails both the build and the runtime load; size gate active | `04` |
| **M8-T90** | Upgrade engine v1 | `apps/server/src/lifecycle/{upgrade,compat}.ts`, `release-compat.json` generation | boot steps 5–7; downgrade refusal; `minUpgradeFrom` enforced; N-1 fixture test in CI | `02` backup/migrations |
| **M8-T91** | Backup ops v1 | `apps/server/src/ops/backup/{schedule,retention,verify}.ts`, CLI `backup`/`restore` | GFS property tests pass; free-space guard and alerts work; recovery-key reminder fires (§3.9) | `02`, `08` |
| **M8-T92** | 0.1 cut | — | the §3.12 alpha checklist is closed | all above |
| **M9-T90** | `init` deployment generator | `apps/cli/src/deploy/{preflight,compose-render,dotenv,native-check}.ts` | §3.4.2 end to end, including non-interactive mode, the WSL named-volume rule and armhf detection; output passes `compose config -q`; `.env` is 0600 | `09` wizard |
| **M11-T90** | whisper.cpp + ffmpeg-mini | Dockerfile `native` stage, `deploy/docker/ffmpeg.sha256`, `deploy/docker/third-party/*`, `deploy/sbom/extra-components.cdx.json` | `selftest` decodes OGG/Opus, M4A, MP3 and WebM and transcribes a 5 s clip with base-q5_1 on both arches; CPU-variant dispatch verified on AVX2 and Pi 5; size increase ≤ 20 MB; LGPL source asset produced | `05` subprocess contract (argv, timeout, prlimit) |
| **M12-T90** | npm trusted publishing | `release.yml` npm jobs | the six public packages (P11, incl. `@comvivo/evals` and `@comvivo/mcp-bridge`) are published via OIDC with provenance; tokens disallowed; no `NPM_TOKEN` exists | M0-T91, `10` SDKs, `11` evals |
| **M12-T91** | Beta channel + HA `village_beta` + Umbrel community store | subset of M14-T9/T10 | the HA and Umbrel items of the 0.5 checklist | M14-T9 design |
| **M14-T1** | Production image | `deploy/docker/*` | all §3.2.3 stages, with pruning and reproducibility; the `node:26-trixie-slim` image passes `selftest` and the upgrade matrix on amd64 and arm64 (if it fails, the documented `node:24-trixie-slim` fallback of P1 is used and the failure is recorded in STATUS.md); ≤ 300 MB; no fixable criticals | M6-T90, M11-T90 |
| **M14-T2** | Multi-arch release pipeline | `release.yml`, `scripts/release/{tags.mjs,image-size-gate.sh}` | push-by-digest and an annotated merge; immutable tags; highest-semver logic unit-tested over hotfix sequences; Docker Hub switch via `names.json` | M14-T1 |
| **M14-T3** | Signing & attestations | `release.yml` `image-sign-attest` | cosign `--recursive` on both images; provenance and SBOM (with extra components) pushed; post-release verify job green; verify commands in docs and notes | M14-T2 |
| **M14-T4** | npm distribution & native mode | `apps/cli/src/{bin.mjs,runtime/*,update/*}`, `apps/server/package.json` (`bin`, `exports["./ops"]`) | §3.4 complete; CLI no-native-deps check; `allowScripts`, ORT skip and `audit signatures`; the update check makes no request when disabled (mocked network) | M12-T90 |
| **M14-T5** | Compose variants | `deploy/compose/*`, `Caddyfile` | every overlay validates; e2e: Ollama on CPU passes a tiny-model structured-output smoke, signal-cli is reachable, Caddy with `tls internal` streams SSE, rclone copies to a local remote | M3-T92 |
| **M14-T6** | Upgrade engine v2 + recovery | `apps/server/src/lifecycle/{recovery,downgrade}.ts`, `/recovery` route (with `09`), `upgrade check` | §3.8.3–3.8.5 implemented; the rollback runbook is automated in CI | M8-T90 |
| **M14-T7** | Upgrade matrix | `fixtures/upgrade/{scenario,assertions}.yaml`, `TEST-ONLY-master.key`, `upgrade-matrix.yml` | clean and dirty fixtures for every release; §3.8.6 assertions pass; nightly green for 7 days before 1.0 | `11` harness |
| **M14-T8** | Backup ops v2 | `apps/server/src/ops/backup/*` | offsite hook with env scrub and timeout; `notifyUrl`; weekly verify; `restore --drill`; dashboard backup endpoints; recovery-key verification nudge; new job kinds registered (§12-5) | M8-T91 |
| **M14-T9** | Home Assistant app | `deploy/home-assistant/**`, `apps/server/src/platform/ha.ts`, downstream job | §3.5 complete; ingress listener on 8099, base path and pairing-code linking of HA users (`09` §3.9.10; unlinked headers never authenticate); hot-backup round-trip on HAOS; AppArmor complain → enforce with no denials; linter green; DOCS.md and translations; watchdog verified | M14-T2, `09` |
| **M14-T10** | Umbrel, CasaOS, Unraid, TrueNAS | `deploy/{umbrel,casaos,unraid,truenas}/` → mirror repos | installs verified on umbrelOS, ZimaOS and Unraid VMs and on TrueNAS 25.10 via YAML; token-based web setup works without a CLI; the bot bumps versions and digests | M14-T2, `09` setup page |
| **M14-T11** | systemd & launchd | `deploy/systemd/village.service`, `deploy/launchd/*.plist`, `apps/cli/src/service/*` | `systemd-analyze verify` clean and `security` exposure ≤ 2.5; start, stop and drain verified on Ubuntu 24.04, Pi OS 64-bit and macOS 15 | M14-T4 |
| **M14-T12** | Channels, hotfix, notes, downstream, manifest | `tools/release/{notes.ts,dist-tag.mjs,manifest.ts}`, checklist templates | beta and edge rehearsed; a hotfix on `release/0.N` doesn't move `latest`; manifest published; notes include upgrade notes and verify blocks | M14-T2, M14-T3 |
| **M14-T13** | Ops docs & runbooks | `apps/docs/src/content/docs/ops/*`, `runbooks/R1–R7.md` | each runbook dry-run by a non-author on a Pi 5 and a VPS; commands work copy-paste | `13` docs site |
| **M14-T14** | Sizing & profiles | — | measurements on Pi 5 4/8 GB, a 1 GB VPS, an x86 NAS and a Mac mini replace the §3.11.1 estimates; idle RSS ≤ 300 MB; `low-memory` survives a 24 h soak on 1 GB | `11` perf |
| **M14-T15** | Release-readiness gate | environment rules, checklist automation | a stable publish is blocked while the checklist is open; the 1.0 checklist is complete | M14-T12 |

---

## 11. Open questions (recommended default in **bold**)

| # | Question | Default |
|---|---|---|
| Q1 | Final names, now that npm `village` is taken? | **Owner decision D-2 (01 §14 A2; deadline M8 exit).** Recommendation: choose a name whose unscoped npm package, npm scope, GitHub org and GHCR namespace are all free; otherwise ship `npm create <name>@latest` + `@<scope>/cli` |
| Q2 | Docker Hub mirror? | **Apply to Docker-Sponsored OSS at 0.5; mirror only if accepted** |
| Q3 | Image Node version at 1.0? | **Resolved (01 §14 A1):** Node 26 LTS (`node:26-trixie-slim`), falling back to 24 only if M14-T1 fails; native `engines >=24.11` |
| Q4 | Trust HA ingress user headers for auth? | **Resolved (01 §14 A9):** never trust headers alone; each HA user is linked once via a bot pairing code (or the host claim code while unclaimed) (§3.5, `09` §3.9.10) |
| Q5 | Bake the embedding model (+135 MB)? | **Yes. Revisit if the image exceeds 300 MB or `04` moves to a bigger default (bge-m3 q8 ≈ 570 MB → download on first run)** |
| Q6 | Local transcription in native mode? | **Require `whisper-cli`/`ffmpeg` on PATH, else API. Ask `05` to evaluate transformers.js Whisper (reuses ORT) as a binary-free fallback** |
| Q7 | ffmpeg-mini vs Debian `ffmpeg`? | **ffmpeg-mini. Renovate tracks FFmpeg; rebuild for security fixes within 7 days** |
| Q8 | Bundle rclone? | **No. Use the argv hook + sidecar** |
| Q9 | Sign `release-manifest.json`? | **Not in 1.0 (advisory only, TLS). Revisit if auto-update is ever added** |
| Q10 | LTS length? | **12 months for the previous major's last minor** |
| Q11 | Official Umbrel/CasaOS store timing? | **Community stores at 0.5; official PRs after 1.0** |
| Q12 | HA edge app? | **No** |
| Q13 | Publish `@comvivo/mcp`? | **No. Publish a stdio bridge only if `10` finds demand** |
| Q14 | npm edge cadence? | **Nightly, only if HEAD changed** |
| Q15 | Distroless later? | **Revisit after 1.0 with a Node entrypoint using `process.setuid`; HA stays on Debian** |
| Q16 | Umbrel port 7777 already taken? | **Pick a free port at submission** |

---

## 12. Proposed spine changes

1. **ADR-001 Node.** Node 24 entered **Maintenance LTS on 2026-10-20**, and Node 26 became **Active LTS on 2026-10-28**. Proposal: "Node.js LTS ≥ 24.11; the Docker image runs the newest Active LTS (Node 26 at 1.0)". Low risk: every native dependency is N-API (better-sqlite3-mc v13, ORT napi-v6, matrix crypto) or ABI-free (sqlite-vec), and EOL moves from 2028-04 to 2029-04. **→ Resolved: 01 §14 A1** (base `node:26-trixie-slim`, fallback `node:24-trixie-slim`).
2. **Install command** (`00` §3.7, ADR-015). The unscoped npm package `village` is taken, so `npx village@latest init` cannot ship under the codename. `13`'s naming check must cover unscoped npm availability; otherwise the documented command becomes `npm create <name>@latest`. **→ Resolved: 01 §14 A2** (placeholder until owner decision D-2).
3. **Package split** (§3/§4). Publish a **thin `village` CLI** and a public **`@comvivo/server`** runtime; internal packages stay private and bundled. Add to §4: "apps/cli imports `@comvivo/server/ops` types only; runtime resolution is dynamic". The public npm set is `village`, `@comvivo/server`, `@comvivo/plugin-sdk` and `@comvivo/channel-sdk`. **→ Resolved: 01 §14 A2** (thin CLI + public server runtime); A17 adds `@comvivo/evals` to the public set (P11).
4. **Repo layout** (§3 `deploy/`). Use `compose.yaml` plus overlays; add `deploy/{unraid,truenas,launchd,models,sbom}/` and `deploy/names.json`. HA terminology is now **"apps"**, and `deploy/home-assistant` is mirrored to its own repo. ADR-015 gains the `village-ha` image and GHCR as the canonical registry. **→ Accepted, owned here** (ADR-015 already says HA "apps"; the `deploy/` layout is specified in this document).
5. **Jobs** (§6.4). Add `backup.verify` (weekly) and `backup.offsite` (after a snapshot; retryable). `backup.snapshot` uses GFS retention per `12` §3.9. **→ Accepted, owned here** (02 registers the job kinds; M14-T8).
6. **ADR-014: secrets for appliance web setup.** Umbrel and CasaOS have no CLI and no secret UI. Allow a master-key-encrypted `keys/secrets.enc` (format by `08`) as a secret source, with precedence **below** real env. "Secrets never in DB or YAML" still holds. **→ Resolved: 01 §14 A29.** Format and key derivation in `08` §3.10 (vault-key AEAD container, AAD-separated); UI in `09` D-29 and `/setup` (token-gated, then host step-up); env and the platform's options UI still take precedence.
7. **Config** (§10). Add `instance.{profile,timezone}`, `dashboard.{basePath,trustedProxies}`, `backups.{schedule,keepWeekly,keepMonthly,keepPreMigrate,dir,verify,offsite,notifyUrl}`, `updates.*` and `logging.file`. §9 should state that containers bind `0.0.0.0` internally and publish on host loopback, which is equivalent to the 127.0.0.1 default. **→ Accepted, owned here** (config keys in §5; `dashboard.trustedProxies` is renamed to `09`'s `dashboard.trustProxy`).
8. **Process** (§8). Add `--role=drill`, recovery mode, the exit-code contract (§4.2), the instance lock, and "never auto-generate a master key while a DB exists". tini forwards SIGTERM to Node only, and Node stops its own children. **→ Resolved: 01 §14 A15** (exit-code contract and `--role=drill`); the instance lock and recovery mode are **accepted, owned here**.
9. **Transcription** (§2.1). "Local whisper (whisper.cpp)" means the **`whisper-cli` binary run as a subprocess** plus a decode-only FFmpeg, not a Node binding. **→ Resolved: 01 §14 A19.**
10. **ADR-017.** Specify the update check: opt-in, a static manifest, a generic User-Agent, no identifiers. `backups.notifyUrl` and offsite hooks are host-configured egress, not telemetry. **→ Accepted, owned here** (generic User-Agent; 08 §3.16.3 aligned; the manifest is hosted on GitHub Pages with no request logs, §3.1).

---

## Sources (verified 2026-11-01)

- **Node.js:** https://github.com/nodejs/Release/blob/main/schedule.json · https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule
- **Base images:** https://hub.docker.com/_/node · https://wiki.debian.org/DebianReleases · https://github.com/GoogleContainerTools/distroless/blob/main/nodejs/README.md
- **Native deps:** https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/tag/v13.0.3 · https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0 · https://github.com/asg017/sqlite-vec/releases · https://registry.npmjs.org/sqlite-vec · https://www.npmjs.com/package/onnxruntime-node (1.30.0 tarball inspected: bundled binaries, CUDA postinstall, `ONNXRUNTIME_NODE_INSTALL`) · https://www.npmjs.com/package/@huggingface/transformers
- **Models & whisper.cpp:** https://huggingface.co/Xenova/multilingual-e5-small · https://huggingface.co/ggerganov/whisper.cpp · https://github.com/ggml-org/whisper.cpp/releases
- **Home Assistant apps:** https://contributors.home-assistant.io/apps/reference/configuration/ · https://contributors.home-assistant.io/apps/guides/ingress/ · https://contributors.home-assistant.io/apps/guides/options/ · https://contributors.home-assistant.io/apps/guides/repository/ · https://contributors.home-assistant.io/apps/guides/publishing/ · https://contributors.home-assistant.io/apps/guides/security/ · https://contributors.home-assistant.io/apps/reference/environment/ · https://contributors.home-assistant.io/apps/guides/presentation/ · https://contributors.home-assistant.io/apps/guides/dockerfile/ · https://www.home-assistant.io/blog/2026/02/04/release-20262/ · https://github.com/home-assistant/builder (`io.hass.type=app`)
- **Other platforms:** https://github.com/getumbrel/umbrel-apps (AGENTS.md, `.agents/skills/umbrel-package-app`) · https://github.com/getumbrel/umbrel-community-app-store · https://github.com/IceWhaleTech/CasaOS-AppStore/blob/main/docs/specs/compose-and-x-casaos.md · https://ca.unraid.net/submit/help/repository-xml · https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/installcustomappscreens/ · https://apps.truenas.com/managing-apps/installing-custom-apps/
- **CI & signing:** https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/ · https://github.com/sigstore/cosign/blob/main/CHANGELOG.md · https://github.com/actions/attest · https://github.com/actions/attest-build-provenance
- **npm & release tooling:** https://docs.npmjs.com/trusted-publishers · https://github.com/npm/cli/blob/latest/CHANGELOG.md (v12 `allowScripts`) · https://github.com/changesets/changesets/blob/main/packages/cli/CHANGELOG.md · https://github.com/changesets/action · https://github.com/googleapis/release-please
- **Misc:** https://docs.docker.com/docker-hub/usage/pulls/ · https://github.com/bbernhard/signal-cli-rest-api · https://www.npmjs.com/package/village (name taken)
