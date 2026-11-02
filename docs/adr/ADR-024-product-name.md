# ADR-024 — Product name: Comvivo

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode — `CLAUDE.md` §5)
- **Resolves:** owner decision **D-2** (`15` §1), pulled forward from M7/M8 to **M0**
- **Amends:** `01` §14 **A2** (naming & distribution); `13` §3.A

## Context

`00` carried **Village** as a codename only. `13` §3.A.1 had already found it unusable: `village`
on npm belongs to another company's SDK, so the plan's own `npx village@latest init` would fetch
someone else's package; Village.ai is an active AI SaaS in the same Nice class 42; the obvious
GitHub orgs are taken; every sensible domain resolves; and "AI Village" is a well-known public
experiment in which frontier agents share a group chat — the nearest possible conceptual collision.
`01` §14 A2 therefore put the name behind a single `BRAND` constant with a hard deadline of M8
exit, before the first public tag.

Two things moved that to M0: the repository was **already public** when work started, and renaming
after packages, container tags and appliance-store manifests exist is expensive and partly
irreversible (A2 forbids a rename after M14 starts for exactly that reason). The project owner
instructed on 2026-11-01 that the name be decided immediately, with real research.

Constraints are `13` §3.A.2: meaning that fits "belongs to the group" (weight 2), trademark
distinctiveness (3), availability across npm / npm scope / GitHub org / GHCR / domains / handles
(3), spellable after one hearing across EN/ES/PT/DE/FR/HI/AR (2), rare enough in ordinary chat to
be a safe bot trigger word (2), not a common first name (1), no cultural-appropriation concern
(1, knockout if severe).

## Decision

**The product is `Comvivo`.** Slug `comvivo`; display name `Comvivo`.

*com* (with/together — the Portuguese and Catalan form of Latin *cum*) + *vivo* (I live) →
**"living together"**. It is the root of English *convivial* / *conviviality*, which names both the
product's thesis (a group living shared life, with an AI that belongs to all of them) and its tone
target (`00` §3.3: quiet, warm, "people are glad it's here"). It is a coinage — the strongest mark
class — with **zero trademark records** and **zero prior software use** anywhere.

`BRAND` (`packages/shared/src/brand.ts`) remains the single runtime home of the name. The AST
guard, the rename codemod and the weekly rename drill (`13` §3.A.6) are **not** retired by this
decision: they are what kept this reversible, and they were used twice during it.

### What this sets

| Surface | Value |
|---|---|
| npm CLI package | `comvivo` (so `npx comvivo@latest init`), with `convivo` and `create-convivo` claimed defensively as deprecation stubs |
| npm scope | `@comvivo` |
| CLI binary | `comvivo` |
| Config file | `comvivo.yaml` |
| Env prefix | `COMVIVO_` (platform tokens such as `TELEGRAM_BOT_TOKEN` stay unprefixed) |
| Container image | `ghcr.io/comvivo/comvivo` — `ghcr.io/faizannraza/comvivo` until the GitHub org exists |
| Default bot persona | `Comvivo`, alias `comvivo`. Groups rename their own bot; a product rename never changes an existing group's bot name |
| Primary domain | `comvivo.dev` (not yet purchased; GitHub Pages is used until it is) |
| Legacy compatibility | `BRAND.legacy` carries `VILLAGE_` and `village.yaml`, accepted with a deprecation warning until 1.1 |

## Alternatives considered

Four waves, ~50 candidates. The full evidence with URLs and HTTP statuses is in the gitignored
`naming/decision-2026-11-01.md`; `13` §3.A.3's longlist was redacted from the public tree per
§3.A.5 so the candidates cannot be squatted.

