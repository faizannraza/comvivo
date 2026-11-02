# Kickoff: building Village with Claude Code

## One-time setup
1. Open a terminal in this folder (`~/village`).
2. Initialize git if you haven't: `git init && git add -A && git commit -m "docs: implementation plan"`.
3. Start Claude Code: `claude`. Use the strongest model available. Planning-heavy milestones (M1, M4, M5) benefit most from it.
4. Keep `CLAUDE.md` at the repo root. Claude Code loads it automatically; it is the working agreement.

## The prompt to start (paste as-is)

```
Read CLAUDE.md, docs/plan/README.md, docs/plan/STATUS.md and docs/plan/14-milestones.md §0–§2 (M0 section).
We are starting milestone M0. First, write the M0 execution note in STATUS.md (task order, risks,
anything you need from me). Then implement M0 task by task, following CLAUDE.md §1 exactly:
tests with every task, `pnpm verify` green, STATUS.md ticked, one Conventional Commit per task.
Stop and ask me before any owner decision (15 §1), any spine change, any new runtime dependency
not named in the plan, or anything that costs money or needs credentials.
When the M0 exit gate is green, write the milestone report and stop so I can review.
```

## For every later milestone

```
Read CLAUDE.md and docs/plan/STATUS.md. Continue with milestone M<n> per docs/plan/14-milestones.md.
Run its spikes first (record results in STATUS.md), write the execution note, implement tasks in order,
and stop at the exit gate with a milestone report.
```

## Tips
- **One milestone per session or a few sessions.** If the context gets long, ask Claude Code to update STATUS.md and then start a fresh session with the "later milestone" prompt. STATUS.md is the memory.
- **Review at every gate.** Read the milestone report, try the demo script in `14-milestones.md`, and answer any "Decisions needing approval".
- **Parallel work.** Only for tasks marked `parallel-ok` in `14`, such as the M10 adapters or dashboard screens. Ask Claude Code to use sub-agents for them.
- **Money.** Live-model calls (smoke tests, `pnpm evals:live`) cost API credits, so Claude Code must ask first. Get an Anthropic API key ready by M2, and a Telegram bot token by M3 (see `06` §D for the BotFather steps).
- **Before the first public tag (M8):** decide the final name (D-2). The npm name `village` is taken.
