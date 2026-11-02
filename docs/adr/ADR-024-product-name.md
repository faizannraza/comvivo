# ADR-024 — Product name: Folkstead

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode — `CLAUDE.md` §5)
- **Resolves:** owner decision **D-2** (`15` §1), pulled forward from M7/M8 to **M0**
- **Amends:** `01` §14 **A2** (naming & distribution); `13` §3.A

## Context

`00` carried **Village** as a codename only. `13` §3.A.1 had already found it unusable as a
product name: `village` on npm belongs to another company's SDK, so the plan's own
`npx village@latest init` would fetch someone else's package; Village.ai is an active AI SaaS in
the same Nice class 42; the obvious GitHub orgs are taken; every sensible domain resolves; and
"AI Village" is a well-known public experiment in which frontier agents share a group chat — the
nearest possible conceptual collision. `01` §14 A2 therefore put the name behind a single `BRAND`
constant and set a hard deadline of **M8 exit, before the first public tag**.

Two things moved that deadline to M0:

1. **The repository was already public** when work started (2026-11-01). Renaming after packages,
   container tags, store manifests and documentation exist is expensive and partly irreversible —
   Home Assistant, Umbrel and CasaOS store listings are slow to change, which is exactly why
   A2 forbids a rename after M14 starts.
2. **The project owner instructed it explicitly** on 2026-11-01: decide the name now, run the
   `13` §3.A process with real research, and apply it through `BRAND`.

The constraint set is `13` §3.A.2: meaning that fits "belongs to the group" (weight 2),
trademark distinctiveness (3), availability across npm/npm scope/GitHub org/GHCR/domains/handles
(3), spellable after one hearing across EN/ES/PT/DE/FR/HI/AR (2), rare enough in ordinary chat to
be a safe bot trigger word (2), not a common first name (1), and no cultural-appropriation
concern (1, knockout if severe).

## Decision

**The product is `Folkstead`.** Slug `folkstead`; display name `Folkstead`.

Old English *folcstede* — a compound of *folk* (a people, your people) and *stead* (a place or
holding, as in homestead, farmstead, Hampstead) — meaning **"the dwelling place of a people"**.
The word is recorded in the OED and survives only in Yorkshire dialect, so it is functionally
extinct in modern English. That combination is the point: it carries the right meaning to anyone
who stops to read it, describes nothing about software, and is therefore an **arbitrary** mark —
the strongest class realistically available without inventing a nonsense word.

`BRAND` (`packages/shared/src/brand.ts`) is the single runtime home of the name. The AST guard,
the rename codemod and the weekly rename drill specified in `13` §3.A.6 are built as planned and
are **not** retired by this decision: they are what keeps a forced change to one command.

### What this sets

| Surface | Value |
|---|---|
| npm CLI package | `folkstead` (so `npx folkstead@latest init`) |
| npm scope | `@folkstead` |
| CLI binary | `folkstead` |
| Config file | `folkstead.yaml` |
| Env prefix | `FOLKSTEAD_` (platform tokens such as `TELEGRAM_BOT_TOKEN` stay unprefixed) |
| Container image | `ghcr.io/folkstead/folkstead` — `ghcr.io/faizannraza/folkstead` until the GitHub org exists |
| Default bot persona | `Folkstead`, alias `folkstead`. Groups rename their own bot; a product rename never changes an existing group's bot name |
| Primary domain | `folkstead.dev` (not yet purchased; GitHub Pages is used until it is) |
| Legacy compatibility | `BRAND.legacy` carries `VILLAGE_` and `village.yaml`, accepted with a deprecation warning until 1.1 |

## Alternatives considered

`13` §3.A.3's recommended shortlist was cleared in its stated order. **All four failed.** The full
evidence, with URLs and HTTP statuses, is in the gitignored `naming/decision-2026-11-01.md`;
§3.A.3 itself was redacted from the public tree per §3.A.5 so the candidates cannot be squatted.

