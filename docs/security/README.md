# Security documentation

Where the security material lives, and who owns it.

| Topic | Where |
|---|---|
| How to report a vulnerability | [`/SECURITY.md`](../../SECURITY.md) |
| The threat model, trust boundaries and the full control set | [`docs/plan/08-security-privacy.md`](../plan/08-security-privacy.md) |
| Supply-chain policy: pinned actions, `allowBuilds`, `minimumReleaseAge`, OSV triage | `08` §3.15, [`docs/architecture/native-deps.md`](../architecture/native-deps.md), [`osv-scanner.toml`](../../osv-scanner.toml) |
| Release integrity: cosign signatures, SLSA provenance, SBOMs | [`docs/architecture/release.md`](../architecture/release.md), `12` §3.10.4 |
| The information-flow model and invariants I1–I7 | [`docs/plan/01-architecture.md`](../plan/01-architecture.md) §4, `03` |
| What never reaches a log or a trace | `01` §11.7, [`docs/architecture/observability.md`](../architecture/observability.md) |

## The short version of the threat model

The **host is trusted.** Somebody with root on the machine Comvivo runs on, or with its keys, can
read everything — and no design can change that without taking the data away from them, which is
the opposite of the point. Everything else is in scope.

What the project does defend, and the mechanism rather than the intention:

| Promise | Mechanism |
|---|---|
| A member never learns something they are not allowed to know | Information-flow control with machine-checked invariants (no read-up, no write-down, requester authority, group isolation), plus property-based tests and an adversarial suite |
| Message and memory content never reaches a log or a trace | Four layers: a closed field type, a gated content channel, depth-unlimited field stripping, shape scrubbing. Telemetry attributes make content a **compile error** |
| Nothing phones home | Zero telemetry, by design and by ADR. No analytics, no usage counting, no opt-in |
| Nothing leaves the machine unexpectedly | An egress allowlist in front of every outbound request |
| A compromised dependency cannot quietly ship | Three-day release delay, no-downgrade trust policy, explicit install-script allowlist, SHA-pinned actions, OSV and CodeQL on every pull request |

## For researchers

The guards in this repository are tested by **planting violations**, not by inspection — three
separate guards here were found reporting success while enforcing nothing, so "it is configured"
is not evidence. If you find a guard that does not actually bite, that is a valid report and a
welcome one.
