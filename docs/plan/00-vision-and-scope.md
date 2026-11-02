# 00 — Vision, Product Principles and Scope

> Status: normative. Every other plan document must be consistent with this file and with `01-architecture.md`.
> Codename: **Village** (final name is decided in `13-docs-launch-community.md` → "Naming & trademark check" before public launch).

## 1. One-liner

**Village is the open-source AI that belongs to your group, not to one person.** It joins the group chats you already use (Telegram, Discord, Slack, Matrix, Signal) as a member that serves everyone. It remembers what the group decided, keeps private things private by design, shares work out fairly, and only speaks when it's worth it.

## 2. The insight we are building on

- Software became great when it became multiplayer: Google Docs made documents multiplayer, and Figma did the same for design. AI is still single-player. ChatGPT, Claude, Gemini and OpenClaw each answer to exactly one principal.
- Life is multiplayer. Families, friend groups, roommates, teams, clubs, school-parent groups and communities coordinate in group chats that have no intelligence at all: hundreds of unread messages, lost decisions, and one person who quietly does all the coordinating (the "mental load").
- Nobody has built a *group-owned* agent because it is genuinely hard. It must:
  1. obey several people who sometimes disagree,
  2. keep each member's private information private from the others,
  3. be fair,
  4. resist manipulation by any single member, and
  5. not be annoying.

  Those are the five hard problems Village solves, and solving them well is our moat.
- Evidence of the gap (Nov 2026): OpenClaw (the most-starred personal agent, ~387k stars) documents an instance as "one trust domain" and closed multi-user RBAC as "not planned". The closest products are either closed (ChatGPT group chats, Ollie/Ohai-style family apps) or small open-source projects without a principled privacy model (MindRoom, Nautilo, LanJAM).

## 3. Product principles (these break ties in every design decision)

1. **Belongs to the group.** Village serves multiple principals under a written, editable **group constitution**: roles, permissions, how disagreements are settled, privacy defaults, and how often it may speak.
2. **Discretion by architecture, not by prompt.** Private information is protected by information-flow control enforced in code. The model that writes group-visible messages *never receives* another member's private data, only typed, owner-approved constraints derived from it (see `03-group-intelligence.md`).
3. **Quiet by default.** Village speaks when addressed, or when it has something clearly valuable to say within a strict **attention budget**. A bot that talks too much gets kicked; we optimize for "people are glad it's here".
4. **Lives where you already talk.** No new app is required for members. The web dashboard is for hosts and admins and is optional for everyone else.
5. **Yours.** Self-hosted, local-first, works with any model (Claude, OpenAI, Gemini, or fully local via Ollama), zero telemetry, export everything, delete anything.
6. **Fair and explainable.** Every action has a "why" trail. Chore and task assignment is transparent. Anyone can ask "why did you say that?" and get an answer limited to what they are allowed to see.
7. **Delight in under five minutes.** From `npx village init` to Village being helpful in a real group chat in under five minutes on a laptop, a Raspberry Pi 5 or a $5 VPS.
8. **Boringly reliable.** It never double-sends, never loses a reminder, survives restarts, and upgrades without drama.

## 4. Personas

| Persona | Who | What they need | Where they touch Village |
|---|---|---|---|
| **Host** | The technical person who installs it (developer, self-hoster, tinkerer) | Easy install, safe defaults, low cost, clear docs, hackability | CLI, dashboard, config, logs |
| **Organizer** | The person who carries the group's coordination load (often a parent) | Capture dates and commitments automatically, reminders, fair sharing of chores, fewer things falling through cracks | Group chat, DMs, morning brief |
| **Member** | Everyone else in the group, often non-technical | Answers ("when is the recital?"), catch-ups, reminders, no creepiness | Group chat, DMs |
| **Teen / Child** | Restricted member in a family | Help with own tasks, can't change others' stuff without approval | Group chat, DMs |
| **Community Admin** | Runs a Discord server, club or open-source project community | Answers FAQs from group memory, decisions log, event coordination, moderation-safe behavior | Discord/Slack/Matrix, dashboard |
| **Team Lead** | Small team or startup | Decisions log, task fairness, meeting/plan coordination | Slack/Discord, dashboard |

