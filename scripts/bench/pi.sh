#!/usr/bin/env bash
#
# The Raspberry Pi 5 benchmark session (owner ask H-10 in `docs/plan/STATUS.md`).
#
# Everything `02` §3.6.3 step 10 and `02` §3.16.4 specify on a Pi, in one command, printing a
# markdown report to paste back. It installs nothing outside this clone, needs no credentials, and
# makes no network request beyond `pnpm install`.
#
#   git clone https://github.com/faizannraza/comvivo && cd comvivo
#   ./scripts/bench/pi.sh
#
# Why this exists: `00` §3.7 promises Comvivo runs on a Raspberry Pi, and three M1 decisions turn
# on whether it actually does — whether the encrypted-SQLite stack loads on arm64 Linux (SP-1),
# whether the backup cipher is fast enough to be the default rather than a flag (SP-2, threshold
# 40 MB/s), and whether the `02` §3.16.4 query budgets hold on the slowest machine we claim to
# support. Getting those wrong is expensive later: the first is a dependency choice, the second a
# default, the third a published promise.
set -euo pipefail

cd "$(dirname "$0")/../.."

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "Environment"
printf '  uname:  %s\n' "$(uname -srm)"
printf '  model:  %s\n' "$(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo 'not a device-tree system')"
printf '  node:   %s\n' "$(node --version 2>/dev/null || echo 'MISSING')"
printf '  pnpm:   %s\n' "$(pnpm --version 2>/dev/null || echo 'MISSING')"
printf '  memory: %s\n' "$(awk '/MemTotal/ {printf "%.1f GiB", $2/1048576}' /proc/meminfo 2>/dev/null || echo unknown)"

if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  cat <<'NEED'

  Node 26 (or ≥ 24.11) and pnpm are needed first. The official tarball is the reliable route on
  Raspberry Pi OS:

    curl -fsSLO https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-arm64.tar.xz
    mkdir -p ~/.local/node && tar -xJf node-v26.13.0-linux-arm64.tar.xz -C ~/.local/node
    export PATH="$HOME/.local/node/node-v26.13.0-linux-arm64/bin:$PATH"
    npm install -g pnpm

NEED
  exit 2
fi

say "Installing (prebuilt binaries only; no compiler needed)"
pnpm install --frozen-lockfile

say "SP-1: does the encrypted stack load and work on this machine?"
# The spike suite is the SP-1 answer: encryption, WAL canaries, vec0, FTS5, Drizzle, crash
# recovery and worker connections. A failure here is the one that blocks arm64 Linux.
pnpm -w exec vitest run --project integration packages/storage/spike

say "SP-2 and the SQLCipher matrix: the spike's own numbers"
pnpm -F @comvivo/storage bench:storage

# `02` §3.16.4's rows, on the fixture the budgets are stated over. Two runs, because the table has
# two KNN rows and a vec0 partition key *is* the group: `stress-50k-1m` holds 30k vectors in its
# largest partition and `knn-50k` holds 50k in one.
#
# **Deliberately not `--gate`.** The budgets declared on the benchmarks are the *reference-runner*
# column; `02` §3.16.4's Pi column is still an estimate and `11` §3.9.4 gates the Pi through the
# signed attestation rather than through this script. A gate here would fail for the wrong reason
# and teach everyone to pass `--no-verify`. `--profile pi` labels every result as a Pi measurement,
# so it can never be mistaken for a reference one in the trend.
say "02 §3.16.4: the storage latency rows (1M messages / 50k memories)"
COMVIVO_BENCH_PROFILE=stress-50k-1m pnpm bench --filter storage/bench --profile pi \
  --out pi-storage.json --summary pi-storage.md

say "02 §3.16.4: the second KNN row (50k vectors in one partition)"
COMVIVO_BENCH_PROFILE=knn-50k pnpm bench --filter storage/bench --profile pi \
  --out pi-knn.json --summary pi-knn.md

say "02 §3.16.2: what a row costs on this machine, from dbstat"
COMVIVO_BENCH_PROFILE=stress-50k-1m pnpm exec tsx packages/storage/bench/sizes.ts

printf '\n\033[1mThrottling check\033[0m\n'
# `11` §3.9.4: any throttling invalidates the run, so this is the first thing to read in the paste.
printf '  throttled: %s\n' "$(vcgencmd get_throttled 2>/dev/null || echo 'vcgencmd unavailable')"
printf '  temp:      %s\n' "$(vcgencmd measure_temp 2>/dev/null || echo 'vcgencmd unavailable')"

cat <<'DONE'

Done. Please paste everything above back, and attach these four files:

  pi-storage.md  pi-storage.json  pi-knn.md  pi-knn.json

The markdown tables go verbatim into docs/architecture/storage-benchmarks.md, which today carries
arm64-macOS numbers and says the Pi column is not measured. The spike result settles the
linux-arm64 row of SP-1 and U5 in docs/architecture/storage-spike.md. The secretstream figure is
SP-2's gate: at or above 40 MB/s `libsodium-wrappers` stays the default; below it, `02` D13
switches the implementation to `sodium-native` with the wire format unchanged.

If `throttled` is anything but 0x0, the numbers are not usable (11 §3.9.4) — a better power supply
or an active cooler, then run it again.
DONE