| Alternative | Why not |
|---|---|
| **Kinhold** (§3.A.3's first choice) | `kinhold.app` hosts a live, marketed product called *Kinhold*: an open-source, self-hostable family hub with an AI chat assistant, an MCP server, permission-aware access and a paid hosted tier. Active repository through 2026-10-25. Same category, same positioning, same distribution model — senior common-law rights and permanent, unwinnable confusion. GitHub org taken, so no `ghcr.io/kinhold` |
| **Folkmoot** | GitHub org taken, and a repository named `folkmoot` is already a messaging app *between agents*. Folkmoot USA, a long-running international folk festival, owns the search space. "Moot" also means *irrelevant* in English |
| **Thorp** | ThorpCare Inc. and ThorpLabs (one owner, both shipping in 2026) sell group chat for families, an MCP server for Claude, and "AI assistants and agents" — with no registration, which makes their senior use invisible to every database. `.dev`, `.com`, `.org`, `.ai`, `.app` all registered; GitHub org taken. SEO owned by the Sellafield THORP nuclear plant. Phonetics fail three ways: ES/PT/TL hear *torpe* ("clumsy, sordid, stupid"); Japanese renders it ソープ (*sōpu*), which is brothel slang and the standard katakana for Thorp; and English speakers cannot reliably choose *thorp* vs *thorpe* after one hearing |
| **Commonhold** | A dictionary headword *and* a live English statutory term (Commonhold and Leasehold Reform Act 2002) at peak public salience, with a reform bill before Parliament. Descriptive of the very concept being sold, so weak or unregistrable; ~46 UK companies already trade under it; page 1 of search is entirely government, legal and dictionary content |
| **Plenum**, **Witan**, **Skein**, **Steading** | npm name and/or GitHub org already taken. Witan Labs ships an LLM product and Hyperledger Indy's consensus protocol is called Plenum — both in-field |
| **Frith** / **Frithstead** | GitHub user taken; 115 matching repositories, one of them "Team chat where accumulated knowledge is the product" — our category |
| **Chaupal**, **Mehfil** (South Asian gathering words, authentic to the owner's background) | GitHub org taken for both. Also multiple accepted romanisations, which fragments search and typing, and Mehfil is a very common restaurant name |
| **Folkhold** | Clean namespace, but structurally identical to the **Kinhold** competitor — `-hold` compounds would be confused with it indefinitely |
| **Moothall** (runner-up, scored 37.75 vs Folkstead's 41) | Clean namespace and an excellent semantic fit — the moot hall is literally where a community's assembly settled shared matters, which maps onto the group constitution. Rejected because English "a moot point" means *irrelevant*: the name undercuts the product every time a native speaker hears it, in precisely the audience we most need |
| Keeping **Village** | Ruled out by `13` §3.A.1 before this ADR: npm name taken by another company, Village.ai active in class 42, "AI Village" is the nearest conceptual collision, all domains gone, and a generic word makes a weak mark with poor search ranking and frequent false bot invocations ("the village fair") |

## Consequences

**Good**
- Every surface that matters for an open-source developer tool is free: npm `folkstead` and
  `create-folkstead`, the `@folkstead` scope, the GitHub org `folkstead` (and therefore
  `ghcr.io/folkstead`), zero matching GitHub repositories, `folkstead.dev`/`.org`/`.sh`/`.chat`/`.ai`,
  PyPI, crates.io, Hugging Face, Mastodon and LinkedIn.
- No software, AI, chat or group-coordination product uses the name anywhere. Trademarkia returns
  **zero** results, and USPTO's own index ranks no FOLKSTEAD-shaped mark.
- An extinct dictionary word is an arbitrary mark for software — strong, and with no SEO
  competition to fight.
- The meaning is on-brand and inclusive: *folk* covers friends, roommates, teams, clubs and
  school-parent groups, not only families, which *kin* would have skewed toward.
- Essentially never appears in ordinary chat, so it is a safe bot trigger word
  (measured against `13` §3.A.2 criterion 5 in `M3-T22`).

**Bad / accepted costs**
- **The formal trademark registers were not searched.** Every one of them refused automated
  access: USPTO's search is an interactive SPA with no documented wordmark field, TSDR requires an
  API key, EUIPO/TMview sits behind a WAF, WIPO behind a proof-of-work challenge, UKIPO behind a
  CAPTCHA. What was done instead — Trademarkia (zero results) plus USPTO's fuzzy index, validated
  against control queries that *did* surface exact matches — is a **substitute, not a clearance
  opinion**, and is stated as such here and in `STATUS.md`.
- A small solo apparel brand already trades as *Folkstead* in Nice class 25 and holds `.com`,
  YouTube, Facebook and the Bluesky handle. Different class, tiny operation, no registration found;
  coexistence is routine. We take `.dev` (the spec's primary), `.org`, `.sh` and a Bluesky **domain**
  handle.
- "Folk" pulls a folk-music association in bare search. Qualified queries are uncontested.
- Nine characters is a longish CLI name. A shell alias is documented rather than shipping a second
  `bin`, which would invite conflicts.
- *folcstede* also carried a poetic sense of "battlefield" in Old English verse. Obscure, recorded
  so it is never a surprise.
- `folkstead.dev` is not bought yet, so `BRAND.urls` point at GitHub Pages and flip in one edit.

**Follow-ups**
- `M0-T5` encodes these values in `BRAND` and the AST guard.
- `M0-T15` writes `deploy/names.json` and the check/apply scripts.
- `M0-T19` keeps the rename codemod and the weekly drill green.
- `STATUS.md` **H-6** holds the owner actions: create the GitHub org `folkstead`, create the npm
  org (needs `npm login`), buy `folkstead.dev`, and claim the handles. Until the GitHub org exists
  the repository and image live under `faizannraza/`, and `BRAND.repo` is the single place that
  changes.
- `M3-T22` measures the name-invocation false-positive rate against the multilingual corpus
  (criterion 5 requires ≤ 0.1%).
- The native-speaker review in `13` §3.A.4 should specifically probe the German *Volk* / *völkisch*
  association and the silent *L* in "folk" for Spanish and Hindi/Urdu speakers.
- `M12-T33` (name hard-stop verification) stays in the plan as the contingency it was written to be.

## References
- `docs/plan/01-architecture.md` §14 **A2**; ADR-015 (packaging and distribution)
- `docs/plan/13-docs-launch-community.md` §3.A.1, §3.A.2, §3.A.4, §3.A.5, §3.A.6, §4.1
- `docs/plan/15-risks-and-open-questions.md` §1 **D-2**, §3 **R-9**
- `naming/decision-2026-11-01.md` (private, gitignored) — the unredacted evidence
