# Contributing to Comvivo

Thank you for looking. Comvivo is pre-1.0 and unannounced, so the most useful contributions right
now are review and argument rather than code: reading
[`docs/plan/`](docs/plan/), disagreeing with a decision in
[Discussions](https://github.com/faizannraza/comvivo/discussions), or finding a guard that does not
actually bite.

This is the M0 skeleton. It gets its full form at M15; the outline is `13` §3.F.1.

## 1. Ways to help

- **Code.** Channel adapters, dashboard screens, tools.
- **Docs.** Including the parts that are wrong because the code moved.
- **Translations.** The dashboard and the docs site, once those exist.
- **Red-team scenarios.** Ways to make Comvivo say something it should not. These are genuinely
  valuable and do not require writing production code — see `docs/plan/11-quality-evals-observability.md` §3.6.
- **Constitution templates.** What a household actually wants to agree on.
- **Triage and design.**

## 2. Ground rules

- The [Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere, including Discussions and pull
  request reviews.
- **DCO, not a CLA.** Sign off every commit with `git commit -s`. That adds a
  `Signed-off-by:` line certifying you wrote the change or have the right to submit it
  (<https://developercertificate.org>). The DCO app enforces it. There is no copyright assignment
  and never will be.
- Everything is Apache-2.0.

## 3. Setup, in about five minutes

```bash
git clone https://github.com/faizannraza/comvivo.git
cd comvivo
pnpm install       # pnpm is pinned by `packageManager`; do not use Corepack (absent from Node 25+)
pnpm verify        # lint, types, boundaries, guards, tests, build
```

Node **26** is the primary target; **24.11+** is supported and covered by its own CI leg. pnpm 12.

`pnpm dev` runs the server and dashboard against the **simulator channel and a fake model**, so you
need no API key and no bot token to work on almost anything.

## 4. Repo tour

| Where | What |
|---|---|
| `docs/plan/` | The complete implementation plan. The source of truth, and public. |
| `docs/plan/STATUS.md` | The live record: what is done, every decision and why, and every place the plan was wrong. |
| `docs/architecture/` | Notes on non-trivial modules. |
| `docs/adr/` | Architecture decision records. |
| `packages/` | The libraries. `core` is pure — no I/O, no `Date`, no `Math.random`, no `node:*`. |
| `apps/` | The CLI, server, dashboard and docs site. |
| `scripts/` | The guards. Each one has a test that plants a violation. |

**Dependency boundaries are enforced**, not suggested (`dependency-cruiser`, 26 rules, each with a
planted-violation fixture). If an import is refused, the design is wrong — do not weaken the rule.

## 5. Picking work

Look for `good first issue` and `help wanted`. Comment to claim one; a maintainer assigns it.
Unassigned after 14 days without activity, with no hard feelings.

## 6. Making a change

- Branch, then open a pull request. Conventional Commits for the subject line.
- **Tests are required.** Property-based tests specifically for policy, information flow and
  fairness, because those are the places where an example-based test passes by picking a kind
  example.
- `pnpm changeset` if the change affects anybody running Comvivo. Start the summary with a type —
  `breaking:`, `security:`, `upgrade:`, `feat:`, `fix:`, `perf:`, `docs:` — and write it for a host
  rather than for a reviewer. See [`.changeset/README.md`](.changeset/README.md).
- Docs in the same pull request as the change.
- Small pull requests. A 2,000-line one does not get the review it deserves.

### Test conventions

| Tier | Filename | Runs |
|---|---|---|
| unit | `*.test.ts` | every pull request, 3 shards |
| integration | `*.int.test.ts` | every pull request |
| contract | `*.contract.test.ts` | every pull request |
| property | `*.prop.test.ts` | longer runs, nightly at 20k cases |
| scenario | `*.scenario.ts` | the evals harness |

- **No real timers.** Use `VirtualClock` from `@comvivo/shared/testing`.
- **No fixed ports.** `listen(0)` and read the assigned port.
- **No shared temp directories.** `mkdtemp`.
- **No `.only`.** The hygiene check will catch it, but it will catch it after you have pushed.
- **Snapshots only for rich-text renderers**, with a real file extension so a reviewer reads the
  diff as rendered markup.
- **A secret-shaped fixture must be assembled at runtime** from separate string literals. Writing
  one out whole gets your push rejected by GitHub's secret scanning. `pnpm secrets:check` catches
  it first and tells you how.

### Flake policy

A flaky test is one that has passed and failed on the same commit. Required checks run with **zero
retries**. A skipped test needs `// skip(<task-id>): <reason>` on the line above, and none at all
is allowed at a milestone gate.

Tests under `core/{ifc,policy}`, `engine/{context,guard,declassifier,tools-executor}`, the chaos
oracles and the red-team suites **may never be quarantined**. A flaky test there is treated as a
possible real nondeterminism bug and blocks the merge queue until it is understood.

## 7. Protected areas

Information flow, policy, context building, the outbound guard, the declassifier and crypto need
**two maintainer approvals**, and an RFC if the semantics change. These are the parts where a
mistake means somebody's private message reaches the wrong person.

## 8. AI-assisted contributions

AI tools are welcome. **You are responsible for every line and must be able to explain it.**
Disclose your level of AI assistance in the pull request template — it is not held against you, and
it helps a reviewer know where to look hardest.

Please do not post AI-generated issues, reviews or security reports without verifying them
yourself. An unverified generated security report costs a maintainer an afternoon.

For what it is worth, this project is itself largely implemented by AI agents executing the public
plan, with a human accountable for the result. We would rather say so than have it noticed.

## 9. Reporting problems

- **Bugs:** include `comvivo doctor --bundle` output once that exists.
- **Security and discretion failures: privately.** See [SECURITY.md](SECURITY.md). A discretion
  failure is a security issue even when it looks like a bug.
- **Never paste real chat content** into an issue, a discussion or a test fixture. Not yours and
  especially not anybody else's. The simulator generates realistic groups for exactly this.

## 10. Docs

Prose is checked with Vale against `apps/docs/STYLE.md`. Every pull request that touches the docs
gets a preview link.

## 11. Translations

Weblate for the dashboard; Lunaria and ordinary pull requests for the docs site. Neither is wired
up yet.

## 12. Review expectations

A first response within 72 hours. If a pull request has been quiet longer than that, a nudge in the
thread is welcome rather than rude.

## 13. Recognition

Non-code contributions — docs review, translation, design, testing, red-teaming — are recorded in
`CONTRIBUTORS.yml` and count toward the maintainer ladder in [GOVERNANCE.md](GOVERNANCE.md) exactly
like code does.
