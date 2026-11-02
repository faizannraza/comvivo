# 15 — Risks, Decisions & Open Questions

> Status: living document. It consolidates the risk register, the owner decisions still pending, the cross-document conflicts already resolved, and the spikes that must run before dependent work starts. Each subsystem spec's §11 holds its detailed open questions, with a recommended default for each. **Use those defaults unless a decision below overrides them.**

## 1. Decisions needing the project owner

These are the only items where the plan cannot proceed on a recommended default without the owner's judgment. Claude Code must not decide these. Record each answer in `STATUS.md`.

| ID | Decision | Options | Recommendation | Needed by |
|---|---|---|---|---|
| **D-1** | Which model preset the init wizard pre-selects | (a) **Best** (Opus 5.5, about $67/mo per family); (b) **Balanced** (Sonnet 5.5, about $36/mo); (c) ask with no default | (a) with the estimate shown and per-preset budgets (§14 A3 of `01`). Revisit at M13 with measured costs. If early alpha feedback shows cost shock, switch to (b). | M9 |
| **D-2** | Final product name (npm `village` is taken; see `13` §A) | Shortlist for trademark clearance: Kinhold, Folkmoot, Thorp, Commonhold, or the owner's own | Run the `13` §A clearance checklist on the top two. The name must be free on unscoped npm, an npm scope, a GitHub org, GHCR and a domain. | M8 exit (hard) |
| **D-3** | When the repo goes public | Unannounced at 0.1 alpha (M8), or at 1.0 | Go public unannounced at M8. Some community channels require project age (r/selfhosted, awesome-selfhosted). | M8 |
| **D-4** | Funding for live-model evals | Full profile (~$850/mo) / reduced (~$370/mo) / provider open-source credits | Apply for credits. Run the reduced profile until they are granted. | M2 entry per run, standing answer by M5 (live spend starts in M2; `14` §0.6) |
| **D-5** | Self-harm or abuse disclosures by minors in DMs | No automatic guardian alert in v1 (resources only), or some escalation path | No automatic alert in v1. Commission an expert review (child-safety professional) before 1.0. | M13 |
| **D-6** | Hybrid mode (sensitive routes on a local model) pre-selected when Ollama is detected and RAM ≥ 16 GB | Yes / No | Yes | M9 |
| **D-7** | Community chat home | Discord (primary) + Matrix (bridge), or Matrix-first | Discord primary, with Village itself running there on Economy and capped at $5/day | M8 entry (community-server tasks start at M8; `14` §0.6) |
| **D-8** | WhatsApp | `06` §B concludes it is out for 1.x: Meta's official platform does not support bots as members of ordinary user groups, and its AI-assistant policy is restrictive. Conditions for reconsidering are listed there. | Stay out. Re-check quarterly. Never use unofficial clients. | Quarterly review |

## 2. Cross-document conflicts already resolved

The resolutions are normative. Specs that still contain the superseded text must be read with these overrides. The consistency pass in `14` §0 fixes the text itself.

