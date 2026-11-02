# Competitor check: "Evidence-carrying changes" (behavioral diff + preservation evidence + anti-gaming + graded signed assurance levels for agent-written PRs), as of Oct 31, 2026

Research method: adversarial search, aiming to show the idea is NOT new. About 50 searches and fetches across vendor docs, GitHub, HN, arXiv, the in-toto/SLSA specs, and trade press. Vendor claims are marked as such. Where a page could not be fetched or verified, that is noted under Gaps.

## Q1. Does any product or OSS project produce behavioral diffs (executed old vs new, not syntax-aware text diffs) for PRs?

### Takeaway
Yes, in several partial forms. Each vertical has at least one shipping product that runs old and new side by side and reports behavioral differences on PRs:
- **Frontend:** Meticulous
- **APIs and microservices:** Speedscale, Signadot SmartTests, Tusk Drift, Diffy, Keploy, GoReplay
- **Data and SQL:** Datafold, Recce
- **Optimization PRs:** Codeflash

Tusk Drift Cloud and the Testora research tool go further. They classify each behavioral difference as intended or unintended against the PR's stated intent (title and body). That is roughly items 1 and 2 of the idea. Nobody found in this search summarizes behavior change as input-space partitions (for example "differs only when currency=JPY and amount<1"). Every tool reports differences per request, per screenshot, per test, or per row.

### Cited Findings

