# Competitor check: "Invariant ratchet" (mine -> falsify -> ratify -> ratchet invariants for brownfield codebases), as of Oct 31, 2026

Idea under test (short form): (1) MINE semantic/business invariants from existing code via LLM agents and dynamic analysis (Daikon-style); (2) FALSIFY candidates with adversarial PBT/fuzzing/counterexample search and report real bugs found; (3) RATIFY survivors as plain-language statements with one-click accept/reject/edit, stored in-repo as executable properties/contracts; (4) RATCHET: every future change by any agent or human is checked; set only grows; violations block merge unless a human amends; the invariant file is a vendor-neutral, machine-checkable "constitution" for all coding agents.

Scoring used below: each competitor is scored against the four stages (M / F / R / E = mine / falsify / ratify / enforce-ratchet). Percentages are my judgment, not vendor figures.

## Key Question 1: Do products/OSS projects infer specs/invariants from existing code and enforce them on future changes? (named list)

### Takeaway
No product does the full loop. Commercial AI reviewers (Qodo, Cursor Bugbot, Greptile, CodeRabbit) now *mine rules and enforce them on every PR*, but the rules are natural-language review conventions mined from PR comments/feedback, judged by an LLM, stored in vendor dashboards, never falsified, and pruned rather than ratcheted. Tools that *falsify* (Anthropic's agentic PBT, Antithesis, Benchify, Imandra) do not persist a ratified, merge-gating invariant set. Spec-driven tools (Kiro, Spec Kit, Tessl) start from human-written specs, not mined brownfield behavior.

### Cited Findings

**Qodo (Rules System / Rule Miner) — closest commercial match on M+R+E (~40%)**
- Qodo's changelog lists "Rule Miner" (beta), which "automatically discovers recurring review patterns from your organization's pull request history and generates rules from them" — [Qodo changelog](https://docs.qodo.ai/changelog)
- Qodo 2.1 (Feb 2026) added "Rule generation from natural language; Automatic rule discovery from codebase and PR history; Scoped enforcement at organization and repository levels"; rules are applied programmatically during PR review and the product recommends fixes on violations — [IT Brief](https://itbrief.co.uk/story/qodo-2-1-adds-ai-driven-rules-for-smarter-code-review)
- A "Rules Discovery Agent generates rules automatically from existing code patterns and PR history. Recurring review comments become rule candidates" — [IT Brief](https://itbrief.co.uk/story/qodo-2-1-adds-ai-driven-rules-for-smarter-code-review)
- A Qodo-authored overview (citing an Oct 2026 changelog entry I could not independently confirm) says rules whose findings are rarely fixed switch off automatically once enforcement is on, unless a team locks them — the opposite of a monotone ratchet — [Qodo 3.0 post](https://www.qodo.ai/?p=22534)
- What it does NOT do: no dynamic analysis/traces; no adversarial falsification of candidate rules; rules are review conventions/patterns (LLM-judged) rather than executable runtime properties; not a vendor-neutral file consumed by all agents.

**Cursor Bugbot learned rules (~35%)**
- Bugbot "can now learn from feedback on pull requests and turn those signals into learned rules"; it uses reactions/replies to its comments and human reviewer comments to create candidate rules, and "automatically promotes the ones that accumulate signal and disables the ones that stop being useful" — [Cursor blog: Bugbot learning](https://cursor.com/blog/bugbot-learning)
- "More than 110,000 repos have enabled learning, generating more than 44,000 learned rules" — [Cursor blog](https://cursor.com/blog/bugbot-learning)
- Learned rules live only in the Cursor dashboard; a user forum feature request asks for an "API or Git-based workflow to promote Bugbot learned rules into repository rules" — [Cursor forum](https://forum.cursor.com/t/api-or-git-based-workflow-to-promote-bugbot-learned-rules-into-repository-rules/171018) (strong evidence of demand for in-repo, portable rules)
- Lacks: mining from code behavior (mines from review feedback), falsification, human ratification (promotion is automatic), executable properties, ratchet (rules auto-disabled).

**Greptile / CodeRabbit / Semgrep (~20–30% each)**
- Greptile "can infer rules by observing other developers in your team commenting on PRs, as well as from interaction data such as replies to Greptile comments and 👍/👎 reactions"; scoped to repos/paths — [Greptile docs: memory and learning](https://www.greptile.com/docs/how-greptile-works/memory-and-learning); Greptile's own guide says to verify auto-created rules align with preferences — [Greptile best practices](https://www.greptile.com/docs/code-review-bot/best-practices)
- CodeRabbit "Learnings" are captured from PR comments; users can filter, edit, or delete learnings on a dashboard page — [CodeRabbit docs commit](https://github.com/coderabbitai/coderabbit-docs/commit/395545b487ac4440213d20b24b2868993d64e2c9); custom review rules and path instructions are separate features — [CodeRabbit features](https://coderabbit.ai/features)
- Semgrep Assistant "Memories" tailor remediation guidance; scoped per project/vulnerability class/rule; non-admin suggestions need admin activation — [Semgrep docs](https://semgrep.dev/docs/semgrep-assistant/customize). I found no evidence Semgrep mines repo-specific semantic invariants from code behavior.

**Amazon Kiro (spec + property-based testing) (~30%)**
- Kiro "extracts properties from your EARS-formatted requirements," defines a property as "a universal statement about how your system should behave," and links each property back to its requirement and task — [Kiro docs: correctness](https://kiro.dev/docs/specs/correctness/)
- GA announcement: Kiro extracts properties from requirements, determines which can be logically tested, then generates hundreds/thousands of random test cases; PBT is "not formal verification" — [Kiro GA blog](https://kiro.dev/blog/general-availability/)
- Kiro can generate steering files from an existing codebase — [Tom's Hardware Italia](https://www.tomshw.it/business/kiro-ide-spec-driven-development); a competitor argues Kiro fits greenfield better because the requirements→design→tasks workflow adds friction on existing codebases — [Augment comparison](https://www.augmentcode.com/tools/kiro-vs-augment-code) (vendor-competitor source)
- Lacks: properties come from human-written requirements for new work, not mined from brownfield behavior; no candidate-invariant falsification stage; no repo-wide ratchet gating all agents; Kiro-locked.

**GitHub Spec Kit (~15–25% incl. community extensions)**
- Official brownfield guide: initialize in place, "capture the rules that matter," and use the workflow for the next bounded change; no requirement to re-spec the system — [Spec Kit: existing projects](https://github.github.com/spec-kit/guides/existing-projects.html)
- A community "brownfield bootstrap" extension scans a codebase, generates a constitution from existing conventions, and reverse-engineers specs — [Spec Kit community extension](https://speckit-community.github.io/extensions/brownfield); proposed in [spec-kit issue #1436](https://github.com/github/spec-kit/issues/1436)
- A fork ("Spark") adds constitution-driven PR reviews and codebase-wide compliance audits — [Mark Hazleton blog](https://markhazleton.github.io/mark-hazleton-s-notes/blog/why-i-forked-github-spec-kit)
- Lacks: constitution is prose read by agents; no executable properties; no falsification; enforcement only via LLM review in forks.

**Tessl (~5–10%)**
- Tessl paused its spec-as-source "Framework" to concentrate on registry functionality and agent integration; v0.28.0 remains available but development is paused — [Tessl changelog](https://docs.tessl.io/changelog)
- Tiles are "reusable, structured context for agents"; developers can generate tiles for code they maintain plus evals — [Tessl blog](https://tessl.io/blog/my-coding-agent-needed-a-package-manager-for-its-own-brain-and-i-gave-it-one-using-a-skills-registry)
- Lacks: invariant mining, falsification, enforcement. A third-party overview's status claims conflict with the changelog — [rywalker.com](https://rywalker.com/research/tessl)

**Anthropic/MATS "Agentic Property-Based Testing" (arXiv 2510.09907) — closest on M+F (~35–40%)**
- An LLM agent "analyzes Python modules, infers function-specific and cross-function properties from code and documentation, synthesizes and executes PBTs" (Hypothesis + pytest); evaluated on 100 popular Python packages; agent decides which functions to target and whether a failing property is a real bug (with a rubric) — [arXiv 2510.09907](https://arxiv.org/abs/2510.09907v1). Authors: Maaz (MATS/Anthropic), DeVoe, Hatfield-Dodds, Carlini.
- A summary reports 56% valid bug reports — [Emergent Mind](https://www.emergentmind.com/papers/2510.09907) (secondary)
- Code at github.com/mmaaz-git/agentic-pbt; packaged as a Claude Code "hypo-plugin" (~82 stars, last updated Nov 3, 2025) — [Skillselion listing](https://skillselion.com/skills/mmaaz-git/agentic-pbt/hypo-plugin)
- Lacks: goal is bug-finding — passing properties are not presented for ratification or persisted as a governed suite; no dynamic-trace mining; no merge gate/ratchet; Python only.

**Antithesis (antithesis-skills for Claude Code) (~45%, unverified internals)**
- The `antithesis-research` skill builds a property catalog; the `antithesis-workload` skill maps properties into SDK assertions (`Always`/`AlwaysOrUnreachable` for safety, `Sometimes` for liveness, `Reachable`/`Unreachable`) that run under fault injection on Antithesis; the catalog is stored in-repo at `antithesis/scratchbook/property-catalog.md` with per-property evidence files; the workload skill implements one property at a time and waits for user confirmation; repo Apache-2.0, ~304 stars, version dated 2026-07-14 — [Claude Skills Hub mirror of antithesis-skills](https://claudeskills.info/skills/antithesishq/antithesis-skills/antithesis-workload/) (third-party mirror; I could not load the GitHub repo directly)
- Lacks: how the research skill infers properties is undocumented in what I saw; tied to the paid Antithesis simulation platform and system-level workloads; no documented CI merge gate or monotone ratchet; catalog is a scratchbook, not a vendor-neutral constitution for other agents.

**Hypothesis Ghostwriter (~5%)**
- Ghostwriter "inspects the function name, argument names and types, and docstrings" to emit roundtrip/equivalent/idempotent/binary-op/ufunc/fuzz tests; the docs explicitly contrast it with execution-based invariant detection like Daikon — [Hypothesis docs](https://hypothesis.readthedocs.io/en/latest/reference/integrations.html). No LLM, no mining of semantic business rules, no enforcement layer.

**Diffblue (behavioral ratchet of examples, not rules) (~25%)**
- Diffblue Cover writes unit tests "derived from existing code, so they reflect the current functionality of the program. This primary map of the code is used to test new commits" — [Diffblue resource](https://www.diffblue.com/resources/how-unit-regression-tests-are-created/)
- Diffblue Testing Agent GA on Mar 24, 2026, works alongside Copilot/Claude Code; vendor benchmark 81% line coverage on 8 Java projects; Java and Python only — [AP/Business Wire via Standard-Journal](https://www.standard-journal.com/ap/business/article_41479cfa-823a-56bf-a387-94acd8f11bb9.html); regression workflow requires compiling project and passing tests — [Diffblue docs](https://docs.diffblue.com/workflows/regression-unit-tests.md)
- Lacks: captures example-level characterization tests, not human-readable invariants; no ratification of rules; no falsification of hypotheses.

**Imandra CodeLogician (~35%)**
- Agent autoformalizes existing source (e.g., Python) into an executable IML model, making hidden assumptions explicit; "verification goals" are predicates checked symbolically over all inputs, and ImandraX returns concrete counterexamples on failure; example: transitivity of a trading-system ranking function — [arXiv 2601.11840](https://arxiv.org/abs/2601.11840v2)
- LangGraph agent + ImandraX; a tutorial turns code comments into verification goals; requires Imandra Universe API key — [Imandra docs](https://docs.imandra.ai/universe/code_logician/introduction/)
- Lacks: goals largely authored (or derived from comments) rather than mined from behavior at scale; no ratchet/merge-gate governance; proprietary reasoning engine.

**Benchify (YC) (~30%, status uncertain)**
- "Automatically writes a blueprint of how the code is intended to function, then tests the code against it using thousands of strategically generated inputs," posts results as PR comments with verified bugs/unit tests — [YC launch](https://ycombinator.com/launches/Law-benchify-automatic-code-reviews-that-work)
- Benchify's Max von Hippel co-authored FVSpec (11,039 real-world PBTs scraped; 2,772 translated to Lean 4) — [FVSpec](https://huggingface.co/papers/2606.01008.md)
- Lacks: per-PR, ephemeral properties; no ratified persistent invariant set; YC listing described as beta; a Benchify blog page focuses on vibe coding, suggesting a possible repositioning (unconfirmed).

**Theorem (YC S25), Harmonic, Atlas Computing, Axiom — formal-verification players (~10–15%)**
- Theorem raised $6M to formally verify AI-generated code; uses "fractional proof decomposition" — [VentureBeat](https://venturebeat.com/security/theorem-wants-to-stop-ai-written-bugs-before-they-ship-and-just-raised-usd6m)
- Harmonic announced (Oct 27, 2026) Aristotle expanding to code verification, starting with C and Verilog; reports don't explain integration or how accuracy was measured — [Let's Data Science](https://letsdatascience.com/news/harmonic-expands-aristotle-model-to-software-and-chip-design-c355d759); [Digg summary](https://digg.com/ai/rks9ncnr)
- Atlas Computing (nonprofit) is building an AI system that drafts, reviews, and checks formal specs — [Schmidt Sciences](https://www.schmidtsciences.org/?p=16077); [Metagov](https://metagov.org/projects/atlas-computing)
- All verify code against specs; none found that mines a brownfield repo's implicit business invariants and governs them as a ratchet. "Verification only proves code meets its specification" — [VentureBeat](https://venturebeat.com/security/theorem-wants-to-stop-ai-written-bugs-before-they-ship-and-just-raised-usd6m)

**Enforcement-side tools (no mining): Sonar, Corridor, CodeScene, Moderne, Entire, DataGrout invariant-cli**
- SonarQube 2026.4 adds an AI-specific quality gate, architecture management, and agentic-security rules — [Sonar 2026.4](https://www.sonarsource.com/products/sonarqube/whats-new/2026-4/); agents use SonarQube MCP to iterate until code passes the hardened profile — [Sonar blog](https://www.sonarsource.com/ko/blog/how-to-optimize-sonarqube-for-reviewing-ai-generated-code/). Generic vendor rules, not repo-mined invariants.
- Corridor guardrails: security rules given to agents via MCP during generation and run as checks on PR diffs; integrations with Claude Code (Mar 2026), Codex CLI and Cursor (May 2026) — [Corridor guardrails](https://docs.corridor.dev/features/guardrails); [Corridor changelog](https://docs.corridor.dev/changelog). This is the closest existing "same rules, all agents, pre-gen + merge" pattern, but security-only and not mined.
- CodeScene CodeHealth MCP gives agents deterministic code-health feedback; setup uses an AGENTS.md — [CodeScene docs](https://codescene.io/docs/developer-tools/mcp/codescene-mcp-server.html)
- Moderne's Moddy agent uses OpenRewrite's rules-based transformations; workshop warns AI-written recipes can be incorrect without checks — [DevOps.com](https://devops.com/moderne-adds-ai-agent-to-simplify-application-modernization-initiatives/); [Moderne docs](https://docs.moderne.io/user-documentation/agent-tools/skills)
- Entire (Dohmke; $60M seed Feb 2026) first shipped an OSS tool storing AI-agent context; July 2026 preview of a distributed Git network for agents — [Axios](https://www.axios.com/2026/02/10/former-github-ceo-ai-coding-startup); [SiliconANGLE](https://siliconangle.com/2026/07/08/ex-github-chiefs-entire-opens-distributed-git-network-agent-era/). No invariant mining/enforcement found. Entire is a plausible future platform owner for a "constitution" layer.
- DataGrout invariant-cli 0.7.0 (2026-07-21, Elastic License 2.0): tree-sitter structural fact extraction, server-side LLM enrichment, "enforcing architectural rules," real-time validation of AI-generated code; no dynamic analysis, no human ratification, no PR gating documented — [docs.rs invariant-cli](https://docs.rs/invariant-cli/latest/invariant/)

### Inferences
- The market has converged on "learned rules + PR enforcement" (Qodo, Bugbot, Greptile, CodeRabbit). These are the most dangerous fast-followers because they already own the PR gate and the "rules" UX; adding dynamic mining + PBT-backed executable rules is a plausible roadmap step for Qodo (which historically had Qodo Cover test generation) or Cursor.
- Incumbents explicitly *prune* rules (Qodo auto-disables, Bugbot disables); the monotone, human-amendment-only ratchet is a deliberate product difference, not an oversight they've solved.
- The Bugbot forum request to export learned rules into repo rules is direct evidence of unmet demand for a portable, in-repo, vendor-neutral rule file.

### Gaps
- Factory, Augment, Sourcegraph (Amp/Cody): searches returned nothing specific about mined/enforced invariants; not verified either way.
- Qodo Cover's 2026 status (maintained vs archived) not verified.
- Axiom: no 2026 code-verification product found in results.
- Antithesis research-skill internals (how properties are inferred) not verified; GitHub repo failed to load.
- Corridor and Sonar do not appear to mine repo-specific rules, but I did not exhaustively check their 2026 changelogs.

## Key Question 2: Academic work 2023–2026 — has anyone built an end-to-end mine -> falsify -> ratify -> enforce loop for real repos?

### Takeaway
Research has built mine+falsify loops (Code-Augur 2026, SpecFuzzer+LLM counterexamples at ICST 2026, agentic PBT 2025, ClassInvGen 2025) and separately enforce-only frameworks (ContextCov, Protocol-Driven Development). I found no paper that closes the loop with human ratification and an ongoing merge-gating ratchet on real repos. The SpecOps 2026 workshop and a 2026 paper listing spec-surface extraction for legacy code as an "open problem" corroborate that the brownfield piece is unsolved.

### Cited Findings
- **Daikon remains the baseline**, not superseded; 2025 work layers LLMs on top (LLM proposes predicates, Daikon infers) — [SAC '25 paper](https://dl.acm.org/doi/pdf/10.1145/3672608.3707984); a May 2026 tutorial reimplements a simple Daikon-style runtime invariant miner with no LLM and no CI use — [Lobsters / Gopinath](https://lobste.rs/s/e1eqdm/simple_runtime_invariant_miner)
- **ClassInvGen** pairs an LLM with test generation to synthesize class invariants, outperforming pure-LLM spec generation and Daikon-style inference — [arXiv 2502.18917](https://arxiv.org/pdf/2502.18917)
- **"Improving Dynamic Specification Inference with LLM-Generated Counterexamples"** (ICST 2026, arXiv 2604.10761): LLMs generate tests to invalidate assertions inferred by SpecFuzzer; discards up to 11.68% of invalid assertions, precision +7% without hurting recall — [ICST 2026 listing](https://conf.researchr.org/details/icst-2026/icst-2026-research/36/Improving-Dynamic-Specification-Inference-with-LLM-Generated-Counterexamples). This is literally "Daikon-style mining + LLM falsification," with modest gains and no ratify/enforce.
- **Code-Augur** (Luo, Zafar, Wolff, Roychoudhury; Jun 2026): agent records local security invariants as in-source assertions, grey-box fuzzers (libFuzzer/Jazzer) try to falsify them, LLM triage decides real vuln vs flawed spec and refines; 22 new vulnerabilities found — [arXiv 2606.18619](https://arxiv.org/html/2606.18619). Closest research M+F loop; security-only; no human ratification or ratchet.
- **AgenTest** (Oct 20, 2026): mines business rules from an LLM agent's system prompts/tool definitions into Given-When-Then specs and tests them; removes specs relying on undefined concepts; reports some mined specs are incorrect — [arXiv 2610.28116](https://arxiv.org/abs/2610.28116). Business-rule mining, but targets LLM agents, not codebases.
- **PROBE** (ACL Findings 2026): agent tries to "break" generated properties by constructing counter-implementations to expose weak properties — [ACL Anthology](https://aclanthology.org/2026.findings-acl.683.pdf)
- **Loop/postcondition lines**: Lemur (LLM proposes invariants as sub-goals checked by automated reasoners) — [Lemur](https://ar5iv.labs.arxiv.org/html/2310.04870); BALI (SMT-checked LLM loop invariants with counterexample feedback) — [arXiv 2601.00882](https://arxiv.org/html/2601.00882v1); SpecMind (interactive multi-turn postcondition inference) — [arXiv 2602.20610](https://www.alphaxiv.org/abs/2602.20610.md); TU Wien LLM-guided likely invariants for distributed systems refined by runtime-monitoring counterexamples — [Xia 2025](https://repositum.tuwien.at/bitstream/20.500.12708/219559/1/Xia-2025-Guiding%20Likely%20Invariant%20Synthesis%20on%20Distributed%20Systems%20with%20L...-vor.pdf); symbolic execution + LLM spec generation — [arXiv 2506.09550](https://arxiv.org/pdf/2506.09550); study of logical constructs in LLM spec generation — [arXiv 2602.00715](https://arxiv.org/pdf/2602.00715); slicing-based spec generation — [arXiv 2509.09917](https://arxiv.org/pdf/2509.09917); FLAMES fine-tunes LLMs for smart-contract invariants — [arXiv 2510.21401](https://arxiv.org/pdf/2510.21401)
- Earlier named works (from prior knowledge; URLs not re-fetched this session): SpecGen — [arXiv 2401.08807](https://arxiv.org/abs/2401.08807); AutoSpec — [arXiv 2404.00762](https://arxiv.org/abs/2404.00762); nl2postcond — [arXiv 2310.01831](https://arxiv.org/abs/2310.01831). These target function/loop-level formal specs (JML/ACSL/Dafny-style) on benchmarks, not repo-level business invariants with governance.
- A survey notes an LLM approach achieving Daikon-comparable invariants without execution — [arXiv 2502.18474](https://arxiv.org/pdf/2502.18474)
- **Enforce-only research**: ContextCov (Feb 2026) turns AGENTS.md-style instruction files into executable checks (AST queries, runtime shell shims, architectural validators); 46,000+ checks across 723 repos; 88.3% constraint compliance vs 67.0% prompt-only on SWE-bench Lite; code released; no mining from code behavior, no human review — [arXiv 2603.00822](https://arxiv.org/abs/2603.00822)
- **Protocol-Driven Development** (He & Yu, May 2026): machine-enforceable protocol of structural/behavioral/operational invariants is the durable artifact; generated code accepted only with an Evidence Chain; runtime Dynamic Evidence Ledger — [arXiv 2605.12981](https://arxiv.org/html/2605.12981v1). Conceptually the "constitution" half; no mining; no published implementation found.
- **Executable Code Knowledge** (Aug 2026): code-local, executable knowledge units with contracts, evidence, staleness detection (50/50 stale cases caught); authored, not mined; no hard gate — [arXiv 2608.16295](https://arxiv.org/abs/2608.16295)
- **Rebuild Dossier** (Aug–Oct 2026): locks an app's exact I/O interface before rebuilding, enforced "through automated checks, not written instructions alone"; MIT-licensed tool — [arXiv 2608.23616](https://arxiv.org/abs/2608.23616)
- A 2026 paper lists "automatic extraction of enumerable specification surfaces for legacy codebases" as an open problem — [Emergent Mind open problem](https://api.emergentmind.com/open-problems/automatic-extraction-of-enumerable-specification-surfaces-for-legacy-codebases); SpecOps 2026 workshop lists synthesizing formal specs from undocumented source as a topic — [SpecOps 2026](https://conf.researchr.org/home/splash-issta-2026/specops-2026)

### Inferences
- The technical core (LLM+dynamic mining, adversarial falsification) is validated but noisy in research: falsification removes only ~12% of bad assertions in the ICST study, and AgenTest admits mined specs are sometimes wrong — this supports the idea's insistence on human ratification as a necessary stage, not a nice-to-have.
- Every component has prior art; the novelty claim must rest on the integrated workflow and governance semantics, not on any single technique.

### Gaps
- Did not find whether Code-Augur or the ICST 2026 tooling is released as reusable OSS.
- Did not review ICSE/FSE/PLDI 2026 proceedings exhaustively; a mine->ratify->enforce paper could exist under different terminology.

## Key Question 3: YC (W25–F26) startups, Show HN launches, GitHub repos doing this?

### Takeaway
No YC W25–F26 company found doing mine->falsify->ratify->ratchet. GitHub has several tiny 2026 projects that implement the *ratify+ratchet* half with hand-authored rules (signed registries, CI gates, "rules can only be loosened in a human-approved diff"), and a couple of "executable AGENTS.md" compilers — all with 0–30 stars. This validates the pattern while showing nobody has combined it with mining/falsification.

### Cited Findings
- Search for a 2026 YC startup inferring business-logic invariants returned nothing relevant; the only YC code-review hit was Codeball/Sturdy (W21) — [YC: Sturdy](https://ycombinator.com/companies/sturdy). Theorem (YC S25) is formal verification of AI code, not brownfield mining — [VentureBeat](https://venturebeat.com/security/theorem-wants-to-stop-ai-written-bugs-before-they-ship-and-just-raised-usd6m). Benchify (YC) is PR-time property testing — [YC launch](https://ycombinator.com/launches/Law-benchify-automatic-code-reviews-that-work)
- **ratchets-before-code** (Oct 2026): "Architectural invariants as failing builds"; five hand-written bash ratchets; CI runs them before compiling; `test-ratchets.sh` plants violations to prove each ratchet can fail; "a ratchet can be loosened only in a diff that a person reads and approves"; built by orchestrated AI agents; 0 stars; no mining — [GitHub](https://github.com/ioitiki/ratchets-before-code)
- **invariants** (Alessio2704): experimental PoC; AST-based architecture rules (Swift/TS) with should_pass/should_fail fixtures; rule registry locked by Touch ID/Secure Enclave signatures so agents can't weaken rules; CI `invariants check` described as the "ultimate floor" blocking merges; rules hand-authored; 0 stars, MIT — [GitHub](https://github.com/Alessio2704/invariants)
- **invAIriant** (mindicator): architecture-audit skill/CLI for Claude Code/Codex/Cursor; candidates must "survive adversarial evidence checks"; `ci-gate` exits 1 on S0/S1 findings; GitHub Marketplace action; 29 stars; Apache-2.0; "early"; no invariant mining from behavior — [GitHub](https://github.com/mindicator/invAIriant)
- **soma-governance**: search snippet says `soma genesis` scans codebase architecture to generate governance rules and rules that stop proving themselves expire — [PyPI](https://pypi.org/project/soma-governance/0.103.0/) (page failed to load; snippet-level only, unverified)
- **AgentRules Compiler**: compiles AGENTS.md/CLAUDE.md/Cursor rules/Copilot instructions into checks runnable locally or in GitHub Actions; sample shows only ~56% of a file becomes enforceable — [GitHub](https://github.com/R0SS94/agentrules)
- **getff**: author says "you physically can't push an AGENTS.md whose rule table disagrees with the rules on disk"; generating the executable AGENTS.md from conventions is a future milestone — [DEV](https://dev.to/artyhoo/agentsmd-is-advisory-heres-what-it-takes-to-make-it-executable-111a)
- Spec reverse-engineering skills for brownfield exist (reverse-spec, spec-gen for OpenSpec, retrofit commands) — [OpenSpec discussion #634 mirror](https://gh.r-mj.com/Fission-AI/OpenSpec/discussions/634); [skills.sh create-specs](https://www.skills.sh/jschulte/claude-plugins/create-specs); a practitioner warns AI-generated brownfield specs often miss original intent — [intent-driven.dev](https://intent-driven.dev/blog/2026/03/10/spec-driven-development-brownfield/)
- Decision Guardian/Decispher: harvests decisions from engineering messages/PRs, generates AGENTS.md/CLAUDE.md, enforces ADRs on PRs (search-snippet level) — [DEV post](https://dev.to/ali_abbas_d8086e0f96d8173/your-ai-agent-doesnt-know-why-your-codebase-looks-like-this-thats-the-whole-problem-3kjl)

### Inferences
- The "agents must not be able to weaken the rules" + "human-only amendment" + "CI floor" pattern is independently emerging in hobby/early OSS (ratchets-before-code, invariants), which is evidence of real pain but also means the ratchet/governance half alone is not defensible.
- The open gap in this OSS cluster is exactly the front half: none of them generate the rules from code behavior or falsify them.

### Gaps
- YC directory not browsed batch-by-batch (W25, X25, S25, F25, W26, X26, S26, F26); a stealthy company could exist under different language (e.g., "behavioral contracts," "business-logic guardrails").
- No Show HN post matching the full idea was found, but HN search coverage via web search is incomplete.

## Key Question 4: Legacy-modernization vendors (COBOL business-rule extraction) — ongoing mine->ratify->enforce, or one-time?

### Takeaway
Legacy vendors extract rules/behavior for comprehension or one-time migration. Mechanical Orchard is the most technically similar (behavioral spec captured from the running system, closed-loop verification of generated code), but it's a component-by-component migration verification, not an ongoing ratchet governing future development. IBM extracts business-rule documentation drafts, not executable invariants.

### Cited Findings
- Mechanical Orchard Imogen (launched Apr 2025 with Thoughtworks): first builds a precise behavioral specification from the running system via data capture, then a closed loop of code generation and verification against that spec; one component at a time with fallback; supports CICS, COBOL, DB2, JCL — [Mechanical Orchard banking](https://mechanical-orchard.com/banking); [Business Wire launch](https://www.businesswire.com/news/home/20250403982657/en/Mechanical-Orchard-Ignites-Major-Shift-in-Enterprise-IT-Transformation-with-Launch-of-End-to-End-Mainframe-Modernization-Platform-%E2%80%9CImogen%E2%80%9D-and-Announces-First-Partnership-with-Thoughtworks)
- IBM watsonx Code Assistant for Z (Understand): business-rules discovery for COBOL via chat; developers receive an AI-generated draft of a business rule (purpose, logic, key terms, variables) — [IBM Community blog, Nov 2025](https://community.ibm.com/community/user/blogs/stephanie-marino/2025/11/11/accelerate-understanding-and-documentation-on-ibm); [IBM docs](https://www.ibm.com/docs/SSNFH6_5.4.x/svc-welcome/wxca-zu.html)
- Classic academic COBOL business-rule extraction (variable identification + slicing, stakeholder validation) dates to ~2013 — [UOC record](https://recerca.uoc.edu/documentos/67421eed97996574209fc297)
- Reversa (May 2026) analyzes legacy code to produce traceable specifications for coding agents — [Reversa README](https://cdn.jsdelivr.net/npm/reversa@1.3.4/README.md)

### Inferences
- Mechanical Orchard proves the "capture behavior dynamically → verify generated code against it" mechanic works commercially for mainframes, but its unit of value is a migration, after which the behavioral spec is not presented as a ratified rule set that keeps governing future changes. A post-migration "keep the rules" ratchet is unclaimed.
- IBM's rule extraction stops at documentation (human-readable drafts); no executable/enforced output found.

### Gaps
- "Morph" (as a legacy-modernization vendor) could not be identified/verified in searches.
- Did not check other modernization vendors (e.g., Thoughtworks CodeConcise beyond partnership mention, AWS Transform, Google mainframe tools) for ongoing enforcement features.

## Key Question 5: Overall novelty verdict and precise unclaimed white space

### Takeaway
Verdict: PARTIALLY EXISTS. Every stage exists somewhere; pairs of stages exist (M+F in research and Anthropic/Antithesis tooling; M+R+E in Qodo/Bugbot with weak, LLM-judged, non-executable rules; R+E ratchets in tiny OSS with hand-written rules). No product or paper found ships the integrated loop: dynamic-trace-grounded semantic invariant mining on brownfield repos -> adversarial falsification as a pre-filter -> plain-language one-click ratification compiling to executable properties in-repo -> monotone, human-amend-only merge gate shared by all agents. Closest single competitors cover ~35–50%.

### Cited Findings
- Commercial learned-rule systems prune/auto-disable rules rather than ratchet — [Cursor blog](https://cursor.com/blog/bugbot-learning); [Qodo 3.0 post](https://www.qodo.ai/?p=22534)
- Learned rules are locked in vendor dashboards; users request export to repo — [Cursor forum](https://forum.cursor.com/t/api-or-git-based-workflow-to-promote-bugbot-learned-rules-into-repository-rules/171018)
- Falsification-filtered mining exists only in research/bug-hunting form — [Code-Augur](https://arxiv.org/html/2606.18619); [ICST 2026](https://conf.researchr.org/details/icst-2026/icst-2026-research/36/Improving-Dynamic-Specification-Inference-with-LLM-Generated-Counterexamples); [Agentic PBT](https://arxiv.org/abs/2510.09907v1)
- Executable-AGENTS.md exists but compiles prose instructions, not mined behavior — [ContextCov](https://arxiv.org/abs/2603.00822); [AgentRules](https://github.com/R0SS94/agentrules)
- Ratchet + human-only amendment exists only with hand-written rules — [ratchets-before-code](https://github.com/ioitiki/ratchets-before-code); [invariants](https://github.com/Alessio2704/invariants)
- Cross-agent rule delivery (MCP pre-generation + PR check) exists for security rules only — [Corridor guardrails](https://docs.corridor.dev/features/guardrails)

### Inferences
**Five closest competitors and what each lacks**
1. Qodo Rules System (Rule Miner / Rules Discovery Agent) [~40%; same category: Cursor Bugbot learned rules ~35%, Greptile, CodeRabbit] — Has: mining from code patterns + PR history, rule management, enforcement on every PR. Lacks: dynamic analysis; falsification; executable properties (rules are NL conventions judged by an LLM, so enforcement is probabilistic); semantic runtime invariants like "refund <= charge"; monotone ratchet (auto-disables rules); vendor-neutral in-repo artifact usable by Claude Code/Codex/Devin.
2. Antithesis skills (antithesis-research -> property catalog -> SDK assertions -> fault-injection runs) [~45%, internals partly unverified] — Has: agent-built property catalog stored in repo, properties made executable as Always/Sometimes assertions, strong falsification engine, per-property user confirmation. Lacks: documented mining method from brownfield behavior/traces; plain-language ratification UX; CI merge-gate ratchet; vendor neutrality (requires Antithesis platform); business-logic focus (system/distributed-systems focus).
3. Anthropic/MATS Agentic PBT (arXiv 2510.09907; agentic-pbt/hypo-plugin) [~35–40%] — Has: LLM infers semantic properties of existing code from code+docs, writes and runs Hypothesis PBTs, triages failures into bug reports. Lacks: persistence of surviving properties; human ratification; ongoing enforcement/ratchet; dynamic-trace mining; multi-language.
4. Code-Augur (Roychoudhury group, Jun 2026) [~40%] — Has: agent-mined invariants as in-source assertions, fuzzer-based falsification, LLM triage + refinement loop, real bugs found. Lacks: business/semantic invariants (security-only); human ratification; merge-gate ratchet; productization.
5. Imandra CodeLogician [~35%] (alternate #5: Amazon Kiro PBT ~30%) — Has: autoformalizes existing code into executable formal model, verification goals over all inputs, counterexamples, business-logic examples (trading). Lacks: automated mining of candidate invariants at repo scale (goals authored/from comments); ratchet governance across agents; open, vendor-neutral format. Kiro lacks brownfield mining entirely (properties from human-written EARS requirements) and has no repo-wide ratchet.
Honorable mentions: Diffblue (behavior-capturing regression tests = example-level ratchet, no rules/ratification); Mechanical Orchard (dynamic behavioral spec + verification, one-time migration); ContextCov/AgentRules (executable AGENTS.md from prose); Benchify (per-PR blueprint + PBT); Protocol-Driven Development (conceptual "invariants as durable artifact"); ratchets-before-code / invariants (hand-written ratchets with human-only loosening).

**Precise unclaimed white space**
- (a) Falsification-as-filter feeding human ratification: nobody uses adversarial PBT/fuzzing/counterexample search to *pre-filter mined candidate invariants* before showing humans plain-language statements with one-click accept/reject/edit that compile 1:1 to executable properties.
- (b) Executable, deterministic, repo-specific *semantic/business* invariants (not style conventions, not generic SAST rules) mined from brownfield code using *dynamic evidence* (test runs, recorded traces) plus LLMs — Daikon+LLM exists only in research (ICST 2026, ClassInvGen) or one-time migration (Mechanical Orchard).
- (c) Monotone ratchet semantics: set only grows; any weakening requires an explicit human-signed amendment. Incumbents do the opposite (auto-prune); only hand-written hobby OSS implements this.
- (d) Vendor-neutral, machine-checkable invariant file as a cross-agent "constitution" checked both pre-generation (as agent context/MCP) and at merge (CI) for Claude Code, Codex, Cursor, Copilot, Devin and humans alike. AGENTS.md is prose; ContextCov compiles prose; Bugbot/Qodo rules are vendor-locked; Corridor does this only for security.
- (e) Ongoing post-modernization governance: keeping legacy business rules enforced after a COBOL/mainframe migration — current vendors extract once or document.

**Risk notes**
- High fast-follow risk from Qodo and Cursor (already own learned rules + PR gate at scale: Bugbot 110k repos), Antithesis (already has property catalog + falsification + Claude Code skills; adding CI gating is small), and Anthropic/Hypothesis maintainers (authored agentic PBT; DeVoe published a Hypothesis Corpus of 28,928 tests in Apr 2026 per search snippet — unverified).
- Defensibility likely rests on: the ratification UX and quality bar (precision of surviving invariants), dynamic-trace ingestion, open file format/standard adoption, and the ratchet governance model — not on any single mining or falsification technique.

### Gaps
- Percent-coverage scores are analyst judgment.
- Could not verify whether any closed-beta enterprise product (e.g., inside Qodo 3.0, Factory, Augment, Sourcegraph) already compiles learned rules into executable property tests.
- Antithesis research-skill method and any CI integration unverified (GitHub repo did not load).