| Topic | Conflict | Resolution |
|---|---|---|
| Runtime | `01` said Node 24 LTS; `08`/`10`/`12` found Node 26 became Active LTS on 2026-10-28 | Node 26 primary, Node 24 supported (`01` §14 A1) |
| CLI name | `npx village@latest init` resolves to a third-party package | Placeholder until D-2 (`01` §14 A2) |
| Budgets | `01` default $20/mo vs `05`'s measured ~$67/mo on Best | Per-preset budgets (`01` §14 A3) |
| Confirmation entity | `05` "PendingConfirmation" vs `03` "ConfirmationRequest" | **ConfirmationRequest** (`01` §14 A7) |
| libsodium binding | `02` sodium-native vs `08` libsodium-wrappers | libsodium-wrappers default; sodium-native if the M1 benchmark is below 40 MB/s on a Pi 5 (`01` §14 A8) |
| Backup key slots | `02` master key + passphrase vs `08` backup key + recovery key | VBK1: derived backup key + recovery key + optional passphrase (`01` §14 A10) |
| Dashboard login | `09` magic link primary vs `08` pairing primary | Pairing by default; magic link on loopback, or HTTPS opt-in (`01` §14 A9) |
| HA ingress auth | `09` trust HA headers after a one-time link vs `12` never auto-trust | Link once via a bot code; never trust headers alone |
| Memory search callers | `01` §4 "only engine/context" vs the `09` memory explorer | `engine/context` + `engine/readmodels`, both with the eligible-label filter (`01` §14 A11) |
| Capability list in charter | `01` §6.3 vs `05` (cache stability) | Per-turn system message (`01` §14 A13) |
| Wizard preset recommendation | `13` Balanced vs `05`/`09` Best | Owner decision D-1 |
| Task numbering | Each spec numbered tasks independently | `14` renumbers; doc-prefixed references (`01` §14 A20) |
| Voice notes trust | `03`/`04` asked whether members' own voice notes are trusted | Untrusted in v1 (spine). Revisit after M11 evals. |
| Default embedding | e5-small vs granite-97m vs bge-m3 | Decided by the M6 bake-off (`01` §14 A18) |
| Signal polls | `07` numbered replies vs `06` native polls (signal-cli ≥ 0.13.23) | Native once the M10 spike confirms the bot receives votes; numbered replies are the fallback (`01` §14 A28) |
| Attachment download | `01` §6.1 downloads at ingest vs `06`'s 20 ms budget | `attachment.fetch` job (`01` §14 A25) |
| DM conversations | `01` one DM conversation per member vs people in several groups | One conversation per group with an active-group switcher (`01` §14 A27) |
| Load-ledger visibility | `03` templates defaulted to `everyone` vs `00` §6.3 opt-in | Default `self_only` in all templates; group-visible aggregates are opt-in |
| TurnTrace retention | `08` 30 days vs `11` 90 days | 30 days, manifests only, configurable 7–365 (`traces.retentionDays`) |
| MCP endpoint | `10` separate port 7778 vs main listener | `/mcp` on the main listener. Token format is owned by `08`, endpoint by `10` (`01` §14 A12) |
| ICS feeds | `07` vs `09` token fields and route | `07` owns semantics (per-member 256-bit hashed tokens, delivered by DM only); route `/ics/v1/` |
| MCP memory/event writes | Direct create vs proposal | They create **proposed** items that need one DM tap (taint rule, `03` §3.10.2). Revisit after M12 dogfooding |
| Reaction observation | `06` off by default (data-minimal) vs `04`, which needs reactions as extraction signals | **On** by default, within bound groups only. Reactions inherit the message label, retention and consent filtering, and are deletable with the message. Hosts and groups can switch this off. Owner may revisit. |
| Commands and buttons | `01` §6.1 sent slash commands and buttons to model turns | Deterministic `command`/`interaction` dispositions with no model call unless the command needs one (`01` §6.1) |

## 3. Risk register

Likelihood (L) and impact (I) are rated High, Medium or Low.

| ID | Risk | L | I | Mitigation | Owner doc |
|---|---|---|---|---|---|
| R-1 | **A discretion leak despite the architecture.** Inference/differential probing, guard false negatives, or a labeling bug. One public leak story would be existential. | M | H | C1 writer isolation, simulatable refusals with a probe limiter, layered guard, noninterference "twin" tests, adversarial fake models in CI, a ≥ 500-scenario red-team suite, and an external review before 1.0 | 03, 11 |
| R-2 | **Cost shock** on cloud presets, leading to bad reviews and churn | H | M | Per-preset budgets, cost shown in the wizard, a budget guard that degrades gracefully, Economy/Local presets, caching-first design | 05, 09 |
| R-3 | **Scope too large** for a small team, risking a stalled project | H | H | A strict milestone gate, an alpha at M8 (Telegram + web only), cut-lines in `14` §Cut-lines, and sub-agent parallelism only for isolated work | 14 |
| R-4 | **Native-module and packaging fragility** (SQLCipher + sqlite-vec + onnxruntime + whisper.cpp on arm64) | M | H | M1 spike with documented fallbacks, the M14 native matrix, pinned versions, an image smoke test on real arm64 | 02, 12 |
| R-5 | **Platform policy/API changes** (Slack history rate limits for non-Marketplace apps, Discord privileged intents, Telegram privacy mode, Meta AI policies) | M | M | Capability detection, adapter isolation, fix-it guides, conformance tests with recorded fixtures | 06 |
| R-6 | **Proactivity annoyance** gets the bot removed from groups | M | H | Hard caps (code constants), quiet-by-default templates, feedback learning, simulated-week evals | 07, 11 |
| R-7 | **Minors' safety and legal exposure** | L | H | Child DMs off until a guardian enables them, a kid-safe register, no advice positioning, expert review (D-5), and provider policies for minors respected (`08`) | 03, 08 |
| R-8 | **Model API drift** (betas: refusal fallbacks, per-message effort, preserved-thinking enforcement, tool changes) | M | M | Betas probed at startup with graceful fallback, an append-only tool loop, adapter contract tests, and the requirement to load the `claude-api` skill before SDK work | 05 |
| R-9 | **Naming or trademark conflict** after launch | M | M | Rename before the first public tag (D-2); a single BRAND constant with a weekly rename drill in CI | 13 |
| R-10 | **Weak plugin isolation** (Node permission model is a seat belt, not a sandbox) | M | M | Process per plugin, brokered capabilities, Node 26 for network flags, host approval, clear documentation, a container runner after 1.0 | 08, 10 |
| R-11 | **Supply-chain compromise** of a dependency or CI action | M | H | pnpm `minimumReleaseAge` (3 days), `trustPolicy`, SHA-pinned actions, an `allowBuilds` list, OSV/CodeQL/zizmor/Scorecard, signed releases, SBOMs | 08, 12 |
| R-12 | **Raspberry Pi performance** misses its budgets (embeddings, search, whisper) | M | M | Worker threads, lazy/unloaded embedder, brute-force vectors sized for groups, a Pi release protocol, a cloud transcription option | 04, 11, 12 |
| R-13 | **MCP spec churn** (2026-07-28 removed sessions; SDK v2) | M | L | An isolated `@village/mcp` package, conformance tests, bearer tokens in 1.0 | 10 |
| R-14 | **Live-eval budget** unaffordable | M | M | D-4; reduced profile; deterministic adversarial fakes carry the per-PR guarantee | 11 |
| R-15 | **Launch underperforms** (HN flop, install failures at scale) | M | M | Launch gates (≥ 95% quickstart success over ≥ 40 attempts, 0 leaks, signed images), a multi-channel launch, a staffed 72-hour rota, and a demo that costs nothing to run | 13 |
| R-16 | **Host-trust misunderstanding.** Members assume the host can't read anything | M | M | Honest in-product disclosure, a debug-content banner, the Privacy & Trust page, intro copy | 03, 08 |
| R-17 | **Data loss** (lost master key with no recovery key; failed migration) | L | H | Printed recovery key required at init, verified pre-migration backups, `restore --drill`, a weekly verify job | 08, 12 |

