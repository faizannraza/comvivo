#!/usr/bin/env bash
#
# Prose style, if Vale is available.
#
# Same pattern as actionlint and shellcheck in `scripts/hygiene/check.ts`: used when present,
# reported as **skipped** when not — never silently as clean. A contributor on macOS installs it
# with `brew install vale`; CI installs it pinned and checksum-verified
# (`scripts/ci/install-vale.sh`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if ! command -v vale > /dev/null 2>&1; then
  echo "prose: vale not installed locally; it runs in the \`docs\` CI job."
  exit 0
fi

# The documentation site plus the community files. `docs/plan/**` is excluded in `.vale.ini` —
# it is an engineering document, not product prose.
vale apps/docs README.md CONTRIBUTING.md GOVERNANCE.md MAINTAINERS.md SECURITY.md SUPPORT.md docs/security
