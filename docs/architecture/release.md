# Release engineering

How a Comvivo release is cut, and what exists today.

Specs: `12` §3.10.4 (the workflow graph), `11` §3.8.1–§3.8.3 (CI and required checks), `08` §3.15
(supply-chain hardening). Skeleton built in `M0-T11`.

## What exists today

| Workflow | Status at M0 | Completed by |
|---|---|---|
| `ci.yml` | **Complete for the M0 tree**: `static`, `unit` ×3 shards, `integration`, `coverage`, `build`, `node24`, `ci-ok` | jobs added per milestone; `11` §3.8.2 has the full list |
| `release.yml` | **Front half**: `mode` (select-mode) runs for real, `version-pr` runs in dry-run | M0-T14 (changesets), M12 (image, npm), M14 (repro, Grype gate) |
| `edge.yml` | Verifies `main` is releasable; publishes nothing | M12 |

`ci.yml`'s job list grows; branch protection names only **`ci-ok`**, so adding a job never needs a
repository-settings change. `ci-ok` audits `needs` explicitly rather than relying on `needs`
alone — with `if: always()` and no audit, a skipped or cancelled dependency leaves the aggregator
green, which is the one failure mode that makes a required check worthless.

## Hardening, and why each rule is there

From `08` §3.15, enforced by `scripts/hygiene/workflow-policy.ts` on every PR:

- **`permissions: {}` at the top of every workflow**, with each job granting what it needs. Without
  it a job inherits the repository default, which is often write. Starting from nothing means the
  diff that grants `contents: write` is something a reviewer sees.
- **Every third-party action pinned to a full 40-character commit SHA.** A tag is mutable: `@v4`
  means "whatever that repository calls v4 today", so whoever controls it controls what runs in our
  CI, with our token, without appearing in our history. Renovate proposes the bumps (`M0-T13`).
- **No `pull_request_target`.** It runs with a writable token in the base repository's context while
  checking out a fork's code.
- **`timeout-minutes` on every job.** The default is six hours; a hung job holds the merge queue.
- **No attacker-controlled `github.event` field interpolated into `run:`.** A PR title is user
  input, and `run: echo ${{ github.event.pull_request.title }}` executes it as shell.

`release.yml` holds **no** `packages: write`, no `id-token`, and no registry credential of any kind.
That is the property worth keeping while the rest of the graph is built: a mistake in it today
cannot publish anything.

## actionlint

actionlint has no npm distribution, and `rhysd/actionlint` ships no `action.yml`. The two usual
routes are a third-party wrapper action (`reviewdog/action-actionlint`, which brings reviewdog's
whole toolchain and wants a token to post reviews) or piping the project's install script from curl
into bash.

Neither fits a repository that pins every action to a SHA for supply-chain reasons, so
`scripts/ci/install-actionlint.sh` downloads the pinned release and **verifies its SHA-256 against
a checksum committed here**, refusing to install on a mismatch. Upgrading means bumping the version
and replacing both checksums from the release's own `checksums.txt`.

actionlint and our policy check are complementary and neither replaces the other: actionlint
validates syntax, expressions and runner labels; `workflow-policy.ts` covers what a compromised
dependency could do with our token, which actionlint has no opinion about.

## Sharding, coverage and a trap worth knowing

`unit` runs in three shards. Two things about that are not obvious, and both were found by running
it rather than by reading:

1. **A shard cannot meet whole-tree coverage thresholds.** Each one runs a third of the files and
   legitimately covers a third of the code, so with thresholds on, all three shards exit 1. The
   shards therefore set `COMVIVO_COVERAGE_THRESHOLDS=off` and the `coverage` job enforces them once
   over the merged reports.
2. **A configured `blob` reporter makes `--merge-reports` impossible.** Vitest refuses with
   "Cannot merge reports when `--reporter=blob` is used. Remove blob reporter from the config
   first." So `blob` is passed on the sharded command and is deliberately absent from
   `vitest.config.ts`.

The `coverage` job downloads every blob — three from `unit`, one from `integration` — and merges
them, which is the only run that sees the whole suite at once.

## The full release graph

Not built yet. From `12` §3.10.4:

```
mode (select-mode) ─► version-pr                                               [mode=version]
                   └► verify (ci.yml) ─► image[amd64|arm64] ─► image-merge ─► image-sign-attest ─┐
                                     └► npm-pack ─► npm-publish (env npm, id-token) ─────────────┴►
                                        fixtures ─► github-release ─► downstream ─► docs-deploy
```

Properties to preserve when it is built:

- `build-reusable.yml` is called rather than inlined, which is what earns **SLSA Build L3**.
- npm publishing uses a **trusted publisher** with `id-token: write` and **no `NPM_TOKEN`
  anywhere**, so there is no long-lived credential to leak. One-time setup is `M12-T90`, and the
  first publish must happen within two days of configuring it.
- Images are signed keyless with cosign, provenance and an SBOM are attested, and Grype fails the
  release on a critical vulnerability that has a fix available.
- Pre-1.0 releases go out as prereleases; 1.0 is the first final release.
