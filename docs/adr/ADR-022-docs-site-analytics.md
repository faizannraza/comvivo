# ADR-022 — Docs-site analytics

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** introduced by §14 **A21**. **Does not change ADR-017** — product telemetry stays at **zero**

## Scope — read this first

This ADR covers **the documentation website only**: `apps/docs`, served on the docs domain. It says nothing about the Village product, and it changes nothing in it.

**Product telemetry remains exactly zero (ADR-017).** The installed Village instance:

- collects no analytics;
- never phones home;
- has no crash reporting;
- performs an update check only if the host opts in, with no identifiers, against a static manifest on GitHub Pages where maintainers have no access to request logs or counts.

A21 states this explicitly, and so does the public trust page. If this ADR ever appears to justify measuring anything inside the product, it is being misread.

## Context

Launch depends on a docs funnel that actually works: landing page → demo → quickstart → GitHub. If that funnel is broken — a quickstart command that 404s, a page nobody can find, a demo that nobody starts — we need to know, and the honest sources available otherwise (GitHub stars, npm downloads, GHCR pulls) say nothing about the website.

The constraints are tighter than for a normal marketing site:

- A project whose pitch is "no telemetry" cannot embed Google Analytics on its own website without looking ridiculous.
- No cookies, no cross-site identifiers, no third-party data processor.
- Whatever we measure, we must be able to **publish** — if the numbers are not something we would show the reader, we should not collect them.
- The website must stay fast and must not break with a blocked script.

## Decision

| Item | Choice |
|---|---|
| Tool | **Umami** (MIT), **self-hosted** |
| Cookies | **None** — Umami is cookieless |
| Script origin | Served from **our own subdomain**, not a third-party CDN |
| DNT | Respected (`data-do-not-track="true"`) |
| Dashboard | **Public share dashboard** — the numbers are published, not private |
| Opt-out | A documented toggle, with the whole arrangement described at the website-privacy page under `/trust/` |
| Scope | **Docs site only.** Never on the release-manifest host, never in the product |

What is measured: page views, referrers, countries, 404s, and four custom events — `quickstart_copy`, `demo_start`, `demo_scenario_complete`, `github_click`.

What is never logged: **search queries, and any free text typed into the demo.**

Reviewed weekly alongside the non-telemetry sources (GitHub API and Traffic API, npm downloads, best-effort GHCR pulls, voluntary reports), and summarised in a public monthly health post (`13` §3.G).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **None** (collect nothing at all, even on the website) | The purest option, and it was genuinely considered. Rejected because the launch gates depend on the docs funnel converting (`13` §3.E.1), and a broken quickstart or an unfindable page would otherwise be invisible until it showed up as an issue — if it ever did. Self-hosted, cookieless, publicly-shared aggregates are a small, honest cost for that signal. |
| **Plausible** | Equally privacy-respecting in design, but the hosted version makes a third party the data processor for our own website, which weakens the claim we are making. Self-hosting Plausible would be acceptable in principle; Umami is lighter to run and is MIT-licensed. |

## Consequences

**Good**
- The docs funnel becomes measurable without a third-party processor and without cookies.
- Publishing the dashboard makes the measurement itself a trust artefact instead of something to disclose awkwardly.
- 404 tracking catches broken links and renamed pages quickly — which matters a lot around a rename, and the rename machinery is permanent (ADR-015, ADR-024).
- Serving the script from our own subdomain means no cross-site identifier and fewer blocked requests.

**Bad / accepted costs**
- We now operate a small service: an Umami instance and its database, to patch and back up.
- Even cookieless analytics requires an honest explanation, so there is a privacy page to write and keep accurate.
- Aggregate numbers are blunt: no funnels per cohort, no session replay, no answers to "why did they leave".
- There is a standing risk of scope creep from this ADR toward the product. It does not extend there, and ADR-017 is unchanged.

**Follow-ups**
- `M13`–`M15` — docs-site work (`13`) owns the Umami deployment, the four custom events, the `/trust/website-privacy/` page and the public share dashboard.
- The monthly public health post is generated from the metrics store (`13` §3.G).

## References
- `docs/plan/01-architecture.md` §2 ADR-022, §2 ADR-017, §14 A21
- `docs/plan/13-docs-launch-community.md` §3.G (metrics without telemetry), §3.C.2 (docs hosting and headers), §3.E.1 (launch readiness gates)
- `docs/plan/12-packaging-release-ops.md` §2 P18; §3.1 (release manifest on GitHub Pages)
