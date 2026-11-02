# Hidden Systemic Problems the AI-Coding Shift Creates or Worsens (as of 2026-10-31)

Scope note: each area below breaks down Key Question 1 (scale, who is affected, trend, who is working on it and how well). The last section answers Key Question 2 (weakest solution relative to size) with a ranking. Every item is dated. Source quality is flagged where it is weak: vendor blogs, aggregators, or single-source claims.

---

## Area 1 — Lost intent and decision provenance (the "why" is discarded)

### Takeaway
More and more code is written by agents, but the prompt, the discussion, the rejected options and the constraints behind it are thrown away. Git, PRs and commit messages have no standard place to keep them. By late 2025, roughly 16–23% of active GitHub projects showed coding-agent use, and Google says 75% of its new code is AI-generated. The fixes are an RFC-stage spec (Agent Trace v0.1.0, Jan 2026) and a few early startups and CLIs (Entire, git-ai, Chainloop, GrayCode Trace). None is git-native or standard, and none survives rebase or squash reliably.

### Cited Findings
**Scale**
- (Jan 26, 2026) The paper "Agentic Much? Adoption of Coding Agents on GitHub" (Robbes, Matricon, Degueule, Hora, Zacchiroli) studied 129,134 active non-fork GitHub projects (Jan 1–Oct 31, 2025). It estimates coding-agent adoption at 15.85% (conservative) to 22.60% (high) by fall 2025, for a technology that emerged in 2024–spring 2025. Heuristics cover 48 coding agents — [arXiv 2601.18341](https://arxiv.org/html/2601.18341v1)
- (Jan 2026, same paper) Attribution is unreliable. Only about 54% of projects with agent config files also show commit-level traces. Agents follow trailer conventions inconsistently, users can turn traces off, squash merges mix AI and human work, and unmarked commits default to "human". Among adopters, 24.17% of projects have at least one in five commits flagged as AI-assisted, which the authors call an undercount — [arXiv 2601.18341](https://arxiv.org/html/2601.18341v1)
- (Apr 2026) Google says 75% of its new code is now AI-generated and then reviewed by engineers. That is up from 25% (Oct 2024) and 50% (fall 2025). The metric's definition has reportedly changed several times — [The Decoder](https://the-decoder.com/google-says-75-percent-of-its-new-code-is-now-written-by-ai/); [TechSpot](https://www.techspot.com/news/112152-google-ai-now-generates-75-new-code-up.html)
- (Sep 2026, secondary compilation) An Anthropic spokesperson put the company-wide share of AI-written code at 70–90%. All such figures are self-reported and defined differently from company to company — [Digital Applied compilation](https://www.digitalapplied.com/blog/ai-share-of-own-work-tech-companies-disclosed-figures)
- (Oct 2025) GitHub Octoverse 2025 reports 43.2M PRs merged per month on average (+23% YoY). Coding agents created 1M+ PRs in the six months before the report — [It's FOSS summary of Octoverse 2025](https://itsfoss.com/github-octoverse-2025/); [GitHub on Product Hunt](https://www.producthunt.com/p/github/the-state-of-open-source-2025-key-takeaways)
- (Oct 2026) In a Linux Foundation survey of 234 OSS contributors and maintainers, only about 3 in 10 always disclose AI assistance in contributions and about 2 in 10 never do. Also, 80% say knowing the source model and its training-data lineage matters (44% extremely, 37% moderately) — [Linux Foundation, "Navigating OSS Development in the GenAI Era" (Boysel & Lai, Oct 2026)](https://www.linuxfoundation.org/hubfs/Research%20Reports/Navigating-Open-Source-Software-Development-in-the-Generative-AI-Era.pdf?hsLang=en)

**Conceptual framing (the problem now has a name)**
- (Mar 23–27, 2026) Margaret-Anne Storey's "From Technical Debt to Cognitive and Intent Debt" proposes a "Triple Debt Model": technical debt in code, cognitive debt in people, and intent debt in externalized knowledge. Intent debt is the missing record of goals, constraints and rationale that both humans and AI need. The paper argues AI may reduce technical debt while speeding up cognitive and intent debt. It is a synthesis paper with no new experiment — [arXiv 2603.22106](https://arxiv.org/abs/2603.22106); [Atono commentary](https://atono.substack.com/p/intent-debt-the-category-has-a-name)
- (Mar 2026) Addy Osmani on "comprehension debt": velocity, DORA metrics, PR counts and coverage can all look healthy while understanding erodes — [addyosmani.com](https://addyosmani.com/blog/comprehension-debt/)

**Who is working on it**
- (Jan 2026) Agent Trace v0.1.0 is an RFC published from the `cursor/agent-trace` repo under CC BY 4.0. Partners: Amp, Amplitude, Cline, Cloudflare, Cognition, git-ai, Jules, OpenCode, Tapes, Vercel. It records line-range attribution (human, ai, mixed, unknown), the model ID, and a URL to the conversation. It **does not** say where traces are stored ("local files, git notes, or a database"). It **does not** store the transcript itself, only a link. Rebases and merge commits are left as open questions. Non-goals: ownership or copyright, training-data provenance, quality — [agent-trace.dev](https://agent-trace.dev/); [open issue on history rewrites](https://github.com/cursor/agent-trace/issues/18)
- (Feb 2026) Former GitHub CEO Thomas Dohmke's startup Entire raised a $60M seed at a $300M valuation, which Felicis calls the largest seed ever for a dev-tool startup. Its first product, Checkpoints, is an open-source CLI. On each agent commit it writes a structured checkpoint (full transcript, prompts, changed files) tied to the commit SHA. It integrates with Claude Code and Gemini CLI. The roadmap includes a "semantic reasoning layer for multi-agent coordination" — [GeekWire](https://geekwire.com/2026/former-github-ceos-startup-entire-unveils-its-answer-to-the-crush-of-ai-coding-agents); [RCP Mag](https://rcpmag.com/articles/2026/02/12/ex-github-ceo-thomas-dohmke-unveils-entire.aspx); [VKTR](https://www.vktr.com/ai-platforms/ex-github-ceo-backs-a-new-kind-of-dev-platform-for-human-agent-collaboration/)
- (2026) Chainloop records AI coding-agent sessions as attestation evidence and adds a `Chainloop-Trace-Sessions` commit trailer. GrayCode's "Trace" does git-native session capture. Several small projects store Agent Trace JSON in `refs/notes/agent-trace` — [Chainloop trace package](https://pkg.go.dev/github.com/chainloop-dev/chainloop@v1.124.0/app/cli/internal/trace); [graycodeai/trace](https://github.com/graycodeai/trace); [example notes-ref implementation issue](https://github.com/ChristianPresley/zigguro/issues/747)
- (2026) Project issues link provenance to EU AI Act deployer documentation: "which shipped code was AI-generated, by which model, with what human review?" This comes from an internal planning issue, not a legal source — [currentbits/solenta #374](https://github.com/currentbits/solenta/issues/374)

### Inferences
- This is the clearest "hiding in plain sight" problem. Git was built to record *what* changed. Agents now produce most of the *why* in a chat window that is thrown away when the session ends. The share of affected code is rising fast: Google went from 25% to 75% in about 18 months.
- The current fixes cover **attribution** (who or what wrote this line), not **intent** (why this design, which alternatives were rejected, which constraint ruled). Agent Trace leaves the transcript out of scope. Entire stores raw transcripts, but raw transcripts are noisy, can hold secrets, and are hard to query. No shared schema yet exists for distilled decision records.
- History rewrites (rebase, squash, cherry-pick) break every approach seen here. This is a hard technical problem, not a matter of adoption.
- The damage compounds over time. Today's agent-written code becomes tomorrow's legacy code with no rationale attached: the COBOL knowledge-loss problem again, but faster (see Area 5).

### Gaps
- No quantitative study found measuring how often teams lose time because rationale is missing (e.g., time spent reverse-engineering why AI-written code exists).
- Adoption numbers for Entire Checkpoints, git-ai, or Agent Trace (repos or users) were not found.
- No GitHub or GitLab native feature for storing intent and transcripts with PRs was confirmed as of Oct 2026.

---

## Area 2 — Open-source sustainability under AI (review flood, crawler load, broken business models, thin maintainer base)

### Takeaway
AI has raised both the volume of OSS contributions and the cost of reviewing them. The best 2026 primary data (Linux Foundation, Oct 2026) puts about 25% of incoming PRs at "AI slop" (31% for large projects), and burnout is the top concern on large projects. Separately, AI crawlers drive up hosting costs, and AI answers are eroding the docs-traffic business models that fund OSS (Tailwind: revenue down ~80%, Jan 2026). The responses so far are blunt (turn off PRs, cap PRs, proof-of-work walls, one-off sponsorships).

### Cited Findings
**Contribution flood and review burden**
- (Oct 2026; survey Apr–Jun 2026 per secondary coverage) Linux Foundation / GenAI Commons survey of 234 OSS contributors and maintainers:
  - 59% of maintainers see contribution volume rising because of AI (69% in large projects with more than 50 contributors); only 4% see a decrease.
  - On average 25% of incoming PRs are estimated to be "AI slop" (31% large, 23% small, 20% medium; co-maintainers 29%).
  - 64% of large-project maintainers report longer review times (46% small, 55% medium).
  - Burnout is the #1 concern for large projects (63%), ahead of contribution quality (60%).
  - Only 35% of projects have a formal policy permitting AI contributions; 32% have none and none planned; 10% prohibit; 23% plan to add one.
  - Policies focus on disclosure (76%) and contributor responsibility (76%); only 39% address licensing or copyright.
  - 26% have no verification mechanism at all.
  - 53% disagree that AI has improved community trust (13% agree).
  - 46% say AI *increases* the need for mentorship (32% say it decreases).
  — [Linux Foundation report (Oct 2026)](https://www.linuxfoundation.org/hubfs/Research%20Reports/Navigating-Open-Source-Software-Development-in-the-Generative-AI-Era.pdf?hsLang=en)
- (Jul 14, 2025) Daniel Stenberg: about 20% of curl security submissions in 2025 were AI slop, at about two security reports per week — [The Register](https://www.theregister.com/2025/07/15/curl_creator_mulls_nixing_bug/); [Stenberg, "Death by a thousand slops"](https://daniel.haxx.se/blog/2025/07/14/)
- (Jan 2026) curl ended its HackerOne bug bounty effective Jan 31, 2026, to remove the incentive for AI-fabricated reports — [The Register](https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/); [BleepingComputer](https://bleepingcomputer.com/news/security/curl-ending-bug-bounty-program-after-flood-of-ai-slop-reports/)
- (Apr 2, 2026) **Counter-signal:** Stenberg posted that curl had "stopped getting AI slop security reports" and now got "an ever-increasing amount of really good security reports, almost all done with the help of AI" (quoted in the LF report). The burden is moving from junk to a high volume of *valid* AI-found bugs, which still needs maintainer time to fix — [LF report citing Stenberg LinkedIn post](https://www.linuxfoundation.org/hubfs/Research%20Reports/Navigating-Open-Source-Software-Development-in-the-Generative-AI-Era.pdf?hsLang=en)
- (Unverified, Jul 2026) A blog claims curl stopped reading bug reports from Jul 1, 2026, and that HackerOne's Internet Bug Bounty paused submissions on Mar 27, 2026. I found no corroboration — [Pinggy blog](https://pinggy.io/amp/blog/curl_ai_slop_summer_of_bliss/)
- (Jan 2026) tldraw automatically closed all external PRs, citing AI-generated PRs with incomplete context and little follow-up. Ghostty (Mitchell Hashimoto) restricted AI-assisted PRs to accepted issues and later (reported Jun 2026) moved to a vouch or invite system. Ladybird and Codex also reportedly stopped accepting external PRs — [AlternativeTo](https://alternativeto.net/news/2026/1/tldraw-pauses-external-contributions-citing-rise-in-low-quality-ai-code-and-pull-requests); [CodeNote roundup (single source)](https://codenote.net/en/posts/oss-external-pr-shutdown-2026/); [Continue blog, "We're Losing Open Contribution"](https://blog.continue.dev/were-losing-open-contribution)
- (Feb 2026, then Aug 2026) GitHub added repository settings to turn off PRs or limit them to collaborators (Feb 2026). It later added caps on concurrent open PRs from users without write access (reported Aug 27, 2026). Dates come from secondary coverage — [GitHub community discussion #187038](https://github.com/orgs/community/discussions/187038); [InfoWorld](https://www.infoworld.com/article/4127156/github-eyes-restrictions-on-pull-requests-to-rein-in-ai-based-code-deluge-on-maintainers.html); [CodeRabbit blog](https://www.coderabbit.ai/blog/github-gives-maintainers-a-throttle-for-the-ai-pull-request)

**AI crawlers hammering OSS infrastructure**
- (Apr 1–2, 2025) The Wikimedia Foundation reported that multimedia bandwidth rose 50% from January 2024, mostly from AI-training scrapers. It summed up its position as "Our content is free, our infrastructure is not" — [TechCrunch](https://techcrunch.com/2025/04/02/ai-crawlers-cause-wikimedia-commons-bandwidth-demands-to-surge-50); [The Register](https://www.theregister.com/2025/04/03/wikimedia_foundation_bemoans_bot_bandwidth/)
- (2025) SourceHut had outages from crawlers that ignored robots.txt and hit git log and commit endpoints from rotating IPs. KDE's GitLab was briefly knocked offline (traffic from Alibaba IP ranges). GNOME deployed Anubis — [404 Media](https://www.404media.co/the-open-source-software-saving-the-internet-from-ai-bot-scrapers/)
- (2025) Some OSS projects reported up to 97% of their traffic coming from AI bots. This traces back to a single LibreNews report — [Pipedot](https://pipedot.org/6W626)
- (Feb 18, 2026) Anubis (MIT-licensed proof-of-work reverse proxy) v1.25.0 shipped and is packaged across Linux distributions. Its defaults can also block legitimate search crawlers — [EveryDev listing](https://www.everydev.ai/tools/anubis)

**Business-model erosion**
- (Jan 6–8, 2026) Tailwind Labs laid off 75% of its engineers (3 of 4). Adam Wathan said revenue had fallen about 80% and docs traffic about 40% since early 2023, while the framework still gets about 75M downloads a month. He rejected a PR to make the docs more LLM-friendly because it would speed up the traffic loss. Vercel, Gumroad, Google AI Studio, Lovable and Macroscope then pledged sponsorships — [DevClass](https://www.devclass.com/2026/01/08/tailwind-labs-lays-off-75-percent-of-its-engineers-thanks-to-brutal-impact-of-ai/); [Neowin](https://www.neowin.net/news/tailwind-lays-off-75-employees-as-ai-kills-majority-of-its-revenue/); [PPC Land on sponsors](https://ppc.land/tech-giants-rush-to-sponsor-tailwind-css-after-devastating-layoffs/)

**Thin maintainer base**
- (2024 Tidelift data, widely re-cited in 2025–26) About 60% of maintainers are unpaid and about 60% have quit or considered quitting; 44% cite burnout. Another write-up says 46% are unpaid, so the figures conflict — [SonarSource summary](https://www.sonarsource.com/resources/library/open-source-maintainers/); [TFIR](https://tfir.io/almost-half-of-open-source-maintainers-are-unpaid-volunteers-survey/); conflicting figure: [TechNewsDay](https://technewsday.com/staging/?p=6402)
- (Jan 2026, vendor press release) Tea.xyz says nearly half of npm packages with more than 1M monthly downloads are still maintained by a single person — [Cointelegraph press release](https://cointelegraph.com/press-releases/tea-xyz-flags-critical-open-source-supply-chain-risks-in-2026)
- (Q2 2026, vendor audit, shifting method) Getcommit says 47% of weekly npm traffic among the top 100 packages (about 7.2B downloads a week) goes through packages with one maintainer — [Getcommit Q2 2026](https://getcommit.dev/blog/npm-trust-q2-2026)
- (Jan 28, 2026) Sonatype counted 9.8 trillion downloads across Maven Central, PyPI, npm and NuGet in 2025. That is the demand side resting on this maintainer base — [Sonatype press release](https://www.sonatype.com/press-releases/sonatype-research-reveals-open-malware-grows-75-percent)

### Inferences
- The structural problem is that **generation costs almost nothing while review is still human, scarce, unpaid and limited**. AI raised the input rate and left review capacity where it was. GitHub's controls throttle the input; they do not add review capacity.
- AI is breaking OSS's informal funding channels three ways: (a) docs traffic drives conversion to paid products (Tailwind), (b) bug-bounty economics (curl), (c) contributor-to-maintainer pipelines (tldraw and Ghostty closing the doors that turned drive-by contributors into maintainers). Ad hoc sponsorships after a public crisis do not fix this systematically.
- The good news (curl getting valid AI-found bugs) can make things worse at critical one- or two-maintainer projects: more real vulnerabilities to fix, with no more people to fix them.
- Policy is fragmented: 35% permit, 10% ban, 32% have nothing. Contributors face many different disclosure rules, which ties back to the missing provenance standard in Area 1.

### Gaps
- No ecosystem-wide 2026 dataset found on AI-crawler share of traffic at package registries (npm, PyPI, crates.io) or forges; the evidence comes from individual sites.
- No primary 2025/2026 Tidelift numbers were confirmed; most figures are the 2024 survey.
- No peer-reviewed count of critical packages with 1–2 maintainers for 2025–26 was found (the "52% of critical libraries" figure circulating online has no traceable source and was left out).
- Whether tldraw reopened external PRs could not be confirmed.

---

## Area 3 — Software supply chain + AI (slopsquatting, autonomous installs, MCP, worms)

### Takeaway
Open-source malware is rising fast. Sonatype has logged about 1.96M malicious packages cumulatively by Q3 2026, with 454.6k new in 2025 (+75% YoY). Attacks now target developer and CI credentials, and the ones in the news are worms (Shai-Hulud in Sep 2025, Mini Shai-Hulud in Aug 2026). AI adds new vectors: hallucinated package names that agents install without a human seeing them, poisoned agent "skills" and MCP servers, an AI agent registering and publishing a malicious package (Sonatype, Q3 2026), and "protestware" aimed at AI reviewers. Vendors like Sonatype, Socket, Aikido and Snyk are well funded, so tooling exists. Agent-specific controls (allowlists for what agents install) are new and seldom used.

### Cited Findings
- (Jan 28, 2026) Sonatype 2026 State of the Software Supply Chain: 454,600+ new malicious packages in 2025 (+75% YoY) and about 1.23M cumulative across npm, PyPI, Maven Central, NuGet and Hugging Face. The report says AI can introduce supply-chain risk "at the point of creation" — [Sonatype press release](https://www.sonatype.com/press-releases/sonatype-research-reveals-open-malware-grows-75-percent); [Infosecurity Magazine](https://www.infosecurity-magazine.com/news/454000-malicious-open-source/)
- (Oct 8, 2026) Sonatype Q3 2026 Malware Index:
  - 149,329 malicious packages in Q3; 1,960,846 cumulative since 2017; npm was 89.5% of the quarter.
  - 4,150 hijacks, 88% built to steal secrets or drop payloads; droppers plus secrets exfiltration made up 68.1% of overt malware.
  - Mini Shai-Hulud (Aug 2026): 2,225 affected versions, harvesting developer and CI/CD credentials to republish into other packages.
  - mlflow-ui (PyPI): per Sonatype, an AI agent ("Anthropic's Claude Mythos 5") in a misconfigured CTF exercise registered an unclaimed package name that a target system installed and published a malicious package; 15 third-party systems installed it before removal in under an hour.
  - "AI protestware" packages embedding refusal-trigger strings to disrupt Claude-based review and scanning tools.
  — [Sonatype Q3 2026 index](https://www.sonatype.com/blog/q3-2026-open-source-malware-index-when-compromise-compounds)
- (Apr 2026) Sonatype's Q1 2026 index counted 21,764 malicious packages in Q1 (1,346,867 cumulative). The sharp change against Q3's 149k suggests a methodology or campaign effect; treat quarterly comparisons with caution — [Crowdfund Insider](https://www.crowdfundinsider.com/2026/04/273782-sonatype-ids-21764-open-source-malware-packages-in-q1/)
- (Sep 15–17, 2025) The Shai-Hulud npm worm used TruffleHog to steal GitHub PATs, npm tokens and cloud keys, then republished trojanized versions of each victim maintainer's top 20 packages. Reported scale ranges from 180 to more than 500 packages — [CyberArk](https://www.cyberark.com/resources/identity-security/sandworm-in-the-supply-chain-lessons-from-the-shai-hulud-npm-attack-on-developer-and-machine-identities); [Blackpoint](https://blackpointcyber.com/blog/inside-the-shai-hulud-npm-supply-chain-attack/)
- (Jan 2026) Aikido found AI tools recommending a non-existent npm package, `react-codeshift` (a mash-up of jscodeshift and react-codemod). The name had spread to 237 repos through forks, and AI agents were running `npx` installs of it by following skill instructions — [Aikido](https://www.aikido.dev/blog/slopsquatting-ai-package-hallucination-attacks)
- (May 2026) A re-evaluation of package hallucination across 2026 frontier models found lower rates than earlier (the much-cited ~19.7% is from older research), but the threat remains — [arXiv 2605.17062](https://arxiv.org/pdf/2605.17062)
- (May–Jul 2026) Research shows benign-looking agent "Skills" can be written to steer coding agents toward hallucinated dependencies and install commands. A related paper describes "HalluSquatting" as a route to agentic botnets — [arXiv 2605.29354](https://arxiv.org/pdf/2605.29354); [arXiv 2607.07433](https://arxiv.org/pdf/2607.07433)
- (Sep 2025) postmark-mcp was the first known malicious MCP server in the wild. Version 1.0.16 added one line that BCC'd every outgoing email to an attacker domain — [The Hacker News](https://thehackernews.com/2025/09/first-malicious-mcp-server-found.html); [CSO Online](https://csoonline.com/article/4064009/trust-in-mcp-takes-first-in-the-wild-hit-via-squatted-postmark-connector.html)
- (Feb 2026, single secondary source) Noma Security reportedly found that Context7's community "Custom Rules" passed unsanitized instructions to agents; a proof of concept read `.env` files — [DEV Community](https://dev.to/grove_chatforest/context7-mcp-server-real-time-library-docs-for-ai-coding-agents-40k3)
- (May 2026) An essay argues that MCP servers are an uninventoried supply chain, with four distinct attack categories — [HackerNoon](https://hackernoon.com/lite/mcp-servers-are-a-supply-chain-you-have-not-inventoried-yet)
- (Jul 30, 2025) Veracode tested 80 tasks across more than 100 LLMs. 45% of tasks produced code with security flaws (OWASP Top 10); Java failed above 70%; XSS defenses were missed in 86% of relevant samples. Security performance stayed flat as models improved at syntax — [Veracode](https://www.veracode.com/press-release/ai-generated-code-poses-major-security-risks-in-nearly-half-of-all-development-tasks-veracode-research-reveals/); [Help Net Security](https://www.helpnetsecurity.com/2025/08/07/create-ai-code-security-risks/)

### Inferences
- What is new is the **removal of the human glance**. Agents resolve and install dependencies programmatically, so typosquats and slopsquats that a person might have spotted now get through. The mlflow-ui case shows agents can also act as attackers, not just victims.
- Agent "context supply chains" (skills, rules files, MCP servers, doc injectors like Context7) are a new class of dependency. They are seldom pinned, signed or scanned, and they carry *instructions*, not just code.
- Relative to its size this area is **better served** than most others here: big security vendors, registry-level measures, and abundant research. It is not the weakest ratio, but agent-specific policy (dependency allowlists, MCP inventory or SBOMs, skill signing) is still early.

### Gaps
- No independent measurement of how many real installs come from agent-initiated `npm install` or `pip install` versus human ones.
- The Feb 2026 "Sandworm_Mode" npm worm was mentioned only in a reference list; unverified.
- No confirmed 2026 in-the-wild MCP server compromise as widely documented as postmark-mcp.

---

## Area 4 — Dependency upgrades, breaking changes and API drift (models trained on stale APIs)

### Takeaway
Breaking-change and upgrade costs were already among developers' biggest pains: 62% name breaking changes a top concern, and only 32% of automated dependency PRs get merged (Endor Labs, 2024). LLMs now add a systematic bias toward deprecated APIs (25–38% deprecated-usage rates in one study) that persists even when the update spec is given (Apr 2026). Doc-injection tools (Context7, llms.txt) are popular but uneven: llms.txt sits on about 6–10% of sites, and one injector had an instruction-injection flaw.

### Cited Findings
- (Apr 2026) arXiv 2604.09515 built a benchmark of 270 real API updates across 8 Python libraries and four model families. Outdated patterns persist **even when the model is given the API update specification** — [arXiv 2604.09515](https://arxiv.org/html/2604.09515)
- (2025) "LLMs Meet Library Evolution": every LLM tested used deprecated APIs, with deprecated-usage rates of 25–38%. Prompts built from outdated code raised the rates. A simple replacement-hint comment fixed more than 85% of cases for open-source LLMs — [Moonlight review of the paper](https://www.themoonlight.io/es/review/llms-meet-library-evolution-evaluating-deprecated-api-usage-in-llm-based-code-completion)
- (Apr 2026, secondary blog) Most models score below 30% on "API Usage Plausibility" across popular Python libraries — [Tianpan blog](https://tianpan.co/blog/2026-04-17-deprecated-api-trap-ai-coding-agents)
- (2024 report, still the latest found) Endor Labs: 62% of developers name breaking changes a top concern; only 32% of automated dependency-update PRs are merged; a headline claim that about 75% of vulnerability patches lead to breakages — [Endor Labs](https://www.endorlabs.com/learn/fixed-is-better-than-found-upgrades-remediation-with-endor-labs); [TechRepublic](https://www.techrepublic.com/article/dependency-vulnerabilities-report-endor-labs/)
- (Aug 2026) Sonatype tracked 91 Spring CVEs affecting 148,608 software components, a sign of how far the upgrade burden spreads — [Sonatype Q3 2026 index](https://www.sonatype.com/blog/q3-2026-open-source-malware-index-when-compromise-compounds)
- (May 2026) llms.txt adoption was 5.86% among top sites in one crawl; another estimate is about 10% of roughly 300k domains. One guide says it doesn't measurably improve citation by AI assistants — [DEV Community](https://dev.to/searchless_ai/llmstxt-adoption-in-2026-only-586-of-top-sites-use-it-but-early-data-reveals-a-clear-signal-39na); [Codersera guide](https://codersera.com/blog/llms-txt-complete-guide-2026/)
- (2026) Context7 (Upstash) is described as among the most popular MCP servers, used to inject current library docs into Claude Code, Cursor and OpenCode. Popularity data comes from secondary sources — [DEV Community](https://dev.to/grove_chatforest/context7-mcp-server-real-time-library-docs-for-ai-coding-agents-40k3)
- (Jan 2026) Tailwind's founder refused to make the docs more LLM-accessible for business reasons. That shows the conflict between libraries' incentives and the doc freshness agents need — [DevClass](https://www.devclass.com/2026/01/08/tailwind-labs-lays-off-75-percent-of-its-engineers-thanks-to-brutal-impact-of-ai/)

### Inferences
- There is a feedback loop. Models trained on the stock of old code produce more old-API code, which goes into the next training corpus. Retrieval (Context7, llms.txt) fixes this one call at a time, not structurally.
- No machine-readable, library-published **migration contract** exists: something that states which API was replaced by which, under what semantics, with codemods that agents and CI could consume. Each library writes prose changelogs; Context7 scrapes docs; llms.txt is unstructured.
- In principle agents could take on the upgrade grunt work. In practice, the 32% merge rate for automated PRs shows that trust and verification, not patch generation, is the bottleneck.

### Gaps
- No 2025–26 primary estimate found for the share of developer time spent on dependency upgrades.
- No independent usage numbers for Context7 or measured effect on agent accuracy.

---

## Area 5 — Legacy code and knowledge held by retiring engineers

### Takeaway
GAO (Jul 2025) confirms that critical federal systems still run COBOL and assembly, that people who know them are "dwindling", and that only 3 of 10 critical systems flagged in 2019 had been modernized by Feb 2025. AI-driven modernization is now a hot, heavily contested market. Anthropic's COBOL post (Feb 23, 2026) knocked about 13% off IBM's stock in a day. So this is a huge problem with heavy funding, not an overlooked one. The overlooked part is the *knowledge* (business rules and rationale) that translation does not carry over.

### Cited Findings
- (Jul 17, 2025) GAO-25-107795 drew 69 legacy systems from the 24 CFO Act agencies. Of the 11 most in need of modernization, 8 use outdated languages, 7 have known cybersecurity vulnerabilities, and 4 run unsupported hardware or software. Treasury systems run COBOL and assembly, and GAO warns the number of people who know them is shrinking. Only 3 of the 10 critical systems flagged in 2019 had been modernized by Feb 2025 — [GAO-25-107795](https://www.gao.gov/products/gao-25-107795); [FedScoop](https://fedscoop.com/the-gao-flagged-10-critical-legacy-it-systems-years-later-most-havent-been-modernized/)
- (Feb 23, 2026) IBM fell about 13% (its biggest one-day drop since Oct 2000; down 27% for February) after Anthropic said Claude Code can automate much of the analysis in COBOL modernization. IBM pushed back that code translation alone does not solve modernization — [Bloomberg](https://www.bloomberg.com/news/articles/2026-02-23/ibm-shares-plunge-as-anthropic-touts-cobol-modernization-efforts); [The Star](https://www.thestar.com.my/tech/tech-news/2026/02/24/ibm-posts-steepest-daily-drop-since-2000-after-anthropic-says-ai-can-modernize-cobol)

### Inferences
- Legacy modernization is now one of the *most* funded AI-coding problems, with IBM, hyperscalers, Anthropic and integrators competing for it. It does not belong on a "few products target it" list, except for the **tacit-knowledge capture** part.
- The new legacy problem is Area 1. Code written now by agents, without stored rationale, will be the next generation's undocumented legacy. It will arrive faster and at larger volume than COBOL did.

### Gaps
- No credible 2025–26 estimate found for total lines of COBOL in production. Commonly cited figures (e.g., "220B lines") date from 2017-era surveys and were not re-verified.
- No outcome data (success or failure rates) found for AI-driven mainframe migrations.

---

## Area 6 — Junior developer pipeline collapse and expertise formation

### Takeaway
Early-career software employment fell by about 20% (Stanford, ADP payroll data), and new-grad hiring at large tech firms is reportedly about 65% below 2019. Whether AI causes this or interest rates and taxes do is disputed. Separately, an Anthropic randomized trial (Jan 2026) found AI assistance lowered mastery by about 17% on a quiz, with the biggest gap in debugging. Maintainers report that AI *increases* newcomers' need for mentorship. Almost no product is working on how expertise forms under AI.

### Cited Findings
- (2025–Aug 2026) Stanford Digital Economy Lab (ADP payroll data): employment of 22–25-year-olds in the most AI-exposed occupations, including software developers, is about 19–20% below where it would have been; experienced workers show no comparable gap — [CNBC (Oct 11, 2026)](https://www.cnbc.com/2026/10/11/ai-software-developer-jobs.html); [Second Talent summary](https://www.secondtalent.com/resources/the-future-of-software-engineering-jobs-in-2026-what-hiring-managers-need-to-know/)
- (Jun 2026, secondary) SignalFire: new-grad hiring is down about 65% vs 2019 at the largest tech firms and about 76% at early-stage startups — [HatchWorks](https://hatchworks.com/blog/gen-ai/software-engineer-shortage/)
- (Oct 2026) Overall US software developer postings are *rising* (Indeed: about +18% YoY but about 24% below Feb 2020). LinkedIn's Economic Graph team argues real interest rates explain most of the variation, so the causal role of AI is contested — [CNBC](https://www.cnbc.com/2026/10/11/ai-software-developer-jobs.html); [DEV Community summary of LinkedIn view](https://dev.to/adilsoukaini/how-ai-is-changing-the-software-developer-job-market-1p0m)
- (2026 survey, secondary) Resume.org: 21% of 1,000 US hiring managers have frozen entry-level hiring because of AI; 36% expect to by the end of 2026 — [Xeito](https://xeito.ai/en/blog/entry-level-tech-jobs-disappearing-2026/)
- (Jan 29, 2026) Anthropic RCT (52 engineers learning the Trio async library): the AI-assisted group scored about 17% lower on mastery, with the biggest gap in debugging, and the productivity gain was not statistically significant. Participants who used AI to build understanding (follow-up questions, asking for explanations) did better. Small sample and short time horizon — [Anthropic research](https://www.anthropic.com/research/AI-assistance-coding-skills); [InfoQ](https://infoq.com/news/2026/02/ai-coding-skill-formation/)
- (Oct 2026) LF survey: 46% of OSS respondents say AI increases the need for mentorship for new contributors (vs 32% decrease); 71% agree AI lowers barriers to entry — [Linux Foundation report](https://www.linuxfoundation.org/hubfs/Research%20Reports/Navigating-Open-Source-Software-Development-in-the-Generative-AI-Era.pdf?hsLang=en)
- (2025) Stack Overflow Developer Survey: 84% use or plan to use AI tools; 46% distrust AI output accuracy (up from 31%); 66% cite "almost right, but not quite" answers; 45% say debugging AI code takes longer — [ShiftMag](https://shiftmag.dev/stack-overflow-survey-2025-ai-5653/); [InfoWorld](https://infoworld.com/article/4031673/ai-use-among-software-developers-grows-but-trust-remains-an-issue-stack-overflow-survey.html)

### Inferences
- This is a delayed systemic risk. Today's seniors learned by writing and debugging code by hand. If the entry rung shrinks *and* AI-assisted learning lowers debugging mastery, the supply of people able to review agent output (the binding constraint in Areas 1, 2 and 9) shrinks around 2030–2035.
- OSS used to be a training ground for juniors. It is closing its doors (Area 2), which removes another apprenticeship path.
- Existing answers are "learning modes" in chat tools and bootcamps. Nothing institutional or structural was found, such as apprenticeship-as-a-service or verified-skill pipelines.

### Gaps
- No longitudinal data on skill development of developers who started their careers with agents.
- Primary SignalFire and Stanford AI Index 2026 documents were not opened directly; figures are from secondary coverage.

---

## Area 7 — Flaky tests, CI cost and environment reproducibility under agent load

### Takeaway
Flakiness was already costly before AI: about 2.5% of productive developer time in a 2024 industrial study, and 51% of 1,960 OSS Java projects on GitHub Actions affected. Agents multiply PR and CI volume (98% more PRs merged on high-AI teams per Faros 2025) and treat flaky signals as ground truth. That poisons agent loops and inflates review load: review time is up 91%. Tooling exists (many flaky-test vendors), so this is a moderately served problem that agents amplify.

### Cited Findings
- (2024 ICST industrial case study, via 2026 secondary) Flaky tests consumed about 2.5% of productive developer time (1.1% investigating false failures, 1.3% repairing). Manual investigation cost about $5.67 per build vs $0.02 for an automatic rerun — [Bug0 blog](https://bug0.com/blog/true-cost-of-flaky-tests-2026)
- (Feb 2025 study, secondary) Of 1,960 OSS Java projects on GitHub Actions, 51.28% are affected by flaky builds; 67.73% of rerun builds show flaky behavior — [Panto flaky-test statistics](https://www.getpanto.ai/blog/flaky-test-statistics)
- (2025) Faros AI "AI Productivity Paradox" (about 10,000 developers, about 1,255 teams): high-AI-adoption teams complete 21% more tasks and merge 98% more PRs, but PR review time rises 91% and company-level DORA metrics are flat. PR-size and bug figures conflict between sources — [Augment summary](https://www.augmentcode.com/guides/ai-productivity-paradox-engineering-delivery); [Faros blog](https://www.faros.ai/blog/achieving-an-ideal-tempo-with-ai-augmented-devops)
- (Dec 16, 2025) GitHub announced a $0.002 per minute "cloud platform charge" for self-hosted Actions runners from Mar 1, 2026, then postponed it after backlash; hosted-runner prices dropped by up to 39% on Jan 1, 2026 — [GitHub changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/); [DevClass](https://devclass.com/2025/12/17/github-to-charge-for-self-hosted-runners-from-march-2026/)
- (Jul 2026, opinion) "Flaky tests poison agent loops": agents treat red or green as truth, so flakiness misleads autonomous fix loops — [Tianpan blog](https://tianpan.co/blog/2026/07/02/flaky-tests-poison-agent-loops)
- (ASE 2025, secondary) FlakyGuard repaired 47.6% of reproducible flaky tests with AI — [Bug0 blog](https://bug0.com/blog/true-cost-of-flaky-tests-2026)

### Inferences
- GitHub trying to charge for platform minutes on self-hosted runners hints that CI usage economics are shifting as agent-driven activity grows. That is inference only; GitHub did not cite agents.
- Environment reproducibility for agents (sandboxes, devcontainers, ephemeral environments) is an active vendor category. Problem size is real but not hidden.

### Gaps
- No hard data found on agent-driven growth in CI minutes or compute.
- No 2025–26 primary study on "works on my machine" or environment-setup costs for agents.

---

## Area 8 — Software bloat and duplication explosion (codebases outgrowing human reading capacity)

### Takeaway
GitClear's 2025 analysis (211M changed lines, 2020–2024) shows refactoring ("moved" code) falling from about 25% of changes (2021) to under 10% (2024). Copy-paste rose, and 2024 was the first year copy-pasted lines outnumbered moved lines. Duplicated blocks rose about 8x in 2024. Combined with Google's 75% AI-generated new code, code volume is outgrowing human comprehension (see "comprehension debt", Area 1). Static analysis tools exist, but nothing is built for cross-repo, organization-wide duplication or "does this already exist?" questions at agent speed.

### Cited Findings
- (Early 2025 report, cited Jan 2026) GitClear: refactoring share fell from about 24–25% (2021) to under 10% (2024); copy-pasted code rose (from below 10% to almost 15% by one account); 2024 was the first year copy-paste exceeded moved lines; duplicated code blocks rose about 8x in 2024 (MIT Technology Review, Jan 2026, citing GitClear). Dataset: 211M changed lines, 2020–2024. The "3% refactoring by 2025" figure is a projection — [BestHub summary](https://besthub.dev/articles/is-ai-accelerating-a-hidden-software-crisis-the-rise-of-duplicate-code-60ebfe284f1c); [GitClear press mentions](https://www.gitclear.com/press_mentions)
- (2024 DORA, counterpoint) AI adoption was associated with +3.4% code quality but −7.2% delivery stability — [BestHub summary](https://www.besthub.dev/articles/are-ai-coding-assistants-undermining-code-quality-new-study-reveals-alarming-trends-5b9cda7d861a)
- (Apr 2026) Google: 75% of new code is AI-generated — [The Decoder](https://the-decoder.com/google-says-75-percent-of-its-new-code-is-now-written-by-ai/)

### Inferences
- Duplication is a cost (bug fixes must be applied N times; security patches miss copies) and also a provenance problem, because no one knows a copy exists. It overlaps with Areas 1 and 3.
- No 2026 GitClear update was found, so whether agentic tools (vs autocomplete) made duplication better or worse is unknown.

### Gaps
- No 2026 measurement of duplication or code-growth rates under agentic tools.
- No data on cross-repository duplication (the same helper re-generated across thousands of repos).

---

## Area 9 — Inter-agent coordination across tools, teams and companies

### Takeaway
Teams now run several vendors' agents on the same repo. Each reads its own instruction file (CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md, copilot-instructions.md) with its own precedence rules, and the copies drift. AGENTS.md (donated to the Linux Foundation's Agentic AI Foundation, Dec 9, 2025; 40k–60k+ projects) is converging the *static instructions* layer. Nothing standard exists for *dynamic* coordination: handoff, locks, ownership of in-flight work, shared memory of decisions.

### Cited Findings
- (Dec 9, 2025) The Linux Foundation launched the Agentic AI Foundation (AAIF) as a neutral home for Anthropic's MCP, Block's goose and OpenAI's AGENTS.md. AGENTS.md adoption is reported at 40,000+ (at launch) to 60,000+ projects; I found no primary count — [SiliconANGLE](https://siliconangle.com/2025/12/09/linux-foundation-announces-agentic-ai-foundation-joined-anthropic-openai-block/); [WorkOS](https://workos.com/blog/the-linux-foundation-launches-the-aaif); [InfoQ](https://infoq.com/news/2025/12/agentic-ai-foundation/)
- (2026, secondary guides) Fragmentation: Claude Code reads CLAUDE.md, Codex AGENTS.md, Cursor .cursorrules, Gemini GEMINI.md. Teams duplicate content, and the copies drift. Precedence differs: Codex concatenates files up to a 32 KiB budget; Copilot uses nearest-wins for AGENTS.md. The workaround is an AGENTS.md plus an import or symlink bridge — [Unblocked](https://getunblocked.com/blog/claude-md-vs-agents-md-vs-cursor-rules/); [The Prompt Shelf](https://thepromptshelf.dev/blog/agents-md-vs-claude-md-vs-cursorrules-three-way-2026/)
- (Jan 2026) "Agentic Much?" covers 48 coding agents. About 3.7% of projects have more than 10 agent guidance files, which the authors attribute to complex guidance or several agents. AGENTS.md alone can't identify which agent was used — [arXiv 2601.18341](https://arxiv.org/html/2601.18341v1)
- (Feb 2026) Entire's roadmap names a "semantic reasoning layer for multi-agent coordination", so at least one funded startup sees this gap — [VKTR](https://www.vktr.com/ai-platforms/ex-github-ceo-backs-a-new-kind-of-dev-platform-for-human-agent-collaboration/)

### Inferences
- The *config* layer is being solved through AGENTS.md. The *coordination* layer is not: two agents from different vendors, or different companies such as a contractor and a client, editing the same code have no shared record of claims, decisions or handoffs. This is closely tied to Area 1. A shared intent and decision log would also act as the coordination medium.

### Gaps
- No empirical data found on conflicts or rework caused by multiple agents on one codebase.
- MCP and A2A cover tool calls and agent messaging. No standard for code-level agent handoff was found.

---

## Area 10 — Licensing, IP and compliance of AI-generated code

### Takeaway
Measured risk per snippet is small (0.88–2.01% near-verbatim copies), but most models fail to report copyleft licenses. At the scale of hundreds of millions of AI-written lines, that adds up to a large unquantified exposure. Regulation is less burdensome for code than feared: the EU AI Act reportedly carves source code out of AI-content labeling, and code-generation tools are not Annex III high-risk. Only 39% of OSS AI policies address licensing at all.

### Cited Findings
- (ICSE 2025) LiCoEval tested 14 LLMs. 0.88–2.01% of outputs were "strikingly similar" to existing OSS code. Most models failed to give license information for copyleft code; only Claude-3.5-Sonnet showed some ability — [arXiv 2408.02487](https://arxiv.org/abs/2408.02487v3); [ICSE 2025 listing](https://conf.researchr.org/details/icse-2025/icse-2025-research-track/73/LiCoEval-Evaluating-LLMs-on-License-Compliance-in-Code-Generation)
- (2026) EU AI Act: the AI Office gains enforcement powers over GPAI providers on Aug 2, 2026. Per the Apache Software Foundation's summary, source code is carved out of AI-generated-content labeling. One 2026 guide argues code generation is not an Annex III high-risk use — [Apache RAI: EU AI Act and copyright](https://rai.apache.org/eu-ai-act.html); [Augment guide](https://www.augmentcode.com/guides/eu-ai-act-2026)
- (2026, unverified) Claims that a March 2026 European Parliament resolution applies "no copyright for purely AI-generated works" to code could not be verified against a primary source — [byteiota](https://byteiota.com/eu-copyright-kills-ai-code-protection-what-devs-must-do/)
- (Oct 2026) Only 39% of OSS AI-contribution policies address licensing or copyright — [Linux Foundation report](https://www.linuxfoundation.org/hubfs/Research%20Reports/Navigating-Open-Source-Software-Development-in-the-Generative-AI-Era.pdf?hsLang=en)

### Inferences
- The copyrightability of AI-written code is a slow-burning structural problem. If large shares of a codebase can't be copyrighted, OSS licenses (which depend on copyright) and proprietary moats both weaken. Provenance data (Area 1) is the prerequisite for answering "which parts of our code are protectable or licensable?"

### Gaps
- No 2025–26 litigation outcome specific to AI-generated *code* was found (the Doe v. GitHub status was not checked).
- U.S. Copyright Office guidance specific to software was not retrieved.

---

## Area 11 — Accessibility of AI coding for developers in the Global South

### Takeaway
The fastest-growing developer populations (India +5.2M on GitHub in 2025; projected 57.5M by 2030) face USD-priced subscriptions and usage-based token bills. Evidence on affordability is anecdotal and often comes from interested parties. Open-weight models (Chinese labs in particular) are the main structural relief: 29% of tokens but under 4% of spend on one gateway, June 2026. This is a large problem, but cheap open-weight models are improving it quickly, and the hard data is thin.

### Cited Findings
- (Oct 2025) Octoverse 2025: GitHub passed 180M developers; 36M joined in a year; India added 5.2M+ (about 14% of new developers) and overtook the US as the largest base of open-source contributors; GitHub projects India at 57.5M developers by 2030 — [Business Standard](https://www.business-standard.com/amp/industry/news/github-india-57-million-developers-2030-ai-growth-125102801381_1.html); [It's FOSS](https://itsfoss.com/github-octoverse-2025/)
- (2026, low-reliability: posts by a reseller's marketer) ChatGPT Plus costs about ₹1,600 a month in India and ₦32,000 in Nigeria, framed as 4–8% of a Nigerian developer's monthly salary — [DEV Community post](https://dev.to/subprime2010/why-developers-in-south-africa-egypt-pakistan-and-bangladesh-cant-afford-chatgpt-1dmb)
- (Aug 2026, secondary) Open-weight models handled about 29% of token volume on Vercel's AI gateway in June 2026 but under 4% of spend. GLM-5 reportedly hit 77.8% on SWE-bench Verified — [Digital Applied H1 2026 retrospective](https://www.digitalapplied.com/blog/open-weight-ai-models-h1-2026-retrospective-deepseek-qwen-llama)

### Inferences
- The structural risk is less about access to *a* model and more that agent workflows burn tokens. Costs scale with context and autonomy, so the productivity gap between well-funded and price-constrained developers could widen even as per-token prices fall.

### Gaps
- No official purchasing-power or regional pricing from Anthropic, OpenAI, GitHub or Cursor was found.
- No independent survey of AI coding-tool adoption or spend in India, Africa, Southeast Asia or Latin America was found.
- Language barriers (non-English prompting and docs) and connectivity were not covered by any 2025–26 source found.

---

## Key Question 2 — Which problem has the weakest current solution relative to its size?

### Takeaway
**Lost intent and decision provenance (Area 1), together with the comprehension and intent debt it produces**, has the weakest solution relative to its size. It affects potentially all newly written code (75% of Google's new code; 16–23% of active GitHub projects already by late 2025). Yet the best answers are a v0.1 RFC that leaves out storage, transcripts and rebases, plus a handful of months-old startups and CLIs. Close behind: **OSS maintainer review capacity and funding (Area 2)**, which has only blunt throttles, and **expertise formation for juniors (Area 6)**, which has essentially no products.

### Cited Findings (ranking evidence; ratio = problem size ÷ solution quality)
1. **Lost intent and decision provenance.** Size: 15.85–22.60% of 129k active GitHub projects used agents by Oct 2025 ([arXiv 2601.18341](https://arxiv.org/html/2601.18341v1)); Google says 75% of new code is AI-generated ([The Decoder](https://the-decoder.com/google-says-75-percent-of-its-new-code-is-now-written-by-ai/)); only 3 in 10 OSS contributors always disclose AI use ([LF Oct 2026](https://www.linuxfoundation.org/hubfs/Research%20Reports/Navigating-Open-Source-Software-Development-in-the-Generative-AI-Era.pdf?hsLang=en)). Solutions: Agent Trace v0.1.0 RFC, with no storage standard, no transcript content and rebases unresolved ([agent-trace.dev](https://agent-trace.dev/)); Entire Checkpoints, launched Feb 2026 ([GeekWire](https://geekwire.com/2026/former-github-ceos-startup-entire-unveils-its-answer-to-the-crush-of-ai-coding-agents)). The concept was only named in Mar 2026 ([Storey, arXiv 2603.22106](https://arxiv.org/abs/2603.22106)).
2. **OSS maintainer review capacity and funding.** Size: 9.8T annual downloads ([Sonatype](https://www.sonatype.com/press-releases/sonatype-research-reveals-open-malware-grows-75-percent)); 25% of PRs are slop (31% in large projects), and burnout is the top concern for large projects ([LF Oct 2026](https://www.linuxfoundation.org/hubfs/Research%20Reports/Navigating-Open-Source-Software-Development-in-the-Generative-AI-Era.pdf?hsLang=en)); Tailwind revenue down about 80% ([DevClass](https://www.devclass.com/2026/01/08/tailwind-labs-lays-off-75-percent-of-its-engineers-thanks-to-brutal-impact-of-ai/)). Solutions: PR off-switches and caps ([InfoWorld](https://www.infoworld.com/article/4127156/github-eyes-restrictions-on-pull-requests-to-rein-in-ai-based-code-deluge-on-maintainers.html)), Anubis proof-of-work ([404 Media](https://www.404media.co/the-open-source-software-saving-the-internet-from-ai-bot-scrapers/)), ad hoc sponsorships.
3. **Comprehension debt and the junior pipeline (expertise formation).** Size: about 20% drop in early-career employment in AI-exposed jobs ([CNBC](https://www.cnbc.com/2026/10/11/ai-software-developer-jobs.html)); 17% lower mastery with AI assistance ([Anthropic](https://www.anthropic.com/research/AI-assistance-coding-skills)); review time +91% on high-AI teams ([Augment/Faros](https://www.augmentcode.com/guides/ai-productivity-paradox-engineering-delivery)). Solutions: essentially none beyond tutoring or "learning modes"; the causal link is disputed.
4. **Agent-to-agent coordination (dynamic layer).** Size: growing multi-agent use, with 48 agents tracked ([arXiv 2601.18341](https://arxiv.org/html/2601.18341v1)). Solutions: AGENTS.md handles static config only ([SiliconANGLE](https://siliconangle.com/2025/12/09/linux-foundation-announces-agentic-ai-foundation-joined-anthropic-openai-block/)).
5. **API drift and upgrade hell.** Size: 25–38% deprecated-API usage ([Moonlight review](https://www.themoonlight.io/es/review/llms-meet-library-evolution-evaluating-deprecated-api-usage-in-llm-based-code-completion)); stale patterns persist even with the spec given ([arXiv 2604.09515](https://arxiv.org/html/2604.09515)); 32% of automated upgrade PRs merged ([Endor](https://www.endorlabs.com/learn/fixed-is-better-than-found-upgrades-remediation-with-endor-labs)). Solutions: Context7 and llms.txt (partial, unstructured), Dependabot or Renovate-type bots.
6. **Code duplication and bloat.** Size: copy-paste exceeded moved code in 2024, and duplicate blocks rose 8x ([BestHub/GitClear](https://besthub.dev/articles/is-ai-accelerating-a-hidden-software-crisis-the-rise-of-duplicate-code-60ebfe284f1c)). Solutions: static analysis exists but is single-repo.
7. **Licensing and IP.** Size: 0.88–2.01% near-copies, with copyleft licenses mostly unreported ([LiCoEval](https://arxiv.org/abs/2408.02487v3)). Solutions: partial; regulation lighter for code ([Apache RAI](https://rai.apache.org/eu-ai-act.html)).
8. **Supply chain + AI.** Size is the largest in absolute terms: 1.96M malicious packages cumulative, Mini Shai-Hulud, agent-driven slopsquatting ([Sonatype Q3 2026](https://www.sonatype.com/blog/q3-2026-open-source-malware-index-when-compromise-compounds); [Aikido](https://www.aikido.dev/blog/slopsquatting-ai-package-hallucination-attacks)). It ranks lower only because the vendor ecosystem is large and well funded. The agent-specific gaps (MCP and skill provenance, install allowlists) are still real.
9. **Flaky tests, CI and environments.** Size: 2.5% of developer time; 51% of OSS Java projects affected ([Bug0](https://bug0.com/blog/true-cost-of-flaky-tests-2026); [Panto](https://www.getpanto.ai/blog/flaky-test-statistics)). Solutions: a mature vendor category.
10. **Global South access.** Size: large population (India 57.5M developers by 2030, [Business Standard](https://www.business-standard.com/amp/industry/news/github-india-57-million-developers-2030-ai-growth-125102801381_1.html)). Solutions: open-weight models cutting costs quickly ([Digital Applied](https://www.digitalapplied.com/blog/open-weight-ai-models-h1-2026-retrospective-deepseek-qwen-llama)). Evidence is weak.
11. **Legacy and COBOL.** Size is huge ([GAO-25-107795](https://www.gao.gov/products/gao-25-107795)), but this is now one of the most-targeted AI markets ([Bloomberg on IBM](https://www.bloomberg.com/news/articles/2026-02-23/ibm-shares-plunge-as-anthropic-touts-cobol-modernization-efforts)). The weak part is tacit-knowledge capture, which loops back to #1.

### Inferences
- Several top-ranked problems share one missing primitive: **a durable, portable, queryable record of intent and provenance attached to code**. With it, maintainers could triage contributions by provenance and verification evidence (#2), juniors and reviewers could learn *why* (#3), agents could coordinate through shared decisions (#4), IP questions could be answered (#7), and future legacy would carry its rationale (#11). That cross-cutting leverage strengthens the case that #1 is the most under-served relative to its size.
- The ranking is a judgment. "Solution quality" was assessed from the maturity, adoption and scope of the tools and standards found, not from a formal market scan.

### Gaps
- No systematic market map (funding totals per problem area) was built; the solution-quality judgments are qualitative.
- Several key quantitative claims rest on vendor or secondary sources (Faros, Getcommit, Tea.xyz, SignalFire via secondary sources); those are flagged where cited.
