# Native dependencies and the install-script policy

Why each native module is here, which install scripts are allowed to run, and what gets pruned
from the image. Specification: `docs/plan/08-security-privacy.md` §3.15 (supply chain) and
`docs/plan/12-packaging-release-ops.md` §3.2.2 (the native matrix). The enforceable version of
this document is `pnpm-workspace.yaml`; `scripts/supply/check-native.ts` checks the parts a YAML
file cannot express.

## The rule

`strictDepBuilds` is on, so **a dependency with an install script that is not named in
`allowBuilds` fails the install**. It does not silently skip the script and leave a half-built
package — which is how native-module problems usually reach users, as a runtime crash three weeks
later.

`allowBuilds` is a map, not a list: `true` permits the script, `false` denies it explicitly. Both
are deliberate statements. An unlisted package is neither, and that is an error.

`onlyBuiltDependencies`, `neverBuiltDependencies`, `ignoredBuiltDependencies` and
`ignoreDepScripts` were **removed** in pnpm 11 (`01` §14 A31). If you find them in a tutorial, it
predates the change.

## The matrix

Versions re-verified 2026-11-01. `12` §3.2.2 is the authority; this table adds the install-script
decision and the arrival milestone.

| Dependency | Version | Install script | Decision | Why |
|---|---|---|---|---|
| `better-sqlite3-multiple-ciphers` | 13.0.3 (SQLite 3.53.4, SQLite3MC 2.4.0) | none | not listed | Ships bundled N-API prebuilds for amd64, arm64 and musl. Nothing to build. Arrives **M1**. |
| `sqlite-vec` | 0.1.9 | none | not listed | A loadable SQLite extension, so ABI-free; delivered as per-platform optional dependencies. Arrives **M1**. |
| `libsodium-wrappers` | 0.8.4 | none | not listed | WASM, so no build and no platform matrix. The `sodium-native` alternative *would* need a build; `01` §14 A8 only switches to it if the M1 spike measures secretstream below 40 MB/s on a Pi 5. Arrives **M1**. |
| `onnxruntime-node` (via `@huggingface/transformers` 4.3.2 → ORT 1.30.0) | 1.30.0 | **downloads the CUDA 12 EP from NuGet** | **`false` — denied** | The script fetches roughly 190 MB of GPU runtime from outside the npm registry, on a product that runs embeddings on CPU by design (ADR-007). ORT already ships the CPU binaries inside the package, so denying it costs nothing and removes a non-registry download from the install path. `ONNXRUNTIME_NODE_INSTALL=skip` is set in CI and in the image as a second layer. Arrives **M6**. |
| `@matrix-org/matrix-sdk-crypto-nodejs` | 0.6.x | downloads the prebuilt Rust crypto binary | **`true` — allowed** | There is no bundled alternative and Matrix E2EE does not work without it. This is the one runtime install script the project accepts, and it is why `allowBuilds` exists rather than a blanket deny. Arrives **M10**. |
| `sharp` | 0.35.x | none | not listed | Optional platform packages, no script. Arrives **M11**. |
| `esbuild` | 0.28.x | links the prebuilt platform binary | **`true` — allowed** | Dev-only, reached through `vite` and `tsx`. Its postinstall links the binary that ships as an optional dependency; without it the bundler cannot start. Never shipped to users. **An addition to `08` §3.15's original list** — see `STATUS.md` → Plan changes. |
| `whisper.cpp` (`whisper-cli`) | v1.9.5, commit-pinned | n/a — not an npm package | built in the image's `native` stage | `01` §14 A19. Native installs need it on `PATH` or an API provider. Arrives **M11**. |
| FFmpeg (decode-only) | latest 8.x, SHA-256 + GPG verified | n/a | built in the image's `native` stage | Needed to normalise voice notes before transcription. Arrives **M11**. |

**Known platform gap:** ORT 1.30 ships no `darwin/x64` binary, so Intel Macs must use Docker or API
embeddings. This is documented in the install guide rather than worked around.

## Pruning

The image prunes what the platform cannot use, because a 190 MB GPU runtime on a Raspberry Pi is
not a rounding error:

- ORT: drop `win32/`, `darwin/` and the non-target architecture (~190 MB).
- `better-sqlite3-multiple-ciphers`: keep only the target platform's prebuild.
- `sharp`: keep only the target platform's optional package.

## Runtime pins

| Pin | Value | Where | Why |
|---|---|---|---|
| Node, primary | **26.13.0** ("Lithium", Active LTS since 2026-10-28) | `.node-version` holds `26`; CI and the image pin the exact version | `01` §14 A1. The only line that satisfies both `--allow-net` (Node ≥ 25) and every tool's `engines`. |
| Node, supported | **≥ 24.11.0** (currently 24.22.2, "Krypton") | `engines.node`, the CI `node24` leg | Native installs. `01` §14 A1. |
| Node 25 | **excluded** | — | End-of-life, *and* excluded by the `engines` fields of `tsdown`, `vitest`, `dependency-cruiser` and `@changesets/cli`. |
| pnpm | **12.16.1** | `devEngines.packageManager` + `packageManager`, with `pmOnFail: error` | Corepack is not bundled from Node 25 onward; pnpm does its own version switching (`01` §14 A31). |
| TypeScript | **6.0.3, exact** | root `devDependencies`, catalog | `typescript-eslint` cannot run on TypeScript 7 — [ADR-025](../adr/ADR-025-typescript-version-pin.md). |

## A note on `--allow-net`

`01` §14 A1 reads `--allow-net` as the plugin network-isolation mechanism. Verified on Node 26, the
flag is **boolean and all-or-nothing, with no host or port scoping** (per-host scoping is
proposal-only, nodejs/node#67115). So invariant **I5 (guarded egress)** rests on `shared/net`'s
`safeFetch` allowlist on *every* Node version, and `--allow-net` is only a coarse second layer that
Node 24 happens to lack. Recorded as `01` §14 A31.
