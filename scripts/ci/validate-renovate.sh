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

# Skipping is a local convenience, never a CI outcome.
#
# Both branches below used to `exit 0` unconditionally, with a comment pointing at the
# `supply-policy` CI job — and that job runs *this same script*, so the redirect was circular. The
# effect was that `pnpm verify` reported green having validated nothing on any machine without
# Docker, and would have done the same on a runner image that stopped shipping it. `CI` is set by
# every GitHub Actions runner, so there the absence of Docker is a failure to fix rather than a
# condition to report. Found by the M0 independent review.
missing_docker() {
  if [ -n "${CI:-}" ]; then
    echo "renovate: $1 — and CI is set, so this check cannot be skipped." >&2
    echo "renovate: the runner image must provide a working Docker daemon." >&2
    exit 1
  fi
  echo "renovate: $1; skipped locally. CI validates it for real."
  exit 0
}

if ! command -v docker > /dev/null 2>&1; then
  missing_docker "docker is not installed"
fi

if ! docker info > /dev/null 2>&1; then
  missing_docker "docker is installed but not running"
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

# The validator is proven to reject before its verdict on the real file is believed.
#
# `STATUS.md` recorded that it had been shown to exit 1 on a planted config "with an invalid cron
# and a wrong-typed minimumReleaseAge" — but that was a one-off manual run with nothing committed,
# so an edit that neutered the invocation (passing the path explicitly, which validates as a
# *global* config and accepts a different key set — the exact mistake this script's comment above
# documents) would be caught by nothing. Found by the M0 independent review.
BAD="$(mktemp -d)/renovate.json5"
trap 'rm -rf "$(dirname "$BAD")"' EXIT
cat > "$BAD" <<'BADCONFIG'
{
  schedule: ['not a real schedule'],
  minimumReleaseAge: 3,
  thisKeyDoesNotExist: true,
}
BADCONFIG

if docker run --rm --network none \
  -v "${BAD}:/work/renovate.json5:ro" \
  -w /work \
  "$IMAGE" \
  renovate-config-validator --strict > /dev/null 2>&1; then
  echo "renovate: the validator accepted a config with an invalid schedule, a wrong-typed" >&2
  echo "renovate: minimumReleaseAge and an unknown key. It is not validating anything, so its" >&2
  echo "renovate: verdict on renovate.json5 means nothing. Check the invocation above." >&2
  exit 1
fi

echo "renovate: config valid (renovate ${VERSION}, --strict, as repository config;"
echo "renovate: validator confirmed to reject a planted bad config)."
