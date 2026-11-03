# CI, branch protection and the merge queue

What runs, what blocks a merge, and why each choice is the way it is.

Specs: `11` §3.8.1–§3.8.3 (workflows, the PR pipeline, required checks and merge-queue policy),
`08` §3.15 (the security jobs and repository hardening). Configured in `M0-T11`, `M0-T12` and
`M0-T21`.

## The one required check that matters

Branch protection names **`ci-ok`**, not the individual jobs. `ci-ok` sits at the bottom of
`ci.yml` with `needs` on every other job, and it **audits `needs` explicitly** rather than relying
on `needs` alone:

```yaml
ci-ok:
  needs: [static, unit, integration, coverage, build, node24, changeset]
  if: ${{ always() }}
```

`if: always()` is required — without it the job is skipped when a dependency fails, and a skipped
required check never reports, which GitHub treats as pending rather than failed. With `always()`
and no audit, the opposite problem: the job runs and succeeds while its dependencies failed. So it
reads `toJSON(needs)` and fails on any `failure`, `cancelled` **or `skipped`** result. No job in
`ci.yml` is skipped by design, so a skip means a dependency failed earlier or somebody edited the
graph without updating the audit.

The payoff is that the job list can change without touching repository settings.

## A trap worth knowing: event-conditional job names

A required status check that **never reports** blocks a merge forever. GitHub shows it as pending,
not as passed, and there is no timeout that rescues it.

Two of the security workflows have jobs that run on some events and not others:

| Workflow | Job | Runs when |
|---|---|---|
| `osv.yml` | `scan-pr` | pull request only — scans the diff |
| `osv.yml` | `scan-all` | merge group, `main`, nightly — scans everything |
| `zizmor.yml` | `audit` | every pull request and merge group; `push` to `main` only when `.github/**` changed |

Requiring any of those by name would stall the context where it does not run. Measured on a real
push: `scan-all / osv-scan` succeeded and `scan-pr` reported `skipped`.

So each of those workflows ends in an **aggregator with a stable name** — `osv-ok`, `zizmor-ok` —
that always runs and audits the conditional jobs beneath it. `osv-ok` additionally fails if
*neither* scan ran, because "nothing was checked" must not look like "nothing was wrong".

**An aggregator fixes job-level conditionality, not workflow-level triggering.** `zizmor.yml`
originally filtered its `pull_request` trigger on `.github/**`, so a pull request touching nothing
there did not start the workflow at all — `zizmor-ok` never reported either, and the required check
would have blocked forever. The filter is off the `pull_request` trigger for that reason and stays
on `push`, where nothing is gated. Worth knowing before adding a `paths` filter to any workflow
whose checks are required.

## Required checks

| Check | Workflow | Blocks on |
|---|---|---|
| `ci-ok` | `ci.yml` | any failed, cancelled or skipped job in the PR pipeline |
| `analyze (javascript-typescript)` | `codeql.yml` | CodeQL alerts in the `security-extended` suite |
| `analyze (actions)` | `codeql.yml` | CodeQL findings in the workflows themselves |
| `osv-ok` | `osv.yml` | a known-vulnerable dependency, untriaged in `osv-scanner.toml` |
| `review` | `dependency-review.yml` | a newly added dependency with a high+ advisory or a denied licence |
| `policy` | `supply-policy.yml` | a non-registry dependency, an unlisted install script, or a secret-shaped literal |
| `zizmor-ok` | `zizmor.yml` | a high-severity GitHub Actions finding |

Not yet required, and why:

- **`pr-title`** (Conventional Commits) — the workflow does not exist yet. Commit subjects are
  already Conventional by convention; the check arrives with the release tooling it feeds.
- **`dco`** — the DCO GitHub App has to be installed on the repository by its owner. Sign-off is
  enforced by habit and `.github/dco.yml` is already configured for when it is.
- **`security-dast`**, **`mutation / ifc-policy`** — their workflows arrive with the code they
  test (`M9`, `M5`). `11` §3.8.3 treats them as conditionally required.

## Reviews: zero required, on purpose

`11` §3.8.3 asks for one approving review, and two on the CODEOWNERS security paths. **Neither is
enforceable today**, because the project has one maintainer and GitHub does not let an author
approve their own pull request. Setting a positive number would block every change.