**Recorded-traffic or recorded-session replay (old vs new)**
- **Meticulous (frontend).**
  - Records user sessions and replays them on both a "base test run" (main branch, the baseline) and a "head test run" (the PR's latest commit). It finds visual differences by pixel-by-pixel screenshot comparison between base and head, and each diff stays "unapproved" until a reviewer approves it. — [Meticulous glossary](https://app.meticulous.ai/docs/concepts/glossary)
  - Results post as a PR comment. The check can be made a required status check that blocks merge until diffs are approved. It replays a curated subset of 200–500 sessions selected by code coverage and flow diversity. — [21st.dev comparison (third party)](https://21st.dev/blog/meticulous-vs-design-bug-bot)
  - Lacks: no intent claim, no generated inputs (recorded only), no input-class summary, no mutation or adversarial checks, no proofs, no attestations, UI only.
- **Speedscale (API traffic replay, positioned as "AI code verification").**
  - Vendor claims: replays captured production traffic (API calls, DB queries, third-party interactions) "against every code change". It shows "expected vs. actual responses for every replayed request". CI can "attach validation reports to pull requests" and gate merges on a passing replay check.
  - Through proxymock MCP it gives "Claude Code, Cursor, Copilot, and other AI coding tools direct access to traffic snapshots and replay results".
  - The page has no intent-check feature. It says replay "doesn't prove correctness for every possible input". — [Speedscale AI code verification page](https://speedscale.com/features/ai-code-verification/)
  - A search-engine summary of Speedscale's site described "validation receipts" posted to GitHub, GitLab, or Bitbucket PRs. The fetched feature page did not use the term "receipts" and does not mention signing. — [speedscale.com](https://speedscale.com/)
- **Signadot SmartTests (Kubernetes microservices).**
  - Runs the same tests against a baseline and a PR sandbox and uses "AI-powered semantic analysis" to flag unexpected changes, ignoring noise such as timestamps. — [Signadot SmartTests docs](https://www.signadot.com/docs/tutorials/quickstart/smart-tests)
  - Captures requests and responses between microservices and compares baseline to sandbox with noise filtering. — [Signadot concepts](https://signadot.com/docs/concepts/smart-tests-and-jobs)
  - Also compares CPU, memory, and I/O. — [Signadot AI SmartTests](https://new.signadot.com/ai-smart-tests)
  - Its MCP server lets Cursor, Claude Code, and VS Code agents provision sandboxes and verify their own changes. — [Signadot vs Pact page](https://signadot.com/comparison/pact)
  - Signadot argues explicitly: "a reviewer bot reads the diff; a sandbox runs it." — [Signadot blog](https://www.signadot.com/blog/ai-generated-code-crisis/)
  - Lacks: tests are hand-written in Starlark (not generated or property-based), no structured intent claim, no input-class summary, no mutation or adversarial checks, no attestations or levels.
- **Tusk Drift (YC; record/replay API tests).**
  - Records live traffic, including outbound DB, HTTP, and auth calls, and replays it as deterministic tests locally or in CI. CLI and SDK are open source (Apache-2.0, about 143 stars). — [Tusk CLI repo](https://github.com/Use-Tusk/tusk-drift-cli)
  - Per the Show HN author: the Cloud platform "classifies deviations by correlating them with the PR/MR's code changes, including its title and body". Unintended deviations get root-cause analysis and fix suggestions. At launch it supported Node.js only, with Python planned. — [Show HN: Tusk Drift](https://news.ycombinator.com/item?id=45887536)
  - This is the closest commercial match to "check behavior change against intent". Lacks: no generated or property-based inputs (recorded traffic only), no input-class summarization, no mutation or adversarial checks, no proofs, no signed attestations, no levels.
- **Diffy (originally Twitter, now opendiffy).**
  - Runs "your new code and your old code side by side". Requests go to a candidate, a primary, and a secondary instance; non-determinism between primary and secondary is used to cancel noise in the candidate-vs-primary diffs. — [opendiffy/diffy](https://github.com/opendiffy/diffy); [twitter/diffy](https://github.com/twitter/diffy)
  - This is the canonical prior art for the "behavioral diff on real traffic" piece. It has no PR intent, attestation, or levels.

**Data and SQL analog (the most "evidence-checklist-like" PR UX)**
- **Datafold.** In CI it "automatically detects and highlights value-level differences between production data and staging data", writes results as a PR comment, and identifies affected downstream assets. — [Datafold docs](https://docs.datafold.com/deployment_testing)
- **Recce.** A "data validation toolkit for PR review" for dbt. Reviewers run diffs (value, top-K, histogram, row count), add them to a "Checklist" of validation evidence, and share it with the PR reviewer. Recce Cloud can block merge until all checks are approved. — [Recce on PyPI](https://pypi.org/project/recce/0.38.0)
- Both are direct analogs of an evidence bundle with a behavioral diff, but only for data pipelines.

**Generated-input differential testing (old vs new)**
- **Testora (Michael Pradel; ICSE 2026; open source).**
  - Uses the PR title, description, and commit messages as a natural-language oracle. An LLM generates tests that exercise the modified code; the tests run on the original and modified versions; each behavioral difference is classified as intended or unintended.
  - Found 19 regression bugs and 11 PRs that coincidentally fixed bugs in popular Python projects. — [arXiv 2503.18597](https://arxiv.org/pdf/2503.18597v1); [Testora GitHub](https://github.com/michaelpradel/Testora); [ICSE 2026 listing](https://conf.researchr.org/details/icse-2026/icse-2026-research-track/10/Testora-Using-Natural-Language-Intent-to-Detect-Behavioral-Regressions)
  - A third-party review reports classifier precision of about 58%, recall of about 60%, and about 12.3 minutes per PR. Not verified against the paper. — [Moonlight review](https://www.themoonlight.io/review/regression-testing-with-a-natural-language-oracle)
- **DiffTestGen (Hu, Cadar, Pradel; arXiv, July 17, 2026).**
  - LLM-based differential test generation directed at the changed code, with a "union coverage" metric over old and new. Exposed behavioral differences in 78.2% of 463 PRs and pairs with Testora for regression detection.
  - The abstract does not report input-class summaries and does not target AI-authored changes specifically. — [arXiv 2607.16024](https://arxiv.org/abs/2607.16024)
- **PatchDiff.** Generates tests to expose behavioral differences between agent-generated patches and the gold patches on SWE-bench. Behavioral discrepancies appeared in about 29.6% of "plausible" patches. — [arXiv 2503.15223](https://arxiv.org/html/2503.15223v2)
- **Mokav.** Execution-driven LLM differential testing that finds inputs where two program versions behave differently. Published in JSS 2025. — [Moonlight review of Mokav](https://themoonlight.io/review/mokav-execution-driven-differential-testing-with-llms)

**Equivalence and preservation checking**
- **Codeflash (performance-optimization PRs).**
  - Requires that "the optimized code must behave exactly like the original". It verifies this with existing unit tests plus LLM-generated regression tests, instrumented to compare behavior. — [Codeflash engineering post on HackerNoon](https://hackernoon.com/90percent-failure-rate-why-gpt-4o-cant-optimize-code-and-what-we-built-instead)
  - Its PRs carry a "correctness verification report" with lines for existing unit tests, generated regression tests, replay tests, and concolic coverage tests. — [codeflash PR #1950](https://github.com/codeflash-ai/codeflash/pull/1950)
  - Its docs still recommend manual review because "there might be important input cases that we haven't verified". — [codeflash PR #257](https://github.com/codeflash-ai/codeflash/pull/257/files)
  - This is the closest shipped example of a PR that carries preservation evidence (item 3), but only for optimizations, where intent is "no behavior change".
- **Theorem (YC Spring 2025; $6M seed).**
  - Formal verification for AI-generated code. A reported workflow: an engineer writes a reference implementation, and the platform produces an optimized version plus a proof that the two behave identically. — [VentureBeat](https://venturebeat.com/security/theorem-wants-to-stop-ai-written-bugs-before-they-ship-and-just-raised-usd6m); [HUGE Magazine profile (single outlet)](https://huge-magazine.pages.dev/feature/theorem-2)
- **Diffblue Cover.** Generates unit regression tests that "reflect the current functionality of the program", acting as a net to "detect unintended changes" in Java. — [Diffblue docs, finding regressions](https://docs.diffblue.com/features/tutorials/regressions); [Diffblue explainer](https://www.diffblue.com/resources/how-unit-regression-tests-are-created/)
  - No PR-level behavioral-diff report was found.
- **Imandra CodeLogician.** A neurosymbolic agent on ImandraX that formalizes code and performs "region decomposition", partitioning the state space into finitely many regions where behavior is invariant. It is marketed for code review through verification. — [arXiv 2601.11840](https://arxiv.org/pdf/2601.11840v2); [Emergent Mind summary](https://www.emergentmind.com/papers/2601.11840)
  - This is the closest technology to "input-class" behavioral descriptions. However, no evidence was found that it diffs the regions of two versions for a PR.

**Academic prior art for input-partitioned behavioral diffs (decades old)**
- **Shadow symbolic execution (Cadar et al., ICSE 2016; TOSEM 2018).** Runs old and new in one symbolic execution and generates inputs at the points where the versions diverge. — [Imperial SRG Shadow project](https://srg.doc.ic.ac.uk/projects/shadow/index.html); [TOSEM paper PDF](https://core.ac.uk/download/157801155.pdf)
- **Abstract semantic differencing.** Finds the inputs where two versions produce different outputs; a pure refactoring yields an empty semantic diff. — [Technion semantic-diff note](https://csaws.cs.technion.ac.il/~yahave/blog/semantic-diff.html)
- **Conditional equivalence (Microsoft Research).** Checks whether two versions are equivalent under a subset of inputs. — [MSR conditional equivalence](https://www.microsoft.com/en-us/research/wp-json/wp/v2/msr-research-item/160116)

**AI code reviewers (read the diff; do not execute old vs new)**
- **CodeRabbit "Semantic Diff".** Groups related code movement and token-level changes. It is about readability and does not compare execution results. — [CodeRabbit blog](https://www.coderabbit.ai/blog/introducing-semantic-diff)
- **Devin Review (Cognition, Jan 2026).** "Semantic diff organization" groups changes by logical connection and detects moved or copied code. Not executed. — [TestingCatalog](https://www.testingcatalog.com/devin-launches-ai-powered-code-review-tool-for-github-projects)
- **GitHub Copilot code review.** Tool calling for project context, plus CodeQL and ESLint deterministic checks (Oct 2025 preview). No source found showing it executes tests or diffs behavior. — [GitHub changelog](https://github.blog/changelog/2025-10-28-new-public-preview-features-in-copilot-code-review-ai-reviews-that-see-the-full-picture/)
- **Qodo 2.0.** Multi-agent review, test-coverage-gap analysis, and cross-repo impact (beta). Raised $70M Series B on Mar 30, 2026, explicitly as "code verification". No differential execution found. — [SiliconANGLE](https://siliconangle.com/2026/03/30/ai-generated-code-verification-startup-qodo-raises-70m/); [Qodo docs](https://docs.qodo.ai/code-review)
- **Anthropic Code Review in Claude Code (Mar 9, 2026).** Targets logic errors and regressions through review. — [TechDogs](https://www.techdogs.com/tech-news/td-newsdesk/anthropic-launches-code-review-tool-to-check-flood-of-ai-generated-code)
- **IntentDiff (OSS, 0 stars).** Sends diff hunks to Claude to flag unintended behavior changes. LLM-reads the text and does not execute. — [UA9-TA/intentdiff](https://github.com/UA9-TA/intentdiff)
- **Sonar's agent-centric "CI verification loop".** SonarQube quality gate plus Gitar AI review on PRs. No differential behavior. — [Sonar docs](https://docs.sonarsource.com/agent-centric-development-cycle/in-your-pull-requests-the-ci-verification-loop/ci-verification-loop.md)

**Intent-to-properties**
- **Kiro (AWS).**
  - Extracts properties from EARS-style spec requirements and generates property-based tests (Python Hypothesis) mapped back to requirements. Shipped at GA. — [Kiro PBT blog](https://kiro.dev/blog/property-based-testing/); [Kiro GA post](https://kiro.dev/blog/general-availability/)
  - Kiro motivates PBT partly by models "editing tests instead of fixing code", which is an anti-gaming rationale. — [Kiro GA post](https://kiro.dev/blog/general-availability/)
  - Not old-vs-new differential, and no PR evidence bundle was found.

### Inferences
- The behavioral-diff primitive is commoditized in the replay family, which is crowded: Meticulous, Speedscale, Signadot, Tusk, Diffy, Keploy, GoReplay, Datafold, Recce. Speedscale and Signadot already market themselves as "AI code verification" with MCP hooks for coding agents.
- Generated-input differential testing with intent classification exists as open research code (Testora, DiffTestGen) from the same group (Pradel and Cadar). A startup could productize it quickly, and so could Tusk, Qodo, or Diffblue.
- "Output changes only when currency=JPY and amount<1" (summarizing the behavior delta as input-space partitions) is not shipped by anyone found. It exists as academic technique: shadow symbolic execution, semantic differencing, and Imandra's region decomposition (single-version). This is the most defensible technical white space, but also the hardest to make work on real codebases.

### Gaps
- **Keploy:** the search returned nothing for Keploy's 2026 PR/AI-code positioning. Treat it as another record-replay player; current PR-diff features unverified.
- **GoReplay:** not checked.
- **Not checked with first-party sources:** Greptile, Graphite (acquired by Cursor per prior knowledge; unverified here), Cursor Bugbot, Factory, Augment, Corridor, TestSprite, Momentic, SemanticDiff, Difftastic. Background knowledge, not verified this session: all are LLM diff reviewers, AI E2E test generators, or syntax-aware structural diff tools, and none executes old vs new on generated inputs. The report writer should treat this as unverified.
- **Imandra CodeLogician:** whether it offers a two-version region-diff mode is unconfirmed.
- **Meticulous:** whether it groups diffs by behavior class is unverified.

## Q2. Does any standard exist for attaching verification or correctness evidence (not supply-chain provenance) as attestations to PRs or commits?

### Takeaway
There are generic building blocks, but no correctness standard:
- in-toto has a generic Test Result predicate (pass/warn/fail lists) and SCAI ("evidence-based assertions about … attributes or behavior").
- GitHub's `actions/attest` accepts any custom predicate.
- SLSA's Source track covers source history and review, not behavioral correctness.
- Agent Trace (Cursor-led RFC) and Entire Checkpoints standardize AI attribution and context, not correctness.

No standard defines a behavioral-change predicate (intent claim, behavior delta, preservation evidence, test adequacy, verifier independence) or graded correctness-assurance levels. Several 2026 one-person proposals and repos are converging on this space.

### Cited Findings

**Existing in-toto, SLSA, and GitHub primitives**
- **in-toto Test Result predicate** (`https://in-toto.io/attestation/test-result/v0.1`). A "generic schema to express results of any type of tests". It records result, configuration, URL, and passed/warned/failed test lists. Its subjects are the tested source artifacts. — [in-toto test-result spec](https://github.com/in-toto/attestation/blob/main/spec/predicates/test-result.md)
- **in-toto SCAI.** "Evidence-based assertions about software artifact and supply chain attributes or behavior" (v0.2 predicate; demos bumped to v0.3 in Jan 2025). The scai-demos tools do not sign, so signing must be done separately. — [in-toto predicates](https://github.com/in-toto/attestation/blob/v1.0.2/spec/predicates); [scai-demos](https://redirect.github.com/in-toto/scai-demos)
- **GitHub `actions/attest`.** Default is SLSA build provenance, but it accepts a custom `predicate-type` plus `predicate` or `predicate-path`. — [actions/attest](https://github.com/actions/attest)
- **Liatrio autogov.** Defines its own source-review and test-result predicate types, noting "no in-toto standard exists for SARIF/code-scanning results". — [liatrio/autogov predicate pkg](https://pkg.go.dev/github.com/liatrio/autogov/pkg/predicate)
- **SLSA.**
  - The end-to-end guidance suggests source provenance for commits (author, committer, hash) and a Source VSA, with tools like slsa-source-poc and gittuf. — [SLSA e2e blog, Jul 2025](https://slsa.dev/blog/2025/07/slsa-e2e)
  - The Source track gives "increasing levels of trust in the source code". — [SLSA draft levels](https://slsa.dev/spec/draft/levels)
  - A secondary source says v1.2 (Nov 2025) approved the Source track. Another source (Jul 2026) says Source and Dependency tracks are still drafts. — [rywalker SLSA research](https://rywalker.com/research/slsa)
  - The two sources conflict on status. No "test" or "correctness" track was found.
- **Attested Delivery "Production Readiness Attestation Gates"** (DRAFT, dated 2026-06-15).
  - Each gate (build, scan, review, load test, tests) emits a signed in-toto/DSSE attestation; promotion checks a single VSA.
  - It uses a custom code-review predicate and maps tests to the Test Result predicate. It explicitly does not discuss deeper correctness evidence or AI agents on that page. Its nav lists "AI Authorship Provenance" and an ADR on AI provenance Git trailers.
  - Notes: "A custom predicate proves only that a gate ran" and "No standard performance predicate exists". — [attested-delivery.github.io](https://attested-delivery.github.io/docs/specifications/production-readiness-attestation-gates/)

**AI attribution and context standards (adjacent, not correctness)**
- **Agent Trace.** Open specification proposed by Cursor to standardize AI code attribution. Vendor-neutral JSON "trace records" with commit SHAs and file-level contributor types (human, AI, mixed, unknown). RFC v0.1.0 as of Jan 2026, CC BY 4.0. — [Thoughtworks Radar](https://www.thoughtworks.com/radar/platforms/agent-trace)
  - Backers: Cognition, Cloudflare, Vercel, Google Jules, Amp, and OpenCode, per Morph. Sources disagree on who has built-in support. — [Morph explainer](https://www.morphllm.com/agent-trace-spec)
- **Entire (Thomas Dohmke; $60M seed).** Open-source (MIT) CLI that captures agent sessions (prompts, transcripts, tool calls) as "Checkpoints" linked to commits on a separate git branch. Supports Claude Code, Codex, Cursor, Copilot CLI, Gemini CLI, and OpenCode. — [Entire docs](https://docs.entire.io/cli/overview); [36Kr/InfoQ, Feb 2026](https://eu.36kr.com/en/p/3678623948366473)
  - Context and provenance only, with no correctness claims.

**Small 2026 OSS "receipt" and "proof-carrying" projects**
- **workproof** (MIT, 0 stars). A "deterministic evidence layer for AI-assisted pull requests". The signed receipt is an in-toto Statement in a DSSE envelope (Ed25519; Sigstore planned) and contains:
  - commands run against the HEAD SHA, with hashed outputs
  - a hash-chained session log
  - the declared AI level (none, assisted, agent)
  - test-weakening signals: removed assertions and new skip/xfail markers

  No behavioral diffs; the GitHub Action only re-runs tests and compares exit codes. — [workproof repo](https://github.com/rossbuckley1990-hash/workproof)
- **"Proof-Carrying Patch" (Akshat Raj, DEV, Oct 27).** Every AI change ships a JSON verification report (passed, failed, unverified). It recommends mutation testing; signed attestations are "future"; it has no levels, no differential testing, and is a "teaching prototype". — [DEV article](https://dev.to/akshatraj00/the-proof-carrying-patch-building-a-verification-gate-for-ai-generated-code-2agm)
- **proof-carrying-ai.** Coq proofs plus zero-knowledge proofs that agent actions obey a formal policy. About agent actions, not code changes. — [ss1738/proof-carrying-ai](https://github.com/ss1738/proof-carrying-ai)
- **proofcheck-ai.** GitHub Action checking that the PR description, diff, and linked issue match. — [PyPI proofcheck-ai](https://pypi.org/project/proofcheck-ai/)

### Inferences
- The attestation plumbing (in-toto, DSSE, Sigstore, GitHub attestations, VSA) is mature and accepts custom predicates. So the "signed, vendor-neutral" part of the idea is a schema-design and adoption problem, not a technical one. It is also easy for GitHub or OpenSSF to do themselves.
- No standard defines correctness-assurance levels for changes (the "SLSA for behavior" framing). The closest are SLSA Source levels (review and history) and ad-hoc tiers in individual proposals.
- Agent Trace shows that a Cursor-led, multi-vendor spec for agent-code metadata can win backing within weeks. A correctness-evidence spec could plausibly be launched the same way, possibly as an Agent Trace extension, by an incumbent.

### Gaps
- The Witness/Archivista attestor catalog (testifysec) was not checked for a test, mutation, or behavior attestor.
- OpenSSF working-group proposals on AI-generated-code attestations were not found. Absence is unconfirmed.
- The authoritative SLSA v1.2 Source track status is unresolved (conflicting secondary sources).

## Q3. Are there startups, Show HN launches, GitHub repos, or arXiv papers (2024–2026) proposing this whole idea?

### Takeaway
Yes, the whole concept is already articulated publicly, under the same name. "Evidence-Carrying Changes: From AI Code Production to Verifiable Software Delivery" (rmax.ai, July 13, 2026) proposes nearly the same architecture:
- intent claim
- property-based, differential, regression, and mutation testing, plus optional formal methods
- an adversarial verifier
- residual-uncertainty fields
- risk tiers
- SLSA, in-toto, and Sigstore attestations

It comes with an experimental MIT harness (0 stars). Two further 2026 proposals cover adjacent pieces (Assurance Envelopes on arXiv; AICompetence's layered model). Well-funded startups own the formal-proof slice: Axiom ($200M), Harmonic, and Theorem (YC S25). Nobody has a funded product or adopted standard for the full bundle.

### Cited Findings

**Proposals for the whole idea**
- **rmax.ai, "Evidence-Carrying Changes" (2026-07-13, personal lab note, "not a standard").** The change package includes:
  - intent claim and spec version
  - functional evidence: unit, integration, E2E, property-based, differential, regression, and mutation testing, plus formal specs or model checking "where justified"
  - security, architectural, operational, and provenance evidence
  - scoped human approvals
  - structured "residual uncertainty"
  - a policy decision
  - an adversarial verifier that searches for untested requirements and weak assertions (advisory)
  - three risk tiers ("proposed model… not validated")
  - signed attestations (SLSA, in-toto, Sigstore) for higher tiers

  It has no formal schema and no results: the four-condition experiment is designed but not run, and the author explicitly says the hypothesis "still needs controlled evaluation". — [rmax.ai note](https://rmax.ai/notes/evidence-carrying-changes/)
- **rmax-ai/evidence-first-harness (MIT, 0 stars, 25 commits).** Implements:
  - "Evidence Bundles" (claim, evidence, decision)
  - Tiers 3, 2, and 1
  - a deterministic policy decision engine
  - AST impact analysis
  - mutation testing
  - adversarial review (stubs only)
  - a hash-chained provenance stream
  - GitHub Check Runs

  No behavioral diff, differential testing, or attestations are mentioned. — [GitHub repo](https://github.com/rmax-ai/evidence-first-harness)
- **"Assurance Envelopes for Autonomous Coding Agents: Minimum-Cost Evidence for Software Change" (Anjan Goswami, arXiv, Sep 14, 2026).** Selects the least-cost subset of existing evidence (tests, proofs, traces) that re-establishes a change's obligations, via a typed inference graph checked by forward chaining. No behavioral diff, mutation testing, levels, or attestations. — [arXiv 2609.16302](https://arxiv.org/abs/2609.16302)
- **AICompetence "Coding Agent Verification: A Layered Assurance Model" (Sep 17, 2026).** Five layers: self-check, deterministic, specialist, independent verifier agent, human/policy acceptance. Impact tiers and a reproducible evidence record. No differential or mutation testing, no proofs, no signing; "an editorial synthesis, not an industry standard". — [aicompetence.org](https://aicompetence.org/coding-agent-verification/)
- **TAIP (arXiv, 2026).** A 0–5 maturity framework for continuous AI assurance of agentic systems, including "continuous evidence pipelines". Organization-level, not per-change. — [arXiv 2603.03340](https://arxiv.org/pdf/2603.03340)
- **DEV article.** Proposes a per-PR "agent behavior evidence" section built by comparing baseline vs candidate runs. It is about agent-config changes, not code behavior. — [DEV Community](https://dev.to/raju_dandigam/why-code-diffs-are-not-enough-for-ai-agent-changes-3fhn)
- **arXiv 2601.04886.** Found AI-agent PR descriptions sometimes misstate the changes. This motivates machine-checked intent claims. — [arXiv 2601.04886](https://arxiv.org/pdf/2601.04886)

**Formal-verification startups (item 5 of the idea)**
- **Axiom Math.** $200M Series A at $1.6B (Mar 2026). AxiomProver uses Lean "to check whether code does what it should"; it also released AXLE, Lean proof infrastructure. — [SiliconANGLE, Mar 12, 2026](https://siliconangle.com/2026/03/12/verifiable-ai-startup-axiom-raises-200m-prove-ai-generated-code-safe/)
- **Harmonic (Aristotle).** Lean-based formal reasoning agent, marketed for verifying software and hardware. A company-reported 96.8% on the VERINA code-verification benchmark (Dec 2025). — [tooldirectory.ai (third party)](https://tooldirectory.ai/tools/harmonic); [Harmonic job post](https://www.indexventures.com/startup-jobs/harmonic/formal-verification-engineer/)
- **Theorem (YC S25).** Proofs of equivalence between reference and optimized implementations. — [VentureBeat](https://venturebeat.com/security/theorem-wants-to-stop-ai-written-bugs-before-they-ship-and-just-raised-usd6m)
- **Ada/SPARK paper.** AI agents writing formally verified security software: GNATprove discharged 49,280 proof obligations, and the authors claim assurance costs fell about 20–40×. — [arXiv 2607.14340](https://arxiv.org/pdf/2607.14340)

**Independent verifier and anti-gaming**
- **Imbue Vet (Mar 2026, AGPL-3.0).** Open-source tool that reviews agent conversations for goal adherence and diffs for correctness using user-configured LLMs. It runs as an agent skill or in CI. LLM review, not execution. — [Product Hunt](https://www.producthunt.com/posts/vet-2); [ecosyste.ms](https://awesome.ecosyste.ms/projects/github.com%2Fimbue-ai%2Fvet)
- **Meta ACH.** Mutation-guided LLM test generation in production. 9,095 mutants and 571 privacy-hardening tests; engineers accepted 73% of the tests; an LLM equivalent-mutant detector was used. — [arXiv 2501.12862](https://arxiv.org/abs/2501.12862)
- **Antithesis.** Docs describe tools letting AI agents drive its deterministic-simulation workflow. Sacra analysis (not a feature) suggests it could become a release gate for AI-written code. — [Antithesis docs for AI](https://antithesis.com/docs/docs_for_ai/); [Sacra](https://sacra.com/chat/h/0db482e4-7335-4710-818e-a23c858b95c9/)

### Inferences
- The name "Evidence-carrying changes" is already in use for essentially the same concept (rmax.ai, July 2026). Both the name and the conceptual framing should be considered taken. Novelty must come from execution: an adopted spec, the behavioral-diff engine, and distribution.
- Thought leadership is converging fast. At least four independent 2026 write-ups (rmax, AICompetence, Proof-Carrying Patch, Assurance Envelopes) plus workproof and attested-delivery are building this. Expect more entrants; the "first to define the standard" window is open but narrowing.
- The formal-proof tier (L4) will likely be supplied by Axiom, Harmonic, or Theorem rather than built in-house. A standard should define how to reference their proof artifacts.

### Gaps
- A YC directory sweep (W25–F26) was not completed via the directory itself. Generic searches surfaced only Theorem (S25), Tusk, and Signadot (YC), plus Cajal (binary-vs-formal-spec checking). Other YC companies in this niche may exist.
- Product Hunt and HN were not exhaustively searched for "behavioral diff" launches. A direct Show HN for this full concept was not found.
- Google's practice of surfacing surviving mutants in code review (Petrović et al., "Practical Mutation Testing at Scale") is relevant prior art but could not be fetched this session (arXiv blocked on that call).

## Q4. Does any AI coding agent vendor already ship a "prove this change" mode that runs old vs new differentially?

### Takeaway
No major agent vendor (Anthropic, OpenAI, Cursor, GitHub, Cognition, AWS Kiro, Factory, Google) was found shipping old-vs-new differential execution as a built-in mode. Vendors ship "evidence of testing" instead:
- Cursor cloud agents attach videos, screenshots, and logs to PRs.
- Codex is trained to cite terminal logs and test outputs.
- Kiro generates property-based tests from specs.

Differential runs are available to agents only through third-party MCP integrations: Signadot, Speedscale proxymock, Tusk. Codeflash is the one vendor whose agent ships every PR with a correctness-verification report against the old version, scoped to optimizations.

### Cited Findings
- **Cursor cloud agents (Feb 24, 2026).** Produce "merge-ready PRs with videos, screenshots, and logs" from isolated VMs; agents click through the UI to self-test. — [Cursor changelog](https://cursor.com/changelog/02-24-26)
  - About 35% of Cursor's internal merged PRs are created by these agents. — [devops.com](https://devops.com/cursor-cloud-agents-get-their-own-computers-and-35-of-internal-prs-to-prove-it)
  - Arize notes video evidence covers only an exercised path; Cursor's gating policy (CI, security review, demo artifact, risk score) is proprietary. — [Arize](https://arize.com/?p=30179)
- **OpenAI Codex.** The system card addendum says the model is trained to provide citations of terminal logs and test outputs so users can verify its work. — [OpenAI Codex system card addendum](https://openai.com/index/o3-o4-mini-codex-system-card-addendum)
  - An open feature request (#36718) asks Codex to map each requirement to validation commands, results, skipped checks, and remaining uncertainty, and not to label work "verified" without evidence. This suggests the request is not yet met. — [openai/codex issue #36718](https://github.com/openai/codex/issues/36718)
- **Kiro (AWS).** Property-based tests derived from spec requirements, at GA. Not differential against the prior version. — [Kiro PBT blog](https://kiro.dev/blog/property-based-testing/)
- **Signadot, Speedscale, Tusk.** Expose baseline-vs-change runs to agents via MCP or CLI. — [Signadot vs Pact page](https://signadot.com/comparison/pact); [Speedscale](https://speedscale.com/features/ai-code-verification/); [Tusk CLI](https://github.com/Use-Tusk/tusk-drift-cli)
- **Codeflash.** Its optimization PRs include a correctness verification report built from existing, generated regression, replay, and concolic tests run against the original. — [codeflash PR #1950](https://github.com/codeflash-ai/codeflash/pull/1950); [HackerNoon](https://hackernoon.com/90percent-failure-rate-why-gpt-4o-cant-optimize-code-and-what-we-built-instead)
- **Third-party wrappers.**
  - **Codexus:** runs a verification command and treats a Codex run as complete only when it passes. — [Codexus](https://github.com/raeseoklee/codexus)
  - **Imbue Vet:** an agent skill run after changes. — [Product Hunt](https://www.producthunt.com/posts/vet-2)

### Inferences
- The obvious threat is Cursor. It owns cloud-agent VMs, Bugbot review, and (per prior knowledge, unverified here) Graphite, and it led Agent Trace. Adding "run base vs head on generated inputs and attach the diff" is a natural next step for it.
- GitHub is the other threat: Copilot coding agent, `actions/attest`, and branch-protection enforcement.
- Neither appears to have shipped it as of Oct 31, 2026, based on the sources found.

### Gaps
- Not verified with first-party 2026 changelogs: Factory Droids, Augment, Google Jules/Antigravity, Devin (beyond Devin Review), and the current Claude Code features for differential verification. Absence is likely but unconfirmed.

## Overall: novelty verdict, closest competitors, unclaimed white space

### Takeaway
**Verdict: partially exists. Conceptually, it is close to substantially existing.**
- **The concept is taken.** The concept and even the exact name are already public (rmax.ai, July 2026, with a toy MIT harness).
- **Every component ships somewhere, but separately:**
  - behavioral diff via replay: Meticulous, Speedscale, Signadot, Tusk, Diffy, Datafold, Recce
  - intent-vs-behavior classification: Tusk Cloud, Testora
  - preservation evidence: Codeflash, Theorem
  - property-based tests from intent: Kiro
  - mutation-guided adequacy: Meta ACH
  - independent LLM verifiers: Vet, Qodo, Anthropic Code Review
  - formal proofs: Axiom, Harmonic, Theorem
  - signed receipts: workproof, attested-delivery, in-toto Test Result and SCAI
- **The integration is not found anywhere.** No product or adopted standard combines these into a vendor-neutral, signed, leveled evidence bundle that any agent emits and any forge enforces.
- **The input-class behavioral-diff summary is not shipped by anyone found.**

### Cited Findings
- **The five closest competitors, and what each lacks relative to the full idea:**
  1. **rmax.ai "Evidence-Carrying Changes" + evidence-first-harness.** Same name and nearly the same architecture: intent, differential, property-based, and mutation testing, adversarial verifier, tiers, SLSA/in-toto/Sigstore. — [rmax.ai](https://rmax.ai/notes/evidence-carrying-changes/); [harness](https://github.com/rmax-ai/evidence-first-harness)
     - Lacks: a behavioral-diff engine (no old-vs-new execution in the harness), an input-class summary, a formal schema or spec, signing in practice, a real adversarial agent (stubs), adoption (0 stars), cross-vendor or forge support, and validation results.
  2. **Tusk Drift (YC).** Record/replay old-vs-new on PRs, with Cloud classifying deviations as intended or unintended from the PR title and body. — [Show HN](https://news.ycombinator.com/item?id=45887536); [repo](https://github.com/Use-Tusk/tusk-drift-cli)
     - Lacks: generated or property-based inputs, input-class summarization, preservation proofs, mutation testing, an independent adversarial agent, signed attestations, levels, and a standard. It is Node-first (Python planned at launch).
  3. **Testora / DiffTestGen (Pradel, Cadar; ICSE 2026 and arXiv Jul 2026; OSS research code).** LLM-generated differential tests on old vs new for each PR, with each difference classified against the PR's natural-language intent. — [arXiv 2503.18597](https://arxiv.org/pdf/2503.18597v1); [arXiv 2607.16024](https://arxiv.org/abs/2607.16024)
     - Lacks: a product, a recorded-traffic channel, input-class summarization, mutation or adversarial layers, attestations, levels, and forge UX. Python-only research and about 58% precision (third-party figure).
  4. **Speedscale and Signadot SmartTests.** Production-traffic replay or baseline-vs-sandbox semantic diff on every PR, marketed as AI code verification, with MCP integrations for Claude Code, Cursor, and Copilot and validation reports attached to PRs. — [Speedscale](https://speedscale.com/features/ai-code-verification/); [Signadot](https://www.signadot.com/docs/tutorials/quickstart/smart-tests)
     - Lacks: a structured intent claim, generated inputs, input-class summaries, mutation or adversarial checks, proofs, signed vendor-neutral attestations, and levels. Both are tied to their own infrastructure (Kubernetes sandboxes, traffic capture).
  5. **Meticulous.** The most mature "behavioral diff replaces reading the diff" UX for frontend: base-vs-head session replay, visual diffs as a PR check, and merge blocking until approved. — [Meticulous glossary](https://app.meticulous.ai/docs/concepts/glossary)
     - Lacks: backend or logic coverage, intent claims, generated inputs, input-class summaries, mutation or adversarial checks, proofs, attestations, and levels.
- **Honorable mentions:**
  - **Codeflash:** a shipped correctness-verification report per PR, but only for optimizations. — [codeflash PR #1950](https://github.com/codeflash-ai/codeflash/pull/1950)
  - **Kiro:** intent-to-property tests. — [Kiro](https://kiro.dev/blog/property-based-testing/)
  - **workproof:** in-toto/DSSE receipts with test-weakening signals for AI PRs. — [workproof](https://github.com/rossbuckley1990-hash/workproof)
  - **Datafold and Recce:** the evidence-checklist PR UX for data. — [Datafold](https://docs.datafold.com/deployment_testing)
  - **Axiom, Harmonic, Theorem:** the formal-proof tier. — [SiliconANGLE](https://siliconangle.com/2026/03/12/verifiable-ai-startup-axiom-raises-200m-prove-ai-generated-code-safe/)
  - **Agent Trace:** the template for a vendor-neutral, multi-vendor agent-code spec. — [Thoughtworks](https://www.thoughtworks.com/radar/platforms/agent-trace)

### Inferences
- **Precise unclaimed white space, as of Oct 31, 2026, based on what was found:**
  1. **Input-partitioned behavioral diff as the review artifact.** Merge results from generated-input differential testing and recorded-traffic replay into human-readable input-class predicates (for example "differs only when currency=JPY and amount<1"), each mapped to an intended or unintended verdict against a structured intent claim. Shipping tools report per request, per screenshot, per test, or per row. Partition-style output exists only in academic symbolic techniques and single-version region decomposition.
  2. **A vendor-neutral, signed "behavioral change evidence" predicate.** An in-toto predicate plus forge display and enforcement spec that carries:
     - intent claim (change set and preserve set)
     - behavior-delta classes
     - preservation evidence and its method (differential, equivalence, proof)
     - test-adequacy evidence (mutation score on changed code)
     - verifier independence metadata (different model or vendor, no access to author tests)
     - residual uncertainty

     Today in-toto Test Result is pass/fail only and SCAI is generic. workproof records commands and exit codes, and rmax has only an illustrative YAML.
  3. **Correctness-assurance levels (an "SLSA for behavior", L0–L4) with a conformance definition.** Only ad-hoc tiers exist (rmax's three tiers, AICompetence's impact tiers). SLSA levels cover provenance and review, not behavior.
  4. **Formalized verifier independence as an attestable property.** "Adversarial agent from a different model, without access to the author's tests, failed to falsify the claim" is not formalized anywhere found. Vet, Qodo, and Anthropic review are LLM reviewers whose independence is not attested.
  5. **One engine fusing the layers across languages and agents.** No product combines generated-input differential testing, traffic replay, mutation adequacy, adversarial falsification, and optional proof hooks across languages and agents. Every incumbent covers one or two layers and is tied to its own runtime (Kubernetes, frontend, Node, data warehouse).
- **Defensibility caveats.**
  - The plumbing (in-toto, Sigstore, `actions/attest`) is free.
  - Incumbents with distribution (Cursor, GitHub, Speedscale/Signadot/Tusk, Qodo) can each add one missing layer.
  - The concept's name and framing are already published.
  - The moat would have to be the behavioral-diff engine's quality (input-class summarization at low noise) and winning standard adoption, for example multi-vendor backing the way Agent Trace got it.

### Gaps
- Most commercial claims here are vendor-reported (Speedscale, Signadot, Tusk, Codeflash, Axiom, Harmonic) and not independently verified.
- Search coverage of private or stealth startups is inherently limited. A stealth company could be building exactly this.
- Some named products (Greptile, Graphite, Bugbot, Factory, Augment, Corridor, TestSprite, Momentic, Keploy, GoReplay, SemanticDiff, Difftastic, Witness) were not verified with first-party sources this session.
