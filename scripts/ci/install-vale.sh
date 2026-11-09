#!/usr/bin/env bash
#
# Install Vale, pinned by version and verified by checksum.
#
# Same reasoning as `install-actionlint.sh`: Vale is a Go binary with no npm distribution, and
# downloading an unverified one would undo the SHA-pinning discipline in `08` §3.15 for one linter.
# The repository moved from `errata-ai/vale` to `vale-cli/vale` (`01` §14 A31).
#
# The style packages (Microsoft, write-good) are **vendored** in `.vale/styles/` rather than fetched
# with `vale sync`, so CI needs no network for them and an upstream rule change arrives as a
# reviewable diff instead of a surprise failure. To upgrade them: `vale sync`, then read the diff.
#
# To upgrade Vale: bump VERSION and replace both checksums from
#   https://github.com/vale-cli/vale/releases/download/v<VERSION>/vale_<VERSION>_checksums.txt
set -euo pipefail

VERSION="3.26.0"
SHA256_LINUX_AMD64="22aa69a556558e4a9dfc63c17030777383d8d3c48dcdfad655fa98e839d666ed"
SHA256_LINUX_ARM64="3154179f4611140c9af54a8b3bc6a90bc02b73fe6c1f635369604dde0490406d"

DEST="${1:-/usr/local/bin}"

case "$(uname -m)" in
  x86_64 | amd64) asset="Linux_64-bit"; expected="$SHA256_LINUX_AMD64" ;;
  aarch64 | arm64) asset="Linux_arm64"; expected="$SHA256_LINUX_ARM64" ;;
  *) echo "install-vale: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

if [ "$(uname -s)" != "Linux" ]; then
  echo "install-vale: only Linux is pinned here; on $(uname -s) use your package manager." >&2
  exit 1
fi

archive="vale_${VERSION}_${asset}.tar.gz"
url="https://github.com/vale-cli/vale/releases/download/v${VERSION}/${archive}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "install-vale: downloading ${archive}"
# Same retry shape as `install-actionlint.sh`, and for the same measured reason: without
# `--retry-all-errors`, curl retries connection-level failures and **not** an HTTP 5xx — so
# `--retry 3` alone did nothing for the release-CDN 504 that killed the rename drill on
# 2026-11-09. Fixed in both scripts together, because the next transient would have hit whichever
# one was left.
curl --fail --silent --show-error --location \
  --retry 6 --retry-all-errors --retry-max-time 120 \
  --max-time 180 \
  --output "${work}/${archive}" "$url"

actual="$(sha256sum "${work}/${archive}" | cut -d' ' -f1)"
if [ "$actual" != "$expected" ]; then
  echo "install-vale: CHECKSUM MISMATCH for ${archive}" >&2
  echo "  expected ${expected}" >&2
  echo "  actual   ${actual}" >&2
  echo "Refusing to install." >&2
  exit 1
fi
echo "install-vale: checksum ok (${actual})"

tar -xzf "${work}/${archive}" -C "$work" vale
install -m 0755 "${work}/vale" "${DEST}/vale"
"${DEST}/vale" --version
