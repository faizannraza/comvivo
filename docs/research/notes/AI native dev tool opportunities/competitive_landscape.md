# Competitive Landscape of AI Software-Development Tooling (as of Oct 31, 2026) — White-Space Map

Source-quality note for the report writer: Much 2026 coverage comes from aggregator and content-farm sites (tech-insider.org, valueaddvc, presspool, pulse2, getlatka, etc.). Where a fact rests only on such a source it is flagged "(secondary)" or "(unverified)". Wikipedia's Cursor article carries an "LLM-generated text" maintenance tag, but its dated facts cite TechCrunch, Bloomberg, NYT and an SEC 8-K. GitHub Universe 2026 was not yet recapped in any source found (a webinar recap is scheduled for Nov 5, 2026), so GitHub's late-2026 announcements are missing.

## Q1. Categorized map: who are the top players per category, open vs. closed, funding/ARR, and user-reported gaps?

### Takeaway
Agents/IDEs, code review, app builders and sandboxes are heavily capitalized and consolidating fast. Cursor went to SpaceX for $60B (closed Aug 14, 2026). Cognition was valued at $26B in May 2026 and bought Corridor on Oct 28, 2026. Lovable reached $13.3B and CodeRabbit $1.5B. Open-source agents (opencode, OpenHands, Cline) are very strong. In contrast, verification, provenance, agent security, cost control and comprehension tooling are early, thinly funded, or built by only a handful of firms.

### Cited Findings