## 4. Spikes (must complete before dependent tasks)

| Spike | Milestone | Question | Fallback if it fails |
|---|---|---|---|
| SP-1 | M1 | Do Drizzle + better-sqlite3-multiple-ciphers (SQLCipher v4 config) + sqlite-vec + FTS5 work together on Node 26 and 24, macOS, linux/amd64 and linux/arm64? | Plain better-sqlite3 + column envelope encryption + HMAC-token FTS + an in-memory vector index (`02`) |
| SP-2 | M1 | libsodium-wrappers secretstream throughput on a Pi 5 (≥ 40 MB/s?) | sodium-native |
| SP-3 | M1 | Is the output of `VACUUM INTO` encrypted under SQLite3MultipleCiphers in WAL mode? | Online backup API + archive encryption only |
| SP-4 | M2 | Anthropic per-message effort beta + cache behavior; refusal-fallback beta behavior | Top-level effort per route (accept the cache split) |
| SP-5 | M2 | Tool catalog experiment E-CAT: full catalog vs per-role vs deferred loading | Full catalog (spine default) |
| SP-6 | M6 | Embedding bake-off (e5-small vs granite-97m vs bge-m3), with quality and RSS on a Pi | e5-small |
| SP-7 | M7 | `rrule-temporal` correctness on DST/EXDATE/overrides | `rrule` + a Temporal adapter |
| SP-8 | M10 | Do signal-cli poll votes reach the bot? Matrix E2EE library maturity | Numbered-reply polls; Matrix rooms without E2EE marked beta |
| SP-9 | M11 | transformers.js Whisper as a no-binary fallback in native mode | Require `whisper-cli` on PATH, or an API provider |
| SP-10 | M12 | Browser demo Tier 2 (real engine in a Web Worker) | Tier 1 recorded playback only |
| SP-11 | M14 | Native-module matrix on Node 26 for all images; HA watchdog on an ingress-only port | Node 24 base image |

## 5. Things we deliberately did not do (and why)

- **No hosted service.** Hosting would make the project an operator of other people's family data, which brings legal exposure and contradicts "yours" (`00` §3.5).
- **No public "discretion challenge" at launch.** It would invite abuse and uncapped cost. It runs locally instead (`13` §D).
- **No LangChain or Vercel AI SDK.** We need native provider features and the policy gate in every step of the tool loop (`05`).
- **No WhatsApp via unofficial clients, ever** (`00` §6.2).
- **No break-glass admin read of DMs.** It would be the first feature abused (`03` D2).
