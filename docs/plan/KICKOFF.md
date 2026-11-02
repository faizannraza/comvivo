# Kickoff: building Village with Claude Code (autonomous mode)

## How to launch

1. Open Terminal and run `cd ~/village`.
2. Keep the Mac awake for long runs: `caffeinate -dims &`.
3. Start Claude Code with `claude`. Use the most capable model available, and pick a permission mode that lets it work without stopping for every command. The owner has authorized full autonomy (see `CLAUDE.md` §5). Turn on auto mode if your version has it (Shift+Tab cycles modes); otherwise use accept-edits mode and approve the first round of command prompts with "always allow".
4. Paste the **first prompt** below.
5. If the session ends, because of a usage limit or a closed terminal, start `claude` again and paste the **resume prompt**. `CLAUDE.md` and `docs/plan/STATUS.md` carry everything it needs.

## First prompt (paste as-is)

```text
You are taking Village from a finished plan to a finished, published, production-grade 1.0 — end to end, with nothing left half-built. Act as a world-class staff engineer and a world-class product manager working in perfect sync. I am the project owner. I have delegated every decision to you, so do not ask me to choose anything. The only things you ask me for are money, credentials or account actions that only I can perform, and an occasional 2-minute real-chat smoke test. CLAUDE.md §5 has the exact rules.

== GROUND TRUTH ==
- CLAUDE.md is the binding working agreement, and it survives context compaction. Follow it exactly, and re-read it plus docs/plan/STATUS.md whenever you resume.
- docs/plan/ is the source of truth.
  - 00 is the vision.
  - 01 is the normative architecture; its §14 amendments A1–A30 override older text.
  - 02–13 are the subsystem specs.
  - 14 holds the 504 canonical tasks with acceptance criteria, gates, demo scripts and cut-lines.
  - 15 holds risks, spikes and the decisions now delegated to you.
- docs/plan/STATUS.md is your memory. Keep it current enough that a fresh session can resume from it alone.
- Repository: https://github.com/faizannraza/village (public). Local folder: ~/village.

== FIRST HOUR — do these in order ==
1. Read CLAUDE.md, docs/plan/README.md, STATUS.md, 00, 01 (all of §14), 15, and 14 §0–§3 plus the M0 section. Read only the tables of contents of 02–13 for now; load their sections when a task needs them, and use sub-agents for wide reading so your context stays lean.

2. Environment audit and setup. Use `brew` where needed.
   - Node 26 (primary) and Node 24.11+ (matrix), managed with fnm or nvm.
   - pnpm 11, installed explicitly. Do not use Corepack.
   - Docker Desktop, running.
   - gh CLI, authenticated.
   - git identity.
   - Python 3, for plan scripts.
   If a GUI first-run or a login is required, add it to the batched ask in step 5 and keep going.

3. Git and GitHub.
   - Add `origin` = https://github.com/faizannraza/village.git and push `main`.
   - Configure the repo: description, topics, homepage (the docs URL once live).
   - Enable Discussions with categories from 13, private vulnerability reporting, and Dependabot alerts.
   - After M0 creates CI, protect `main` so it requires `ci-ok`.

4. Decide the product name NOW. D-2 is pulled forward to M0 because the repo is already public and renaming later is expensive.
   - Run the 13 §A process with real web research: npm (unscoped and scope), GitHub orgs, GHCR, domains, the free USPTO and EUIPO searches, and existing AI products.
   - The npm name `village` is taken by another company's SDK, so you need a final name that is clean everywhere, or a defensible scoped strategy.
   - Choose the name and record the rationale as an ADR.
   - Apply it through the BRAND constant. If it changes, rename the GitHub repo with `gh repo rename` and update `origin`.
   - Buying a domain costs money: recommend one in the batched ask, and use GitHub Pages until it is bought.

5. Send me ONE consolidated "What I need from you" message, then continue working immediately without waiting.
   (a) A proposed API budget with a breakdown, for me to approve once:
       - development smoke tests;
       - the reduced nightly live-eval profile;
       - release-time eval runs;
       - and whether to apply for provider open-source credits.
       After I approve, stay within it and track spend in STATUS.md.
   (b) ANTHROPIC_API_KEY. Tell me exactly where to put it: a gitignored .env or the keyfile layout from 08. Never commit it.
   (c) A Telegram bot token, with exact BotFather steps including the privacy-mode setting, plus a private test group with me and the bot in it.
   (d) Anything else needed soon (gh auth, Docker first run). Platform apps for Discord and Slack (M10), npm login and scope (M12), and paid items (domain, community-bot API spend, optional paid external security/child-safety review) — announce each when its milestone approaches, with exact steps.
   Until credentials arrive, use the simulator, the fake and adversarial model gateways, recorded fixtures, and local services.

6. Update STATUS.md:
   - Operating mode: autonomous.
   - The Decisions log, recording each delegated decision (D-1 to D-8) when you make it.
   - The M0 execution note.
   Then start M0.

== EXECUTION LOOP (M0 → M15, no stopping between milestones) ==
For each milestone:
1. Run its spikes first and record the decision and evidence.
2. Write the execution note.
3. Implement every task in table order, with tests. Then run `pnpm verify`, tick STATUS.md with the commit hash, and make a signed-off Conventional Commit.
4. Work on branch `m<n>-<slug>` and push after every task.
5. Use sub-agents in separate git worktrees for tasks marked ‖. Never parallelize core policy/IFC or migrations.
6. At the gate:
   - Run the exit gate and record the real numbers.
   - Run the milestone's demo script yourself.
   - Spawn an independent reviewer sub-agent with fresh context to audit the milestone against the spec acceptance criteria, the invariants (I1–I7, C1) and the "done means done" bar, then fix every finding.
   - Write the milestone report, open a PR, get CI green, and merge.
7. Move straight on to the next milestone.
If you are blocked on something only I can provide, ask in one batched message and keep working on everything else.

== DECISIONS YOU NOW OWN ==
Use 15 §1 recommendations as the starting point, decide with data where possible, and log the rationale.
- D-1, the pre-selected model preset: decide in M9 using the measured cost and quality from M2–M8. The goal is the best first impression without cost shock, so the wizard must show estimates.
- D-2, the name: decided in M0, as above.
- D-3, going public: the repo is already public. Keep it unannounced, with no launch posts, until the 1.0 launch gates pass.
- D-4, eval funding: this is money. Ask once with the budget proposal.
- D-5, minors' disclosures: implement the safest design, with no automatic guardian alert and with resources plus careful copy. Any paid external expert review is money: offer it, don't block on it.
- D-6, hybrid mode: decide in M9.
- D-7, community home: GitHub Discussions is the guaranteed baseline. Creating a Discord or Matrix space needs my account, so give me the steps; running a community bot costs money, so propose a cap.
- D-8, WhatsApp: stays out of 1.x. Never use unofficial clients.

== QUALITY BAR — "done means done" (CLAUDE.md §8) ==
- No stubs, placeholder implementations, mock data in production paths, or skipped tests at gates. No TODO/FIXME in production code at 1.0; a CI check enforces this from M14.
- Every feature must be reachable through chat, the dashboard or the CLI, documented, and covered by simulator scenarios.
- Never fake evidence. Where a gate needs something only a human can provide, use the strongest automated substitute and state it explicitly:
  - fresh-user dry runs → scripted clean-machine and clean-container installs across OSes and architectures;
  - Raspberry Pi runs → arm64 CI runners plus measured scaling;
  - human annotation → dual independent LLM annotation plus your own audit of disagreements;
  - external review → a deep internal security and privacy review plus the full red-team suite.
- Tighten any vague acceptance criterion before implementing it.

== PRODUCT BAR — users must be impressed ==
- Install to the first useful answer in a real group in under 5 minutes. Every error has a fix-it message.
- In chat, Village is brief, warm, precise, never spammy, and quiet by default. Its discretion is visibly trustworthy.
- The dashboard is beautiful and fast: shadcn design system, dark mode, mobile-ready, WCAG 2.2 AA, empty states that teach.
- Copy is reviewed like UI. Onboarding has delightful moments, such as the group intro and the first "here's what I caught for you."
- Performance budgets from 01/11 are met and measured.
- Before every release, run a simulated "week in a family group", the persona scenarios and a real-chat smoke test, then ask yourself: would this impress a demanding user and beat every alternative? If not, improve it before moving on.

== REAL-PLATFORM TESTING ==
- Matrix: run a local homeserver (Synapse or conduwuit in Docker) with scripted test users, for fully automated real end-to-end tests.
- Telegram, Discord and Slack: use the bot tokens I provide plus a short scripted smoke test at M3, M10 and M15 that I run in a test group. Batch these asks.
- Signal: recorded fixtures, plus a real number only if I provide one.

== FINISH LINE — what "done" means ==
- Every M0–M15 task is ticked with evidence, and every exit gate and launch gate is green with recorded numbers (substitutions stated).
- GitHub:
  - `main` has a clean history.
  - Tag v1.0.0 with a GitHub Release: notes, SBOM, provenance, signed multi-arch images on GHCR.
  - npm packages published with provenance; I will do `npm login` when you ask.
  - The docs site is live.
  - The README is professional and converts, with a real demo GIF or video recorded from the actual product (Playwright or terminal recording).
  - CHANGELOG, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue and PR templates.
  - ≥50 well-written good-first-issues.
  - A public roadmap (GitHub Projects).
  - The Home Assistant app repo, plus the Umbrel and CasaOS manifests.
- Launch kit in the repo: post drafts and the timing plan. Hacker News and Reddit rules require that I write the final text and post it myself, so prepare everything and post nothing.
- Final report: what shipped, measured results, known limitations, how to install, and the recommended next steps.

== NEVER ==
- Never commit secrets.
- Never enter passwords or create accounts.
- Never spend money without approval.
- Never use unofficial platform clients or scraping.
- Never add telemetry.
- Never post on social platforms on my behalf.
- Never mark anything done without evidence.

Start now with the FIRST HOUR steps.
```

## Resume prompt (after any interruption)

```text
Resume building Village. Read CLAUDE.md, then docs/plan/STATUS.md and the current milestone's section of docs/plan/14-milestones.md. Check `git status` and `git log -5`, then continue exactly where you left off, in autonomous mode, until 1.0 is finished and published.
```

## What Claude Code will ask you for (so you can prepare)

| When | What | Why |
|---|---|---|
| Start | Approve a monthly API budget; an Anthropic API key | Live model calls and evals cost money |
| Start | A Telegram bot token (from BotFather) and a test group | The M3 vertical slice runs in a real Telegram group |
| Start (if needed) | `gh auth login`, first launch of Docker Desktop | Pushing, CI and containers |
| M0 (optional) | Domain purchase | Docs and site URL (GitHub Pages works meanwhile) |
| M3, M10, M15 | A 2-minute scripted smoke test in real chat apps | Real-platform verification needs a human account |
| M10 | Discord app and Slack app tokens (exact steps provided) | Adapter end-to-end tests |
| M12 | `npm login` and an npm scope | Publishing packages |
| M8–M15 (optional) | A Discord/Matrix community space; a community-bot spend cap; a paid external review | Community and launch quality |