## 5. Group archetypes (ship as constitution templates)

`family`, `roommates`, `friends`, `trip` (time-boxed), `team`, `club` (community, larger and more public), `parents-class` (school parent group: many adults, low trust, high message volume), `oss-project`. Each template sets roles, permission grants, conflict-resolution strategies, privacy defaults, proactivity limits and tone (see `03-group-intelligence.md` §Templates).

## 6. Scope

### 6.1 v1.0 (public launch) — must ship, at excellent quality

**Channels**
- Telegram: first-class, the reference adapter.
- Discord: first-class.
- Slack: Socket Mode, so no public URL is needed.
- Matrix: beta, E2EE supported.
- Signal: experimental, via signal-cli.
- Web chat inside the dashboard: first-class; also used for demos and tests.
- A Simulator channel (dev/test only).

**Group intelligence**
- Constitution (YAML plus a plain-language charter), roles and capabilities, authorization on every action, conflict resolution (last-writer-with-notice, ask-owner, vote, role-precedence, consensus), and an amendment workflow.
- Information-flow control: labels on every datum, audience-safe context assembly, a declassifier that produces typed constraints, a disclosure guard on every outgoing message, and a strict boundary between groups.
- Consent and member onboarding (announce, explain, opt-out of memory), plus a child role and guardian approval.
- Defenses against confused-deputy actions and prompt injection: actions run with the *requester's* authority, and untrusted content is quarantined.

**Memory**
- Typed memories: facts, preferences, decisions (with rationale), commitments, events, tasks, list items, plans and notes.
- Each memory carries provenance and a validity time. It is extracted from conversation with confidence scores; low-confidence items become proposals.
- Hybrid retrieval: full-text search plus vector search plus recency and entity matching, always filtered by information-flow rules.
- User controls: "what do you know about me", forget, correct, export.
- Nightly consolidation into a "group story".

**Coordination**
- Calendar (one-off and recurring, timezone-correct), reminders, ICS feed.
- Tasks and chores with fair assignment and rotation, plus a load ledger.
- Shared lists (groceries etc.).
- Polls, using native ones where the platform supports them.
- Plans (multi-step, such as a trip).
- Decisions log.
- "Catch me up" summaries, scoped to what the reader may see.
- Morning brief (DM) and weekly group recap.

**Proactivity**
- Attention budget, quiet hours, batching into digests, priority scoring, and learning from reactions (muted or ignored means less).

**Multimodal**
- Voice notes (transcription, local or API), images (flyers, screenshots) and PDFs (school letters).
- Email ingestion via a dedicated IMAP mailbox ("forward school emails to Village").

**Models**
- Anthropic (default, through the official `@anthropic-ai/sdk`), OpenAI, Google, and any OpenAI-compatible local server (Ollama, LM Studio, llama.cpp, vLLM).
- Presets: Best (Claude Opus 5.5), Balanced (Claude Sonnet 5.5), Economy (Claude Haiku 5.5), Local.
- Per-group cost budgets.

**Dashboard (web)**
- Passwordless login: pair the browser by sending a short code to the bot in a DM. Magic links are allowed only on loopback or with HTTPS opt-in (`01` §14 A9).
- Group overview, members and roles, constitution editor with diff and amendment flow, memory explorer, calendar, tasks and fairness view, lists, audit log, turn traces ("Why did Village say this?"), costs, settings, backups.

**CLI**
- `village init` (wizard), `start`, `doctor`, `backup`, `restore`, `export`, `migrate`, `eval`, `keys`.

**Extensibility**
- Plugin SDK (tools, channels, skills).
- MCP *server*: members' personal agents (Claude, OpenClaw, etc.) can query their group with the member's own authority.
- MCP *client*: gated external tools.
- Skills packs (`SKILL.md` format).