So the ruleset requires **0 approvals** and `.github/CODEOWNERS` is complete and correct but not
yet enforced. When a second maintainer arrives, the review requirements are one settings change
rather than an archaeology exercise — which is the entire reason CODEOWNERS was written out in
full at `M0-T17` rather than left until it could be turned on.

What *is* enforced today and does not need a second person:

- every required check above;
- branches must be up to date with `main` before merging;
- review threads must be resolved;
- no force pushes, no branch deletion;
- squash is the only merge method.

## The merge queue — configured, not yet enabled

**The merge queue cannot be turned on yet.** `comvivo` is a user-owned repository, and GitHub's
merge queue requires an organisation. Measured rather than assumed: `POST /repos/.../rulesets` with
a `merge_queue` rule returns

```
422 Validation Failed — Invalid rule 'merge_queue':
```

with an empty detail, on every parameter combination tried — alone, alongside the `pull_request`
rule, with `MERGE` instead of `SQUASH`, and with enforcement both active and disabled. A complete
parameter set is accepted by the schema and then rejected as a rule, which is what a feature gate
looks like rather than a bad request.

It becomes available when the repository moves into the `comvivo` organisation — owner ask **H-6**
in `docs/plan/STATUS.md`, which is already the highest-priority one. The settings below are the
ones to apply then, per `11` §3.8.3:

| Setting | Value | Why |
|---|---|---|
| Merge method | squash | One commit per pull request on `main`, so `main`'s history is the list of changes |
| Build concurrency | 5 | Up to five queue entries building at once |
| Group size | 1–5, 5-minute wait | Batches merges without making a single change wait on a full group |
| Only merge non-failing pull requests | on | A failing entry is removed rather than taking the batch down with it |
| Status-check timeout | 45 minutes | p95 for `ci.yml` is budgeted at 20 minutes (`11` §8), so this is generous and still bounded |

**Every required workflow already triggers on `merge_group`**, so the queue will work the day it
is switched on. Without that the required checks never report inside the queue and it stalls, which
is the single most common way a merge queue is misconfigured. `ci.yml`, `codeql.yml`, `osv.yml`,
`dependency-review.yml`, `supply-policy.yml` and `zizmor.yml` all carry the trigger.

Until the queue exists, **"require branches to be up to date before merging" is on**. That is the
manual equivalent: it forces a rebase onto `main` before merging, which is the property the queue
would otherwise guarantee by building each entry on top of the branch. It is deliberately *off* in
the queue configuration above, because there the queue owns that job.

Wildcard branch patterns are deliberately not used, per `11` §3.8.3.

## How to get a change in

```bash
git switch -c m1-storage          # one branch per milestone
# …commits…
pnpm verify                        # everything CI runs, locally
gh pr create
# CI green → add to the merge queue → it merges itself
```

Direct pushes to `main` are blocked. Release pull requests from Changesets go through the queue
like anything else.

## Timing

Measured on run `41613125268`, the M0 tree: **1 minute 6 seconds** wall-clock for all nine jobs —
`static` 41 s, `unit` 31/27/24 s across three shards, `integration` 23 s, `coverage` 23 s, `build`
21 s, `node24` 21 s, `ci-ok` 3 s. The budget in `11` §8 is p50 ≤ 12 minutes and p95 ≤ 20 minutes,
so there is a great deal of headroom to spend as the test suite grows.

## Running the checks locally

`pnpm verify` is the same set `ci.yml` runs, in the same order. Three of its steps need a binary
that is not an npm package, and each reports itself as **skipped** rather than clean when absent:

| Tool | Install |
|---|---|
| actionlint | `scripts/ci/install-actionlint.sh` in CI; `brew install actionlint` locally |
| shellcheck | preinstalled on the runners; `brew install shellcheck` locally |
| Vale | `scripts/ci/install-vale.sh` in CI; `brew install vale` locally |

Reporting "skipped" rather than "clean" is not pedantry. It is exactly how a local run came to be
weaker than CI's while printing the same word, and how shellcheck finding SC2129 in `release.yml`
came as a surprise in CI (see STATUS, `M0-T11`).
