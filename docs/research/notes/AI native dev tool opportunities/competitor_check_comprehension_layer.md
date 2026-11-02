# Competitor Check: "Comprehension Layer / Dark-Code Map" (as of Oct 31, 2026)

Idea under test: an open-source system that tracks human understanding of a codebase the way git tracks code. Five parts: (1) per-engineer and per-team knowledge model built with knowledge-tracing methods (BKT/DKT, spaced repetition), not just authorship; (2) a "dark code" / comprehension-coverage metric weighted by criticality; (3) personalized "mental-model diffs" when agents change code a person relies on, with optional quizzes; (4) policy gates, such as "dark critical code needs a human to regain understanding first" and on-call briefings tailored to each person's gaps; (5) a junior curriculum generated from the real codebase and the learner's knowledge model.

Method: adversarial search (aim: prove it is not new) across GitHub, Hacker News, DEV, YC, arXiv, vendor docs and blogs. About 37 search and fetch calls. The tool names that came up were checked against primary pages where possible.

## Q1. Does anything model individual developers' understanding of a codebase beyond git authorship?

### Takeaway
Only partly. Commercial tools (CodeScene) and most OSS bus-factor tools still infer knowledge from authorship. A 2026 position paper argues AI-authored code breaks that whole class of metric. Three small 2026 projects (Fathohm, comprehension-coverage, cdebt) go beyond authorship with review depth, decay, attestations or execution-graded quizzes. None keeps a per-engineer probabilistic knowledge state using knowledge tracing or spaced repetition. The closest per-person prior art is academic: the 2010/2014 Degree-of-Knowledge model, which predates AI coding.

