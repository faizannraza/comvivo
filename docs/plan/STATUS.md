# STATUS — Village build tracker

**Current milestone:** M0 — Foundations (in progress)  
**Last updated:** 2026-11-01  
**Last green gate:** none  
**Plan:** [`14-milestones.md`](14-milestones.md) is authoritative for task IDs and order.  
**Operating mode:** autonomous (`CLAUDE.md` §5). Ask the owner only for money, credentials/account actions, or a 2-minute real-chat smoke test.  
**Repo:** https://github.com/faizannraza/comvivo (renamed from `village` on 2026-11-01 when D-2 landed; see DL-8)

## How to update this file

- **Start of a session:** read this file first. Set *Current milestone* and *Last updated* (YYYY-MM-DD).
- **Before a milestone:** fill in its *Execution note*: task order (normally the table order in `14`), which `‖` tasks go to sub-agents, spike plan, risks, and what you need from the human (credentials, hardware, money, publishing approvals). Check `14` §0.6 for owner decisions and §0.7 for open cross-doc issues.
- **Per task:** tick `[x]` only after the AC are met and `pnpm verify` is green. Append the commit hash, e.g. `- [x] M3-T5 RichText AST & parser — a1b2c3d`. Log any deviation under *Plan changes* in the same commit.
- **Spikes:** set the status (`open` → `running` → `passed` / `failed → fallback`), the decision and an evidence link.
- **Owner decisions (autonomous mode since 2026-11-01, `CLAUDE.md` §5):** the owner delegated D-1…D-8, spine changes and approvals to Claude Code, except the **money** parts (D-4 budget, paid services, domains, paid reviews), which must be asked once and recorded. At each checkpoint in `14` §0.6, decide with critical thinking and the `15` §1 recommendation. Record the answer, the rationale, the date and "Claude Code (delegated)" in the table below, and add an ADR when the decision is architectural.
- **End of a milestone:** paste the exit-gate results with numbers into *Milestone report*, list cut-lines used and known gaps, update *Last green gate*, have an independent reviewer sub-agent audit the milestone, merge it, and continue to the next milestone (no stop; `CLAUDE.md` §1.4).
- **Never** delete history. Strike through superseded text with `~~…~~` and add a dated line.

## Environment (host audit, 2026-11-01)

The build machine is the project owner's macOS arm64 laptop (Darwin 23.6.0 / macOS 14).

| Tool | Required | Found | Action taken |
|---|---|---|---|
| Node (primary) | 26 LTS | `v26.0.0` via Homebrew; **26.13.0 "Lithium"** is the current Active LTS (since 2026-10-28) | Installing 26.13.0 into `~/.local/node/v26.13.0` (official tarball; Homebrew is on a Tier-3 config here and can only build from source) |
| Node (matrix leg) | ≥ 24.11 | absent | Installing **24.22.2** ("Krypton") into `~/.local/node/v24.22.2` |
| pnpm | ≥ 11, explicit, no Corepack | absent | **12.16.1** installed with `npm install -g pnpm` (explicit, not Corepack). Pinned in `package.json#packageManager` |
| Docker Desktop | running | installed (`29.2.0`), daemon stopped | `open -a Docker` issued; first-run GUI acceptance may be needed → owner ask #4 |
| gh CLI | authenticated | `2.83.1`, logged in as `faizannraza`, scopes `repo, workflow, read:org, gist, user, delete_repo` | ready |
| git identity | set | `Muhammad Faizan Raza <faizanraza766@gmail.com>` | ready |
| Python 3 | for plan scripts | `3.14.5` | ready |
| Homebrew | — | `6.0.12`, **Tier-3 (unsupported) config**: outdated Command Line Tools, so formulae build from source | Avoid brew for toolchain; use official tarballs and npm. Owner may optionally refresh Xcode CLT (not blocking) |

**GitHub repo configured** (2026-11-01): `origin` added and `main` pushed; description and 15 topics set; Discussions enabled; Issues and Projects on; wiki off; delete-branch-on-merge on; **private vulnerability reporting enabled**; **Dependabot alerts enabled**; secret scanning + push protection confirmed enabled. Branch protection waits for `ci-ok` to exist (`M0-T21`).

## What I need from the human (open asks)

Batched per `CLAUDE.md` §5. Everything else proceeds without waiting, using the simulator, the fake/adversarial model gateways, recorded fixtures and local services.

| # | Ask | Kind | Blocks | Status |
|---|---|---|---|---|
| H-1 | Approve the API budget below (one-time approval; then I operate inside it and track spend here) | money | `M2-T19`, `M2-T20` live calls; all live evals from M5 | **open** (asked 2026-11-01) |
| H-2 | `ANTHROPIC_API_KEY` in `~/village/.env` (mode 0600, gitignored) | cred | `M2-T19` onwards; live smoke | **open** (asked 2026-11-01) |
| H-3 | Telegram bot token + a private test group containing the owner and the bot | cred | `M3-T56` real-group exit check; `M3-T32`–`T35` live verification | **open** (asked 2026-11-01) |
| H-4 | Docker Desktop first run (accept the licence dialog once so the daemon starts) | account action | `M3-T50` image build, `M10-T1` Synapse homeserver, `M14` packaging | **open** (asked 2026-11-01) |
| H-5 | Create the 5 extra GitHub Discussions categories (no API exists for this; web UI only) | account action | `M8-T27`, `M15-T15` | **open** (asked 2026-11-01) |
| H-6 | **Secure the `comvivo` assets — highest priority of all the asks.** See the steps below | account action | `M0-T15` names manifest; `M12-T34` npm trusted publishing; `ghcr.io/comvivo` | **open** (asked 2026-11-01) |
| H-7 | Optional: a domain for the docs site and product URL | money | nothing (GitHub Pages is used until bought) | **open** (asked 2026-11-01) |
| H-8 | Later, announced at their milestone: Discord + Slack apps (M10), `npm login` / trusted publishing (M12), Cloudflare Pages token for docs (M0-T18/M15), optional paid security + child-safety review (M13/M15), community-chat space + bot spend cap (M8, D-7) | mixed | their milestones | **not yet due** |

### H-1 — proposed API budget

Anthropic list prices used for the estimates (cached 2026-10-06 in `11` §8; re-verified at `M8-T22`): Opus 5.5 $4/$20 per MTok, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50, Batches −50%.

| Bucket | What it buys | When | Cap |
|---|---|---|---|
| Development smoke + spikes | `SP-4` (per-message effort + cache behaviour, refusal-fallback beta), `SP-5`/E-CAT tool-catalog experiment, per-milestone live smoke, `pnpm evals:live` spot checks | M2–M15 | **$100** |
| Gate-triggered live evals (reduced profile) | Discretion / authority / injection red-team suites plus judges on real models, run **at each milestone gate** rather than nightly | M5–M13 | **$250** |
| Full hardening run | The ≥ 500-scenario red-team at full size across Opus 5.5 / Sonnet 5.5 / Haiku 5.5 with an OpenAI cross-check; extraction F1 on the labelled multilingual corpus | M13 | **$150** |
| Release gates | `quality-gates.yml` for 0.1 alpha, 0.5 beta, 1.0, plus one launch rehearsal | M8, M12, M15 | **$100** |
| | | **Total** | **$600** |

- **Hard daily cap $40**, enforced in the eval runner: a run that would exceed the remaining budget refuses to start rather than truncating.
- **Why not the plan's nightly profile.** `11` §8 prices the full nightly profile at ≈ $850/month and the reduced profile at ≈ $370/month. Both assume a human team working over calendar months. Running continuously, the same coverage comes from gate-triggered runs at a fraction of the cost, because the deterministic adversarial fake gateways carry the per-PR guarantee by design (`15` D-4 interim behaviour). If the owner prefers a true nightly cadence, that is ≈ $370/month for the reduced profile.
- **Open-source credits.** I will verify the current Anthropic programme and hand over a prepared application; applying costs nothing. If credits are granted we upgrade to the full nightly profile at no cash cost.
- Spend is recorded in *API spend ledger* below after every live run.

### H-6 — secure the Comvivo assets

D-2 is decided (**`Comvivo`**, [ADR-024](../adr/ADR-024-product-name.md)) and the repository is already public, so the
window between the decision and securing these names is the only squatting risk in the project. All were verified free
on 2026-11-01. In priority order:

1. **GitHub organisation `comvivo`** — https://github.com/organizations/plan → Free. This also claims
   **`ghcr.io/comvivo`**, the container namespace the release pipeline publishes to. Afterwards, transfer
   `faizannraza/comvivo` into the org (Settings → Danger Zone → Transfer); GitHub keeps redirects, and `BRAND.repo`
   is the single line that changes.
2. **npm organisation `comvivo`** — needs `npm login`, then `npm org create comvivo` (free for public packages).
   This claims the `@comvivo` scope. Also claim the unscoped `comvivo` and `create-comvivo`, and defensively
   `convivo` and `create-convivo` as deprecation stubs, because English-first speakers will reach for `con-`.
   All five are currently free. Do **not** publish placeholder packages — npm discourages squatting and
   `13` §3.A.4 says real alpha builds ship at M8.
3. **Domain `comvivo.dev`** (~$12/year; this is the money part of H-7). Turn on registrar lock, DNSSEC and 2FA.
   `.org`, `.sh`, `.ai` and `.app` are also free if you want them cheaply. Until a domain exists, `BRAND.urls`
   point at GitHub Pages.
4. **Handles**: X `@comvivo`, Mastodon `@comvivo@fosstodon.org`, LinkedIn `/company/comvivo`, and — once the
   domain exists — the self-verifying Bluesky **domain handle** `@comvivo.dev`. All verified free.

**Also worth doing, but not blocking:** the formal trademark registers could not be searched without a human. Every one
refused automated access — USPTO's search is an interactive SPA with no documented wordmark field, TSDR needs an API
key, EUIPO/TMview sits behind a WAF, WIPO behind a proof-of-work challenge, UKIPO behind a CAPTCHA. **Trademarkia
returned zero results for `comvivo`**, which is a strong substitute but **not a clearance opinion**. If you want the
real thing: run `comvivo` in classes 9, 38, 42 and 45 at https://tmsearch.uspto.gov, https://www.tmdn.org/tmview/ and
https://branddb.wipo.int/, and optionally buy a one-hour attorney knockout opinion (money, offered not required). The
one residual worth raising with an attorney is VIVO, the handset maker, which holds class-9 marks — COMVIVO is a
unitary coined word rather than "Vivo" with a prefix, and *vivo* is a weak common Romance word used by many unrelated
brands, but it is the only adjacency found.

### API spend ledger

| Date | Milestone / task | Route(s) | Model(s) | Cost (USD) | Running total |
|---|---|---|---|---|---|
| — | no live calls yet | — | — | 0.00 | 0.00 |

## Decisions needing approval

