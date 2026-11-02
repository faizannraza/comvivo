# Village — Implementation Plan

This folder is the complete, end-to-end technical plan for building **Village**: the open-source AI that belongs to your group, not to one person. Claude Code (or any engineer) can execute it from an empty repo to a launched 1.0.

## Reading order

| # | Document | Read when |
|---|---|---|
| 00 | [Vision, principles & scope](00-vision-and-scope.md) | First, always |
| 01 | [System architecture — the spine](01-architecture.md) | First, always (normative) |
| 14 | [Milestones & execution plan](14-milestones.md) | Before any implementation |
| 02 | [Domain model & storage](02-domain-model-and-storage.md) | M1, and whenever touching persistence |
| 03 | [Group intelligence: constitution, policy, discretion (IFC), consent, fairness](03-group-intelligence.md) | M4–M5, and whenever touching context, tools or policy |
| 04 | [Memory system](04-memory-system.md) | M6 |
| 05 | [Agent runtime: router, turns, prompts, model gateway, tools](05-agent-runtime.md) | M2–M3, M5, M8 |
| 06 | [Channels & adapters](06-channels.md) | M3, M10, M11 |
| 07 | [Coordination features & proactivity](07-coordination-features.md) | M7–M8 |
| 08 | [Security & privacy](08-security-privacy.md) | M0, M1, M5, M9, M12, M14 |
| 09 | [Dashboard, HTTP API & CLI](09-dashboard-api-cli.md) | M3 (minimal), M9 |
| 10 | [Extensibility: plugins, MCP, skills](10-extensibility.md) | M12 |
| 11 | [Quality, evals & observability](11-quality-evals-observability.md) | Every milestone (gates) |
| 12 | [Packaging, release & operations](12-packaging-release-ops.md) | M0, M3, M14 |
| 13 | [Docs, launch & community](13-docs-launch-community.md) | M0, M15 |
| 15 | [Risks & open questions](15-risks-and-open-questions.md) | Planning and reviews |

Progress is tracked in [STATUS.md](STATUS.md). To start building, follow [KICKOFF.md](KICKOFF.md).

Supporting material:
- `_review/` holds the consistency-review logs (R1–R4) that produced the current text. They are useful when a spec choice looks surprising.
- `../research/` holds the market research behind the idea.

## Conventions

- **Normative vs informative.** `00` and `01` are normative; subsystem specs elaborate them. Where a subsystem spec proposes a spine change, it appears under that spec's "Proposed spine changes" section and is resolved in `15-risks-and-open-questions.md` §Resolved decisions.
- **Task IDs.** `M<milestone>-T<n>` (e.g. `M5-T3`). Tasks defined inside subsystem specs are consolidated and ordered in `14-milestones.md`. Where the two differ, `14` wins for ordering and the subsystem spec wins for design detail.
- **Verified facts.** Third-party facts (APIs, limits, versions) cite a source and the date checked. Re-verify anything older than 3 months when you implement it.