### Cited Findings
- **CodeScene** defines bus factor as how many developers can leave before code becomes unmaintainable. It is "based on each developer's contributed code" over the deep history of each file. "Knowledge Loss" flags modules where at least 50% of the code was written by former contributors. An off-boarding simulator models departures. — [CodeScene Terminology](https://codescene.io/docs/terminology/codescene-terminology.html); [Off-boarding simulation](https://codescene.io/docs/guides/simulations/offboarding-simulator.html)
- CodeScene's knowledge-distribution analysis covers key-person risk, knowledge islands, team knowledge maps, CODEOWNERS alignment and ex-developer knowledge loss. These maps depend on accurate commit authorship and on how bot or bulk commits are treated. I found no CodeScene feature that makes knowledge maps AI-authorship-aware. — [Rubinlake tech radar on CodeScene](https://rubinlake.com/pl/technology-radar/developer-ai-and-delivery/codescene)
- CodeScene's 2026 AI work centres on Code Health: an agentic framework on CodeHealth, an MCP server and the ACE refactoring engine. It also claims AI assistants raise defect risk by at least 30% in unhealthy code (vendor claim). — [techintelpro](https://techintelpro.com/news/ai/agentic-ai/ai-coding-assistants-raise-defect-risk-30-in-unhealthy-code); [codescene.com](https://codescene.com/)
- Pricing listed Oct 2026: EUR 18 (Standard) or EUR 27 (Pro) per active author per month; free for open source. — [Repowise comparison](https://repowise.dev/blog/comparisons/best-git-analytics-tools)
- **"The Substrate Collapse"** (Brett Wheeler, arXiv 2606.20882, 18 June 2026) argues that authorship-based knowledge metrics (truck factor, Degree-of-Authorship, degree-of-knowledge) are invalidated as a class, not merely weakened, once agents write code and humans merge it. It predicts that systems with a healthy authorship truck factor but low comprehension-measured retention will fail at incident resolution. It explicitly leaves a "comprehension-grounded instrument" as an open problem and proposes no tool. — [arXiv 2606.20882](https://arxiv.org/abs/2606.20882)
- **Degree-of-Knowledge (DOK)** by Fritz, Ou, Murphy and Murphy-Hill (ICSE 2010; ACM TOSEM 2014) gives each developer a per-code-element knowledge score that combines VCS authorship with IDE interaction data (edits, selections). The 2014 case studies cover expert finding, knowledge transfer and "identifying changes a developer should be aware of". — [researchr](https://researchr.org/publication/FritzOMM10); [Thomas Fritz research page](https://www.cs.ubc.ca/~fritz/research.html)
- **Fathohm** (fathohm.dev, MIT CLI `npx fathohm`, GitHub App, waitlist / design partners) gives each file a 0–1 comprehension score. Weights: human review depth 0.40 ("lgtm" is worth about 1/50 of full credit), human author recency 0.25 (decays over 180 days), bus factor 0.25 (prompting an agent counts as a quarter of a person) and question answerability 0.10 (currently zero on every file). Its `team` command shows each person's "sole-keeper load" and `offboard` simulates someone leaving. The score is per file, not a model of each engineer. — [fathohm.dev](https://fathohm.dev)
- **comprehension-coverage** (tiarebalbi, Apache-2.0, spec v0.1 plus Python prototype, 0 stars, 22 commits, 2026) is "a per-module, evidence-based, churn-decaying map of which humans still plausibly understand a codebase". Module aggregates are public; per-person scores are private and shown only with `--show-individuals`. v0.1 reads only git history (authorship and agent-mediated commits via co-author trailers). Review, incident diagnosis and ADR authorship exist only as reserved schema. It does not claim to "read minds". — [GitHub tiarebalbi/comprehension-coverage](https://github.com/tiarebalbi/comprehension-coverage)
- **cdebt** (Adityakk9031, Apache-2.0, 108 commits, 0 stars) explicitly refuses per-person modelling: "cdebt measures code and teams, never individuals." It has no leaderboards or per-person scores. Understanding is recorded per code hash and expires when the code changes. — [GitHub Adityakk9031/cdebt](https://github.com/Adityakk9031/cdebt)
- **Knowledge Islands** (arXiv 2408.08733, 2024) is a research web tool that computes per-component truck factor to show where knowledge is concentrated. It is authorship-based. — [arXiv 2408.08733](https://arxiv.org/pdf/2408.08733)
- **System Comprehension Heatmap** is a free spreadsheet template from a DEV post. It has an Engineer-System Matrix with "engineer-system capability scores", criticality and change-velocity pressure factors, and a "Minimum Viable Coverage" check for critical systems: at least 2 safe modifiers, at least 2 capable reviewers, and doc, recent-exposure and on-call familiarity each at 3 or higher. Scoring is manual. — [DEV: Does your team have comprehension debt?](https://dev.to/javz/your-codebase-has-technical-debt-but-does-your-team-have-comprehension-debt-385f)
- Knowledge tracing for programming exists only in education: Code-DKT and the BePKT dataset model student mastery on programming exercises, not engineers' familiarity with a production codebase. A targeted search found no source applying BKT or DKT to engineers' codebase familiarity. — [Code-DKT arXiv 2206.03545](https://arxiv.org/pdf/2206.03545); [BePKT arXiv 2112.08273](https://arxiv.org/pdf/2112.08273)
- **Unblocked** is positioned as a "context engine" and "context layer for AI-driven development". It reads code, PRs, Slack, Jira, Notion and Confluence and serves that context to IDEs and agents over MCP; the MCP went GA on 28 Apr 2026 and Code Review launched on 4 Feb 2026. It models organizational context, not what each human knows. — [Unblocked blog](https://getunblocked.com/blog/unblocked-context-engine-for-agents/); [getunblocked.com](https://getunblocked.com/)
- **Swimm** became mainly a services company in 2026 ("agentic modernization, delivered by expert pods") and sells an "agentic context layer" that indexes code and tribal knowledge for Copilot, Cursor and Claude Code. — [Swimm About](https://swimm.io/about); [Swimm AI-ready](https://swimm.io/solutions/ai-ready)
- **Windsurf Codemaps** (Cognition, 4 Nov 2025) builds task-scoped, AI-annotated codebase maps on top of DeepWiki and Ask Devin, explicitly so engineers avoid shipping "slop that they don't understand". It is an aid to understanding with no persistent record of who understands what. — [Cognition blog: Codemaps](https://cognition.com/blog/codemaps)
- **CodeSee** (codebase maps) was acquired by GitKraken on 14 May 2024 and folded into GitKraken's DevEx platform. — [schneider.im](https://www.schneider.im/gitkraken-acquired-codesee); [codesee.io](https://codesee.io/codebase-maps)

### Inferences
- The thesis that authorship no longer proxies understanding is now published (Wheeler 2026) and widely discussed, so it is not novel. What has not been built is the instrument: a calibrated, per-person knowledge state over code units, fed by evidence beyond git.
- DOK (2010/2014) is the strongest prior art for "per-developer knowledge beyond authorship" and even for "changes a developer should be aware of". Any novelty claim must sit on top of it: AI-era evidence sources, knowledge-tracing dynamics, decay under agent churn, and verified checks.
- The industry is wary of per-person scoring. cdebt refuses it, comprehension-coverage hides it by default, and Fathohm restricts it to sole-keeper load. That is a design signal and an adoption risk for part 1 of the idea.

### Gaps
- Not individually verified this session: DeepWiki/Devin Wiki details, Sourcegraph/Amp, Greptile, Augment Context Engine, Glean for code, GitHub Copilot Spaces, Mintlify, Onboard AI, Stepsize, Pluralsight Flow, LinearB, Jellyfish, DX (getdx), Waydev, Hercules, git-truck and truckfactor. From general knowledge, these are codebase Q&A, context or docs engines, productivity analytics, or authorship-based ownership tools. None was surfaced by any search as modelling individual comprehension, but this was not confirmed against each one's 2026 changelog.
- Could not confirm whether DOK's TOSEM 2014 version includes time decay or forgetting.

## Q2. Is anything measuring "code no human understands" / AI-authored-but-unreviewed code coverage?

### Takeaway
Yes. The "dark code" metric (part 2 of the idea) substantially exists in early form. Fathohm already publishes a "Dark Index" over the top 100 GitHub repos and scores per-file comprehension with critical-path policy floors. comprehension-coverage and cdebt compute similar module or file maps with CI gates. The provenance substrate (git-ai, Agent Trace, Entire Checkpoints) is mature and open. Criticality weighting is mostly a manual "critical" flag or path floor, not a weighted risk model.

### Cited Findings
- **Fathohm** defines comprehension debt as "code no human has recently written, reviewed, or explained". Files scoring below 0.30 are "blind spots". The CLI headline metric is the share of code no human has written or prompted in 180 days. "Comprehension policies" set floors for critical paths (e.g., "nothing under auth/ may score below 60"). The work queue is ranked by churn and size, not by criticality. — [fathohm.dev](https://fathohm.dev)
- **Fathohm Dark Index** (measured 2026-08-12, tool v1.5.1, top 100 most-starred GitHub repos, 6.4 GB): 49.5% of bytes are "dark", median repo 40.9%, 24 repos at least 90% dark. Here "dark code" means code that git history shows no human wrote or directed in the previous 180 days. — [Fathohm Dark Index findings](https://fathohm.dev/dark-index/findings)
- The Fathohm author's DEV article says the scorer uses git-observable signals with 180-day decay. Its comprehension-check factor scores zero because it would need independent reviewers to prevent self-grading. The article is written by the vendor. — [DEV: Comprehension debt](https://dev.to/amit_shrivastava_e813c728/comprehension-debt-what-ai-written-code-actually-costs-2m02)
- **cdebt** says it will "Measure, test and pay down comprehension debt: AI-written code nobody has verifiably understood." Quiz answers are graded by running the code in a sandbox, using a deterministic rule ("No model ever judges an answer"). Each push gets at most 6 questions; a set passes at 2 of 3 including a hard question. States are verified, attested (weighted 0.5) or none. It computes blast radius from a SCIP call graph and produces a ranked pay-down plan. On three pilot repos, quizzes could verify only 19–77% of AI lines. The debt score is "unvalidated" and the pre-registered quiz validity study "has not been run". — [GitHub cdebt](https://github.com/Adityakk9031/cdebt)
- **comprehension-coverage** lets users mark modules `critical:`. `--gate` exits non-zero if a critical module is DARK (or AT_RISK, if configured), for CI gating of agent-authored changes. — [GitHub comprehension-coverage](https://github.com/tiarebalbi/comprehension-coverage)
- **Tears** (Thillel, MIT, 16 stars) declares trust tiers 0–3 per file (0 = deeply reviewed, 3 = "Vibe Coded"). Hooks for Claude Code, Codex and OpenCode auto-demote files an agent edits, and a human restores the tier in the diff after review. CI blocks trusted code from importing less-trusted code. It "doesn't prove the engineer understood the code" and tracks no individuals. — [GitHub Thillel/tears](https://github.com/Thillel/tears); [Ask HN thread](https://news.ycombinator.com/item?id=48191051)
- **git-ai** is an open-source Git extension (about 2.9k stars, 68 contributors). It does line-level AI attribution (agent, model, prompt, session and tool call) stored in git notes and kept through rebase and squash. It also tracks token cost per commit and PR. It does not track human review or understanding. — [usegitai.com](https://usegitai.com/track-ai-code)
- OpenAI hired git-ai's founders (Aidan Cunniffe, Sasha Varlamov), announced around 12 Sep 2026. Reporting says this was a hire, not an acquisition, and the OSS project continues. — [The New Stack](https://thenewstack.io/openai-hires-git-ai/); [AI Catchup](https://aicatchup.com/news/openai-welcomes-git-ai-agent-attribution)
- **Agent Trace** is an open spec from Cursor for recording AI versus human origin of code (human / AI / mixed / unknown) and is VCS-agnostic. Cognition, Cloudflare, Vercel and others endorsed it on 29 Jan 2026. It explicitly does not define ownership or quality. — [cursor/agent-trace](https://github.com/cursor/agent-trace); [Cognition blog](https://cognition.ai/blog/agent-trace)
- **Entire** (Thomas Dohmke) launched on 10 Feb 2026 with a $60M seed. Its open-source Checkpoints CLI stores prompts, transcripts and tool calls alongside commits, and a dashboard traces any commit or PR back to its agent session. A distributed Git network preview followed in Jul 2026. — [Futurum](https://futurumgroup.com/insights/selling-agent-provenance-to-the-cio-entire-changes-who-signs/); [docs.entire.io](https://docs.entire.io/web/checkpoints)
- **Faros AI** published "Comprehension debt: AI code is outpacing human understanding" on 29 Sep 2026. It says "There is no single comprehension debt metric" and suggests proxy signals (onboarding time, knowledge concentration). The page shows no Faros product feature that measures comprehension. — [Faros AI blog](https://www.faros.ai/blog/comprehension-debt-in-software-engineering)
- "Dark code" is a term in active circulation. Speedscale defines it as software no human has written, read or reviewed. Nate's Newsletter (13 Apr 2026) proposes a dark-code audit plus comprehension gates; the paywalled part mentions a "Repo Learning Coach" OSS tool that I could not locate. — [Speedscale](https://speedscale.com/blog/dark-code/); [Nate's Newsletter](https://natesnewsletter.substack.com/p/your-codebase-is-full-of-code-nobody); [Upsun](https://upsun.com/blog/dark-code-architectural-intent/); [LeadDev](https://leaddev.com/software-quality/were-on-call-for-code-nobody-wrote)

### Inferences
- Part 2 of the idea (dark-code metric) is at least 60–70% claimed by Fathohm alone, and the same concept is replicated in two OSS prototypes. The name "dark code" itself is taken (Fathohm's Dark Index, Speedscale, Nate's Newsletter). "Comprehension coverage" is the literal name of the tiarebalbi repo.
- Remaining room on part 2: criticality as a real weighted risk model (on-call paths from incident and paging data, security and payment code, call-graph centrality) instead of path floors; and feeding the metric with verified, multi-source comprehension evidence instead of git proxies. Fathohm's own "question answerability" factor is still zero.
- The provenance layer (git-ai, Agent Trace, Entire) is a ready input substrate, not a competitor. It tells you which lines AI wrote, not who understands them.

### Gaps
- Could not determine Fathohm's founding date, funding, team or pricing. Its site says it is free for design partners and has a waitlist.
- Could not verify adoption for cdebt, comprehension-coverage or Tears. All have negligible stars (0–16).

## Q3. Does anything generate personalized "mental-model diffs" or knowledge-gap-tailored on-call briefings?

### Takeaway
Not found. Generic change digests, PR comprehension aids (Stage, YC 2026) and AI-SRE incident briefings exist. None computes what changed relative to what this particular person knew, and none tailors an on-call briefing to an individual's knowledge gaps. The only prior art is DOK's 2014 academic use case of "changes a developer should be aware of", which predates AI agents.

### Cited Findings
- Fathohm sends a weekly digest to the dashboard inbox: top new blind spot, debt movement, three riskiest paths and one suggested file. It also generates a transient "module briefing" from source ("the orientation a teammate would have given you"). Neither is described as personalized to a person's prior knowledge. — [fathohm.dev](https://fathohm.dev)
- **Stage** (YC Spring 2026, launched May 2026, stagereview.app) is "a code review platform to help engineers understand and review AI-generated code". It groups PRs into logical "chapters" and claims review is 5x faster (vendor claim). It is per-PR, with no persistent model of the reviewer. — [YC launch](https://www.ycombinator.com/launches/QQz-stage-code-review-platform-for-ai-generated-code); [YC company page](https://ycombinator.com/companies/stage)
- Generic "what changed" tools: Codigest (`cdg diff` from an anchor, MCP server for Claude Code); a "merged changes digest" agent template that sorts changes by who they matter to; Knownbase (agent project memory with a "changes since" call). None models individual human knowledge. — [Codigest on PyPI](https://pypi.org/project/codigest/0.8.0/); [trustcase merged-changes digest](https://trustcase.dev/use-cases/merged-changes-digest); [Knownbase](https://knownbase.dev/)
- The DOK model (TOSEM 2014) includes a case study on "identifying changes a developer should be aware of" based on that developer's knowledge score. — [Thomas Fritz research page](https://www.cs.ubc.ca/~fritz/research.html); [researchr](https://researchr.org/publication/FritzOMM10)
- On-call: practitioners say AI-shaped codebases leave incident responders in territory they know less deeply. AI-SRE vendor briefings (what fired, what changed, what happened last time) are generic, not tailored to each responder. One post argues on-call rotations need an "AI-literacy prerequisite". — [Great Circle, 9 Jun 2026](https://greatcircle.com/blog/2026/06/09/on-call-cost-of-ai-generated-code/); [Tian Pan, 28 Apr 2026](https://tianpan.co/blog/2026-04-28-on-call-rotation-needs-ai-literacy); [Brex AI on-call](https://www.brex.com/journal/how-we-built-an-ai-oncall-engineer)
- A targeted search for "per-developer knowledge model + personalized briefing" found no system that tracks which developer understands which part of a codebase in order to personalize change briefings. — search results incl. [arXiv 2608.10319](https://arxiv.org/html/2608.10319v2) (that paper personalizes agents to developers, the opposite direction)

### Inferences
- Part 3 (mental-model diffs) and the personalized on-call briefing in part 4 are the clearest unclaimed product surfaces found. They also depend on part 1: you cannot compute "relative to what you knew" without a per-person knowledge state.

### Gaps
- Did not check incident.io, Rootly, PagerDuty or Resolve.ai 2026 changelogs individually for responder-personalized briefings.

## Q4. Do comprehension gates and policies exist?

### Takeaway
Yes, and they are commoditizing fast. At least seven OSS Actions, apps or hooks quiz PR authors on their diff before merge or push, and three tools gate on dark or untrusted critical code. What is missing is a gate whose unlock condition is "a specific human regained understanding", measured against a persistent knowledge model and paired with a personalized catch-up briefing.

### Cited Findings
- PR and push comprehension gates found: erickdevz/comprehension-gate (2–4 questions on the author's diff, config in `.github/comprehension.yml`); Commit Comprehension Gate (Claude generates 3 MCQs, MIT); dkamm/pr-quiz (OpenAI-generated quiz with a time limit); Gater.app (GitHub App); AICodeQuest (Chrome extension with a Checks API gate); Sphinx (local git hook in which a fresh model asks one question about the diff); Codecop (the "merge gate for AI-generated PRs"). — [comprehension-gate](https://github.com/erickdevz/comprehension-gate); [DEV islandbytes](https://dev.to/islandbytes/i-built-a-merge-gate-that-quizzes-developers-on-their-own-code-changes-heres-why-and-how-5460); [pr-quiz](https://github.com/dkamm/pr-quiz); [Gater app](https://github.com/apps/gater-app); [AICodeQuest](https://github.com/Upendra2003/AICodeQuest-Artifacts); [DEV: push gate false negatives](https://dev.to/cole_halton_42f71d71b809b/a-push-gate-that-quizzes-you-on-your-ais-code-ships-its-own-unresolved-false-negatives-1ihc); [codecop](https://github.com/apps/codecop-codes)
- cdebt's `cdebt gate` flags PRs whose AI-authored changes land in un-understood code. It is advisory by default and fails builds with `--enforce`, and a GitHub Action re-checks recorded answers. — [GitHub cdebt](https://github.com/Adityakk9031/cdebt)
- comprehension-coverage `--gate` fails CI if a critical module is DARK. Fathohm has policy floors per path. Tears enforces import boundaries by trust tier. — [comprehension-coverage](https://github.com/tiarebalbi/comprehension-coverage); [fathohm.dev](https://fathohm.dev); [Tears](https://github.com/Thillel/tears)
- Storey et al.'s grey-literature review (arXiv 2610.37888, 27 Oct 2026, 76 practitioner sources) lists "comprehension gates" as a practice for preventing cognitive debt. — [arXiv 2610.37888](https://arxiv.org/abs/2610.37888)
- An Ask HN thread on shipping AI-written code people don't understand reached 391 points and 538 comments. — [AI Weekly](https://aiweekly.co/alerts/ask-hn-on-shipping-ai-code-you-dont-understand-hits-391-points); [Ask HN](https://news.ycombinator.com/item?id=50151036)

### Inferences
- "Gate on dark critical code" alone is not differentiated. Differentiation would come from the unlock path: a briefing targeted at the person's gaps, then a verified check (cdebt-style execution grading is a good model), then an update to the person's knowledge state.
- Gaming is a known issue: cdebt notes a quiz cannot stop someone pasting questions into an AI, and LLM-graded gates produce false negatives.

### Gaps
- No usage or adoption data found for any gate tool.

## Q5. Does anything generate a learning curriculum from the real codebase plus an individual knowledge model (juniors)?

### Takeaway
Partially. Many tools generate onboarding paths, learning sites or quizzes from a repo, and Claude Code ships a "Learning" output style. None ties the curriculum to a persistent per-learner knowledge model, spaced repetition over codebase concepts, or the team's dark-code priorities.

### Cited Findings
- Claude Code's "Explanatory" and "Learning" output styles (Aug 2025): Learning asks the user to write strategic pieces of code (`TODO(human)`). This is in-session behaviour only, with no persistent learner model. — [AlternativeTo](https://alternativeto.net/news/2025/8/claude-s-learning-mode-is-now-available-to-all-users-with-new-coding-styles); [ClaudeLog](https://www.claudelog.com/faqs/what-is-output-styles-in-claude-code/)
- Repo-derived learning tools:
  - repo-dojo: staged, persistent learning tracks stored in `.repo-dojo/`.
  - Repo Reader: gamified learning paths with achievements, progress tracking and quizzes.
  - developer-onboarding-buddy: a 5-day plan with reading lists, tasks and quizzes.
  - OnBoardAI: commercial, with learning paths, role-based training and manager dashboards.
  - xhawk.ai: Socratic and Feynman learning paths over MCP.
  - tt-a1i/repo-learning: one-page learning site.
  - Understand-Anything: knowledge-graph dashboard for onboarding.
  — [repo-dojo](https://skills.cat/skills/alpardmason/repo-dojo); [Repo Reader](https://app.readytensor.ai/publications/repo-reader-understand-a-codebase-in-less-time-and-with-more-fun-XKiFftVYurmu); [onboarding-buddy](https://github.com/mohammedamaanaltafshaikh47-maker/developer-onboarding-buddy); [OnBoardAI](https://onboard-developer.com/); [xhawk.ai](https://xhawk.ai/explore); [Understand Anything](https://understand-anything.com/); [Show HN](https://news.ycombinator.com/item?id=47908512)
- A search for spaced-repetition tools that build cards from your own codebase found none. Results were generic Anki or flashcard apps and coding-problem SRS tools. — [freeCodeCamp Anki](https://www.freecodecamp.org/news/use-spaced-repetition-with-anki-to-learn-to-code-faster-7c334d448c3c/); [Show HN SRS for coding problems](https://news.ycombinator.com/item?id=40173237)
- Addy Osmani argues onboarding tasks should teach both the codebase and AI tool use, and warns juniors may skip the "why". — [Addy Osmani Substack](https://addyo.substack.com/p/ai-wont-kill-junior-devs-but-your)

### Inferences
- The new element would be a curriculum that is (a) driven by the learner's knowledge-tracing state, (b) scheduled with spaced repetition over code concepts that are still live (and invalidated when code churns), and (c) prioritized toward the team's dark or critical code. That turns junior learning into dark-code reduction. No one combines these.

### Gaps
- Did not verify Cursor, ChatGPT Study Mode or Copilot learning features in 2026.

## Q6. What do YC, Show HN, GitHub and arXiv show (W25–F26)?

### Takeaway
The concept is mainstream in discourse and research ("comprehension debt", "cognitive debt", "dark code"). On the product side there is one YC company on review comprehension (Stage) and a cluster of 2026 micro-projects and one small startup (Fathohm) on dark-code measurement. No YC company was found doing a per-engineer comprehension model.

### Cited Findings
- Term lineage: Jason Gorman coined "comprehension debt" on 30 Sep 2025. Addy Osmani popularized it in Mar 2026 as "the growing gap between how much code exists in your system and how much of it any human being genuinely understands". — [Codemanship](https://codemanship.wordpress.com/2025/09/30/comprehension-debt-the-ticking-time-bomb-of-llm-generated-code/); [Addy Osmani](https://addyosmani.com/blog/comprehension-debt/)
- Margaret-Anne Storey's "triple debt" (technical, cognitive, intent): cognitive debt is the erosion of shared understanding until no one can explain the system. She warns that AI-generated docs can give the appearance of understanding. She first used the term in Oct 2025. — [ACM Queue](https://queue.acm.org/detail.cfm?id=3807966); [arXiv 2603.22106](https://arxiv.org/pdf/2603.22106); [LeadDev](https://leaddev.com/ai/ai-coding-creates-two-kinds-of-debt-youre-only-measuring-one)
- Storey treats cognitive debt as a property of a system or project, not an individual burden, and suggests detecting it with retrospective questions ("who can explain each component?"). — [LeadDev](https://leaddev.com/ai/ai-coding-creates-two-kinds-of-debt-youre-only-measuring-one)
- O'Reilly Radar: "Comprehension Debt: The Hidden Cost of AI-Generated Code". — [O'Reilly](https://www.oreilly.com/radar/comprehension-debt-the-hidden-cost-of-ai-generated-code/)
- Augment's "State of AI-Native Engineering 2026" (219 engineering leaders): 55% flag codebase comprehension as a top worry. The search summary also says almost nobody is building a response beyond code review (vendor report, figure seen only in a search snippet). — [Augment](https://www.augmentcode.com/resources/state-of-ai-native-engineering-2026)
- YC: Stage (Spring 2026) is the closest YC match. Canary (W26) is AI QA that "reads and comprehends your code" (adjacent, not human comprehension). — [YC Stage](https://ycombinator.com/companies/stage); [startground W26](https://startground.com/yc-w26-startups/)

### Inferences
- The narrative is saturated. A launch pitched only as "measure comprehension debt / dark code" would meet Fathohm, cdebt and comprehension-coverage immediately. The pitch has to lead with the per-person knowledge model and personalized diffs.

### Gaps
- No full scan of YC W25–F26 company lists was possible. A YC company in stealth or with a vague listing could have been missed.

## Q7. Is there academic or industry measurement of how well developers understand AI-written code they shipped?

### Takeaway
Controlled experiments and qualitative studies show AI assistance lowers comprehension, but no field instrument measures shipped-code understanding per person. Wheeler (2026) names building one an open problem. Fathohm's Dark Index is the only large-scale measurement found, and it uses a git proxy (no human-directed change in 180 days), not measured understanding.

### Cited Findings
- Anthropic RCT (Shen & Tamkin, arXiv 2601.20245): developers learning a new library with AI scored 17% lower on a comprehension quiz. Secondary reports put it at about 50% vs 67%, with the largest gap in debugging and passive delegation hurting most. — [O'Reilly](https://www.oreilly.com/radar/comprehension-debt-the-hidden-cost-of-ai-generated-code/); [Stephen Turner summary](https://blog.stephenturner.us/p/ai-assistance-coding-skills-anthropic)
- Copilot brownfield study (arXiv 2511.02922, v2 May 2026): performance improved but there was no overall comprehension gain. High-comprehension participants verified generated code 4.7x more often. — [arXiv 2511.02922](https://arxiv.org/html/2511.02922v2)
- Ahmad 2026 (arXiv 2604.13277) on student projects identified four comprehension-debt accumulation patterns, including black-box acceptance and verification bypass. — [arXiv 2604.13277](https://arxiv.org/html/2604.13277v1)
- Practitioner SE-agents study (arXiv 2607.10856): teams knowingly defer comprehension while AI code keeps working, and some delegate diagnosis back to agents. — [arXiv 2607.10856](https://arxiv.org/pdf/2607.10856)
- AIRELI persona taxonomy (ACM): "AI-steered" developers finished tasks quickly without comprehending most of the codebase or even their own changes. — [ACM DL](https://dl.acm.org/doi/10.1145/3794763.3794804)
- Fathohm Dark Index: 49.5% of bytes across the top 100 repos are "dark" (git proxy). — [Fathohm](https://fathohm.dev/dark-index/findings)
- Wheeler: a comprehension-grounded instrument is an open problem. — [arXiv 2606.20882](https://arxiv.org/abs/2606.20882)

### Inferences
- There is a research opening (and credibility for an OSS tool): validate a codebase knowledge-tracing model against incident-resolution outcomes, the exact falsifiable prediction Wheeler poses. cdebt's pre-registered but unrun validity study shows how early this is.

### Gaps
- Could not retrieve arXiv 2603.28592 (large-scale study of AI code "in the wild") to check whether it measures human comprehension.

## Q8. Overall novelty verdict and unclaimed white space

### Takeaway
Verdict: **partially exists.** The framing ("comprehension / cognitive debt", "dark code") and two of the five components (dark-code metric, comprehension gates) already exist in 2026 as early OSS and one small startup, Fathohm, plus about seven PR-quiz gates. The core differentiator remains unbuilt: a per-engineer knowledge-tracing model of the codebase driving personalized mental-model diffs, tailored on-call briefings and a knowledge-aware curriculum. The integrated "git for human understanding" system was not found anywhere.

### Cited Findings
Closest competitors (approximate overlap with the full idea):
1. **Fathohm** (about 45–50%). Has: dark-code metric and Dark Index, per-file comprehension score (review depth, recency decay, bus factor), sole-keeper load per person, offboarding simulation, critical-path policy floors, weekly digest, module briefings, MIT CLI and GitHub App. Lacks: per-engineer knowledge model and knowledge tracing (score is per file; its comprehension-check factor is zero), personalized "relative to what you knew" diffs, quizzes (only self-rated written answers that don't move the score), weighted criticality (floors only), on-call tailoring, and a curriculum. — [fathohm.dev](https://fathohm.dev); [Dark Index](https://fathohm.dev/dark-index/findings)
2. **cdebt** (about 30–35%). Has: verified comprehension through execution-graded quizzes, per-code-hash expiry on change, attestation states, CI gate, SCIP blast radius, pay-down plan. Lacks: any per-individual model (explicitly refused), knowledge tracing or spaced repetition, personalized diffs, on-call briefings and curriculum. It is unvalidated and has 0 stars. — [GitHub cdebt](https://github.com/Adityakk9031/cdebt)
3. **comprehension-coverage (tiarebalbi)** (about 30–35%). Has: per-module and private per-person evidence scores with churn and time decay, critical flag, DARK/AT_RISK CI gate, and the literal name "comprehension coverage". Lacks: evidence beyond git in v0.1 (review and incidents are only schema), knowledge tracing, quizzes or verification, personalized updates and curriculum. It is a spec-stage prototype with 0 stars. — [GitHub](https://github.com/tiarebalbi/comprehension-coverage)
4. **CodeScene** (about 20–25%). Has: mature commercial knowledge distribution, bus factor, knowledge loss, team knowledge maps, off-boarding simulation, Code Health and hotspots. Lacks: anything beyond authorship (no evidence of AI-authorship awareness), comprehension verification, personalized diffs, gates on understanding and learning features. — [CodeScene docs](https://codescene.io/docs/terminology/codescene-terminology.html)
5. **Tears** (about 15%), plus the PR comprehension-gate cluster. Has: agent-edit auto-demotion, human re-review restores trust, CI trust boundaries. Lacks: per-person tracking, understanding measurement, criticality weighting beyond tier requirements, briefings and learning. — [Tears](https://github.com/Thillel/tears)
- Honourable mentions and prior art:
  - DOK model (per-developer knowledge from authorship plus interaction, "changes a developer should be aware of", 2010/2014). — [researchr](https://researchr.org/publication/FritzOMM10)
  - Stage (YC S26, PR comprehension). — [YC](https://www.ycombinator.com/launches/QQz-stage-code-review-platform-for-ai-generated-code)
  - Windsurf Codemaps / DeepWiki (comprehension aids). — [Cognition](https://cognition.com/blog/codemaps)
  - git-ai, Agent Trace and Entire (provenance substrate). — [usegitai](https://usegitai.com/track-ai-code); [agent-trace](https://github.com/cursor/agent-trace); [Futurum](https://futurumgroup.com/insights/selling-agent-provenance-to-the-cio-entire-changes-who-signs/)
  - System Comprehension Heatmap spreadsheet (manual engineer-system matrix plus MVC). — [DEV](https://dev.to/javz/your-codebase-has-technical-debt-but-does-your-team-have-comprehension-debt-385f)

### Inferences
Exact unclaimed white space (nothing found doing these as of 31 Oct 2026):
- **(a) Codebase knowledge tracing:** a persistent per-engineer probabilistic knowledge state over code units (functions, modules, concepts or invariants). It would be updated from multi-source evidence: review depth, debugging and incident participation, questions asked to agents, explanations given, verified quiz answers. It needs forgetting dynamics plus churn invalidation tied to agent provenance (Agent Trace / git-ai / Entire). DOK is the pre-AI ancestor. Fathohm, cdebt and comprehension-coverage stop at per-file or team proxies or deliberately avoid individuals.
- **(b) Mental-model diffs:** a per-person delta between "the version of this region you last understood" and the current one after agent changes, delivered as a minimal explanation plus an optional verified check. Existing digests and PR tools (Fathohm digest, Stage, Codigest) are generic.
- **(c) Knowledge-gap-aware on-call briefings:** a briefing for whoever is paged, built from the intersection of incident blast radius and that person's knowledge state. AI-SRE briefings are responder-agnostic.
- **(d) Understanding-restoring gates:** gates whose unlock is "a named human's knowledge state on this critical, dark region crosses a threshold", reached through a targeted briefing plus a verified check, not a one-off PR quiz. Criticality would come from real signals (paging history, security and money paths, call-graph centrality) rather than path floors.
- **(e) Knowledge-model-driven curriculum with spaced repetition over live code:** cards and exercises invalidated when code churns, prioritized toward the team's dark or critical code, so junior learning lowers dark-code exposure.
- **(f) Validation:** the first field validation linking comprehension-measured retention to incident outcomes, which Wheeler 2026 poses as a falsifiable open problem.
- Risks: privacy and surveillance backlash against per-person scores (cdebt's refusal, comprehension-coverage's private-by-default design). Gaming of quizzes via AI. A crowded narrative space, where Fathohm could add per-person modelling quickly. The provenance substrate is now partly under OpenAI's influence (git-ai founders) and Entire's.

### Gaps
- Could not verify Fathohm's funding, team or roadmap; it is the most likely fast follower.
- Incumbent changelogs (DX, Jellyfish, LinearB, Pluralsight Flow, Sourcegraph/Amp, Greptile, Augment, Glean, Copilot Spaces) were not individually checked for late-2026 "comprehension" features.