Owner decisions from [`15` §1](15-risks-and-open-questions.md#1-decisions-needing-the-project-owner). **Delegated to Claude Code** (autonomous mode, `CLAUDE.md` §5): decide at the checkpoint in `14` §0.6 and log the rationale. Only the money parts are asked of the owner. D-2 (name) is pulled forward to M0 because the repo is already public.

| ID | Decision | Ask at | Needed before | Status | Answer | Decided by / date |
|---|---|---|---|---|---|---|
| [D-1](15-risks-and-open-questions.md#1-decisions-needing-the-project-owner) | Wizard pre-selected preset | M3 (inform), M9 entry | M9-T32; revisit at M13-T25 | open | — | — |
| [D-2](15-risks-and-open-questions.md#1-decisions-needing-the-project-owner) | Final product name | **M0** (pulled forward by the owner 2026-11-01, because the repo is already public and renaming later is expensive) | M0-T5 `BRAND`; M8 exit hard | **decided** | **`Comvivo`** — *com* (with) + *vivo* (I live): "living together", the root of *convivial*. A coinage with **zero** Trademarkia results and zero prior software use. All four `13` §3.A.3 shortlisted names failed clearance, and two later candidates (**Folkstead**, **Commonry**) were chosen and reversed — see DL-8. Evidence and risks in [ADR-024](../adr/ADR-024-product-name.md); unredacted in the gitignored `naming/`. Repo renamed to `faizannraza/comvivo` | Claude Code (delegated) / 2026-11-01 |
| [D-3](15-risks-and-open-questions.md#1-decisions-needing-the-project-owner) | When the repo goes public | M8 entry | M8-T28 | **decided** | Already public (2026-11-02). Stays public but **unannounced**; no launch posts until the 1.0 launch gates pass. `M8-T28` becomes "announce-readiness check", not a visibility flip | Claude Code (delegated) / 2026-11-01 |
| [D-4](15-risks-and-open-questions.md#1-decisions-needing-the-project-owner) | Funding for live-model evals | M2 entry (per run), M5 entry (standing) | M8-T22 | **asked (money)** | Budget proposal H-1 above: $600 total with a $40/day hard cap, gate-triggered instead of nightly. Awaiting owner approval; no live call is made before it | owner (money part) |
| [D-5](15-risks-and-open-questions.md#1-decisions-needing-the-project-owner) | Minors' self-harm/abuse disclosures in DMs | M5 (inform), M13 entry | M13-T30, 1.0 | **decided** | **No automatic guardian alert in v1.** Resources-only response with carefully reviewed copy. No guardian-escalation code path is built. Paid external child-safety review is offered to the owner as a money item and never blocks the gate; the automated substitute is a dedicated red-team family plus a documented limitation | Claude Code (delegated) / 2026-11-01 |
| [D-6](15-risks-and-open-questions.md#1-decisions-needing-the-project-owner) | Hybrid mode pre-selected (Ollama + ≥ 16 GB) | M9 entry | M9-T32 / M9-T33 | open | — | — |
| [D-7](15-risks-and-open-questions.md#1-decisions-needing-the-project-owner) | Community chat home | M8 entry | M8-T27, M10-T24; confirm at M15 | **decided** | **GitHub Discussions is the guaranteed baseline** and ships at 1.0 (enabled 2026-11-01). A Discord space is the recommended addition but needs the owner's account, so exact steps are handed over at M8; running Village itself there is a money item with a proposed **$5/day / $30/month cap** on the Economy preset. Matrix bridge is post-1.0 | Claude Code (delegated) / 2026-11-01 |
| [D-8](15-risks-and-open-questions.md#1-decisions-needing-the-project-owner) | WhatsApp | Quarterly (M4, M8, M12, M15 entry) | — (stays out of 1.x unless decided) | **decided** | **Out of 1.x.** Meta's official platform still does not support bots as members of ordinary user groups, and unofficial clients are permanently excluded (`00` §6.3). Re-check recorded at M4, M8, M12 and M15 entry | Claude Code (delegated) / 2026-11-01 |

**Other approvals** (spine changes, owner-level questions, new runtime dependencies, spend, publishing):

| # | Date | Item | Raised by task | Status | Answer |
|---|---|---|---|---|---|
| A-1 | 2026-11-01 | `@village/mcp-bridge` is not in 12's P11 public-package set but must be installable by members (`14` §4.3 item 9) | before M12-T19 | **resolved** (planner, 2026-11-01) | Added to 12 P11. There are now six public packages; publishing still needs owner approval at release time |
| A-2 | 2026-11-01 | 0.5 beta checklist items that 12 schedules in M14 (overlays, N-3 upgrade matrix, runbooks, sizing): waive for 0.5 or pull forward (`14` §3.2) | before M12 exit | **resolved** (planner default, 2026-11-01; owner may override) | **Pulled forward to M12:** the default compose file, an upgrade test from the previous release (N-1), and the backup/restore + "bot stopped responding" runbooks (data safety for beta testers). **Deferred to the 1.0 checklist:** the N-3 upgrade matrix, the Ollama/Caddy/signal-cli/rclone overlays, the full runbook set and the sizing guide |

## Decisions log

Every significant delegated decision, with its rationale. Architectural decisions also get an ADR in `docs/adr/`.

| # | Date | Decision | Rationale | ADR |
|---|---|---|---|---|
| DL-1 | 2026-11-01 | **D-3 — repo stays public but unannounced.** | The owner created the repository as public and instructed that it stay unannounced until the 1.0 launch gates pass. `15`'s recommendation was "public unannounced at M8", so this is the same posture, reached earlier. Consequence: `M3-T52` edge images must push to a namespace that is not advertised, and `13` §3.A.3's name shortlist is redacted from the public tree so the candidates cannot be squatted. | — |
| DL-2 | 2026-11-01 | **D-8 — WhatsApp stays out of 1.x.** | `06` §B's conclusion is unchanged: Meta's WhatsApp Business Platform does not support bots as members of ordinary user groups, and its AI-assistant policy is restrictive. Unofficial clients (Baileys, whatsapp-web.js) are a permanent "never" (`00` §6.3) on terms-of-service and legal grounds. | — |
| DL-3 | 2026-11-01 | **D-5 — resources-only response to minors' disclosures; no automatic guardian alert.** | This is the safest design and the one every option in `15` D-5 includes, so building it exclusively forecloses nothing. An automatic alert can out a child to the person harming them, and Village cannot verify who a "guardian" actually is. Building no escalation code path at all is also the only way to be sure one cannot be triggered by prompt injection. A paid expert review is offered but never gates the release; the automated substitute is a dedicated red-team family plus an honest documented limitation. | pending (M5) |
| DL-4 | 2026-11-01 | **D-7 — GitHub Discussions is the community baseline.** | It needs no new account, no hosting, no moderation bot and no spend, and it is indexable, which matters for support SEO. Discord is additive and is handed to the owner as a short set of steps at M8. Running Village in its own community is excellent dogfooding but is real money, so it carries a proposed cap. | — |
| DL-8 | 2026-11-01 | **D-2 — the product is `Comvivo`.** Two earlier choices (**Folkstead**, **Commonry**) were made and reversed on the way. | *com* (with) + *vivo* (I live) = "living together", the root of *convivial*: the product's thesis and its tone target in one coined word. Zero Trademarkia results, zero prior software use, and every surface free — npm `comvivo` and `create-comvivo`, the `@comvivo` scope, the typo-space (`convivo`), the GitHub org (so `ghcr.io/comvivo`), zero matching repositories, `.dev`/`.org`/`.sh`/`.ai`/`.app`, PyPI, crates.io, Hugging Face, Mastodon, LinkedIn, Bluesky.<br><br>**All four `13` §3.A.3 shortlisted names failed**, three because an active product already occupies this exact category under senior common-law rights that no trademark register records — the failure mode a registry-only check cannot see.<br><br>**Reversal 1 — Folkstead.** It cleared every availability and trademark check perfectly and was decided, documented and applied. It was reversed within the hour on a register finding surfaced by the Folkmoot report: "folkish" (German *völkisch*) is the self-applied label of the racist branch of Germanic Heathenry, and **"stead" is a documented Heathen term for a kindred** (Asatru Alliance: "Kindreds are sometimes called a garth, **stead**, or skeppslag"), with "folk-" as that movement's marker prefix (cf. the Asatru **Folk** Assembly; the SPLC's "Neo-Völkisch" category). No actual far-right use of "folkstead" exists — the risk is a latent reading — but it is unfixable by explanation, it lands on a product whose whole pitch is inclusive shared belonging, and avoiding it cost one hour before any product code existed.<br><br>**Reversal 2 — Commonry.** Clean on npm and the GitHub org, then found to have a **live registered COMMONRY mark in International Class 009** (downloadable software) plus a live-pending one in class 045. This is where the method was corrected: **screen trademark and same-category products first, availability second** — those two checks are the only ones that kill a name outright and both are cheap.<br><br>**Two findings supersede `13` §3.A.2–§3.A.3 for any future rename.** (1) The entire Anglo-Saxon/Norse revivalist register is off-limits: *folk-*, *moot*, *stead*, *garth*, *hearth*, *kindred*, *thing*, *frith*, *troth*, *thorp*, *kith*, *kin*. §3.A.3's whole candidate family drew from that one well, which is why waves 1 and 2 both failed. (2) Every apt dictionary word or obvious compound in this space is already claimed by someone building something adjacent, so **only a genuine coinage is reliably free** — which is also the strongest mark class, and what Immich, Jellyfin, Forgejo, Traefik, Umami and Ollama all did. | [ADR-024](../adr/ADR-024-product-name.md) |
| DL-9 | 2026-11-01 | **TypeScript is pinned to 6.0.3, not 7.x.** | `typescript-eslint@8.72.1` declares a hard peer of `typescript >=4.8.4 <6.1.0`, and TS 7 support is closed `not_planned` upstream pending a stable TS 7 JavaScript API (typescript-eslint#12518, #10940; TS 7.0.2 ships no `tsserver` binary and no `lib/typescript.js`). The four type-aware rules the spine makes non-negotiable — `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `strict-boolean-expressions` — only exist there; Biome's equivalents are nursery-grade with `information` severity and cannot carry a gate. A working lint gate on an event-driven server is worth more than being on the newest compiler, so TS 6 it is. Revisit when typescript-eslint#12803 (TS 7.1 native-parser support over IPC) lands. | [ADR-025](../adr/ADR-025-typescript-version-pin.md) |
| DL-10 | 2026-11-01 | **pnpm settings live in `pnpm-workspace.yaml`, and `allowBuilds` replaces `onlyBuiltDependencies`.** | pnpm 11 moved every setting except auth/registry/TLS/proxy out of `.npmrc`, and pnpm 11 **removed** `onlyBuiltDependencies`, `neverBuiltDependencies`, `ignoredBuiltDependencies` and `ignoreDepScripts` in favour of the `allowBuilds` *map*. `strictDepBuilds` now defaults to `true`, so any package with an install script that is not listed hard-fails the install — which is exactly the behaviour `08` §3.15 wanted and had to ask for explicitly. `minimumReleaseAge` is in **minutes** (4320 = 3 days) and already defaults to 1440. Corepack is gone from Node ≥ 25, and pnpm now reads `devEngines.packageManager` itself, governed by `pmOnFail`. `08` §3.15's YAML block is updated to the current spelling. | — |
| DL-11 | 2026-11-01 | **`--allow-net` cannot implement the guarded-egress allowlist; the in-process allowlist stays load-bearing.** | `01` §14 A1 treats `--allow-net` (Node ≥ 25) as the plugin network-isolation mechanism and records weaker isolation on Node 24 as the residual risk. Verified on Node 26: the flag is **boolean, all-or-nothing, with no host or port scoping** (`AddOption("--allow-net", …, BOOL_FIELD(allow_net))`; per-host scoping is only a proposal, nodejs/node#67115). So on *every* Node version, invariant **I5 (guarded egress)** must be enforced by `shared/net`'s `safeFetch` allowlist, and `--allow-net` is only a coarse second layer. This strengthens rather than weakens A1, and the residual-risk wording in `08` is corrected accordingly. | — |
| DL-5 | 2026-11-01 | **pnpm 12.16.1, not pnpm 11.** | `08` §3.15 and `01` §14 A1 require "pnpm ≥ 11, pinned by `packageManager`, installed explicitly, never Corepack". pnpm 12 is the current major, satisfies "≥ 11", and the supply-chain settings the plan depends on (`minimumReleaseAge`, `trustPolicy`, build allowlisting) are present and better documented there. Logged as a Plan change rather than a spine change because the spec states a floor, not a pin. | — |
| DL-6 | 2026-11-01 | **Node pins: 26.13.0 primary, 24.22.2 matrix leg.** | `01` §14 A1 names "Node 26 primary, Node 24 ≥ 24.11 supported". 26.13.0 is the Active LTS ("Lithium", since 2026-10-28) and 24.22.2 is the newest 24.x, so these are the concrete versions behind A1. `.node-version` holds `26` so minor bumps need no commit. | — |
| DL-7 | 2026-11-01 | **Homebrew is not used for the toolchain.** | Homebrew 6.0.12 reports this macOS/CLT combination as a Tier-3 (unsupported) configuration and therefore builds every formula from source, which failed for both `pnpm` and `fnm`. Official Node tarballs plus an explicit global `pnpm` install are reproducible and match what CI does. Recorded so a future session does not retry brew. | — |

## Plan changes

| Date | Task | File § | Change | Reason |
|---|---|---|---|---|
| 2026-11-01 | M0 entry | `08` §3.15, `01` §14 A1 | Toolchain pins recorded concretely: pnpm **12.16.1**, Node **26.13.0** primary / **24.22.2** matrix. The specs state floors ("pnpm ≥ 11", "Node 26 / ≥ 24.11"); these are the versions that satisfy them today | Re-verification of third-party facts at implementation time (`CLAUDE.md` §6). See DL-5, DL-6 |
| 2026-11-01 | M0 entry (D-2) | `14` §0.6, `15` §1 | **D-2 (final name) is pulled forward from M7/M8 to M0** | Owner instruction, 2026-11-01: the repository is already public, so renaming later is expensive. Consequence: `M0-T1` scaffolds packages directly under the final npm scope instead of `@village/*`, and `M0-T22` (naming kickoff) is folded into the M0 decision. `BRAND`, the AST guard, the codemod and the weekly rename drill are still built exactly as `13` §3.A.6 specifies, so a forced change stays a one-command operation |
| 2026-11-01 | M0 entry (D-2) | `13` §3.A.3 | The candidate shortlist table is **redacted from the public tree** and kept in the gitignored `naming/` workspace | `13` §3.A.5 requires redaction before the repo is public so nobody squats the candidates. The repo is already public, so this is done immediately rather than at M8 |
| 2026-11-03 | M0-T8 | `08` §3.7.11, §3.10 | The project's own token prefixes (`vs1_`, `vmcp_`, `vml1.`, `vlp_`, `vics_`, `vctl_`, `VLG-`, `VRK1-`) are **codename-derived** — the `v` is for "village". Kept verbatim in the scrubber so the canary matches the spec exactly; **re-deriving them from `BRAND` is assigned to `M1-T29` (`TokenService`)** | `M1-T29` is the task that mints them and the last moment the change is free: once a token exists in a host's `data/keys/` or a session row, changing the prefix becomes a migration. Changing them now would also desynchronise the scrubber from `08`'s stated patterns while nothing yet produces one |
| 2026-11-03 | M0-T8 | `11` §3.10.1 | `log.content()` writes through a **separate pino instance with no redaction**, rather than the main one | The spec already requires a separate destination ("never writes to the log file, only to stdout"), and the implementation forces the issue: the redaction that protects the normal channel strips exactly the fields `content()` exists to show. Two instances means the normal channel's protections can never be loosened to accommodate the debug one — found when the redaction layer correctly blocked the deliberate content path |
| 2026-11-03 | M0-T8 | `11` §3.10.1 | Added **depth-unlimited forbidden-field stripping** as a third layer, keyed off `FORBIDDEN_FIELD_NAMES`, and listed every redact path twice (bare and `*.`-prefixed) | pino's `*` matches exactly **one** segment, so `*.text` never matches a top-level `text` — which is the most likely shape of the mistake the layer exists to catch. Found by a test, not by reading: a root-level `text` field was reaching the output. The strip pass also makes the documented forbidden list enforcement rather than documentation |
| 2026-11-03 | M0-T8 | `11` §3.10.1, `01` §10 | Added `logging.file.{enabled,path,maxSizeMib,keep}` to the config schema, **off by default**, 5 × 10 MiB | The AC requires "file rotation off by default" and the key did not exist. Off is the right default: stdout is captured by Docker, systemd and every process manager a host is likely to use, so a file is redundant almost everywhere while being one more place content could land. The transport itself is wired in `M3-T14` |
| 2026-11-03 | M0-T9 | `11` §3.10.2, `01` §14 **A32** | **The GenAI Opt-In content attribute set is 15, not the 6 the spec listed** — nine were added to the registry in the **two days** between the plan being written (2026-11-01) and this task. The denylist is therefore **11 prefix families**, encoded as template-literal types so `Attributes` refuses an attribute the registry has not invented yet; the 15-name snapshot exists only so a test can prove the families still cover it | The additions are not cosmetic: `gen_ai.memory.records` and `gen_ai.retrieval.documents` are exactly what `01` §11.7 forbids, and the four `_ref` variants are content by reference — a URL pointing at the prompt is the prompt to whoever reads the trace. An exact-match denylist against a Development-status registry falls behind in days, and fails **silently**: it looks complete right up to the moment a new name makes a leak typecheck. Families stay narrow (`gen_ai.output.messages`, not `gen_ai.output.`) because `gen_ai.output.type` is legitimate and an over-matching guard gets switched off |
| 2026-11-03 | M0-T9 | `08` §3.10 | **`scrubSecretShapes` could never match a Telegram token in the one form it actually takes.** The pattern was `\b\d{6,12}:…`, but Telegram's URL is `/bot<id>:<secret>/`, so the first digit is preceded by the `t` of `bot` — two word characters with no boundary between them. Changed to `(?<!\d)`, which keeps the property `\b` was there for while allowing a letter immediately before. Two regression tests added | Found by a new consumer, not by reading: `scrubErrorMessage` reduces URLs to `scheme://host/…` **before** reaching the shape patterns, so every existing test passed and the weakness was invisible. `observability/attributes.ts` calls `scrubSecretShapes` on its own, where nothing runs first. The module's own doc comment calls Telegram "the canonical example" — the pattern written for it was the one that could not fire. Third instance of this project's governing failure mode: a guard that reports success while enforcing nothing |
| 2026-11-03 | M0-T9 | `11` §3.10.3, §8 | The metric catalog is **declarative** (33 metrics with type, labels, help, buckets) and histogram **bucket edges carry the budget boundaries** from `01` §11.10 and `00` (0.02 s, 4 s, 10 s, 300 s). The `~5,000 series` budget is met **only because `route`, `provider` and `model` are correlated**: treating them as independent gives ~15,600, and the test now models the correlation explicitly | `histogram_quantile` interpolates *inside* a bucket, so a budget that is not an edge is reported as a guess whose error depends on bucket width — "p95 reply ≤ 4 s" is only checkable if 4 is an edge. The cardinality finding is a standing constraint rather than a calculation: the model family is ~1,280 of the budget, so one more *independent* label on it with a dozen values would exceed 5,000 on its own. The test asserts the total and requires every label to come from a closed set, so an unbounded label fails instead of quietly inflating a host's Prometheus. First attempt at the test multiplied independent maxima of correlated labels and failed at 15,638 — the model was wrong, not the budget |
| 2026-11-03 | M0-T9 | `13` §3.A.6 | **The brand guard has a blind spot:** its globs are `packages/**` and `apps/**` only, so `scripts/**`, `test/**` and the root config files are unscanned. Measured: **46 literals across 20 files**. Most are `test/boundaries/**`, which synthesises a package tree and is arguably legitimate; the real hazards are `COMVIVO_TEST_MODE` in `vitest.config.ts` and `vitest.setup.ts` and `COMVIVO_ALLOW_NETWORK` in `vitest.setup.ts`. **Assigned to `M0-T19`** (rename codemod + weekly drill), which owns tree-wide coverage | Recorded with the number so `M0-T19` starts from measurement rather than discovery. Not fixed here because the drill's correctness is that task's deliverable and because the fix has a real design question attached — importing `BRAND` into `vitest.config.ts` couples the test runner's configuration to package source that has not been built yet, which is a decision the codemod design should make deliberately. Found because the guard correctly flagged ten literals in this task's own new files |
| 2026-11-03 | M0-T8 | `08` §3.15 | **GitHub push protection rejected the M0-T8 push** (`GH013`, "Slack API Token") because the scrubber's canary fixtures contained real-shaped tokens written out whole. Fixed by assembling every canary at **runtime from separate string literals**, not by allowlisting the detection. Added `pnpm secrets:check` (`scripts/security/literal-secrets.ts`, 10 high-confidence shapes, 17 tests) to `pnpm verify` so this is caught locally in a second instead of after the work is done | The scrubber cannot be tested without fixtures of the exact shapes it must catch, so this collision was structural, not a slip — and it recurs at scale: `M5` adds 500+ red-team scenarios and `M11` adds media and email injection fixtures, each a file full of deliberately dangerous-looking strings. Runtime assembly resolves it cleanly: the code under test receives the identical shape because the pieces are joined before they are passed in, while the source text never contains it. Allowlisting was the wrong fix — clicking through a secret-scanning block is a habit worth not forming, because the next block might be a real key. The guard's failure message names the alternative and points at `scrub.test.ts`, since a guard that only says "no" gets disabled |
| 2026-11-03 | M0-T8 | `11` §3.1.x | The guard's test suite spends **half its cases on false positives** — TypeIDs, UUIDv7s, git SHAs, `sha512-` integrity hashes, docker digests, ISO timestamps, `data:` URIs, Tailwind class lists — and asserts every pattern is anchored on a distinctive prefix or separator rather than on entropy | A guard in `pnpm verify` that fires on ordinary code is disabled within a week, after which it protects nothing. Entropy alone cannot distinguish a credential from a content hash, and this repository is full of the latter: every `pnpm-lock.yaml` line, every TypeID in a test, every image digest in a compose file |
| 2026-11-02 | M0-T7 | `11` §3.1.7 | **`VirtualClock.advance` takes *elapsed* time and refuses calendar units** (weeks, months, years). Calendar arithmetic goes through `advanceTo(ZonedDateTime)` | `Temporal.Instant.add()` rightly rejects date units: across a DST transition a calendar day is 23 or 25 hours, and a month is 28–31 days. Silently approximating would fire a weekly recap on the wrong day twice a year and a morning brief at the wrong local hour — for a product whose users are families split across timezones, that is the bug. A day is accepted as exactly 24 h, which is what "elapsed" means; `advanceTo(ZonedDateTime)` is where a zone exists to resolve calendar semantics |
| 2026-11-02 | M0-T7 | `11` §3.1.7 | `pure-rand` v8 exposes **only deep subpaths** (`pure-rand/generator/xoroshiro128plus`), has no root export, and its generator API is now **mutable** (`next(): number`, not a tuple). Uniform integers are drawn by rejection sampling here rather than through its distribution helper | Recorded because `11` §3.1.7 was written against the older tuple API, and a future reader would otherwise assume the tuple form. Rejection sampling is also the right call independently: `next() % n` is biased toward low values whenever `n` does not divide 2³², and in a fairness algorithm that bias is precisely the bug the algorithm exists to prevent — the member who sorts first would draw marginally more chores forever |
| 2026-11-02 | M0-T6 | — | Base error class renamed `ComvivoError` → **`AppError`** | A brand-named class couples a source identifier to the product name: the rename codemod has to rewrite it, and the string form shows up in every test that names it — which the brand guard correctly flagged. The brand belongs in `BRAND` and nowhere else (`13` §3.A.6). Subclasses (`ConfigError`, `ValidationError`, `BugError`, `IoError`, `TimeoutError`) are the names that actually appear in a stack trace and are unchanged |
| 2026-11-02 | M0-T6 | ADR-014 | Environment-variable names are **derived from the schema** rather than maintained by hand, via zod's JSON Schema export | ADR-014 puts env at the top of the precedence chain but does not say how a variable maps to a path. A hand-written mapping would drift the moment a key was added — the key would silently have no env override and nobody would notice until a host filed a bug. Deriving it means a new key gets its variable for free, the generated env reference (`M3-T54`) cannot disagree with the loader, and a `collisions()` test makes an ambiguous pair of names a build failure. Currently 73 leaves, 0 collisions |
| 2026-11-02 | M0-T6 | — | **`isolatedDeclarations` switched off** in `tsconfig.base.json`. Every other strictness flag stays (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals`/`Parameters`) | It conflicts structurally with ADR-010, which puts **zod at every boundary**: an exported schema's inferred type is enormous and not writable by hand, so `isolatedDeclarations` would force a hand-maintained type beside every schema — strictly worse code, and a second thing to keep in sync. Its two benefits do not apply here: faster `.d.ts` generation is irrelevant at a 6-second build, and "forces explicit public API types" is exactly what zod inference already does better. Chosen in `M0-T1` before any zod existed; reversed on contact with the first schema |
| 2026-11-02 | M0-T5 | `13` §4.1 | `Brand.urls.discord` renamed to **`urls.community`** | D-7 (DL-4) chose GitHub Discussions as the guaranteed community baseline, with a chat space additive and dependent on the owner's account. A field literally called `discord` would either hold a Discussions URL — which is a lie in the type — or sit empty and tempt someone to treat the absence as "no community". `urls.community` is the thing it actually is |
| 2026-11-02 | M0-T4 | `14` §2 M0-T4 AC (`biome.json`) | Renamed to **`biome.jsonc`** | `CLAUDE.md` §7 requires a justification comment beside every lint suppression, and JSON has no comments. Two rules are switched off and both needed explaining next to the switch: `complexity/useLiteralKeys` contradicts TypeScript's `noPropertyAccessFromIndexSignature` (Biome wants `process.env.FOO`, TypeScript requires `process.env['FOO']`), and `suspicious/noUndeclaredEnvVars` reads `.env` files that are gitignored here, so it cannot work in CI — the zod config schema is the authoritative declaration instead |
| 2026-11-02 | M0-T4 | — | **ESLint needed a `globals` block or several security bans were inert.** `no-implied-eval` only fires when `setTimeout`/`setInterval` resolve to *declared* globals; with none declared it reported nothing at all | Found by the ban test, not by reading the config. A lint rule that is configured but silently matches nothing is the worst kind of guard — it reads as protection in review and provides none. `globals.node` + `globals.es2024` repo-wide, `globals.browser` for the dashboard. Generalises to the same lesson as the dependency-cruiser `/dist/` bug: **assert that a guard fails on a planted violation, never that it is configured** |
| 2026-11-02 | M0-T4 | — | Planted-violation fixtures use a **synthetic package tree** in a temp directory rather than files under `test/fixtures/` | Almost every boundary rule is keyed on the *importing* module's path (`from: '^packages/core/'`), so a fixture living under `test/` can never match one. The alternatives were to plant files into the real packages during the run — which mutates the working tree and races with parallel test files — or to build a throwaway tree whose paths look real. The harness symlinks the repo's `node_modules` so npm dependency types classify identically, which is what makes the `no-dev-dep-in-src` fixture possible at all |
| 2026-11-01 | M0-T3 | `11` §3.1.3 | **The "bench (Vitest 5 benchmark project)" project is not implementable.** Two verified limitations in Vitest 5.0.5: `benchmark` is listed in `UnsupportedProperties` for project configs, so a per-project benchmark block is rejected; and the `bench` API is unreachable — not exported from `vitest`, `vitest/runtime` or `vitest/node`, not injected as a global even with `globals: true`, and no `@vitest/bench` or `@vitest/benchmark` package exists (both 404). Benchmark **globs** are configured at the root so the files have a home, and `pnpm bench` prints a notice naming `M1-T32`. Five projects run today: unit, integration, contract, scenario, dashboard | Measured, not inferred — each route was tried. `M1-T32` owns bench infrastructure and now also owns the choice of harness. A purpose-built harness is likely right anyway: `01` §11.10 and `11` §8 specify **percentile** budgets (ingestion < 20 ms p95, context build < 150 ms p95) over realistic workloads, which a micro-benchmark runner measures poorly |
| 2026-11-01 | M0-T3 | `11` §3.1.3 | **`TZ=UTC` must be set in Vitest's main process, not in a setup file.** Pinned at the top of `vitest.config.ts`, before any worker forks | A setup-file assignment sets the variable but does **not** change behaviour: a worker receives a copy of `process.env`, so the assignment never triggers Node's timezone-change notification. The suite then reported `TZ=UTC` while formatting dates in the host's zone — `new Date('2026-07-01T12:00:00Z').getHours()` returned 5 (PDT) instead of 12. Caught only because `scripts/harness/network-guard.test.ts` asserts the **behaviour** rather than the variable. Generalises: assert what a guarantee does, not that it was configured |
| 2026-11-01 | M0-T2 | `08` §3.15 | **`allowBuilds` gains `esbuild: true`**, and the YAML block is updated to pnpm 11+ reality: a note that these settings live in `pnpm-workspace.yaml` rather than `.npmrc`, that `minimumReleaseAge` is in **minutes**, that `allowBuilds` replaced the removed `onlyBuiltDependencies`, and the addition of `pmOnFail: error`. The block now also points at `scripts/supply/native-policy.ts` for the parts YAML cannot express | `08` §3.15's list covered only runtime native modules. `esbuild` reaches the tree as a dev-only transitive dependency of `vite` and `tsx`, and with `strictDepBuilds` on (now a pnpm default) an unlisted install script is a hard error, so the toolchain could not install at all without it. It is never shipped to users. The AC says "`allowBuilds` equals 08 §3.15 exactly", so the spec is amended rather than the policy quietly widened |
| 2026-11-01 | M0-T2 | new `docs/adr/MINI-001-yaml.md` | **New dependency `yaml`** (eemeli, ISC), added as a root devDependency and promoted to a `@comvivo/shared` runtime dependency in `M0-T6` | ADR-014 makes `comvivo.yaml` the configuration format, so the config loader needs a parser; `scripts/supply/native-policy.ts` needs one immediately. Mini-ADR per `14` §0.5 rule 6. `js-yaml` was rejected because it cannot preserve comments, which the dashboard's constitution editor needs in order to round-trip a host's file |
| 2026-11-01 | M0-T2 | `14` §2 M0-T2 AC | The AC's "installing a < 3-day-old version fails (test)" is satisfied in **two** parts, because the real behaviour needs the network and `11` §3.1.1 forbids that in the L1–L4 tiers: (a) `scripts/supply/native-policy.test.ts` asserts the policy deterministically and proves each check fails when weakened; (b) the live behaviour was **observed and captured** in `docs/architecture/evidence/m0-t2-minimum-release-age.md` | Honest substitution rather than a test that needs the registry. The live capture is real evidence, not an estimate: the policy rejected `eslint@10.14.0` in a committed lockfile, and a fresh resolution then chose `eslint@10.13.0` and `dependency-cruiser@18.7.0` with no manual pin |
| 2026-11-01 | M0 entry (D-2) | `13` §3.A.2, §3.A.3 | **Two naming findings recorded as superseding guidance.** (1) The Anglo-Saxon/Norse revivalist register is off-limits for this product — *folk-*, *moot*, *stead*, *garth*, *hearth*, *kindred*, *thing*, *frith*, *troth*, *thorp*, *kith*, *kin* — because "folkish" (*völkisch*) is the self-applied label of the racist branch of Germanic Heathenry and several of those words are its vocabulary for a local worship group. (2) Only a genuine coinage is reliably free in this semantic space. Procedurally, screen trademark and same-category products **first** | §3.A.3's entire shortlist drew from the contaminated register, which is why all four names plus the first replacement failed. Discovered while clearing Folkmoot; verified against Asatru Alliance and SPLC sources. Recorded so a future rename does not repeat it |
| 2026-11-01 | M0 entry | `01` §14 (new **A31**), `08` §3.15 | **Spine amendment A31** records the toolchain facts re-verified per `CLAUDE.md` §6: TypeScript pinned to 6.x (ADR-025), concrete Node pins, the `--allow-net` correction, pnpm 11+ settings relocation, Vitest 5 `test.projects`, and two upstream repo renames. `08` §3.15's pnpm pinning paragraph rewritten to `devEngines.packageManager` + `pmOnFail`. Spine text changed under delegated authority (`CLAUDE.md` §5 lists spine changes); logged here and as DL-9/DL-10/DL-11 rather than queued for approval | Five of the plan's third-party facts had moved since 2026-11-01, and two of them (typescript-eslint vs TS 7; `vitest.workspace.ts` failing silently) would have broken the M0 gate |
| 2026-11-01 | M0-T23 | `14` §0.4 | The serial-only rule's "every database migration" is now scoped **by name**: a `migrations/` or `migrate/` path segment, not any occurrence of the word *migration* | `scripts/plan/trace.py --check` flagged `M3-T34` (`packages/channels/telegram/src/{membership,migration,probe,webhook}.ts`) as a serial violation. That file handles Telegram's group→supergroup chat-id change, not a schema migration. §0.4's prose already said "**database** migration"; only the enforceable scope was missing |
| 2026-11-01 | M0-T23 | `14` §2 M4 table | `M4-T5`, `M4-T6` and `M4-T7` re-tagged from `‖` to `—` | All three write to `packages/core/src/{constitution,governance}`, which `14` §0.4 and `CLAUDE.md` §1.5 require to stay serial on the main thread. §0.4 already overrode the tag, so the `‖` marks were actively misleading. Their neighbours `M4-T1`–`M4-T4`, `M4-T8`, `M4-T9`, `M4-T13`, `M4-T18` and every M5 IFC row were already correct, so these were oversights |
| 2026-11-01 | M0-T23 | `14` §4 | Added `<!-- BEGIN:TRACE-MATRIX -->` / `<!-- END:TRACE-MATRIX -->` markers around §4's body | `--regen-matrix` is specified to write between markers and refuses to restructure the document itself. Without them it could only print to stdout |
| 2026-11-01 | M0 entry | docs 02–13 (global) | Where the specs write `@village/<pkg>`, read `@<final-scope>/<pkg>`. Package *directory* names and spec section numbering are unchanged | Avoids rewriting 2.5 MB of plan text for a scope rename. `BRAND.npmScope` is the single source of truth and the codemod keeps the two in sync |

## Spikes

| Spike | Milestone / task | Question | Fallback if it fails | Status | Decision & evidence |
|---|---|---|---|---|---|
| SP-1 | M1 / M1-T2 | Drizzle + better-sqlite3-multiple-ciphers (SQLCipher v4) + sqlite-vec + FTS5 on Node 26/24 × macOS, linux/amd64, linux/arm64 | Plain better-sqlite3 + column envelope encryption + HMAC-token FTS + in-memory vector index (02) | open | — |
| SP-2 | M1 / M1-T4 | libsodium-wrappers secretstream throughput on a Pi 5 (≥ 40 MB/s?) | sodium-native | open | — |
| SP-3 | M1 / M1-T2 | Is `VACUUM INTO` output encrypted under SQLite3MultipleCiphers in WAL mode? | Online backup API + archive encryption only | open | — |
| SP-4 | M2 / M2-T20 | Anthropic per-message effort beta + cache behavior; refusal-fallback beta behavior | Top-level effort per route (accept the cache split) | open | — |
| SP-5 | M2 / M2-T20 (final: M13-T15) | Tool catalog experiment E-CAT: full vs per-role vs deferred loading | Full catalog (spine default) | open | — |
| SP-6 | M6 / M6-T7 | Embedding bake-off (e5-small vs granite-97m vs bge-m3): quality and RSS on a Pi | e5-small | open | — |
| SP-7 | M7 / M7-T1 | `rrule-temporal` correctness on DST/EXDATE/overrides | `rrule` + a Temporal adapter | open | — |
| SP-8 | M10 / M10-T1, M10-T2 | Do signal-cli poll votes reach the bot? Matrix E2EE library maturity | Numbered-reply polls; Matrix rooms without E2EE marked beta | open | — |
| SP-9 | M11 / M11-T6 | transformers.js Whisper as a no-binary fallback in native mode | Require `whisper-cli` on PATH, or an API provider | open | — |
| SP-10 | M12 / M12-T32 | Browser demo Tier 2 (real engine in a Web Worker) | Tier 1 recorded playback only | open | — |
| SP-11 | M14 / M14-T1 (may start after M8) | Native-module matrix on Node 26 for all images; HA watchdog on an ingress-only port | Node 24 base image | open | — |

## Open cross-document issues (`14` §0.7)

State at plan creation (after `_review/R4-alignment.md`). `M0-T23` re-verifies; mark each `resolved (date, commit)` when the spec text is fixed.

- [x] `03:M4-T9` "HMAC tokens" → 06 `InteractionToken`: spec text fixed 2026-11-01
- [ ] `03:M4-T2` runs all 62 tools in M4 before most exist; fixture approach (M4-T2), full run at M7-T36 — **open, blocks M4 only**; verified at M0-T23 as not blocking M0–M2
- [x] `10:M5-T91` duplicate `turn_effects.status` migration: spec text fixed 2026-11-01 (02's M1 schema already has it)
- [x] `@village/mcp-bridge` added to 12 P11 public packages (approval A-1 resolved 2026-11-01)
- [x] Renovate file name unified as `renovate.json5` in 12 (2026-11-01)
- [ ] `@modelcontextprotocol/node`: named conditionally in A12; confirm in M12-T2 and update ADR-021 — **open, blocks M12 only**; verified at M0-T23 as not blocking M0–M2
- [x] Spine wording and pointers, R4 §(b) B1–B9: applied to `01`/`15` on 2026-11-01 (A12 update, new A30); **verified by M0-T23 on 2026-11-01** — `01` §6.1 steps 2.2/2.5/4 cite A27/A25/A16, §5 and §6.4 point at `02` §3.3.13 and §3.10.1, §10 carries `traces.retentionDays` and `mcp.server.http`, A7's entity list and A12 are present, and `15` §2's resolved rows match. No residue
- [x] 03↔07 names, constraints, FairnessPort, statuses, poll hooks: resolved by R4 (verify in M7-T7)
- [x] `ledgerVisibility` default `self_only`: resolved by R4 D1
- [x] ICS token/route; 09 API shapes; MCP format and `/mcp` endpoint; `keyringSnapshot.static.blobId`; TurnTrace 30 d; reactions persistence; guard input; 06 PSC-9 fields; IMAP env var; in-memory demo repos (`02:M12-T70`): resolved by R4 (verify)

## Milestones

### M0 — Foundations

Status: in progress · Tasks: 11/23 · Gate: —

- [x] M0-T1 Monorepo scaffold — 24 packages/apps; `pnpm verify` green in 6s on Node 26.13.0 **and** 24.22.2; 27 modules / 0 depcruise violations; 18 tests — ae5b2e1
- [x] M0-T2 Runtime pins & pnpm supply-chain policy — policy **observed working live**: rejected `eslint@10.14.0` as too fresh, then a clean resolution chose 10.13.0 and `dependency-cruiser@18.7.0` unaided (evidence: `docs/architecture/evidence/m0-t2-minimum-release-age.md`); 15 policy tests
- [x] M0-T3 Vitest workspace — 5 projects (unit/integration/contract/scenario/dashboard), 8 strict tags, socket-level network guard (29 tests), TZ pinned in the main process and asserted behaviourally, per-glob coverage thresholds from `11` §3.1.4; **bench deferred to M1-T32** — Vitest 5.0.5 has no usable `bench` API (see Plan changes)
- [x] M0-T4 Dependency boundaries & lint bans — **26 depcruise rules, every one proven to bite** against a planted violation in a synthetic tree (one cruise, 1.3s); core purity bans (Date/Math.random/process), `08` §3.20 security bans and the guarded-egress `fetch` ban, each proven to fire *and* proven wired to the right paths via the real config; 91 tests
- [x] M0-T5 `BRAND` constant & guard — `BRAND` matches the `13` §4.1 contract field-for-field (asserted both ways: nothing missing, nothing extra); AST guard excludes only `brand.ts`, npm-scope module specifiers, docs content and fixtures; 43 tests across the constant and the guard
- [x] M0-T6 Shared foundation libraries — `Result`, typed errors, zod boundary helpers, `assertNever`, the Clock/IdGenerator/Rng ports (interfaces only), and the config layer: schema, host-only policy, precedence, `.env` parser, `_FILE` secrets, and env names **derived from the schema** (73 leaves, 0 collisions). 340 tests, **97.6% lines / 93.8% branches** (threshold 90/80)
- [x] M0-T7 Testing primitives — `VirtualClock` (timers in due order with a microtask flush, self-rescheduling loops, DST-correct, refuses calendar units), `SeededRng` (xoroshiro128+, **fork stability as a property test**, FNV-1a known-answer vectors), `DeterministicIdGenerator` (valid TypeIDs cross-checked against typeid-js's own parser, UUIDv7 bit layout, monotonic within a millisecond), `fcConfig()` honouring `FC_SEED`/`FC_PATH`/`FC_NUM_RUNS`. 81 tests here, 421 total
- [x] M0-T8 Logger, redaction & `SecretString` — **four layers** protecting `01` §11.7: the closed `LogFields` type (9 `@ts-expect-error` assertions), the content gate on its own unredacted channel, depth-unlimited forbidden-field stripping, and shape scrubbing. `sec.logs.canary` covers **22 secret shapes** from `08` §3.10, each standalone, combined, inside a URL and nested deep. `SecretString` is unprintable through 10 routes including `util.inspect({showHidden:true})`. Push protection rejected the first push, so every canary is now assembled at runtime and `pnpm secrets:check` enforces that repo-wide (see Plan changes). **574 tests**, 98.2% lines
- [x] M0-T9 Observability skeleton — tracing and metrics facades that are **free when off** (frozen no-op singletons; the OTel SDK is never imported while disabled, asserted rather than assumed). GenAI names pinned to commit `95aff9cd` with the upgrade procedure in the header. Content is **unrepresentable**: `Attributes` refuses 11 forbidden families as template-literal types, so even an attribute the registry has not invented yet fails to compile (12 `@ts-expect-error` assertions). Declarative 33-metric catalog with typed labels, budget-aligned bucket edges and an asserted cardinality ceiling. 96 tests here, **672 total**, 97.7% lines / 94.3% branches
- [ ] M0-T10 Test-hygiene lints
- [ ] M0-T11 CI workflow & release skeleton
- [ ] M0-T12 CI security workflows
- [ ] M0-T13 Renovate policy
- [ ] M0-T14 Changesets
- [ ] M0-T15 Names manifest
- [ ] M0-T16 Repo hygiene & community files
- [ ] M0-T17 Issue/PR templates, labels, CODEOWNERS
- [ ] M0-T18 Docs-site skeleton & docs CI
- [ ] M0-T19 Rename codemod & weekly drill
- [x] M0-T20 ADR files — `docs/adr/` ADR-001…ADR-023 + README + TEMPLATE-mini, plus ADR-024 (name) and ADR-025 (TS pin)
- [ ] M0-T21 Branch protection, merge queue & CI docs
- [ ] M0-T22 Naming kickoff (private)
- [x] M0-T23 Plan consistency pass — `scripts/plan/trace.py` + 54 unit tests; **504 tasks / 552 spec tasks, 0 errors, 0 warnings, 0 unmapped spec tasks**; 4 findings fixed (see Plan changes)

#### Execution note

**Written 2026-11-01.** Order is `14` §2's table order. Deviations and their reasons are below.

**Spikes.** None for M0 (`14` §2). The §0.7 consistency pass ran as `M0-T23` and came back clean —
504 canonical tasks across 16 milestones, 552 spec tasks in `02`–`13` §10, **0 unmapped spec tasks,
0 unknown references**, and `STATUS.md` in exact agreement with every task table. Four real
inconsistencies were found and fixed (see *Plan changes*).

**Owner checkpoints.** `D-2` was pulled forward to M0 by the owner, so it was decided here rather
than at M7/M8 — see DL-8 and [ADR-024](../adr/ADR-024-product-name.md). `D-3`, `D-5`, `D-7` and
`D-8` were also decided now, since each was either already determined by the facts on the ground or
costs nothing to settle early (DL-1 to DL-4). `D-1` and `D-6` wait for M9, where there will be
measured cost data to decide with. `D-4` is the money part and is the owner ask H-1.

**Task order, with the deviations.**

1. `M0-T20` (ADRs) and `M0-T23` (the plan consistency pass) ran **first**, in parallel sub-agents,
   because both are `‖`, neither depends on the scaffold, and `M0-T23`'s checker is the thing that
   tells me whether the plan I am about to execute is self-consistent. It was worth knowing that
   before writing code, and it found four defects.
2. `M0-T1` (scaffold) next, on the main thread.
3. Then `M0-T2` → `M0-T19` in table order. `M0-T5` (`BRAND`) was partly pulled into `M0-T1`,
   because every one of the 24 `package.json` files needs the final npm scope and there is no
   sensible way to scaffold without it. `M0-T5` is ticked only when its full acceptance criteria
   are met (the `13` §4.1 shape, the exclusions, and the planted-violation fixture).
4. `M0-T21` (branch protection) last, since it needs `ci-ok` to exist.

**Sub-agents.** `M0-T20` and `M0-T23` went to sub-agents (disjoint file sets, no commits from the
agent, the main thread verifies and commits). Four more sub-agents ran the D-2 clearance research
and one re-verified the entire toolchain against the live registries. Everything touching
`packages/core` and every migration stays serial, per `14` §0.4 — and `M0-T23` found three M4 rows
mis-tagged `‖` over exactly those paths, now corrected.

**Risks taken into M0, and what happened.**

- *The plan's third-party facts were a day old.* Re-verification found five that had moved, two of
  which would have broken the M0 gate: `typescript-eslint` cannot run on TypeScript 7, and
  `vitest.workspace.ts` is removed in Vitest 5 and now fails **silently**. Recorded as spine
  amendment **A31** plus [ADR-025](../adr/ADR-025-typescript-version-pin.md).
- *Naming was the real risk.* Every name in `13` §3.A.3's shortlist failed, and two replacements
  were chosen and reversed. The `BRAND` + codemod + weekly-drill machinery is what made that cost
  an hour instead of a week; it earned its place before a line of product code existed.
- *Guards that report success while enforcing nothing.* The first dependency-cruiser config excluded
  `/dist/`, and since workspace imports resolve through `node_modules` into `dist/`, every
  cross-package edge was invisible. It printed "no violations" over an empty graph. Found by
  planting a violation, not by reading. This is the argument for `M0-T4`'s
  planted-violation-fixture requirement, and it generalises: **a guard is not done until it has
  been seen to fail.**

**Needed from the human.** H-1 (API budget) through H-7, listed above. None of them block M0: the
scaffold, the guards, CI and the docs skeleton need no credentials. H-6 (securing the `comvivo`
names) is the one with a clock on it, because the repository is public.

#### Milestone report

_Not written yet._

### M1 — Storage & domain core

Status: not started · Tasks: 0/35 · Gate: —

- [ ] M1-T1 `@village/storage` scaffold & pins
- [ ] M1-T2 Storage/encryption/index spike (SP-1, SP-3)
- [ ] M1-T3 IDs, clock & canonical JSON
- [ ] M1-T4 Crypto primitives + SP-2
- [ ] M1-T5 KeyService & keyring
- [ ] M1-T6 Recovery-key codec & key-operations library
- [ ] M1-T7 Data-dir primitives
- [ ] M1-T8 Database open/init
- [ ] M1-T9 `SqliteStore`, `NotPromise` & the no-await-in-tx lint
- [ ] M1-T10 Column helpers & custom types
- [ ] M1-T11 Schema part A
- [ ] M1-T12 Schema part B
- [ ] M1-T13 Search & guard migration
- [ ] M1-T14 Migration runner & migration tests
- [ ] M1-T15 Storage test kit
- [ ] M1-T16 `LabelStore`, `computeEligible` (stub flow), `EligibleLabelSet`
- [ ] M1-T17 Core repositories
- [ ] M1-T18 Memory repositories & `MemorySearchPort`
- [ ] M1-T19 Coordination repositories & `ContextReadModel`
- [ ] M1-T20 Governance repositories
- [ ] M1-T21 Turn journal, traces, audit, usage
- [ ] M1-T22 Outbox repository & state machine
- [ ] M1-T23 Durable job queue
- [ ] M1-T24 Scheduler & Temporal schedule evaluator
- [ ] M1-T25 Blob cipher & blob store
- [ ] M1-T26 Retention & deletion primitives
- [ ] M1-T27 Backup library & `VBK1` envelope
- [ ] M1-T28 Export library
- [ ] M1-T29 TokenService
- [ ] M1-T30 `safeFetch`
- [ ] M1-T31 Secret loading
- [ ] M1-T32 Bench infrastructure
- [ ] M1-T33 Perf seed, benches & Pi 5 run
- [ ] M1-T34 Mutation testing
- [ ] M1-T35 Storage docs & generated schema reference

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M2 — Model gateway

Status: not started · Tasks: 0/20 · Gate: —

- [ ] M2-T1 Canonical model port types
- [ ] M2-T2 Capability registry, presets, route resolver
- [ ] M2-T3 Price tables & cost calculator
- [ ] M2-T4 Strict JSON-schema converter (single implementation)
- [ ] M2-T5 Plugin-SDK tool types
- [ ] M2-T6 Anthropic adapter `run()`
- [ ] M2-T7 FakeModelGateway & model doubles
- [ ] M2-T8 Anthropic `structured()`, `countTokens()`, Batches, beta probe
- [ ] M2-T9 Errors & middleware
- [ ] M2-T10 FakeProviderServer
- [ ] M2-T11 OpenAI adapter (Responses API)
- [ ] M2-T12 OpenAI-compatible local adapter
- [ ] M2-T13 Google adapter (`generateContent`)
- [ ] M2-T14 Adapter contract suite
- [ ] M2-T15 Model telemetry
- [ ] M2-T16 Egress manifest, Hybrid & Local-only
- [ ] M2-T17 Catalog canonicalization & `catalogHash`
- [ ] M2-T18 Model diagnostics API
- [ ] M2-T19 Live smoke & budget guard v0
- [ ] M2-T20 Live spike SP-4/SP-5: cache plan, TTL, effort strategy, E-CAT A vs C

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M3 — Channel SDK, simulator, Telegram, ingestion, outbox (vertical slice)

Status: not started · Tasks: 0/57 · Gate: —

- [ ] M3-T1 Channel & onboarding tables
- [ ] M3-T2 Channel SDK contract, schemas, profiles
- [ ] M3-T3 RichText AST & parser
- [ ] M3-T4 Renderers: plain, telegram-html, web-md + measurement
- [ ] M3-T5 Splitter
- [ ] M3-T6 Interactions, tokens & choice fallback
- [ ] M3-T7 Rate limiter, retry, error helpers
- [ ] M3-T8 TypingManager
- [ ] M3-T9 Conformance kit & fixture tooling
- [ ] M3-T10 Renderer & callback safety
- [ ] M3-T11 Simulator adapter
- [ ] M3-T12 Runtime copy catalog
- [ ] M3-T13 CLI skeleton & `village keys`/`version`
- [ ] M3-T14 HTTP foundation & health endpoints
- [ ] M3-T15 Composition root, `DomainEventBus`, `Crashpoints`
- [ ] M3-T16 Ingestion pipeline core & group actor
- [ ] M3-T17 Engine AdapterHost & adapter context
- [ ] M3-T18 Ingestion glue for channels; pre-identity, bot & binding gates
- [ ] M3-T19 Prompt builder & charter v1
- [ ] M3-T20 TurnTrace writer & debug content
- [ ] M3-T21 Router core
- [ ] M3-T22 Name invocation
- [ ] M3-T23 Tool registry & executor skeleton (stub policy)
- [ ] M3-T24 Turn engine & agent loop
- [ ] M3-T25 Coalescing & cancellation
- [ ] M3-T26 Output pipeline (stub guard)
- [ ] M3-T27 Outbound dispatcher
- [ ] M3-T28 Journal, effect templates, recovery, ack check
- [ ] M3-T29 Presence & continuation
- [ ] M3-T30 Usage & basic cost guard
- [ ] M3-T31 EvalHooks
- [ ] M3-T32 Telegram adapter core
- [ ] M3-T33 Telegram interactions, polls, commands, ephemeral, deep links
- [ ] M3-T34 Telegram membership, migration, probes, webhook
- [ ] M3-T35 Telegram attachments
- [ ] M3-T36 Control API (min) & control token
- [ ] M3-T37 Host claim code
- [ ] M3-T38 Group claim flow, unclaimed policy, onboarding triggers
- [ ] M3-T39 Web channel adapter (dev auth)
- [ ] M3-T40 Server lifecycle: boot & graceful shutdown
- [ ] M3-T41 `village start`/`status`/`doctor` (min) & `migrate status`
- [ ] M3-T42 `village init` (min: native, Telegram, Anthropic)
- [ ] M3-T43 Simulation harness core
- [ ] M3-T44 Scenario DSL v1 (TS)
- [ ] M3-T45 Process mode & chaos-lite (outbox)
- [ ] M3-T46 Turn chaos I6/I7
- [ ] M3-T47 Telegram contract tests & renderer snapshots
- [ ] M3-T48 `evals-smoke` job & golden v0
- [ ] M3-T49 B1 ingestion bench
- [ ] M3-T50 Minimal Dockerfile, `selftest` & packaging CI job
- [ ] M3-T51 Alpha compose
- [ ] M3-T52 Edge image pipeline
- [ ] M3-T53 Docs-as-tests runner
- [ ] M3-T54 Config & env reference generator
- [ ] M3-T55 Alpha docs pages
- [ ] M3-T56 Real-group exit check
- [ ] M3-T57 Dogfood program

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M4 — Policy core

Status: not started · Tasks: 0/22 · Gate: —

- [ ] M4-T1 Principals & capability catalog
- [ ] M4-T2 Action registry
- [ ] M4-T3 Constitution schema & 8 templates
- [ ] M4-T4 Compiler, `CompiledPolicy`, issues
- [ ] M4-T5 Semantic diff, privacy delta & constitution API
- [ ] M4-T6 Charter & group prompt layer
- [ ] M4-T7 Governance core
- [ ] M4-T8 `authorize()`
- [ ] M4-T9 Policy support for extensions
- [ ] M4-T10 Reference policy model & differential test
- [ ] M4-T11 Authority oracle & GreedyToolModel
- [ ] M4-T12 Executor ↔ PolicyEngine
- [ ] M4-T13 Confirmations end to end
- [ ] M4-T14 Proposal, amendment & constitution services; `BallotPresenter`
- [ ] M4-T15 Contested actions → proposals
- [ ] M4-T16 Template picker & founding admin in the claim flow
- [ ] M4-T17 Guardian service & claim verification
- [ ] M4-T18 System authority & deferred intents
- [ ] M4-T19 Capabilities in the prompt & gated commands
- [ ] M4-T20 Policy scenario pack v0
- [ ] M4-T21 Authority red-team v0
- [ ] M4-T22 Constitution docs & generators

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M5 — Information-flow control & discretion

Status: not started · Tasks: 0/42 · Gate: —

- [ ] M5-T1 Label algebra
- [ ] M5-T2 Real `computeEligible`
- [ ] M5-T3 Labeling rules & sensitivity
- [ ] M5-T4 Audience resolver, roster tracker & channel audience inputs
- [ ] M5-T5 Requester & audience binding in turns
- [ ] M5-T6 Constraint catalog v1
- [ ] M5-T7 IfcGate, `Readable<T>`, `IfcScopedReader`, `TurnLabelTracker`; sealed-type import rule
- [ ] M5-T8 Tool-result labeling & taint
- [ ] M5-T9 `ScopedRepositories` facade
- [ ] M5-T10 Untrusted output labels & external-effect journaling
- [ ] M5-T11 Membership handlers
- [ ] M5-T12 Sealed set
- [ ] M5-T13 `PrivateConstraintPolicy` & approval UX
- [ ] M5-T14 Declassifier pipeline
- [ ] M5-T15 Disclosure guard
- [ ] M5-T16 Guard hook in the turn
- [ ] M5-T17 URL provenance policy
- [ ] M5-T18 ContextBuilder integration
- [ ] M5-T19 Group layer completion
- [ ] M5-T20 Probe classifier, refusal templates & limiter
- [ ] M5-T21 DM semantics & relay
- [ ] M5-T22 Explanation filter
- [ ] M5-T23 `/why`
- [ ] M5-T24 Link policy & exfiltration tests
- [ ] M5-T25 Consent lifecycle
- [ ] M5-T26 Injection policy
- [ ] M5-T27 Cross-group isolation & portable profile
- [ ] M5-T28 Departure deletion & `ExportPolicy`
- [ ] M5-T29 Host honesty surfaces
- [ ] M5-T30 Canary system
- [ ] M5-T31 Egress scanning
- [ ] M5-T32 IFC property generators
- [ ] M5-T33 Invariant suite I1–I5 & canary harness; S10/S11 properties
- [ ] M5-T34 Noninterference twins
- [ ] M5-T35 LeakyModel & sabotage meta-tests
- [ ] M5-T36 YAML DSL & red-team generator
- [ ] M5-T37 Judge framework & leak-audit calibration
- [ ] M5-T38 Host-surface canary audit
- [ ] M5-T39 Injection suite v0
- [ ] M5-T40 Red-team families: inference, exfil, injection, canary
- [ ] M5-T41 Discretion scenario pack v0
- [ ] M5-T42 Discretion docs

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M6 — Memory v1

Status: not started · Tasks: 0/33 · Gate: —

- [ ] M6-T1 Memory domain types & zod schemas
- [ ] M6-T2 Memory config schema & constitution knobs
- [ ] M6-T3 Search normalization, lexicons, FTS builder, token estimator
- [ ] M6-T4 Ranking, fusion & packing math
- [ ] M6-T5 Embedding spaces & local worker
- [ ] M6-T6 Corpus v0, generator, guidelines, annotator UI, metrics runners, cassettes
- [ ] M6-T7 Embedding bake-off (SP-6)
- [ ] M6-T8 Baked model & verified fetcher
- [ ] M6-T9 Eligible-label-set cache
- [ ] M6-T10 Hybrid retriever & `MemoryQueryService`
- [ ] M6-T11 Retrieval tuning
- [ ] M6-T12 Memory-explorer read queries
- [ ] M6-T13 Extraction debouncer, cursors, adaptive N, prefilter
- [ ] M6-T14 Window builder & renderer
- [ ] M6-T15 Extraction prompt & extractor
- [ ] M6-T16 Post-processing
- [ ] M6-T17 Date resolution & chrono/lexicon cross-check
- [ ] M6-T18 Labels, sensitivity floors, entity registry & aliases
- [ ] M6-T19 Calibration
- [ ] M6-T20 Reconcile planner
- [ ] M6-T21 Plan apply in the actor
- [ ] M6-T22 Memory proposals
- [ ] M6-T23 Forget cascade
- [ ] M6-T24 Memory tools, copy & directed commands
- [ ] M6-T25 About-me, correct, pin, export
- [ ] M6-T26 Consolidation via Batches
- [ ] M6-T27 Re-embedding migration
- [ ] M6-T28 Memory observability & doctor checks
- [ ] M6-T29 Extraction eval runner (S4)
- [ ] M6-T30 Retrieval suite (S5)
- [ ] M6-T31 B2/B3 benches
- [ ] M6-T32 Memory-poisoning scenarios
- [ ] M6-T33 Memory docs

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M7 — Coordination tools & fairness

Status: not started · Tasks: 0/42 · Gate: —

- [ ] M7-T1 Recurrence & ICS library spike (SP-7)
- [ ] M7-T2 Coordination tables (07 extras)
- [ ] M7-T3 Time foundations
- [ ] M7-T4 Recurrence expansion, overrides & series split
- [ ] M7-T5 Calendar storage verification
- [ ] M7-T6 Built-ins on the plugin-sdk contract
- [ ] M7-T7 Coordination schemas, receipts, ChoiceSet, copy system, tone lint; 03 name-alignment checks
- [ ] M7-T8 Fairness ledger & rollups
- [ ] M7-T9 Fair assignment algorithm & `FairnessPort`
- [ ] M7-T10 Calendar domain & tools 1, 3–6
- [ ] M7-T11 Conflicts & availability (tool 2)
- [ ] M7-T12 Coordination interaction handlers
- [ ] M7-T13 ICS serializer, feed tokens, route, tool 9
- [ ] M7-T14 ICS subscriptions & `.ics` attachments (tools 7–8)
- [ ] M7-T15 Reminders domain & scheduler (tools 10–12)
- [ ] M7-T16 Reminder delivery, downtime policy & reliability chaos
- [ ] M7-T17 Tasks domain & tools 13–18, proof photos
- [ ] M7-T18 Rotations, swaps, covers & re-entry (fairness core)
- [ ] M7-T19 Rotation materializer (tool 19)
- [ ] M7-T20 Swap / trade / give-away (tools 20–21)
- [ ] M7-T21 Fairness explanations & ledger copy lint
- [ ] M7-T22 `/chores` load view (tool 22) & tone variants
- [ ] M7-T23 Ledger visibility & labels
- [ ] M7-T24 Invisible-work tracking
- [ ] M7-T25 Lists (tools 23–26), normalization, shopping mode
- [ ] M7-T26 List auto-capture sink
- [ ] M7-T27 Polls core & tools 27–30; emulated modes
- [ ] M7-T28 Telegram native polls & `poll.close`
- [ ] M7-T29 Proposal hook
- [ ] M7-T30 Decisions log (tools 34–36), mirrors, permalinks
- [ ] M7-T31 Memory → coordination intake
- [ ] M7-T32 Plans (tools 31–33) & planning mode
- [ ] M7-T33 Surprise secrecy
- [ ] M7-T34 Catch-up (tools 37–38)
- [ ] M7-T35 Agenda (tool 39) & `CoordinationContextProvider`
- [ ] M7-T36 Built-in tool catalog freeze
- [ ] M7-T37 Coordination commands
- [ ] M7-T38 Coordination effect templates & `compensate`
- [ ] M7-T39 Coordination scenario pack & golden GS-01…GS-35
- [ ] M7-T40 Fairness suite (S7)
- [ ] M7-T41 Coordination user docs & tool-catalog generator
- [ ] M7-T42 Naming decision (target) & asset securing

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M8 — Proactivity & digests → 0.1 alpha

Status: not started · Tasks: 0/29 · Gate: —

- [ ] M8-T1 Proactivity tables & attention-ledger queries
- [ ] M8-T2 Proactivity core
- [ ] M8-T3 Delivery ledger, outbound classes, quiet hours
- [ ] M8-T4 Detectors (all 9 types) & sweep
- [ ] M8-T5 Interjection `route` call
- [ ] M8-T6 System turns
- [ ] M8-T7 Evaluate job, bundling, deferral to digests
- [ ] M8-T8 Interjection rendering
- [ ] M8-T9 Feedback capture, learning & tools 41–42
- [ ] M8-T10 Digest service: morning brief, weekly recap, tool 40; plugin digest-section hook
- [ ] M8-T11 Overdue, poll-closing & stale-step nudges
- [ ] M8-T12 Budget ladder & notices
- [ ] M8-T13 Effort & planning classifier tuning
- [ ] M8-T14 Reply-language hint eval
- [ ] M8-T15 Local model eval & compact charter
- [ ] M8-T16 Persona agents
- [ ] M8-T17 Proactivity suite (S6) & metrics; GS-36…GS-45
- [ ] M8-T18 Charter behavior evals
- [ ] M8-T19 Quality suite v1 (S8)
- [ ] M8-T20 Cost & latency suite (S9)
- [ ] M8-T21 Chaos nightly
- [ ] M8-T22 Nightly live pipeline
- [ ] M8-T23 Human-eval tooling
- [ ] M8-T24 Upgrade engine v1
- [ ] M8-T25 Backup ops v1
- [ ] M8-T26 Alpha docs completeness
- [ ] M8-T27 Community chat structure
- [ ] M8-T28 Public alpha flip
- [ ] M8-T29 0.1 cut

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M9 — Dashboard, HTTP API, auth & CLI wizard

Status: not started · Tasks: 0/41 · Gate: —

- [ ] M9-T1 Auth & dashboard tables; settings repository API
- [ ] M9-T2 Route metadata, OpenAPI emit, `api-client`
- [ ] M9-T3 API conventions & rate limiting
- [ ] M9-T4 HTTP security middleware
- [ ] M9-T5 AuthService, sessions, cookies, CSRF & auth security
- [ ] M9-T6 Pairing, magic link & step-up end to end
- [ ] M9-T7 Web setup, invites, link codes, group claim codes
- [ ] M9-T8 Host-only settings & ICS listener
- [ ] M9-T9 Read-model layer & IFC gate
- [ ] M9-T10 Trace, cost & usage read models
- [ ] M9-T11 Command path, approvals & command status
- [ ] M9-T12 Group, member, conversation & chat routes; web chat on real sessions
- [ ] M9-T13 Constitution & proposal routes
- [ ] M9-T14 Memory routes
- [ ] M9-T15 Coordination routes & ICS feeds
- [ ] M9-T16 Traces, activity, audit, usage, budget, settings & exports routes
- [ ] M9-T17 Instance (host) routes & probes
- [ ] M9-T18 SSE hub
- [ ] M9-T19 Dashboard scaffold
- [ ] M9-T20 Sign-in screens
- [ ] M9-T21 Home & onboarding checklist
- [ ] M9-T22 Chat screen
- [ ] M9-T23 Members & roles
- [ ] M9-T24 Constitution editor
- [ ] M9-T25 Memory explorer
- [ ] M9-T26 Calendar
- [ ] M9-T27 Tasks, chores & fairness
- [ ] M9-T28 Lists, polls & decisions, plans
- [ ] M9-T29 Activity, audit & traces
- [ ] M9-T30 Costs & budgets
- [ ] M9-T31 Settings (group, me, instance)
- [ ] M9-T32 Full `village init` & deployment generator
- [ ] M9-T33 Wizard & in-chat disclosures
- [ ] M9-T34 CLI commands (rest)
- [ ] M9-T35 Full `doctor`, `/instance/health`, security checks, `--bundle`, `eval replay`
- [ ] M9-T36 `/metrics`
- [ ] M9-T37 Playwright suite
- [ ] M9-T38 API canary probes & contract tests
- [ ] M9-T39 DAST
- [ ] M9-T40 Dashboard & API quality gates
- [ ] M9-T41 Operate docs, OpenAPI/CLI/doctor generators & screenshots

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M10 — More channels

Status: not started · Tasks: 0/24 · Gate: —

- [ ] M10-T1 Matrix spike (SP-8, Matrix part)
- [ ] M10-T2 Signal spike & poll decision (SP-8, Signal part)
- [ ] M10-T3 Renderers: discord-md, slack-mrkdwn + blocks, matrix-html, signal-styled
- [ ] M10-T4 Identity linking
- [ ] M10-T5 Discord adapter core
- [ ] M10-T6 Discord interactions, commands, polls
- [ ] M10-T7 Discord probes, diagnostics & install URL
- [ ] M10-T8 Discord native polls in coordination
- [ ] M10-T9 Slack adapter core
- [ ] M10-T10 Slack interactions, commands, emulated polls, ephemeral, verification, manifest
- [ ] M10-T11 Slack Block Kit poll emulation & live tallies
- [ ] M10-T12 Matrix adapter core, E2EE & CLI setup
- [ ] M10-T13 Matrix polls, reactions, threads, edits, redactions, media; nightly Synapse E2EE
- [ ] M10-T14 Matrix polls & read anchors in coordination
- [ ] M10-T15 Signal adapter
- [ ] M10-T16 Signal CLI helpers & version freshness
- [ ] M10-T17 Signal polls in coordination
- [ ] M10-T18 Per-channel capability conformance (runtime)
- [ ] M10-T19 Wizard & doctor steps for the new channels
- [ ] M10-T20 Capability-matrix runner
- [ ] M10-T21 Contract suites & live drift
- [ ] M10-T22 Platform fault profiles
- [ ] M10-T23 Cross-adapter CI matrix & nightly live smoke
- [ ] M10-T24 Host setup guides & quickstarts; Village in the project community

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M11 — Multimodal & email

Status: not started · Tasks: 0/15 · Gate: —

- [ ] M11-T1 Attachment normalization
- [ ] M11-T2 Platform fetch specifics
- [ ] M11-T3 Outbound files
- [ ] M11-T4 Sandbox launcher core & media worker sandbox
- [ ] M11-T5 whisper.cpp + ffmpeg-mini image stage; `village models`
- [ ] M11-T6 SP-9: transformers.js Whisper fallback
- [ ] M11-T7 Multimodal model parts
- [ ] M11-T8 Media job handlers
- [ ] M11-T9 Email ingestion (IMAP)
- [ ] M11-T10 Document windows for PDFs/emails
- [ ] M11-T11 Media-derived calibration features
- [ ] M11-T12 Corpus extension: OCR/ASR-noised items (+15%)
- [ ] M11-T13 Media & email injection fixtures (S3)
- [ ] M11-T14 Multimodal extraction subset (S4)
- [ ] M11-T15 Email & media guides

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M12 — Extensibility → 0.5 beta

Status: not started · Tasks: 0/37 · Gate: —

- [ ] M12-T1 Extension & feedback tables
- [ ] M12-T2 Re-verify external facts; MCP SDK v2 spike
- [ ] M12-T3 `definePlugin`, `define*` & manifest
- [ ] M12-T4 RPC protocol & child runtime
- [ ] M12-T5 Plugin supervisor & sandbox launcher
- [ ] M12-T6 Brokered network
- [ ] M12-T7 `PluginToolProvider` & ctx host
- [ ] M12-T8 Plugin test kit
- [ ] M12-T9 Installer, approval & hash pinning; `village plugin …`
- [ ] M12-T10 Extension tools in the registry
- [ ] M12-T11 Per-group enablement
- [ ] M12-T12 Jobs, delegations & digest sections
- [ ] M12-T13 Channel plugins
- [ ] M12-T14 Skills runtime
- [ ] M12-T15 Bundled skills content
- [ ] M12-T16 MCP server core
- [ ] M12-T17 MCP server security
- [ ] M12-T18 MCP tokens UX
- [ ] M12-T19 `@village/mcp-bridge`
- [ ] M12-T20 MCP client & hardening
- [ ] M12-T21 Plugin `weather`
- [ ] M12-T22 Plugin `ics` (opt-in)
- [ ] M12-T23 Plugin `homeassistant`
- [ ] M12-T24 Author CLI & plugin template
- [ ] M12-T25 Curated registry
- [ ] M12-T26 MCP red-team
- [ ] M12-T27 Plugin authority tests
- [ ] M12-T28 Extension security hardening pass
- [ ] M12-T29 Extension perf benches
- [ ] M12-T30 Extension docs
- [ ] M12-T31 Beta guides & generators
- [ ] M12-T32 Browser-safe in-memory repositories, demo recorder & Tier-2 spike (SP-10)
- [ ] M12-T33 Name hard-stop verification (contingency)
- [ ] M12-T34 npm trusted publishing (5 public packages)
- [ ] M12-T35 Beta channel, HA `village_beta`, Umbrel community store
- [ ] M12-T36 Private beta program
- [ ] M12-T37 Beta gate run

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M13 — Evals hardening, performance & cost

Status: not started · Tasks: 0/30 · Gate: —

- [ ] M13-T1 Red-team expansion to full size
- [ ] M13-T2 Coordination red-team
- [ ] M13-T3 Memory-poisoning red-team
- [ ] M13-T4 Guard calibration
- [ ] M13-T5 Inference & probing hardening
- [ ] M13-T6 Compiler, confirmation & interaction fuzzing; fuzz campaigns
- [ ] M13-T7 Declassify precision eval
- [ ] M13-T8 Corpus v1
- [ ] M13-T9 Calibration refit per default model
- [ ] M13-T10 Memory 1.0 gates in nightly CI & regression bot
- [ ] M13-T11 Trigram FTS for CJK/Thai groups
- [ ] M13-T12 Proactivity Θ tuning
- [ ] M13-T13 Localized templates & multilingual date eval
- [ ] M13-T14 Final cache TTL & effort strategy
- [ ] M13-T15 E-CAT final (ADR-023)
- [ ] M13-T16 Local model re-evaluation
- [ ] M13-T17 Multi-model release run (`quality-gates.yml`)
- [ ] M13-T18 Perf suite complete & CI latency budgets
- [ ] M13-T19 Memory performance hardening on Pi 5
- [ ] M13-T20 Coordination perf benchmarks on Pi 5
- [ ] M13-T21 Crypto & isolation perf
- [ ] M13-T22 Pi protocol & `village bench`
- [ ] M13-T23 Mutation & coverage targets
- [ ] M13-T24 Judge cycle
- [ ] M13-T25 Cost publication per preset
- [ ] M13-T26 Chaos at release level
- [ ] M13-T27 Red-team scorecard, perf & cost generators; README sync
- [ ] M13-T28 Local discretion challenge & `village eval challenge`
- [ ] M13-T29 Fresh-user dry-run round 1 (TTFV)
- [ ] M13-T30 Child-safety expert review (D-5)

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M14 — Packaging & operations

Status: not started · Tasks: 0/29 · Gate: —

- [ ] M14-T1 Native-module matrix (SP-11) & production image
- [ ] M14-T2 Multi-arch release pipeline
- [ ] M14-T3 Image signing & attestations
- [ ] M14-T4 SBOM & SLSA Build L3 reusable build
- [ ] M14-T5 Reproducible tarballs
- [ ] M14-T6 Container & systemd hardening
- [ ] M14-T7 npm distribution, thin CLI & native mode; `village runtime`
- [ ] M14-T8 Compose variants
- [ ] M14-T9 Docker mode orchestration
- [ ] M14-T10 Upgrade engine v2, recovery mode & downgrade
- [ ] M14-T11 Upgrade matrix & release DB fixtures
- [ ] M14-T12 Backup ops v2, weekly `backup.verify` & restore drill
- [ ] M14-T13 Ops CLI hardening (backup/restore/verify/prune/export/migrate)
- [ ] M14-T14 Cross-machine restore & key-rotation e2e
- [ ] M14-T15 `healthcheck`, `update`, `version --check`, `service`, `db checkpoint`
- [ ] M14-T16 Appliance secrets via web setup (A29)
- [ ] M14-T17 HA ingress mode
- [ ] M14-T18 Home Assistant app
- [ ] M14-T19 Umbrel, CasaOS, Unraid, TrueNAS
- [ ] M14-T20 systemd & launchd
- [ ] M14-T21 Release channels, hotfix, notes, downstream, manifest
- [ ] M14-T22 Container quality stage
- [ ] M14-T23 Quality-gate integration
- [ ] M14-T24 Drizzle v1 re-evaluation
- [ ] M14-T25 Ops docs & runbooks R1–R7
- [ ] M14-T26 Install & operate docs
- [ ] M14-T27 Quickstart matrix in nightly CI
- [ ] M14-T28 Sizing & profiles
- [ ] M14-T29 Release-readiness gate

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._

### M15 — Docs, README, demo & launch → 1.0

Status: not started · Tasks: 0/25 · Gate: —

- [ ] M15-T1 Copy review pass (CLI + dashboard)
- [ ] M15-T2 Accessibility audit
- [ ] M15-T3 Dashboard perf polish & stream leader election
- [ ] M15-T4 YAML completion & hovers; shortcuts sheet; `completion` command
- [ ] M15-T5 Pseudo-locale & RTL verification
- [ ] M15-T6 Translation infrastructure
- [ ] M15-T7 User-facing security & privacy docs
- [ ] M15-T8 Maintainer runbook & advisory templates
- [ ] M15-T9 Docs IA completion
- [ ] M15-T10 Media: GIFs, launch video, captions, social cuts
- [ ] M15-T11 Final README & package READMEs
- [ ] M15-T12 Demo Tier 1
- [ ] M15-T13 Demo Tier 2 (only if SP-10 passed)
- [ ] M15-T14 Changelog & release-notes pipeline; launch post
- [ ] M15-T15 Community & governance final
- [ ] M15-T16 Good-first-issue pipeline
- [ ] M15-T17 Docs metrics & Umami
- [ ] M15-T18 Launch kit
- [ ] M15-T19 Seeding: creators & newsletters
- [ ] M15-T20 External security review gate
- [ ] M15-T21 Wizard timing, `host transfer`, installable manifest
- [ ] M15-T22 Fresh-user dry runs 2–3 & launch rehearsal
- [ ] M15-T23 1.0 quality report
- [ ] M15-T24 Go/no-go & launch day
- [ ] M15-T25 Post-launch 30 days

#### Execution note

_Not written yet._

#### Milestone report

_Not written yet._