**Packaging**
- Multi-arch Docker image, docker compose, an npm CLI (`npx village@latest init`, a placeholder until the final name per `01` §14 A2), a Home Assistant app (formerly called "add-on"), and an Umbrel/CasaOS app manifest.
- Automatic backups and safe migrations.

**Quality**
- Simulation harness with persona agents, a red-team suite for discretion and authority, an extraction eval, a proactivity-annoyance eval and a fairness eval, run in CI (deterministic) and nightly (live models).

**Docs and launch**
- Docs site, README with demo GIF, an in-browser scripted demo, and a launch plan.

### 6.2 Explicitly out of scope for v1.0 (roadmap candidates)
- **WhatsApp.** We never use unofficial clients such as Baileys or whatsapp-web.js, because of terms-of-service and legal risk. We will add it only through Meta's official WhatsApp Business Platform if and when that platform supports bots in normal user groups (`06-channels.md` documents current findings).
- **iMessage.** Possible only via community plugins (e.g. BlueBubbles), never in core.
- **Payments.** No money movement of any kind: no bill splitting with transfers, no purchases. Village may track who-owes-whom notes only as plain memory.
- **No third-party outreach.** Village never messages people outside the group or contacts businesses.
- **No autonomous web browsing agent.** Optional web *search* tool only, off by default.
- **Postgres backend.** Repository layer is designed for it; ships after 1.0.
- Multi-platform bridging of one group across two chat platforms. DMs on another platform are supported via identity linking.
- Native mobile apps.
- Voice calls.
- Hosted SaaS by the project.

### 6.3 Hard "never" list (legal and safety posture)
- No scraping or automation of third-party websites or accounts.
- No unofficial chat clients that violate platform terms.
- No telemetry or phoning home. Update checks are opt-in and read-only.
- No medical, legal or financial advice positioning. Village organizes information; disclaimers live in its behavior charter.
- No features designed to surveil members. The load ledger and fairness views are group-visible and opt-in per constitution, and private DMs stay private even from admins (enforced by information-flow control). The only exception is the *host's* physical access to the machine, which is honestly documented in the threat model.

## 7. Success criteria for 1.0

| Area | Target |
|---|---|
| Time to first value | ≤ 5 minutes from `npx village@latest init` to a correct answer in a real Telegram group (≥ 95% success over ≥ 40 fresh-user attempts, per `01` §14 A22) |
| Discretion | 0 leaks across the red-team suite (≥ 500 adversarial scenarios, multiple models) and property-based IFC tests |
| Authority | 0 unauthorized state mutations across the authority red-team suite |
| Proactivity | ≤ 1 unsolicited message per group per day at default settings; ≥ 70% of proactive messages rated useful in simulation |
| Extraction | Event/commitment extraction F1 ≥ 0.90 on the labeled multilingual corpus (EN + at least ES, HI-Latin, PT, DE, FR, AR samples) |
| Reliability | 0 duplicate sends and 0 lost reminders in chaos tests (kill -9 during turns, network flaps) |
| Performance | p50 reply latency ≤ 4 s and p95 ≤ 10 s for simple questions on cloud models; idle RSS ≤ 300 MB; runs on Raspberry Pi 5 (8 GB) |
| Cost | Typical family (5 members, ~200 msgs/day) costs are measured and published per preset; Economy preset target ≤ $3/month |
| Code quality | TS strict, zero `any` in non-test code, ≥ 90% line coverage in `core` and `engine` policy/IFC modules, all public APIs documented |
| Docs | Every feature has a user doc, and every package has a README and an architecture note |

## 8. Release train

| Stage | Contents | Audience |
|---|---|---|
| `0.1 alpha` | M0–M8 (Telegram + web, core intelligence, memory, coordination, proactivity) | Maintainers + 10 friendly groups |
| `0.5 beta` | + M9–M12 (dashboard, Discord/Slack/Matrix/Signal, multimodal, plugins/MCP) | Private beta, ~100 groups |
| `1.0` | + M13–M15 (eval hardening, packaging, docs, launch) | Public launch |

Milestones are defined in `14-milestones.md`.