#### 1. Coding agents, AI IDEs and CLIs (crowded)
- **Cursor (Anysphere), closed source.** Funding: $900M Series C at $9.9B (Jun 5, 2025) and $2.3B Series D at $29.3B (Nov 13, 2025). ARR passed $1B after Nov 2025 and was about $3B by May 21, 2026 (Bloomberg). On Apr 21, 2026 SpaceX got a right to acquire it for $60B; it exercised that right Jun 16, 2026, and the deal closed Aug 14, 2026, making Cursor a wholly owned SpaceX subsidiary (SEC 8-K). Products: Bugbot (Jul 2025), Cursor CLI (Aug 7, 2025), Cursor 2.0 with parallel agents on worktrees or remote machines (Oct 29, 2025), Cloud Agents (Oct 30, 2025), and Composer 2, built on Kimi 2.5 (Mar 2026). — [Wikipedia: Cursor (company)](https://en.wikipedia.org/wiki/Cursor_(company))
  - Other secondary sources give ARR of $2B in Feb 2026 and over $4B in Jun 2026, plus April 2026 talks to raise $2B at $50B that the acquisition superseded. — [The Next Web](https://thenextweb.com/news/cursor-anysphere-2-billion-funding-50-billion-valuation-ai-coding); [valueaddvc (secondary)](https://valueaddvc.com/blog/cursor-ai-valuation-how-a-code-editor-became-a-9b-company)
- **Cognition (Devin, plus Windsurf, now reportedly "Devin Desktop"), closed source.** It completed the Windsurf acquisition Jul 14, 2025 — [Mergr](https://mergr.com/transaction/cognition-acquires-windsurf). Funding: $400M at $10.2B (Sep 2025) — [Pulse2](https://pulse2.com/cognition-400-million-raised-at-10-2-billion-valuation-to-advance-future-of-ai-based-software-engineering). Series D of more than $1B at $26B post-money (May 2026), with ARR about $492M, up from $37M a year earlier — [KuCoin News (secondary)](https://www.kucoin.com/news/flash/cognition-ai-raises-1b-valuation-hits-26b-as-arr-surpasses-492m). August 2026 talks at about $40B are reported but unconfirmed — [valueaddvc (secondary)](https://valueaddvc.com/pulse/ai-coding-tools-valuation-data-2026). The Windsurf IDE was reportedly rebranded Devin Desktop on Jun 2, 2026 (single source) — [idealogic](https://idealogic.io/blog/ai-coding-tools).
- **Claude Code (Anthropic), closed source.** Run-rate revenue passed $2.5B in Feb 2026, more than doubling since the start of 2026 per Anthropic. That month Anthropic raised a $30B Series G at a $380B valuation. One secondary source claims Claude Code is behind about 1 in 25 GitHub commits. — [NxCode (secondary)](https://www.nxcode.io/resources/news/anthropic-380b-valuation-super-bowl-claude-code-2026); [gu-log (secondary)](https://gu-log.vercel.app/en/posts/en-clawd-picks-20260212-anthropic-30b-funding)
  - A survey of 2,350 developers (Aug–Sep 2026) found Claude Code overtook GitHub Copilot as the most common primary assistant in mid-2026. It also found the top 4 tools hold 77.0% share, up from 71.2% in January. This is a low-authority source. — [baeseokjae survey](https://baeseokjae.github.io/posts/ai-coding-market-share-adoption-2026/)
- **OpenAI Codex (CLI, cloud and IDE), CLI open source.** It reached about 4M weekly active developers by Apr 2026 — [Digital Applied (secondary)](https://www.digitalapplied.com/blog/openai-codex-4m-weekly-developers-growth-data). Another report claims 7M "active users" on Jul 13, 2026, which may count ChatGPT users — [DEV Community](https://dev.to/max_quimby/did-codex-overtake-claude-code-the-7m-user-question-5bam). OpenAI acquired Ona (formerly Gitpod, cloud dev environments): announced Jun 11, 2026, closed Aug 10, 2026 — [SOTA deal list](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **GitHub Copilot coding agent and Agent HQ, closed source.** Agent HQ was announced at Universe 2025 as a single home for agents from Anthropic, OpenAI, Google, Cognition, xAI and others, inside a paid Copilot subscription. It added "mission control" for assigning, steering and tracking multiple agents — [GitHub Blog](https://github.blog/news-insights/company-news/welcome-home-agents/). It rolled out in early 2026 with Claude Code and Codex available to Copilot subscribers — [IT Brief](https://itbrief.co.uk/story/github-copilot-surges-as-agent-hq-targets-ai-ecosystem); [TestingCatalog](https://www.testingcatalog.com/github-lets-copilot-subscribers-run-multiple-ai-coding-agents.md).
- **Google (Antigravity, Jules, Gemini CLI).** At I/O in May 2026 Google folded Gemini CLI into "Antigravity CLI". Gemini CLI and the Code Assist IDE extensions stopped serving consumer and free users on Jun 18, 2026. Antigravity 2.0 shipped as a standalone desktop app for managing agents, with a CLI and SDK. — [Virtualization Review](https://virtualizationreview.com/articles/2026/05/19/google-moves-gemini-cli-into-antigravity-cli-as-agent-platform-expands.aspx). Jules is positioned as the asynchronous cloud agent that returns PRs — [aitraining2u](https://www.aitraining2u.com/google-antigravity-jules-gemini-cli-2026.html).
- **Meta Muse Code, closed source.** Beta launched Aug 5, 2026: a terminal agent on Muse Spark 1.2 for macOS and Linux, competing on price with Claude Code and Codex. — [Channel Insider](https://www.channelinsider.com/ai/news-meta-muse-code/); [YourStory](https://yourstory.com/ai-story/meta-muse-code-ai-coding-agent-muse-spark-1-2)
- **Factory (Droids), closed source.** $150M Series C at $1.5B (Apr 16, 2026), then a reported $200M at $5B (Sep 15, 2026). Both figures come from secondary sources; Factory has not confirmed the September round. — [tech-insider (secondary)](https://tech-insider.org/factory-ai-5-billion-valuation-coding-agent-2026/); [presspool (secondary)](https://presspool.ai/companies/factory-com)
- **Amp.** Spun out of Sourcegraph as Amp, Inc. in Dec 2025. It has disclosed no standalone funding and is reportedly profitable. — [Ry Walker research](https://rywalker.com/research/amp-sourcegraph)
- **Augment Code, closed source.** About $252M raised in total; a $977M valuation figure is unverified — [startupfundraising.com (secondary)](https://startupfundraising.com/ai-coding-agents-enterprise-fundraising).
- **Browser app builders, closed source.**
  - Lovable: $400M Series C at $13.3B (Aug 12, 2026), with more than $500M annualized revenue — [valueaddvc (secondary)](https://valueaddvc.com/pulse/ai-coding-tools-valuation-data-2026).
  - Replit: $400M Series D at about $9B (Mar 11, 2026) — [Bloomberg (Jan 15, 2026, talks)](https://www.bloomberg.com/news/articles/2026-01-15/ai-coding-startup-replit-nears-funding-at-9-billion-valuation); [presspool (secondary)](https://presspool.ai/companies/replit-com).
  - Bolt and v0 are listed in the same category — [kingy.ai](https://kingy.ai/blog/state-of-ai-coding-tools-2026/).
- **Open-source agents (snapshots from mid-2026):**
  - opencode: about 193k–213k GitHub stars, the most-starred.
  - OpenHands: about 83k–91k stars.
  - Cline: about 65k–70k stars.
  - Kilo Code: about 27k stars.
  - Roo Code: archived; final VS Code release May 15, 2026.
  - Source: [openalternative](https://openalternative.co/blog/best-open-source-ai-coding-agents); [morphllm](https://www.morphllm.com/ai-coding-assistant-open-source).
  - Roo moved to a cloud agent called Roomote — [vibecodehq](https://vibecodehq.pages.dev/blog/roo-code-shuts-down-roomote-cloud-agent-may-2026).
  - Anaconda acquired Kilo (3M developers) on Jul 15, 2026 — [Anaconda blog](https://www.anaconda.com/blog/anaconda-acquires-kilo-code).
  - Cursor acquired Continue in June 2026 and shut the product down; users had until Jul 15 to export, and the code stays Apache-2.0 — [DEV Community](https://dev.to/leobaniak/cursor-acquires-continue-and-gives-its-users-a-july-15-export-deadline-5dkn); [continue.dev](https://continue.dev/).
- **Category definition.** One 2026 overview splits vendors into five groups:
  - AI IDEs (Cursor, Devin Desktop, JetBrains AI)
  - Platform-native agents (Copilot)
  - Browser app builders (Replit, Lovable, Bolt, v0)
  - Review and governance (Qodo, Sourcegraph, Tabnine, CodeRabbit)
  - Open-source model-flexible agents (Aider, Cline, Continue, OpenHands, SWE-agent)
  - Source: [kingy.ai](https://kingy.ai/blog/state-of-ai-coding-tools-2026/).

#### 2. Multi-agent orchestration and parallel agent managers (crowded, low moat, being absorbed by platforms)
- Tools in this category:
  - Vibe Kanban: Apache-2.0. Its company, Bloop, shut down Apr 10, 2026, and the project is now community-maintained.
  - Conductor: macOS only, free, runs each agent in its own git worktree.
  - Claude Squad: AGPL, tmux-based.
  - Nimbalyst (formerly Crystal): MIT, with an iOS app.
  - Superset: open source, macOS app plus CLI and MCP.
  - Paneflow: MIT.
  - Sculptor (Imbue): research preview, runs agents in Docker containers.
  - Mux: AGPL.
  - Opcode: no longer developed.
  - None of these tools has disclosed funding. The source says the category-wide gap is that "the operator becomes the bottleneck": knowing which agent is blocked, which one changed the wrong file, and which branch is safe to merge.
  - Source: [Nimbalyst blog (vendor-authored)](https://nimbalyst.com/blog/best-agent-management-tools-2026/).
- Terragon shut down Feb 9, 2026 and left an unmaintained OSS snapshot (terragon-oss) — [DEV Community](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8); [vibecoding.app](https://vibecoding.app/blog/vibe-kanban-review).
- Platforms are absorbing the category: Cursor 2.0 parallel agents ([Wikipedia](https://en.wikipedia.org/wiki/Cursor_(company))), GitHub Agent HQ mission control ([GitHub Blog](https://github.blog/news-insights/company-news/welcome-home-agents/)), and the Antigravity 2.0 agent manager ([Virtualization Review](https://virtualizationreview.com/articles/2026/05/19/google-moves-gemini-cli-into-antigravity-cli-as-agent-platform-expands.aspx)).

#### 3. AI code review (crowded with vendors, problem still unsolved)
- **CodeRabbit**, closed source: $143M Series C at $1.5B led by Atomico and Smash Capital (Jul 31 / Aug 2026), with revenue up more than 5x — [valueaddvc (secondary)](https://valueaddvc.com/pulse/ai-coding-tools-valuation-data-2026); [Tracxn](https://tracxn.com/d/companies/coderabbit/__eUZkIcCX5V5URbHL1dChWoZTJxYIECPczffdcsAK2n0).
- **Greptile**: $25M Series A led by Benchmark (Sep 2025). A 2026 round of $40M is unconfirmed. — [TheSaaSNews](https://www.thesaasnews.com/news/greptile-raises-25-million-series-a/); [Tracxn](https://tracxn.com/d/companies/greptile/__A9Pe_EGI8X6EpkDjS7k7uGeacgjYy5YgVNtNdf-bQmg)
- **Graphite (Diamond)**: $52M Series B led by Accel (Mar 2025). Cursor agreed to acquire it Dec 19, 2025, reportedly well above its $290M valuation. — [Contrary Research](https://research.contrary.com/company/graphite); [Wikipedia](https://en.wikipedia.org/wiki/Cursor_(company))
- **Qodo**: $70M Series B (Mar 2026), $120M in total, positioned around "code verification" — [Qodo blog](https://www.qodo.ai/blog/qodo-70m-series-b-shift-to-artificial-wisdom/).
- **Others**: Cursor Bugbot (Jul 2025), Copilot code review, and Copilot coding agent's built-in first-pass self-review — [Wikipedia](https://en.wikipedia.org/wiki/Cursor_(company)); [SD Times](https://sdtimes.com/ai/github-unveils-agent-hq-the-next-evolution-of-its-platform-that-focuses-on-agent-based-development/).
- **Effectiveness gap.** A Harvard working paper found:
  - Firms using coding agents produced about 30% more code, but finished work did not measurably rise and time through review rose 49%.
  - AI generated only 23.3% of review comments.
  - Only 10.8% of PRs received even one AI comment.
  - Source: [ComplexDiscovery](https://complexdiscovery.com/harvard-researchers-find-ai-coding-agents-shifted-the-bottleneck-to-code-review/).

#### 4. Testing and verification (well-funded but thin; formal methods mostly at research stage)
- **Antithesis** (deterministic simulation testing), closed source: $105M at $525M led by Jane Street (dated Dec 2025 by Tracxn), about $182M raised in total, with about $10M recurring revenue reported — [Crypto Briefing](https://cryptobriefing.com/antithesis-raises-105m-525m-valuation/); [Tracxn](https://tracxn.com/d/companies/antithesis/__89ib7Vai5H2y7JisXhlf39ghxM55HZTugECLPgANtd0).
- **Meticulous** (frontend regression testing), closed source: $15M Series A led by Chemistry with Menlo (Jul or Oct 2026) — [Software Testing Magazine](https://www.softwaretestingmagazine.com/news/meticulous-ai-automated-frontend-testing-platform-raises-15-million/).
- **TestSprite**: about $6.7M seed (Oct 2025) — [codenote](https://codenote.net/en/posts/ai-software-testing-startups-2026/).
- **Tricentis** acquired Tabnine on Jul 30, 2026 to feed its Enterprise Context Engine into testing agents — [Tabnine blog](https://www.tabnine.com/blog/a-new-chapter-for-tabnine/); [ERP Today](https://erp.today/tricentis-acquires-tabnine-ai-testing-agents-enterprise-context/).
- **Formal verification:**
  - Axiom: $200M Series A at more than $1.6B led by Menlo (Mar 12, 2026), on top of a $64M seed (Oct 2025). It explicitly targets proving AI-generated code safe, using Lean. — [SiliconANGLE](https://siliconangle.com/2026/03/12/verifiable-ai-startup-axiom-raises-200m-prove-ai-generated-code-safe-use/); [Axiom](https://axiommath.ai/fundraising/)
  - Harmonic (Aristotle): $120M Series C at $1.45B, with Nvidia joining (Jan 2026) — [Axios](https://axios.com/2026/01/15/nvidia-harmonic-ai-math-accuracy).
  - Code Metal: reportedly a $125M Series B for legacy code translation with formal verification (single low-authority source) — [geo.sig.ai](https://geo.sig.ai/brands/code-metal.md).

#### 5. Spec-driven development (crowded with free frameworks, thin commercially)
- GitHub Spec Kit is the most-cited, with about 90k stars (Apr 2026) to about 115k (Jun 2026), both blog-reported. Kiro (AWS) is the full spec-driven IDE (requirements, design, tasks). BMAD-METHOD has about 45k stars. Tessl ($125M) treats the spec as the source of truth and is called "least proven". — [particula.tech](https://particula.tech/blog/spec-driven-development-tools-spec-kit-vs-kiro-vs-tessl); [codemyspec](https://codemyspec.com/blog/tessl-review); [ssojet](https://ssojet.com/blog/best-spec-driven-development-tools)
- One guide counts more than 30 spec-driven frameworks — [SoftwareSeni](https://www.softwareseni.com/the-30-plus-framework-landscape-navigating-spec-driven-development-options-in-2026). Another says every major tool (Spec Kit, Kiro, Claude Code, Cursor, OpenSpec, BMAD, Tessl, Antigravity) has shipped its own version — [codemyspec](https://codemyspec.com/blog/spec-driven-development).

#### 6. Codebase context, memory and knowledge (medium; becoming a feature)
- Tabnine's "Enterprise Context Engine" was bought by Tricentis (Jul 30, 2026). Its vendor-reported results: up to 2x accuracy and up to 80% fewer tokens. — [ERP Today](https://erp.today/tricentis-acquires-tabnine-ai-testing-agents-enterprise-context/)
- Qodo launched an expanded context engine in 2026 — [Wikipedia: Qodo](https://en.wikipedia.org/wiki/Qodo).
- Agent memory startups are small:
  - cognee: $7.5M seed (Feb 2026).
  - Supermemory: $3M, with a coding-agent plugin.
  - Unnamed memory startups raised Series A rounds of $20–60M in May 2026.
  - Source: [thetoolnerd](https://www.thetoolnerd.com/p/your-coding-agent-has-amnesia-the); [supermemory](https://supermemory.ai/blog/infinitely-running-stateful-coding-agents/).
- AGENTS.md is used in more than 60,000 OSS repos and is now governed by the Agentic AI Foundation (AAIF) — [DEV Community](https://dev.to/ialijr/top-ai-agent-standards-to-know-in-2026-31gm).
- 43% of engineering leaders cite insufficient agent context as a top quality and governance gap — [Qodo 2026 report](https://www.qodo.ai/blog/state-of-ai-code-quality-report-2026/).

#### 7. Agent infrastructure: sandboxes, protocols, observability and cost (sandboxes crowded; observability consolidating; cost management thin)
- **Sandboxes:**
  - E2B (open source): $21M Series A led by Insight (Jul 2025).
  - Daytona: $24M Series A led by FirstMark (date unconfirmed). One source says Daytona went closed source in Jun 2026; another still describes it as AGPL, so the sources conflict.
  - Modal: about $693M disclosed funding.
  - Other options include Vercel Sandbox, Cloudflare, Northflank and Blaxel.
  - Source: [blaxel](https://blaxel.ai/blog/e2b-alternatives-sandbox-environments); [aiworld](https://aiworld.eu/story/daytona-raises-24-million-to-build-next-gen-infrastructure-for-ai-agents); [StartupHub](https://www.startuphub.ai/startup-categories/agent-sandboxing); [techplained](https://www.techplained.com/best-ai-agent-sandboxes).
- **Protocols and standards:**
  - The Agentic AI Foundation was formed under the Linux Foundation on Dec 9, 2025, co-founded by Anthropic, OpenAI and Block, to hold MCP, AGENTS.md and Goose — [InfoQ](https://www.infoq.com/news/2025/12/agentic-ai-foundation).
  - Agent Skills became an open standard on Dec 18, 2025. Vercel's skills.sh is the most active skills registry, and the MCP registry reportedly had more than 9,400 entries by Apr 2026. — [DEV Community](https://dev.to/ialijr/top-ai-agent-standards-to-know-in-2026-31gm)
  - Arcade.dev acquired Smithery, an MCP registry (Aug 2026) — [SOTA](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **Observability and evals, consolidating:**
  - ClickHouse acquired Langfuse (Jan 2026).
  - ServiceNow acquired Traceloop (Mar 2026).
  - Palo Alto Networks acquired Portkey (closed May 29, 2026, $117M).
  - OpenAI acquired Promptfoo (Mar 2026).
  - Anthropic acquired Humanloop (Aug 2025).
  - Source: [SOTA deal list](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **Cost management:**
  - Braintrust ships a coding-agent insights dashboard showing cost and tokens by developer, model, tool and branch — [Braintrust](https://www.braintrust.dev/blog/coding-agent-insights). amux is an open-source token tracker — [amux](https://amux.io/guides/ai-coding-finops/).
  - The Linux Foundation launched a Tokenomics Foundation on Jun 9, 2026. 1Password added AI spend management on Jul 14, 2026. The FinOps Foundation reports 98% of organizations now manage AI spend. — [innobu](https://www.innobu.com/en/articles/ai-token-costs-finops-2026.html); [ajayk.sh](https://www.ajayk.sh/blog/finops-for-ai-token-costs-focus-2026/)
  - A 2026 study found an average coding-agent run used about 4.2M tokens and cost about $1.86 — [Fabrity](https://fabrity.com/blog/finops-for-ai-coding-agents-stop-counting-tokens-start-pricing-the-fix/).

#### 8. Code provenance, AI attribution and audit (thin; standards forming)
- **Agent Trace**: Cursor's open spec, v0.1.0-draft, status "Proposal", Jan 2026, licensed CC BY 4.0. It defines JSON trace records that tie line ranges to conversations and classify each range as human, AI, mixed or unknown. It explicitly does not cover legal ownership or training-data provenance. — [agent-trace.dev](https://agent-trace.dev/); [InfoQ](https://www.infoq.com/news/2026/02/agent-trace-cursor); [GitHub](https://github.com/cursor/agent-trace). Claimed backers (Cognition, Cloudflare, Vercel, Jules, Amp, OpenCode) are unverified — [morphllm](https://www.morphllm.com/agent-trace-spec).
- **git-ai**: open source. It records line-level attribution in Git Notes when agents call `git-ai checkpoint`, and survives rebase, squash and cherry-pick — [GitHub](https://github.com/git-ai-project/git-ai).
- **Entire**: Thomas Dohmke's post-GitHub startup. Its open-source Checkpoints CLI stores prompts, transcripts and reasoning alongside commits using shadow branches — [jd:/dev blog](https://julien.danjou.info/blog/github-wont-work-for-ai-agents/).
- **Semantica CLI**: local attribution via git hooks for Claude Code, Cursor, Gemini CLI, Copilot and Kiro — [pkg.go.dev](https://pkg.go.dev/github.com/semanticash/cli@v0.5.0).
- **Demand**: Only 45% of leaders have traceability linking AI activity to code changes, and developers trust peers' PRs less because authorship is unclear — [Qodo 2026 report](https://www.qodo.ai/blog/state-of-ai-code-quality-report-2026/).

#### 9. Security for AI-generated code and coding agents (thin; mostly closed source; incumbents moving in)
- **Corridor** ("Agentic Coding Security Management"): $25M Series A led by Felicis at $200M (Mar 18, 2026) — [Corridor blog](https://www.corridor.dev/blog/series-a). Cognition acquired it on Oct 28, 2026 to build "Devin Security" — [ChainCatcher](https://chaincatcher.com/en/article/2300176).
- **Socket**: $60M Series C at $1B led by Thrive (May 2026). Socket Firewall blocks malicious packages on developer machines, in agent sandboxes and in CI.
- **Endor Labs**: AURI (Mar 2026), a Skills plugin, MCP server and CLI for vulnerability detection inside coding agents. Its last disclosed round was $93M Series B (Apr 2025).
- **Snyk**: launched Agent Security / Agent Scan (Mar 2026) after acquiring Invariant Labs (maker of MCP-Scan). Its valuation is reportedly $3.6B, down from $7.4B (Sacra).
- Source for Socket, Endor and Snyk: [SiliconANGLE](https://siliconangle.com/?p=735736); [Snyk](https://snyk.io/news/snyk-launches-evo-agentic-development-security/); [Sacra](https://sacra.com/research/endor-labs-vs-snyk/); [Builtin](https://builtin.com/articles/endor-labs-secures-93m-20250424).
- **Lakera**: Check Point acquired it for about $201.8M (closed Oct 22, 2025) — [SOTA](https://sota.cc/guides/why-ai-startups-get-acquired/).

#### 10. Legacy modernization and migrations (fragmented, seed-stage, one OSS standard)
- **Moderne** (built on the OSS project OpenRewrite): $30M Series B (Feb 2025) — [TechCrunch](https://techcrunch.com/2025/02/11/moderne-raises-30m-to-solve-technical-debt-across-complex-codebases/).
- **Funding rounds in 2025–2026:**
  - CoreStory: $32M (Oct 2025).
  - Kodesage: $6.6M seed (Jun 2026).
  - Hypercubic (COBOL): $5.3M seed (Aug 2026).
  - DesignVerse: $5.5M (May 2026).
  - AppFactor: $4M (Feb 2026).
  - Source: [StartupHub](https://www.startuphub.ai/news/corestory-raises-32m-to-advance-ai-legacy-code-modernization); [SiliconANGLE](https://siliconangle.com/2026/06/04/startup-kodesage-secures-seed-funding-accelerate-premises-app-modernization-ai/); [SiliconANGLE](https://siliconangle.com/2026/08/18/hypercubic).
- **Others**: Morph (Modelcode) runs human-in-the-loop modernization, and AWS Transform covers Windows, VMware and custom code — [DEV Community](https://dev.to/axel_6225c422a7f5ddb4eb30/moderne-alternatives-the-best-code-modernization-platforms-in-2026-2pb3).

#### 11. Production debugging and AI SRE (well-funded, closed source)
- **Resolve AI**: $125M Series A at $1B (TechCrunch, Feb 4, 2026; first reported Dec 19, 2025) — [TechCrunch](https://techcrunch.com/2026/02/04/ai-sre-resolve-ai-confirms-125m-raise-unicorn-valuation/). A $40M extension at $1.5B (Apr 16, 2026) is reported by a secondary source — [beri.net](https://www.beri.net/article/resolve-ai-190m-ai-sre-production-incidents-2026).
- **Traversal**: $48M Series A led by Kleiner Perkins with Sequoia — [search summary of TechCrunch; see wetheflywheel comparison](https://wetheflywheel.com/en/comparisons/cleric-vs-resolve-ai-vs-traversal/).
- **Cleric**: about $4.3M–$9.8M in seed funding; the figures are inconsistent — [Clay](https://www.clay.com/dossier/cleric-funding).

#### 12. Developer understanding and "comprehension debt" (no product category)
- The term was popularized by Addy Osmani and covered by O'Reilly, Faros and TechRadar. It means code merged before any human can explain it. — [Addy Osmani](https://addyosmani.com/blog/comprehension-debt/); [O'Reilly Radar](https://www.oreilly.com/radar/comprehension-debt-the-hidden-cost-of-ai-generated-code/); [Faros](https://www.faros.ai/blog/comprehension-debt-in-software-engineering)
- An arXiv mixed-methods study found teams postponed understanding to keep delivery moving. Participants asked for review surfaces that summarize what generated changes mean. — [arXiv 2607.10856](https://arxiv.org/pdf/2607.10856)
- Mitigations discussed are practices, not products: "explanation gates" and using AI as a tutor — [O'Reilly](https://www.oreilly.com/radar/comprehension-debt-the-hidden-cost-of-ai-generated-code/). Tessl also writes about comprehension debt as a pattern — [Tessl](https://tessl.io/patterns/changing-roles/comprehension-debt/).

### Inferences
- The agent/IDE layer is now a frontier-lab and mega-cap game: Anthropic, OpenAI, Google, Meta, SpaceX/Cursor, Microsoft/GitHub, and Cognition at $26B+. Independent agent startups are being acquired (Continue, Kilo, Tabnine) or pivoting (Roo moving to cloud). A new entrant competing on "a better agent" faces the worst odds.
- Orchestration UIs are commoditizing. They are cheap to build, mostly open source, and absent from funding records. Two shut down in 2026 (Terragon, Bloop), and all three major platforms shipped native multi-agent managers.
- Code review has too many vendors relative to proven outcomes. The Harvard data shows review time rising even as AI reviewers spread, so "more AI comments" is not solving the bottleneck.

### Gaps
- No 2026 funding found for E2B, Runloop, Warp, Zed, JetBrains Junie/Air, Bolt (StackBlitz), v0/Vercel, Augment (confirmed), Sourcegraph, Mechanical Orchard, Swimm, Unblocked, Context7, DeepWiki, Ellipsis, Korbit, Sourcery, Diffblue, Datadog Bits AI SRE, incident.io AI, or Braintrust.
- Kiro's 2026 user and revenue numbers were not found.
- GitHub Universe 2026 announcements (late Oct 2026) were not yet recapped.
- Entire's funding amount was not confirmed in this session.

## Q2. Which categories are crowded, thin, or empty?

### Takeaway
- **Crowded:** agents and IDEs, app builders, code review vendors, parallel-agent UIs, spec-driven frameworks, sandboxes, and LLM observability.
- **Thin:** provenance and attribution, coding-agent security and permissions, verification and testing that proves correctness, coding-agent cost governance, legacy modernization, and AI SRE open source.
- **Empty (white space):**
  - Comprehension tooling.
  - Evidence and risk triage that actually shrinks human review load.
  - A policy and governance plane that works across agents.
  - Links between AI provenance and production incidents.
  - Merging and integrating the output of parallel agents.

### Cited Findings
- **Crowded: agents.**
  - Top 4 tools hold 77% share — [baeseokjae survey](https://baeseokjae.github.io/posts/ai-coding-market-share-adoption-2026/).
  - Recent valuations: Cursor $60B ([Wikipedia](https://en.wikipedia.org/wiki/Cursor_(company))), Cognition $26B ([KuCoin](https://www.kucoin.com/news/flash/cognition-ai-raises-1b-valuation-hits-26b-as-arr-surpasses-492m)), Lovable $13.3B and CodeRabbit $1.5B ([valueaddvc](https://valueaddvc.com/pulse/ai-coding-tools-valuation-data-2026)).
- **Crowded: spec-driven development.** More than 30 frameworks exist — [SoftwareSeni](https://www.softwareseni.com/the-30-plus-framework-landscape-navigating-spec-driven-development-options-in-2026).
- **Crowded: orchestration.** At least 9 tools, with 2 company shutdowns in 2026 — [Nimbalyst](https://nimbalyst.com/blog/best-agent-management-tools-2026/).
- **Crowded: sandboxes.** At least 6 named vendors — [techplained](https://www.techplained.com/best-ai-agent-sandboxes).
- **Thin: provenance.** Demand: only 45% of leaders have AI-to-code traceability — [Qodo](https://www.qodo.ai/blog/state-of-ai-code-quality-report-2026/). Supply is a draft v0.1 spec plus small open-source tools — [agent-trace.dev](https://agent-trace.dev/); [git-ai](https://github.com/git-ai-project/git-ai).
- **Thin: agent security.**
  - The only funded pure-play, Corridor, was acquired within about 7 months of its Series A — [Corridor](https://www.corridor.dev/blog/series-a); [ChainCatcher](https://chaincatcher.com/en/article/2300176).
  - Prompt-injection risk was named a top-2 pain point by 31% of respondents in a Q1 2026 survey. UNVERIFIED: this surfaced in a search summary of 2026 pain-point articles, the original survey was not identified, and the nearest result was [qa.tech](https://qa.tech/blog/code-review-bottleneck-ai-generated-code).
- **Thin: verification.**
  - The bottleneck has moved to review and verification. Faros measured 98% more PRs but 91% longer review times — [Developers Digest](https://www.developersdigest.tech/blog/ai-code-review-bottleneck).
  - Antithesis has only about $10M ARR despite $182M raised — [Crypto Briefing](https://cryptobriefing.com/antithesis-raises-105m-525m-valuation/).
  - Formal-verification capital, Axiom ($200M) and Harmonic ($120M), is mostly aimed at math so far — [SiliconANGLE](https://siliconangle.com/2026/03/12/verifiable-ai-startup-axiom-raises-200m-prove-ai-generated-code-safe-use/); [Axios](https://axios.com/2026/01/15/nvidia-harmonic-ai-math-accuracy).
- **Thin: cost governance.** Token-cost volatility was the top pain point (42%) in a Q1 2026 survey (UNVERIFIED: the original survey was not identified). Coding-specific tooling is limited to Braintrust's dashboard and the open-source amux. — [Braintrust](https://www.braintrust.dev/blog/coding-agent-insights); [amux](https://amux.io/guides/ai-coding-finops/)
- **Empty: comprehension.** The problem is widely named, but only practices are proposed — [arXiv 2607.10856](https://arxiv.org/pdf/2607.10856); [O'Reilly](https://www.oreilly.com/radar/comprehension-debt-the-hidden-cost-of-ai-generated-code/).
- **Empty: standards enforcement across agents.**
  - Only 35% of developers say agents always follow org standards.
  - Fewer than half of leaders have centralized AI coding standards.
  - Only 3.7% say their processes are sufficient.
  - Source: [Qodo 2026 report](https://www.qodo.ai/blog/state-of-ai-code-quality-report-2026/).
- **Empty: incident-to-AI-change linkage.** 89% of organizations report an AI-related production incident — [Qodo 2026 report](https://www.qodo.ai/blog/state-of-ai-code-quality-report-2026/).

### Inferences
- The highest-signal white space sits where demand data is strong (the Qodo, Harvard and Faros numbers) and supply is either missing or acquired early. Corridor's quick exit suggests agent security is valued by acquirers but under-supplied as an independent open option.
- The "verification gap" is the crux. Generation is cheap; proving a change is correct and getting a human to accept it is not. Tools that produce evidence (executed tests, traces, screenshots, formal proofs) and compress review, rather than adding more review comments, form a thin category with strong demand.

### Gaps
- No quantitative market sizing exists per sub-category. The aggregate market estimate ranges from $5.4B to $12.8B for 2026 — [idealogic](https://idealogic.io/blog/ai-coding-tools).

## Q3. Which categories have no strong open-source option?

### Takeaway
Strong open source exists for agents, orchestration UIs, spec frameworks, sandboxes (E2B), attribution (git-ai, Agent Trace, Entire Checkpoints) and codemods (OpenRewrite). Open source is weak or missing in five areas: deep-verification testing, AI SRE, agent security and permission firewalls (the leading open-source scanner was acquired), cost governance (only amux), and comprehension.

### Cited Findings
- **Strong open-source options:**
  - Agents: opencode, OpenHands and Cline at tens of thousands to 200k stars — [openalternative](https://openalternative.co/blog/best-open-source-ai-coding-agents).
  - Orchestration: Claude Squad, Nimbalyst, Superset, Vibe Kanban, Mux — [Nimbalyst](https://nimbalyst.com/blog/best-agent-management-tools-2026/).
  - Spec-driven development: Spec Kit and BMAD — [particula.tech](https://particula.tech/blog/spec-driven-development-tools-spec-kit-vs-kiro-vs-tessl).
  - Attribution: git-ai and Agent Trace (CC BY 4.0) — [git-ai](https://github.com/git-ai-project/git-ai); [agent-trace.dev](https://agent-trace.dev/).
  - Codemods: OpenRewrite — [TechCrunch](https://techcrunch.com/2025/02/11/moderne-raises-30m-to-solve-technical-debt-across-complex-codebases/).
- **Open-source options weakening:**
  - Continue's product was shut down after Cursor acquired it (code stays Apache-2.0) — [continue.dev](https://continue.dev/).
  - Roo Code was archived — [vibecodehq](https://vibecodehq.pages.dev/blog/roo-code-shuts-down-roomote-cloud-agent-may-2026).
  - Vibe Kanban lost its company — [Nimbalyst](https://nimbalyst.com/blog/best-agent-management-tools-2026/).
  - Daytona reportedly went closed source in Jun 2026 (conflicting reports) — [blaxel](https://blaxel.ai/blog/e2b-alternatives-sandbox-environments).
- **Agent security, closed and consolidating:**
  - MCP-Scan's maker, Invariant, is now part of Snyk (Snyk Agent Scan) — [guptadeepak](https://guptadeepak.com/agent-security/vendor/invariant-labs/); [Snyk](https://snyk.io/news/snyk-launches-evo-agentic-development-security/).
  - Corridor is closed source and now part of Cognition — [ChainCatcher](https://chaincatcher.com/en/article/2300176).
- **Testing and verification, closed:** Antithesis, Meticulous and Qodo's commercial products — [Crypto Briefing](https://cryptobriefing.com/antithesis-raises-105m-525m-valuation/); [Software Testing Magazine](https://www.softwaretestingmagazine.com/news/meticulous-ai-automated-frontend-testing-platform-raises-15-million/).
- **AI SRE, closed:** Resolve AI, Traversal and Cleric are all proprietary SaaS — [wetheflywheel](https://wetheflywheel.com/en/comparisons/cleric-vs-resolve-ai-vs-traversal/).

### Inferences
- An open-source, vendor-neutral "agent firewall / permission and policy layer" for coding agents is the clearest gap where no open-source option exists. It would sit between Claude Code, Codex, Cursor, Devin and the rest, and cover prompt injection, MCP/skill vetting, secrets and network egress.
- Open-source AI SRE and open-source verification harnesses (property-based or simulation tests generated and run by agents) look under-served compared with the open-source agent ecosystem.

### Gaps
- Not verified in this session: whether open-source AI SRE projects or open-source PR-review agents have meaningful traction in 2026. No sources were retrieved, so they are not listed above.

## Q4. Which problems do developers describe as painful but have no product category?

### Takeaway
Six problems recur without a dedicated product category:
- Comprehension debt.
- Review overload that AI reviewers have not reduced.
- Agents ignoring org standards, with no cross-agent enforcement.
- Not knowing which change, prompt or agent caused an incident.
- Juggling and merging many parallel agents' work ("the operator becomes the bottleneck").
- Unpredictable token spend.

### Cited Findings
- Reviewing and validating AI code is the #1 delivery constraint (26% of developers and of leaders). 36% say AI code review needs more mental effort. Only 35% say agents always follow standards. 89% of organizations have had an AI-related production incident. Only 3.7% of leaders say their processes are sufficient. (Survey of 500 developers and 300 leaders, published Sep 23, 2026.) — [Qodo 2026 State of AI Code Quality](https://www.qodo.ai/blog/state-of-ai-code-quality-report-2026/)
- Harvard paper: 30% more code, no measurable rise in finished work, and 49% longer time through review. Only 10.8% of PRs got any AI review comment. — [ComplexDiscovery](https://complexdiscovery.com/harvard-researchers-find-ai-coding-agents-shifted-the-bottleneck-to-code-review/)
- Faros telemetry: 21% more tasks completed and 98% more PRs, but review time rose 91% with no gain in delivery velocity — [Developers Digest](https://www.developersdigest.tech/blog/ai-code-review-bottleneck).
- Comprehension debt: code is accepted before developers can explain, modify or maintain it. Participants asked for review surfaces that summarize what changes mean. — [arXiv 2607.10856](https://arxiv.org/pdf/2607.10856)
  - An Anthropic study reportedly found about 17% lower comprehension under passive delegation (secondary citation) — [TechRadar](https://www.techradar.com/pro/the-rise-of-comprehension-debt-in-the-age-of-ai-coding).
- Parallel-agent management: users need to know which agent is blocked, which changed the wrong file, and which branch is safe to merge — [Nimbalyst](https://nimbalyst.com/blog/best-agent-management-tools-2026/).
- Q1 2026 survey: token cost volatility (42%) and prompt-injection risk (31%) overtook model reliability as the top pain points. UNVERIFIED: the original survey was not identified; it surfaced alongside [qa.tech](https://qa.tech/blog/code-review-bottleneck-ai-generated-code).
- Trust: developers trust peers' PRs less because authorship is unclear — [Qodo](https://www.qodo.ai/blog/state-of-ai-code-quality-report-2026/).

### Inferences
Candidate empty categories, ranked by strength of evidence:
1. **"Change-understanding" and comprehension tooling.** Tools that explain intent, risk and behavior change of an AI-generated PR and check that the human understood it (for example an explanation gate or a quiz). Strong evidence (arXiv, O'Reilly, Osmani, Faros) and no vendors.
2. **Review compression and merge-readiness evidence.** Tools that triage which AI PRs need deep human review, with executed proof attached. Current AI reviewers add comments but do not reduce review time (Harvard, Faros).
3. **Cross-agent policy and standards control plane.** A single place to define rules, permissions and security policy that applies across Claude Code, Codex, Cursor, Copilot and Devin (Qodo: 35% standards adherence, 3.7% satisfied). Partial overlap with Corridor (now Cognition-owned) and Agent HQ governance.
4. **AI-change incident forensics.** Joining provenance data (Agent Trace or git-ai records) to SRE incident tooling to answer which prompt or agent session caused an outage (89% incident rate; only 45% traceability).
5. **Parallel-agent integration and merge-conflict resolution.** Current orchestrators isolate agents in worktrees but leave integration to the human.

### Gaps
- Hacker News threads were not systematically mined. Pain-point evidence relies on vendor-published surveys (Qodo sells review tools, Faros sells engineering analytics) and one academic paper, so bias toward "review is the bottleneck" is possible.

## Q5. Notable acquisitions and shutdowns, 2025–2026

### Takeaway
2025–2026 saw the largest dev-tool deal ever (SpaceX buying Cursor for $60B). Frontier labs bought developer infrastructure (Anthropic: Bun and Stainless; OpenAI: Astral, Promptfoo and Ona). Independent open-source agents and orchestrators were absorbed, and LLM-observability vendors were rapidly bought up.

### Cited Findings
- **Jul 14, 2025:** Cognition completed its acquisition of Windsurf — [Mergr](https://mergr.com/transaction/cognition-acquires-windsurf).
- **Jul 18, 2025:** Cursor acqui-hired Koala's team — [Wikipedia](https://en.wikipedia.org/wiki/Cursor_(company)).
- **Aug 2025:** Anthropic acquired Humanloop; the platform was sunset Sep 8, 2025 — [SOTA](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **Oct 22, 2025:** Check Point closed its acquisition of Lakera (about $201.8M) — [SOTA](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **Late 2025:** Supermaven's standalone product was sunset after Cursor's acquisition — [WebProNews](https://www.webpronews.com/supermavens-sudden-sunset-ai-coding-star-fades-into-cursors-orbit).
- **Dec 2025:** Anthropic acquired Bun — [TechCrunch via search](https://techcrunch.com/2026/05/18/anthropic-has-acquired-the-dev-tools-startup-used-by-openai-google-and-cloudflare/).
- **Dec 2025:** Amp spun out of Sourcegraph — [Ry Walker](https://rywalker.com/research/amp-sourcegraph).
- **Dec 19, 2025:** Cursor agreed to acquire Graphite — [Wikipedia](https://en.wikipedia.org/wiki/Cursor_(company)).
- **Jan 2026:** ClickHouse acquired Langfuse — [SOTA](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **Feb 9, 2026:** Terragon shut down — [DEV Community](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8).
- **Mar 2026:** OpenAI acquired Promptfoo, and ServiceNow acquired Traceloop — [SOTA](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **Mar 2026:** OpenAI's acquisition of Astral is reported — [aifundingtracker](https://aifundingtracker.com/openai-biggest-acquisitions/); [TechCrunch](https://techcrunch.com/2026/05/18/anthropic-has-acquired-the-dev-tools-startup-used-by-openai-google-and-cloudflare/).
- **Mar 2026:** Anthropic reportedly acquired Vercept; the framing is inconsistent across sources — [search result](https://forntend-test-5sqwmq-3a22a9-107-172-80-230.traefik.me/anthropic-bolsters-ai-ambitions-with-vercept-acquisition-1772079763571).
- **Apr 10, 2026:** Bloop (maker of Vibe Kanban) shut down — [Nimbalyst](https://nimbalyst.com/blog/best-agent-management-tools-2026/).
- **May 15, 2026:** Roo Code ended its VS Code extension and pivoted to Roomote — [vibecodehq](https://vibecodehq.pages.dev/blog/roo-code-shuts-down-roomote-cloud-agent-may-2026).
- **May 18, 2026:** Anthropic acquired Stainless (SDK and MCP generators; reportedly more than $300M). Hosted Stainless products are winding down. — [TechCrunch](https://techcrunch.com/2026/05/18/anthropic-has-acquired-the-dev-tools-startup-used-by-openai-google-and-cloudflare/)
- **May 29, 2026:** Palo Alto Networks closed its acquisition of Portkey ($117M) — [SOTA](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **Jun 2026:** Cursor acquired Continue and shut the product down — [DEV Community](https://dev.to/leobaniak/cursor-acquires-continue-and-gives-its-users-a-july-15-export-deadline-5dkn).
- **Jun 18, 2026:** Google retired Gemini CLI and the Code Assist extensions for consumers, moving them into Antigravity CLI — [Virtualization Review](https://virtualizationreview.com/articles/2026/05/19/google-moves-gemini-cli-into-antigravity-cli-as-agent-platform-expands.aspx).
- **Jul 15, 2026:** Anaconda acquired Kilo Code — [Anaconda](https://www.anaconda.com/blog/anaconda-acquires-kilo-code).
- **Jul 30, 2026:** Tricentis acquired Tabnine — [Tabnine](https://www.tabnine.com/blog/a-new-chapter-for-tabnine/).
- **Aug 10, 2026:** OpenAI closed its acquisition of Ona (Gitpod) — [SOTA](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **Aug 14, 2026:** SpaceX closed its $60B all-stock acquisition of Cursor (Anysphere) — [Wikipedia citing SEC 8-K](https://en.wikipedia.org/wiki/Cursor_(company)).
- **Aug 2026:** Arcade.dev acquired Smithery — [SOTA](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **Sep 2026:** Harvey acquired Guardrails AI — [SOTA](https://sota.cc/guides/why-ai-startups-get-acquired/).
- **Oct 28, 2026:** Cognition acquired Corridor (AI coding security) — [ChainCatcher](https://chaincatcher.com/en/article/2300176).
- **Undated:** Cognition announced the acquisition of Interaction (maker of Poke) — [traeai](https://www.traeai.com/articles/05c6cd40-ef9c-4653-8185-7d91a77df1e3).

### Inferences
- Acquirers are buying three things: distribution (Cursor buying Continue and Graphite, Anaconda buying Kilo), developer infrastructure for lock-in (Anthropic buying Bun and Stainless, OpenAI buying Astral and Ona), and trust and security layers (Cognition buying Corridor, Check Point buying Lakera, Snyk buying Invariant). Trust and security buyers are paying early, at Series A, which signals that the category is strategically valued and thinly supplied.
- Open-source coding tools are being acquired and then closed or narrowed (Continue, Supermaven). That leaves community forks without corporate maintainers, an opening for well-governed open-source foundations or commercial open source.

### Gaps
- Exact prices are undisclosed for most deals: Graphite, Continue, Kilo, Tabnine, Ona, Langfuse and Corridor.
- The Anthropic acquisition count conflicts across sources (3 vs. 5).
- Kiro, Bolt, Zed and Warp had no acquisition or shutdown news found.
