#!/usr/bin/env bash
#
# Install actionlint, pinned by version and verified by checksum.
#
# actionlint has no npm distribution and `rhysd/actionlint` ships no `action.yml`, so the choices
# were a third-party wrapper action, piping the project's install script from curl into bash, or
# this. `08` §3.15 pins every action to a SHA to stop a mutable reference deciding what runs in our
# CI; downloading an unverified binary over the same trust boundary would undo that for one linter.
#
# `reviewdog/action-actionlint` is the usual wrapper and would work, but it brings reviewdog's whole
# toolchain and wants a token to post reviews — a much larger surface than the one tool we want.
#
# To upgrade: bump VERSION, then replace both checksums with the values from
#   https://github.com/rhysd/actionlint/releases/download/v<VERSION>/actionlint_<VERSION>_checksums.txt
# Never take the checksum from anywhere else, and never skip it.
set -euo pipefail

VERSION="1.7.12"
SHA256_LINUX_AMD64="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
SHA256_LINUX_ARM64="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"

DEST="${1:-/usr/local/bin}"

case "$(uname -m)" in
  x86_64 | amd64) arch="amd64"; expected="$SHA256_LINUX_AMD64" ;;
  aarch64 | arm64) arch="arm64"; expected="$SHA256_LINUX_ARM64" ;;
  *) echo "install-actionlint: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

if [ "$(uname -s)" != "Linux" ]; then
  # Only the Linux checksums are pinned, because that is what the runners are. A developer on
  # macOS gets the "not installed locally" path in `scripts/hygiene/check.ts`, which is honest.
  echo "install-actionlint: only Linux is pinned here; on $(uname -s) use your package manager." >&2
  exit 1
fi

archive="actionlint_${VERSION}_linux_${arch}.tar.gz"
url="https://github.com/rhysd/actionlint/releases/download/v${VERSION}/${archive}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "install-actionlint: downloading ${archive}"
curl --fail --silent --show-error --location --retry 3 --output "${work}/${archive}" "$url"

actual="$(sha256sum "${work}/${archive}" | cut -d' ' -f1)"
if [ "$actual" != "$expected" ]; then
  echo "install-actionlint: CHECKSUM MISMATCH for ${archive}" >&2
  echo "  expected ${expected}" >&2
  echo "  actual   ${actual}" >&2
  echo "Refusing to install. Either the release was re-cut or the download was tampered with." >&2
  exit 1
fi
echo "install-actionlint: checksum ok (${actual})"

tar -xzf "${work}/${archive}" -C "$work" actionlint
install -m 0755 "${work}/actionlint" "${DEST}/actionlint"
"${DEST}/actionlint" --version
