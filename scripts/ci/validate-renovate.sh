#!/usr/bin/env bash
#
# Validate `renovate.json5` with Renovate's own validator, in Renovate's own image, pinned by
# digest.
#
# Why a container rather than a devDependency: `pnpm add -Dw renovate` is **refused by our own
# supply-chain policy**. `trustPolicy: no-downgrade` in `pnpm-workspace.yaml` rejects it with
# "High-risk trust downgrade for @yarnpkg/libzip@3.2.2 (possible package takeover)" — a transitive
# dependency of a transitive dependency, five levels from anything we asked for.
#
# That is the policy working, not an obstacle to route around. The two bad answers would be to add
# a trust exception (weakening a control that exists to stop exactly the chalk/debug and
# Shai-Hulud class of attack, in order to install a convenience tool) or to `pnpm dlx` it (which
# bypasses the lockfile, the trust policy and `minimumReleaseAge` all at once, quietly).
#
# A container is the honest answer: the tool runs, pinned by digest, with `--network none` and a
# single read-only file mounted, and it never enters our dependency graph at all.
#
# To upgrade: pick a release at least three days old, `docker pull` it, and replace both the tag
# and the digest below with what `docker inspect --format '{{index .RepoDigests 0}}'` reports.
set -euo pipefail

VERSION="44.198.3"
DIGEST="sha256:bf344aa39d5b592ec728e1db5c3e1d940a5093a89a4598073efcb18d592d121c"
IMAGE="ghcr.io/renovatebot/renovate@${DIGEST}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="${ROOT}/renovate.json5"

if [ ! -f "$CONFIG" ]; then
  echo "renovate: ${CONFIG} is missing." >&2
  exit 1
fi

if ! command -v docker > /dev/null 2>&1; then
  echo "renovate: docker not available; the config is validated in the \`supply-policy\` CI job."
  exit 0
fi

if ! docker info > /dev/null 2>&1; then
  echo "renovate: docker is installed but not running; the config is validated in CI."
  exit 0
fi

# No args: with the file mounted as the working directory's `renovate.json5`, the validator treats
# it as a **repository** config. Passing the path explicitly makes it validate as a *global*
# config instead, which accepts a different set of keys and would quietly approve a repo config
# that Renovate then rejects at run time.
#
# `--network none` because validation is offline, and a linter has no business making requests.
docker run --rm --network none \
  -v "${CONFIG}:/work/renovate.json5:ro" \
  -w /work \
  "$IMAGE" \
  renovate-config-validator --strict

echo "renovate: config valid (renovate ${VERSION}, --strict, as repository config)."
