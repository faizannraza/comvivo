# Comvivo

**A self-hosted AI assistant that belongs to a group, not to one person.**

Comvivo lives in your family's or household's existing group chat — Telegram, Signal, Matrix,
Discord, Slack — and helps with the things a group actually shares: who is picking up whom, what
is in the fridge, when the rent is due, what somebody said they would do last Tuesday. It runs on
your own machine. Your conversations stay there.

> ### Not launched yet
>
> This repository is public so the work can be reviewed as it happens, but **Comvivo is not
> finished and not announced.** There is no release, no published package and no image to pull
> yet. Things will break and change shape without warning.
>
> If you found this early: you are welcome to read, and
> [Discussions](https://github.com/faizannraza/comvivo/discussions) is open. Please do not file
> bug reports against unfinished subsystems — the honest answer is "not built yet", and
> [`docs/plan/STATUS.md`](docs/plan/STATUS.md) will tell you which ones those are.

## What makes it different

Most assistants are built for one user. A group is harder, and the hard parts are the interesting
ones:

- **Discretion.** A group chat is not one audience. Something a teenager told Comvivo privately
  must not surface in the kitchen group, and something the adults are arranging must not leak into
  a conversation with the children. This is enforced by an information-flow model with
  machine-checked invariants — no read-up, no write-down, requester authority, group isolation —
  not by asking a model to be careful.
- **Shared authority.** Who may ask Comvivo to spend money, change a shared calendar, or message
  somebody outside the group? Roles and a group-editable constitution decide, and every
  consequential action is confirmed to a person who is allowed to authorise it.
- **It belongs to you.** Self-hosted, Apache-2.0, and **no product telemetry**: no analytics, no
  usage counting, no crash reporting, not even opt-in. The one outbound request Comvivo can make on
  its own behalf is an update check, which is **off by default** and reads a static file from a host
  that gives us no request logs — so installs cannot be counted even if we wanted to. Export
  everything, delete anything.

  This website measures aggregate traffic with a self-hosted, cookieless analytics install, and
  publishes the dashboard. That is the site, not the product ([ADR-022](docs/adr/ADR-022-docs-site-analytics.md)).
- **Quiet by default.** An assistant in a family chat that chatters is an assistant people mute.
  Comvivo speaks when it is useful and otherwise stays out of the way.

## Status

| | |
|---|---|
| Phase | **M0 — foundations.** Toolchain, guards, CI, release skeleton. |
| Next | M1 storage, M2 model gateway, M3 the first channel adapters. |
| Target | A finished, published 1.0 — not a prototype. |

The complete implementation plan is public and is the source of truth:
[`docs/plan/`](docs/plan/). [`STATUS.md`](docs/plan/STATUS.md) is the live record — what is done,
what every decision was and why, and every place the plan turned out to be wrong.

## How this is being built

Comvivo is largely implemented by AI coding agents executing that public plan, with a human
reviewing, merging and accountable for the result. We would rather say so plainly than have it
noticed.

What makes that defensible is evidence rather than assurance: every guard in this repository has a
test that plants a violation and asserts the guard fails. That rule exists because **nine guards and
gates here have been caught proving nothing** — a dependency checker cruising an empty graph, a lint
rule with no declared global, a secret-scrubbing pattern that could never match the one case it was
written for, two file scanners blind to a whole class of file, an ESLint rule whose options a later
block silently replaced, a test-time network guard that let real HTTP requests out, a plan checker
whose own fifty-four tests were wired to nothing at all, and a release dry run that had been green
all milestone because it was versioning an empty set. Each was found by trying to break it, or by
running it for real, never by reading it.

Test counts, property tests, the red-team scorecard and the performance budgets are public and
measured, never estimated. Where a gate needs something only a human can do, the substitution is
stated in [`STATUS.md`](docs/plan/STATUS.md) rather than glossed.

## Licence

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).

## Contributing, support and security

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to set up in five minutes and what a good change looks like.
- [SUPPORT.md](SUPPORT.md) — where to ask a question.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability **privately**. Please do not open a
  public issue for one.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [GOVERNANCE.md](GOVERNANCE.md).
