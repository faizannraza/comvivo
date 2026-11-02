# ADR-016 — License and contributions

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** —

## Context

- Village's growth depends on outside contributors; scope is the project's biggest risk (`15` §3 R-3) and a thin maintainer team is the mitigation's weak point.
- It also has to be adoptable without a legal review: a household installs it, and a small company might run one for a team. Anything with copyleft obligations on network use would make the second case a conversation with a lawyer.
- There is no hosted service and there never will be (`15` §5), so the usual reason to reach for a network-copyleft license — stopping a cloud vendor from reselling your work — does not apply to the business we are not in.
- Patents matter for an AI project: contributors and adopters both want an explicit grant.
- Contribution friction is the thing that actually decides whether a drive-by fix becomes a PR.

## Decision

| Item | Choice |
|---|---|
| License | **Apache-2.0** (`LICENSE` + `NOTICE`) |
| Contributor agreement | **DCO sign-off** (`git commit -s`), checked by a bot. **No CLA** |
| Code of conduct | **Contributor Covenant 2.1**, with a contact address that reaches at least two maintainers |
| Attribution | Commits are signed off; AI assistance is disclosed in the PR template, and the project states openly that it is largely implemented by AI agents executing the public plan, with humans reviewing, merging and accountable (`13` §3.F.9) |

Supporting community files land with it: `CONTRIBUTING.md` (DCO sign-off, test conventions, flake policy), `SUPPORT.md`, `GOVERNANCE.md`, `MAINTAINERS.md`, `SECURITY.md` (content owned by `08`, with private vulnerability reporting).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **MIT** | Shorter and equally permissive, but it carries **no explicit patent grant**. For a project in the AI space, where patent exposure is a live concern for both contributors and corporate adopters, Apache-2.0's §3 grant is worth the extra length. Apache-2.0 also gives clearer trademark and notice handling, which matters for a project whose name carries only common-law rights (ADR-015, ADR-024). |
| **AGPL** | Its leverage applies to a hosted-service scenario we have ruled out, and in exchange it makes a company running an internal instance for a team ask a lawyer first. It would deter exactly the adopters and contributors we want, for a protection we do not need. |

A **CLA** was rejected along with the license choice: it asks every contributor to sign a legal document before their first patch, which measurably suppresses casual contributions. DCO gets the provenance assurance with a `-s` flag.

## Consequences

**Good**
- A household or a company can run and modify Village without a legal review.
- Contributors get an explicit patent grant; so do adopters.
- A one-flag sign-off keeps the barrier to a first PR as low as it goes.
- Being explicit about AI-assisted development up front defuses the "vibe-coded" objection instead of letting it be a discovery (`13` §3.F.9).

**Bad / accepted costs**
- Permissive licensing means anyone may fork and commercialise the work, including with no contribution back. That is accepted: the project's value to its users is the self-hosted instance they already run, not exclusivity.
- `NOTICE` has to be maintained as dependencies change.
- Without a CLA, a license change later would require contacting contributors — so the license choice is effectively permanent. That is intended.
- Code-of-conduct enforcement is real work for a small maintainer team and needs a documented process, not just a file.

**Follow-ups**
- `M0-T16` — license, `NOTICE`, code of conduct, DCO plumbing, `CONTRIBUTING.md` skeleton, `SECURITY.md` and disclosure plumbing.
- `M0-T17` — issue/PR templates, labels, `CODEOWNERS`.
- `M15` — the full `CONTRIBUTING.md` and the launch-readiness community work (`13`).

## References
- `docs/plan/01-architecture.md` §2 ADR-016
- `docs/plan/13-docs-launch-community.md` §3.F.1 (repository community files), §3.F.5 (governance and CoC enforcement), §3.F.9 (AI-assisted contributions)
- `docs/plan/08-security-privacy.md` §3 (SECURITY.md content and disclosure)
- `docs/plan/15-risks-and-open-questions.md` §3 R-3, §5