| Alternative | Why not |
|---|---|
| **Kinhold** (`13` §3.A.3's first choice) | `kinhold.app` hosts a live product called *Kinhold*: an open-source, self-hostable family hub with an AI chat assistant, an MCP server, permission-aware access and a paid hosted tier. Same category, same positioning, same distribution model — senior common-law rights and permanent confusion |
| **Folkmoot** | GitHub org taken; two separate repositories named `folkmoot` are AI-agent group-decision tools, one citing the identical Old-English etymology; `folkmoot.app` is an active voting product; and Folkmoot USA, North Carolina's official state folk festival, owns the search space |
| **Thorp** | ThorpCare and ThorpLabs sell family group chat, an MCP server for Claude, and "AI assistants and agents" with no registration — senior use invisible to every database. All good domains gone. Phonetics fail three ways: ES/PT hear *torpe* ("clumsy, sordid"); Japanese renders it ソープ, brothel slang; and *thorp* vs *thorpe* is unresolvable by ear |
| **Commonhold** | A dictionary headword and a live English statutory term with a reform bill before Parliament: descriptive, weak or unregistrable, ~46 UK companies already trading under it, and page 1 of search is entirely government and legal content |
| **Folkstead** — *chosen, then reversed* | Cleared every availability and trademark check perfectly and was decided, written up and applied. **Reversed within the hour** on a register finding: "folkish" (German *völkisch*) is the self-applied label of the racist branch of Germanic Heathenry, and **"stead" is a documented Heathen term for a kindred** (the Asatru Alliance: "Kindreds are sometimes called a garth, **stead**, or skeppslag"), with "folk-" as that movement's marker prefix (cf. the Asatru **Folk** Assembly; the SPLC's "Neo-Völkisch" category). No actual far-right use of "folkstead" exists — the risk is a latent reading — but it is unfixable by explanation, it lands on a product whose entire pitch is inclusive shared belonging, and avoiding it cost one hour before any product code existed. **The structural consequence is recorded below.** |
| **Commonry** — *chosen, then blocked* | COMMONRY, Commonry Pty Ltd, **Live/Registered**, International Classes **003 and 009** — class 9 is downloadable software. Plus a second live-pending COMMONRY in class 045, and an active community platform at `GiveProtocolFoundation/Commonry` |
| **Commonage** | Trademark clear, npm and GitHub org free — but `commonage.app` is *Commonage* by Digital Tide LLC, a community-association platform that "keeps a community's properties, people and **decisions** in one place". Rejecting it was required for consistency with the Kinhold and Thorp rejections |
| **Alltold** | Trademark zero and npm free, but *Alltold* is a VC-funded AI startup (2023, ex-Google founders) owning the GitHub org and `.ai`/`.app`/`.com`. Same field, senior by three years |
| **Evenhand** | Trademark zero and npm free, but both `evenhand` and `evenhandhq` orgs are taken, all good domains are registered, and three adjacent projects already use it — including a group-expense-settling CLI and "a neutral witness for AI agents" |
| **Chaupal** (the South Asian village square; semantically the best fit found, and authentic to the author's background) | CHAUPAL, Bosna Digital Entertainment Pvt Ltd, **Live/Registered, classes 009 and 038**, active to 2029 |
| **Mohalla** (the tight-knit neighbourhood) | Mohalla Tech Pvt Ltd — the $1bn+ company behind ShareChat and Moj, 325M monthly users. Same broad field |
| **Moothall** (runner-up in wave 2, scored 37.75) | Clean namespace and an excellent semantic fit — a moot hall is literally where a community's assembly settled shared matters. Rejected first because "a moot point" means *irrelevant* in English, then conclusively by the register finding |
| **Convivio**, **Gatherly**, **Plenum**, **Witan**, **Skein**, **Throughline**, **Frith**, **Comity**, **Conclave**, **Caucus**, **Steading**, **Baithak**, **Sangat**, **Ourlot**, **Convivo** | Crowded trademarks, taken npm names, taken GitHub orgs, or in-field conflicts. *Ourlot* additionally fails on product judgement: "our lot" names the **group**, not the agent, so addressing the bot by it is semantically confused. *Convivo* — the correct Latin spelling — is thoroughly taken, which is precisely why the `com-` coinage is free |
| Keeping **Village** | Ruled out by `13` §3.A.1 before this ADR |

### The structural finding this produced

**The entire Anglo-Saxon / Norse revivalist register is off-limits for this product.** Not only
*folk-*, *moot* and *stead*, but also **garth**, **hearth**, **kindred**, **thing**, **frith**
(a core Heathen concept — the peace within a kindred), **troth** (The Troth is a Heathen
organisation), **thorp**, **kith** and **kin**. `13` §3.A.3's whole candidate family — Kinhold,
Folkmoot, Thorp, Ingle, Hearthly, Kinfold, Usward — drew from that one contaminated well, which is
why wave 1 and wave 2 both failed. Any future rename must avoid it.

A second finding: **every apt dictionary word or obvious compound in this semantic space is already
claimed**, usually by someone building something adjacent, because the space is crowded with people
solving related problems who reach for the same words. `13` §3.A.2 anticipated this by weighting
distinctiveness at 3 and ranking *coined > arbitrary > suggestive > descriptive*; the practical
consequence is that **only a genuine coinage is reliably free**, which is also the strongest mark.
That is what the successful self-hosted projects did (Immich, Jellyfin, Forgejo, Traefik, Umami,
Vaultwarden, Ollama), and it is where this decision landed.

A third, procedural: **screen trademark and same-category products first, availability second.**
Those two checks are the only ones that kill a name outright and both are cheap. Checking them last
cost two reversals.

## Consequences

**Good**
- Every surface that matters is free: npm `comvivo` and `create-comvivo`, the `@comvivo` scope, the
  typo-space (`convivo`, `create-convivo`), the GitHub org `comvivo` (and therefore
  `ghcr.io/comvivo`), zero matching GitHub repositories, `comvivo.dev`/`.org`/`.sh`/`.ai`/`.app`,
  PyPI, crates.io, Hugging Face, Mastodon, LinkedIn and the Bluesky handle.
- Trademarkia returns **zero** results, and no software, AI, chat or group-coordination product
  uses the name anywhere.
- A coinage, so the strongest mark class, with no SEO competition to fight.
- Latin/Romance register: no Germanic-revivalist, religious, statutory, political or
  ethnic-nationalist reading — the trap that sank two earlier choices.
- Globally pronounceable and, for ~700M Spanish and Portuguese speakers, spelled correctly on first
  hearing, because *com* is their word for "with" and *vivo* is theirs for "I live".
- Three syllables, seven letters. `npx comvivo init`, `@comvivo/core`,
  `ghcr.io/comvivo/comvivo`, `comvivo.dev` all read cleanly.

**Bad / accepted costs**
- **The formal trademark registers were not searched.** USPTO's search is an interactive SPA with
  no documented wordmark field, TSDR needs an API key, EUIPO/TMview sits behind a WAF, WIPO behind
  a proof-of-work challenge, UKIPO behind a CAPTCHA. Trademarkia's zero result is a strong
  substitute but **not a clearance opinion**, and is stated as such here and in `STATUS.md`.
- English-first speakers may reach for `con-`. Mitigated by claiming the `convivo` npm names as
  deprecation stubs and by `comvivo.dev` being the only live site.
- VIVO (the handset maker) holds marks including class 9. COMVIVO is a unitary coined word, not
  "Vivo" with a prefix, and *vivo* is a weak common Romance word used by many unrelated brands
  (Workvivo, Medvivo, Vivo Energy, Savivo). Recorded as the one trademark residual for an attorney.
- A French artisan cushion brand uses ComVivo in classes 24/27 and holds `comvivo.fr`. Unrelated
  class, no registration.
- `comvivo.com` has been parked by a third party since 2005.
- `comvivo.dev` is not bought yet, so `BRAND.urls` point at GitHub Pages and flip in one edit.

**Follow-ups**
- `M0-T5` encodes these values in `BRAND` and the AST guard.
- `M0-T15` writes `deploy/names.json` and the check/apply scripts, including the defensive
  `convivo` names.
- `M0-T19` keeps the rename codemod and the weekly drill green — it earned its place twice today.
- `STATUS.md` **H-6** holds the owner actions: create the GitHub org `comvivo`, create the npm org,
  buy `comvivo.dev`, claim the handles. Until the org exists the repository and image live under
  `faizannraza/`, and `BRAND.repo` is the single place that changes.
- `M3-T22` measures the name-invocation false-positive rate against the multilingual corpus
  (criterion 5 requires ≤ 0.1%).
- `13` §3.A.3's longlist is superseded: any future rename must avoid the revivalist register
  identified above and should start from coinages.

## References
- `docs/plan/01-architecture.md` §14 **A2**; ADR-015 (packaging and distribution)
- `docs/plan/13-docs-launch-community.md` §3.A.1, §3.A.2, §3.A.4, §3.A.5, §3.A.6, §4.1
- `docs/plan/15-risks-and-open-questions.md` §1 **D-2**, §3 **R-9**
- `naming/decision-2026-11-01.md` (private, gitignored) — the unredacted evidence for all four waves
