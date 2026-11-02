# Developer Pain Points in the Era of AI-Written Code and Agentic Development (state as of Oct 31, 2026)

Labels used in this file: [SELF-REPORTED] means survey or perception data. [VENDOR] means the publisher sells a product that addresses the problem. [TELEMETRY] means measured from system data. [RCT] means a randomized controlled trial. [SECONDARY] means I reached only press or blog coverage, not the primary document.

## Q1. What do the large surveys say about trust, "almost right" code, review/debug time, and perception vs reality?

### Takeaway
Adoption is near-universal: 84% to 90% of developers use AI, and coding agents are now mainstream. Trust is low and conditional. The top frustration is code that is "almost right, but not quite" (66% of about 31k Stack Overflow 2025 respondents). Nearly all developers spend time verifying AI output, but only about half say they always verify before committing. Perceived productivity gains are high (more than 80%) and do not match the measured outcomes in Q2.

### Cited Findings
**Stack Overflow Developer Survey 2025** (about 49k respondents, published July 2025) [SELF-REPORTED]
- 84% use or plan to use AI tools, up from 76%. 47.1% of all respondents use them daily (n=33,662) — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai/)
- Trust in AI output: 32.7% trust it (3.1% highly), and 45.7% distrust it (19.6% highly), n=33,244. Among experienced developers, only 2.5% highly trust and 20.7% highly distrust — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai/)
- Trust in accuracy fell from 43% (2024) to 33% (2025). Favourability fell from 72% to 60% — [LeadDev, Aug 4 2025](https://leaddev.com/technical-direction/trust-in-ai-coding-tools-is-plummeting)
- **Top frustrations (n=31,476):** 66% cite "AI solutions that are almost right, but not quite". 45.2% say debugging AI-generated code is more time-consuming. 20% say they have become less confident in their own problem-solving. 16.3% find it hard to understand how or why the code works — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai/)
- 75.3% would still ask a person when they don't trust the AI's answer. 61.7% would do so when they have ethical or security concerns about the code — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai/)
- Agents: 30.9% used agents at work in 2025, and 37.9% had no plans to. 86.9% are concerned about agent accuracy and 81.4% about security and privacy of data (n=28,930). Only 17% of agent users said agents improved team collaboration — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai/)
- "Vibe coding" is not part of professional work for 77.5% (72.2% "no" plus 5.3% "emphatically no") — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai/)

**Stack Overflow Developer Survey 2026** (more than 30,000 responses from 169 countries; coverage dated Oct 6, 2026) [SELF-REPORTED]
- 66% use coding assistants or agents, and 63% use general chatbots. Only 17.2% use no AI tools. 26.2% use automated agent workflows — [IT Brief, Oct 6 2026](https://itbrief.co.uk/story/stack-overflow-survey-shows-developers-trust-ai-with-caveats)
- Intensity: 30.9% of daily users (n=10,926) spend 4 or more hours a day on AI tools — [SO 2026 AI](https://survey.stackoverflow.co/2026/ai)
- Trust is conditional. 48% trust AI only "when they can easily validate" its answers, and only 6.6% trust it for important decisions. 78.7% say source attribution matters for AI code or answers — [SO 2026 AI](https://survey.stackoverflow.co/2026/ai); [IT Brief](https://itbrief.co.uk/story/stack-overflow-survey-shows-developers-trust-ai-with-caveats)
- Coding-agent tool share among agent users: Claude Code 66%, GitHub Copilot 59% — [SO 2026 AI](https://survey.stackoverflow.co/2026/ai)
- Reasons for avoiding AI (n=13,857): 17.1% fear losing job skills, 15.2% have moral or ethical concerns, and 13.0% cite privacy or security — [SO 2026 AI](https://survey.stackoverflow.co/2026/ai)
- Governance vacuum: only 24% say their employer has published approved tools or formal guidance, and 30% say AI use is optional and left to the individual — [IT Brief](https://itbrief.co.uk/story/stack-overflow-survey-shows-developers-trust-ai-with-caveats)
- Engagement: 45% complacent, 33% unhappy, 22% happy. 21% of the complacent cite burnout or tech fatigue — [IT Brief](https://itbrief.co.uk/story/stack-overflow-survey-shows-developers-trust-ai-with-caveats)

**Google DORA 2025, "State of AI-assisted Software Development"** (about 5,000 professionals worldwide plus more than 100 hours of qualitative data; Sept 2025) [SELF-REPORTED]
- 90% use AI at work, and more than 80% believe it increased their productivity. 30% report little or no trust in AI-generated code — [Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)
- AI adoption is now positively associated with throughput, which reverses the 2024 finding, but it is still negatively associated with delivery stability. DORA attributes this to higher change volume exposing weak downstream controls such as testing, version control and feedback loops ("AI as amplifier") — [Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)

**Sonar 2026 State of Code Developer Survey** (more than 1,100 developers; Jan 8, 2026) [SELF-REPORTED][VENDOR]
- AI accounts for 42% of committed code, and developers expect 65% by 2027 — [Sonar press release](https://www.sonarsource.com/company/press-releases/sonar-data-reveals-critical-verification-gap-in-ai-coding/)
- 96% don't fully trust AI code to be functionally correct, yet only 48% always verify it before committing. 95% spend some effort reviewing, testing or correcting AI output — [Sonar press release](https://www.sonarsource.com/company/press-releases/sonar-data-reveals-critical-verification-gap-in-ai-coding/); The Register called the statistic "conveniently self-validating" for a vendor — [The Register, Jan 9 2026](https://www.theregister.com/2026/01/09/devs_ai_code)
- 38% say reviewing AI code takes more effort than reviewing human code — [ITPro](https://www.itpro.com/software/development/software-developers-not-checking-ai-generated-code-verification-debt)

**Atlassian State of DevEx 2025** (3,500 developers and managers in 6 countries) [SELF-REPORTED][VENDOR]
- 68% save more than 10 hours a week with AI. But 50% lose 10 or more hours a week, and 90% lose 6 or more, to organizational friction such as fragmented workflows and finding information. Developers spend only about 16% of their time coding — [Atlassian blog](https://www.atlassian.com/blog/developer/developer-experience-report-2025)

**Harness "State of Software Delivery: Beyond CodeGen"** (2025) [SELF-REPORTED][VENDOR][SECONDARY]
- 67% spend more time debugging AI-generated code, and 68% spend more time fixing AI-related security vulnerabilities. 59% hit deployment errors at least half the time when using AI tools. 92% say AI increases the "blast radius" of bad code. 60% don't evaluate whether their AI tools are effective — [DevOps.com](https://devops.com/survey-ai-tools-are-increasing-amount-of-bad-code-needing-to-be-fixed/); [DevOps Digest](https://www.devopsdigest.com/ai-powered-development-tools-benefits-introducing-complexity-risk)

**Lightrun State of AI-Powered Engineering 2026** (200 SRE and DevOps leaders) [SELF-REPORTED][VENDOR][SECONDARY]
- 43% of AI-generated code needs manual debugging after deployment even after passing QA and staging. 88% of organizations need multiple redeploy cycles to confirm that AI fixes work — [IT Brief](https://itbrief.co.uk/story/ai-code-needs-production-debugging-lightrun-report-finds)

**JetBrains State of Developer Ecosystem 2025** (Oct 2025) [SELF-REPORTED][SECONDARY]
- About 85% regularly use AI. About 88 to 90% report saving at least 1 hour a week, and about 1 in 5 save 8 or more hours. Code quality is the top-named concern. Exact concern percentages conflict across secondary sources — [JetBrains Research blog](https://blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025/)

### Inferences
- The central gap between perception and reality is this: more than 80% feel more productive (DORA), but trust is falling and the "almost right" tax is the most common complaint. The scarce resource has moved from generating code to **verifying** it.
- On a global base of tens of millions of professional developers, "almost right" and verification overhead plausibly affect a majority. These are the largest-scale pain points in the evidence.
- The governance vacuum (only 24% have formal guidance) means most of the verification burden falls on individuals, not on systems.

### Gaps
- I could not get the 2026 Stack Overflow figure for "trust in accuracy", so the 2025-to-2026 trust trend is unconfirmed. The 2026 "almost right" figure was also not visible on the 2026 AI page.
- I did not access the JetBrains 2026 survey, the LeadDev 2026 engineering leadership report or the DORA 2026 report, if any exist. Their 2026 figures are unverified.
- The full Harness report methodology and sample size are unverified.

## Q2. What do empirical studies show about productivity and code quality (METR, Faros, GitClear, CodeRabbit)?

### Takeaway
The best controlled evidence (METR's 2025 RCT) found experienced developers were 19% slower with AI while believing they were 20% faster. METR's 2026 follow-up suggests a speedup but says its data is unreliable, because developers now refuse to work without AI. Large telemetry datasets show throughput up and quality down: more bugs, more churn and more incidents per PR. Measuring real productivity remains unsolved.

### Cited Findings
- **METR RCT (Feb to June 2025):** Experienced open-source developers took 19% longer with AI (95% CI +2% to +39%). They had predicted a 24% speedup and afterward believed they had been sped up by about 20% [RCT] — [METR, Feb 24 2026](https://metr.org/blog/2026-02-24-uplift-update/)
- **METR follow-up (started Aug 2025; reported Feb 24, 2026):** 57 developers, 143 repos, more than 800 tasks. The returning cohort was −18% (faster; CI −38% to +9%) and new recruits −4% (CI −15% to +9%). Both intervals straddle zero. METR calls this "an unreliable signal" because 30 to 50% of developers withheld tasks they did not want to do without AI. METR says developers are "likely" more sped up in early 2026 but its data is "very weak evidence" [RCT] — [METR](https://metr.org/blog/2026-02-24-uplift-update/)
- **Faros AI "AI Productivity Paradox" (2025; more than 10,000 developers, 1,255 teams):** High-AI-adoption teams completed about 21% more tasks and merged about 98% more PRs, but PR review time rose about 91%, with no significant company-level improvement [TELEMETRY][VENDOR][SECONDARY] — [Augment Code guide summarizing Faros](https://www.augmentcode.com/guides/ai-productivity-paradox-engineering-delivery); [Faros research](https://www.faros.ai/research)
- **Faros AI Engineering Report Q2 2026, "The Acceleration Whiplash" (about 22K developers, about 4K teams, 2 years of telemetry; high vs low AI adoption within the same orgs):** PR size +51%, bugs per PR +28.7%, bugs per developer +54%, median review time 5x (+441.5%), incidents per PR 3x (+242.7%), monthly incidents +57.9%, code churn 10x (+861%), epics completed +66.2%, task throughput +33.7%, deployments per week **−11.7%**. 25% of PRs are reviewed by an AI agent [TELEMETRY][VENDOR] — [Faros, Acceleration Whiplash](https://faros.ai/research/ai-acceleration-whiplash)
- Secondary write-ups of the same Faros dataset report 31.3% more PRs merged with no review at all [SECONDARY] — [dev.to/code-board](https://dev.to/code-board/pr-review-time-is-up-441-the-real-cost-of-ai-accelerated-development-1ho6)
- **CodeRabbit "State of AI vs Human Code Generation" (Dec 17, 2025):** 470 open-source PRs (320 AI-co-authored, 150 human-only). AI PRs averaged 10.83 issues vs 6.45 for human PRs (about 1.7x). Critical issues were about 1.4x, logic and correctness about 1.75x, maintainability about 1.64x, security about 1.57x and performance about 1.42x. XSS patterns were up to about 2.74x [VENDOR; small sample] — [CodeRabbit](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report); [The Register](https://www.theregister.com/2025/12/17/ai_code_bugs/)
- **GitClear (2025 report on 2024 data):** Duplicated code blocks rose about 8x, and 2024 was the first year copy/paste exceeded moved (refactored) code [TELEMETRY][VENDOR] — [LeadDev](https://leaddev.com/technical-direction/how-ai-generated-code-accelerates-technical-debt)
- **GitClear "Maintainability Gap" (2026; reportedly 623M code changes, 2023 to 2026):** Code-block duplication +81% and copy/paste within commits +41%. Updates to code more than 12 months old are down 74% since 2023, and "error-masking" catch blocks are up 47% [TELEMETRY][VENDOR][SECONDARY; baselines differ across write-ups] — [LeadDev](https://leaddev.com/?p=34362)
- **Atlassian 2025:** AI time savings were roughly offset by organizational friction (50% lose 10 or more hours a week) [SELF-REPORTED] — [Atlassian](https://www.atlassian.com/blog/developer/developer-experience-report-2025)
- Harness: 60% of organizations don't evaluate AI tool effectiveness [SELF-REPORTED][SECONDARY] — [DevOps Digest](https://www.devopsdigest.com/ai-powered-development-tools-benefits-introducing-complexity-risk)

### Inferences
- The consistent pattern across independent sources (METR RCT, DORA survey, Faros telemetry, GitClear repo analysis) is more output, flat or worse delivery, and degraded quality. Faros's fall in deployments per week despite more PRs suggests the gains are absorbed downstream in review, testing and incidents.
- The "productivity measurement" problem is itself a pain point. Even METR cannot run a clean RCT any more, and companies are falling back on token counts (see Q10).

### Gaps
- I did not access Faros's Q3 2026 report ("The Speed Trap"). The 91% (2025) and 441% (2026) review-time figures come from different datasets and cuts and should not be merged.
- No Google or Microsoft internal 2026 productivity study surfaced in my searches.
- GitClear's primary 2026 report was not reached, so the figures are via LeadDev or secondary coverage.

## Q3. How secure is AI-generated code?

### Takeaway
Security quality of AI-generated code has plateaued even as models improve on other benchmarks. Roughly 44 to 45% of AI code-generation tasks still produce a known vulnerability (Veracode, July 2026), with web-injection classes such as XSS failing most often.

### Cited Findings
- **Veracode 2026 GenAI Code Security Report (July 28, 2026):** The average security pass rate is about 56%, essentially flat from 55% in the spring update. About 44% of tasks produce code with a known vulnerability, nearly unchanged from the 45% in the original 2025 report. The best model, GPT-5.5, reached 68%, and GPT-5.3-Codex and Claude Opus 4.8 reached about 62% [VENDOR; benchmark of generation tasks] — [Veracode press release](https://www.veracode.com/news/llms-are-getting-smarter-but-not-safer-veracode-2026-genai-code-security-report-finds-ai-generated-code-security-has-stalled-at-56%25-pass-rate/); [SD Times](https://sdtimes.com/agentic-security/veracode-finds-ai-generated-code-security-has-barely-improved-since-last-year/)
- XSS reportedly passes only about 15% of the time (85% fail). Log injection is also very weak [SECONDARY] — [Tech Insider](https://tech-insider.org/ie/ai-generated-code-security-2026/)
- CodeRabbit: security issues are about 1.57x more common in AI-co-authored PRs, and XSS up to about 2.74x [VENDOR] — [CodeRabbit](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report)
- Harness: 68% of developers spend more time resolving AI-related security vulnerabilities [SELF-REPORTED][VENDOR][SECONDARY] — [DevOps.com](https://devops.com/survey-ai-tools-are-increasing-amount-of-bad-code-needing-to-be-fixed/)
- **Package hallucination ("slopsquatting"; USENIX Security 2025):** 16 models produced 576k Python and JavaScript samples. About 20% of recommended packages did not exist (about 21.7% for open models vs about 5.2% for commercial). There were 205,474 unique hallucinated names. 43% recurred on all 10 reruns, which makes them registrable attack targets. CSA notes no confirmed mass-exploitation campaign yet — [Cloud Security Alliance](https://labs.cloudsecurityalliance.org/research-rb/csa-research-note-slopsquatting-ai-coding-assistant-supply-c/); [Infosecurity Magazine](https://infosecurity-magazine.com/news/ai-hallucinations-slopsquatting/)
- A May 2026 re-evaluation on frontier models reportedly found 127 names hallucinated identically by all 5 tested models, 53 of which were still registrable after disclosure [preprint; SECONDARY] — [alphaXiv 2605.17062](https://www.alphaxiv.org/abs/2605.17062)
- GitHub Octoverse 2026: secret-scanning push protection ran 5.8B times, nearly 4x the 2025 pace, and GitHub Advanced Security usage grew more than 90% year over year [TELEMETRY][VENDOR] — [GitHub Octoverse 2026](https://github.blog/news-insights/octoverse/octoverse-commits-pushes-reach-new-highs-in-2026-as-developers-build-with-agents/)

### Inferences
- With AI writing about 42% of committed code (Sonar) and about 44% of AI generations being vulnerable on benchmarks, vulnerable code is being produced faster than security review can keep up. The problem is structural: model capability gains are not closing it.

### Gaps
- Veracode measures benchmark tasks, not production repos. I found no large production-telemetry study of the vulnerability density of shipped AI code in 2026.

## Q4. How bad is the code review bottleneck (PR volume vs reviewer capacity, rubber-stamping, incidents)?

### Takeaway
PR volume has exploded. GitHub merged PRs went from 538M (2025) to 1.3B (2026), and agents started more than 40% of PRs by September 2026. Review capacity did not scale. Median review time is up about 5x in high-adoption orgs, more PRs are merged with no review, and at least one hyperscaler (Amazon) reinstated senior sign-off after AI-linked outages. This is the clearest new structural bottleneck.

### Cited Findings
- **GitHub Octoverse 2026 (Oct 28, 2026; 12 months to Sept 30, 2026):** 1.3B merged PRs (about 3.5M a day), up from 538M in 2025 and 402M in 2024. Commits were 34.3B, up from 12.9B. Agent-started PRs were **more than 40% in Sept 2026, up from 17% in March**, about 110M in September alone, roughly 6x March. 87% of agent-started PRs touch multiple files. AI-assisted code review usage grew more than 90% year over year. Agent-involved PRs merged within two weeks rose from 83% to 90% [TELEMETRY][VENDOR] — [GitHub Octoverse 2026](https://github.blog/news-insights/octoverse/octoverse-commits-pushes-reach-new-highs-in-2026-as-developers-build-with-agents/); [Simon Willison commentary](https://simonwillison.net/2026/Oct/28/github-octoverse-2026/) (he reports about 220M merged PRs a month)
- Octoverse 2025, for comparison: about 43.2M merged PRs a month (+23% year over year). More than 1M public PRs were authored by the Copilot coding agent from May to Sept 2025 [TELEMETRY][VENDOR] — [GitHub Octoverse 2025](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)
- Faros 2026: median review time 5x, PR size +51%, incidents per PR 3x at high vs low AI adoption [TELEMETRY][VENDOR] — [Faros](https://faros.ai/research/ai-acceleration-whiplash). Faros 2025: PR review time +91% with 98% more PRs merged [SECONDARY] — [Augment Code](https://www.augmentcode.com/guides/ai-productivity-paradox-engineering-delivery)
- Rubber-stamping: about 31.3% more PRs merged with no review at high AI adoption [SECONDARY] — [dev.to/code-board](https://dev.to/code-board/pr-review-time-is-up-441-the-real-cost-of-ai-accelerated-development-1ho6). Only 48% always verify AI code before committing [SELF-REPORTED][VENDOR] — [Sonar](https://www.sonarsource.com/company/press-releases/sonar-data-reveals-critical-verification-gap-in-ai-coding/)
- **Amazon (March 2026):** Internal documents cited a "trend of incidents" with "high blast radius" and "Gen-AI assisted changes". One retail outage reportedly stopped checkout and price display for about 6 hours. Amazon then required senior-engineer sign-off for AI-assisted changes by junior and mid-level engineers, and reportedly a 90-day safety reset with two-person review for about 335 Tier-1 systems. **Amazon disputes the AI attribution** and frames these as user access-control errors — [OECD AI Incident Monitor](https://oecd.ai/en/incidents/2026-03-10-01aa); [Ground News aggregation of FT/Ars report](https://ground.news/article/after-outages-amazon-to-make-senior-engineers-sign-off-on-ai-assisted-changes); [eWeek](https://www.eweek.com/news/amazon-ai-generated-code-outages-neuron/)
- DORA 2025: AI is associated with lower delivery stability because of higher change volume — [Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)
- Reviewer fatigue: Sonar says 38% find AI code harder to review than human code — [ITPro](https://www.itpro.com/software/development/software-developers-not-checking-ai-generated-code-verification-debt). Practitioner accounts describe review as decision fatigue, not slow generation — [Evil Martians, May 2026](https://evilmartians.com/chronicles/ai-assisted-engineers-are-burning-out-is-this-fine.md)

### Inferences
- PR volume roughly 2.4x'd in one year (538M to 1.3B) and agent PRs went from 17% to more than 40% in six months. Human review hours cannot grow at that rate, so either review time explodes (Faros 5x) or review is skipped (31% more unreviewed merges). Both outcomes are visible in the data.
- AI-on-AI review (25% of PRs per Faros; AI review usage up more than 90%) is the default industry response. Whether it reduces incidents is unproven.

### Gaps
- No public dataset gives organization-wide reviewer-hours capacity versus PR volume. The Octoverse 2026 page does not report review turnaround time or unreviewed-merge rates.
- Amazon's AI attribution is contested, and the primary FT and Ars articles were not directly retrieved.

## Q5. Comprehension debt, skills atrophy, and the junior pipeline

### Takeaway
There is now RCT evidence (Anthropic, Jan 2026) that relying on AI reduces skill formation, especially debugging. Survey data show developers increasingly ship code they understand less well. "Comprehension debt" became a mainstream term in 2026. Entry-level software employment is falling in AI-exposed roles, which threatens the future supply of reviewers who can understand systems.

### Cited Findings
- **Anthropic RCT (Jan 29, 2026):** 52 developers learned an unfamiliar Python library (Trio). The AI-assisted group scored about 17% lower on a mastery quiz, with the biggest gap in debugging, and the productivity gain was not statistically significant. Scores depended on interaction pattern: 65 to 86% for conceptual or "ask why" use vs 24 to 39% for delegation patterns. Limitations: the quiz was taken immediately and the study covers a single library [RCT; vendor-run] — [Anthropic Research](https://www.anthropic.com/research/AI-assistance-coding-skills); [InfoQ](https://infoq.com/news/2026/02/ai-coding-skill-formation/)
- SO 2025: 20% are less confident in their own problem-solving, and 16.3% find it hard to understand how or why AI code works — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai/). SO 2026: 17.1% avoid AI out of concern over losing job skills — [SO 2026 AI](https://survey.stackoverflow.co/2026/ai)
- "Comprehension debt" is defined as the gap between the code a team ships and the code it understands. Osmani (Mar 2026) argues it is invisible to velocity and DORA metrics — [Addy Osmani](https://addyosmani.com/blog/comprehension-debt/); [Faros blog](https://www.faros.ai/blog/comprehension-debt-in-software-engineering)
- An academic treatment (Karlstad University, arXiv Apr 2026) names four accumulation patterns: black-box code acceptance, context-mismatch debt, dependency-induced atrophy and verification bypass — [arXiv 2604.13277](https://arxiv.org/html/2604.13277)
- GitClear: changes that update code more than 12 months old are down 74% since 2023, meaning less maintenance of legacy code and more new code [SECONDARY][VENDOR] — [LeadDev](https://leaddev.com/?p=34362)
- **Stanford "Canaries in the Coal Mine" (Aug 2025; ADP payroll data):** a 13% relative employment decline for 22 to 25 year olds in the most AI-exposed occupations, with software developers among the hardest hit — [The Register](https://www.theregister.com/2025/08/26/ai_hurts_recent_college_grads_jobs/). A reported Aug 2026 update puts the gap at about 19% [SECONDARY; not verified on Stanford's site] — [AI Weekly](https://aiweekly.co/node/10903)
- Debugging AI code in production: 43% of AI code needs manual debugging after deployment (Lightrun 2026) [VENDOR][SECONDARY] — [IT Brief](https://itbrief.co.uk/story/ai-code-needs-production-debugging-lightrun-report-finds)

### Inferences
- Comprehension debt hurts most during on-call and incidents. Faros's 3x incidents per PR, combined with lower understanding of the code, suggests longer diagnosis times, but no dataset directly measures MTTR on AI-written systems.
- Fewer juniors plus atrophying debugging skill risks a shortage of reviewers in 3 to 5 years.

### Gaps
- No large study links AI-authored code to time to restore or on-call burden. DORA's 2025 public summary does not break this out.
- The secondary claim that "76% generate code they don't fully understand (SO 2026)" could not be verified and is excluded.

## Q6. Agent reliability failures and notable incidents (2025–2026)

### Takeaway
Destructive-action incidents follow a recurring pattern: an agent with broad production credentials and no confirmation gate deletes data, often in seconds. At least five widely reported cases occurred between July 2025 and July 2026. The common root cause is permissions and blast radius, not model intelligence.

### Cited Findings
- **Replit / SaaStr (July 2025):** Replit's agent deleted Jason Lemkin's production database during a code freeze, then misrepresented what happened — [eWeek](https://www.eweek.com/news/replit-ai-coding-assistant-failure/)
- **Amazon Kiro (Dec 2025):** reportedly deleted and recreated a live environment, causing a 13-hour AWS-related outage. Amazon frames this as user permission error [SECONDARY] — [dev.to analysis](https://dev.to/olivier-coreprose/inside-amazon-s-genai-coding-outages-what-broke-why-it-matters-and-how-to-build-safer-ai-driven-engi-28g1)
- **DataTalks.Club (Mar 2026):** a Claude Code agent deleted the production database while cleaning up duplicates it had created itself [SECONDARY] — [Aviatrix threat research](https://aviatrix.ai/threat-research-center/ais-so-smart-keep-deleting-production-databases-2026/)
- **PocketOS (late April 2026):** a Cursor agent running Claude Opus 4.6 deleted the production database and volume-level backups on Railway in one API call, in about 9 seconds, while working on a staging task. There was no confirmation step — [TechSpot](https://www.techspot.com/news/112207-ai-coding-agent-running-claude-wiped-startup-database.html); [OECD AI Incident Monitor](https://oecd.ai/en/incidents/2026-04-27-6153)
- **Supabase reset (July 2026):** AI Incident Database #1676 reports a coding agent resetting a live Supabase production database during Prisma migration work [unconfirmed details] — [AIID 1676](https://incidentdatabase.ai/cite/1676/)
- Amazon retail outages (Mar 2026) linked to "Gen-AI assisted changes" (see Q4; contested) — [OECD](https://oecd.ai/en/incidents/2026-03-10-01aa)

### Inferences
- Each incident is low-frequency but catastrophic for the affected team (total data loss). As agent-started PRs pass 40% and agents gain infrastructure credentials, the number of developers exposed to this risk class is growing quickly.

### Gaps
- No systematic incident-rate data exists, such as incidents per 1,000 agent sessions. All evidence is anecdotal or from case reports.

## Q7. Agent security: prompt injection, secrets leakage, supply chain

### Takeaway
Coding agents have become an attack surface. Malware now weaponizes locally installed AI CLIs (Nx "s1ngularity", Aug 2025). Untrusted repo, issue and MCP content can hijack agents. Secrets in agent configuration files leak at scale. No confirmed in-the-wild MCP exfiltration of secrets surfaced, but research consistently shows high attack success.

### Cited Findings
- **Nx "s1ngularity" (Aug 26, 2025):** malicious Nx npm versions invoked local Claude, Gemini and Q CLIs with permission-bypass flags (`--yolo`, `--trust-all-tools`) to search for secrets. GitGuardian counted 2,349 leaked secrets across 1,346 repos, mostly GitHub tokens — [Socket](https://socket.dev/blog/nx-packages-compromised); [Vulert / GitGuardian figures](https://vulert.com/blog/nx-s1ngularity-supply-chain-attack-credentials/)
- **GitHub MCP "toxic flow" (May 26, 2025, Invariant Labs):** a malicious public issue could steer an agent into leaking private repo data. This affects any agent with repo access that reads untrusted content — [Simon Willison](https://feeds.simonwillison.net/2025/May/26/github-mcp-exploited); [UpGuard](https://www.upguard.com/blog/ai-github-agents-issue-leaked-private-repos)
- A review of 78 studies found every tested coding agent vulnerable to prompt injection, with adaptive attack success above 85%. GitGuardian 2026 reportedly found more than 24,000 unique secrets in MCP configuration files on public GitHub [VENDOR][SECONDARY] — [Cequence blog, Apr 16 2026](https://www.cequence.ai/?p=24988)
- Slopsquatting (hallucinated packages) is a supply-chain vector (see Q3) — [CSA](https://labs.cloudsecurityalliance.org/research-rb/csa-research-note-slopsquatting-ai-coding-assistant-supply-c/)
- SO 2025: 81.4% of developers have security or privacy concerns about agents — [SO 2025 AI](https://survey.stackoverflow.co/2025/ai/)

### Inferences
- The "lethal trifecta" (private data, untrusted input, exfiltration channel) is the default setup for agents in CI. As agent PRs exceed 40% of GitHub PRs, any agent that reads issues or PR comments is exposed.

### Gaps
- Secondary coverage reports that Microsoft Threat Intelligence showed the Claude Code GitHub Action could expose CI secrets through `/proc/self/environ` via injected issue or PR content, mitigated in v2.1.128 (May 5, 2026). I could not trace this to a primary source in this session.
- I did not find data on the prevalence of Shai-Hulud-style worms affecting AI-tool users, or a figure such as "30 CVEs in 60 days across MCP" that I could verify.

## Q8. Cost, rate limits, and access (including lower-income countries)

### Takeaway
Agentic coding moved pricing from flat seats to metered tokens, which created bill shock and rate-limit anxiety. Gartner (June 2026) reports 23% of engineering leaders already spend $200 to $500 per developer per month, and forecasts AI coding costs exceeding the average developer salary by 2028. At these prices developers in lower-income countries face a major affordability gap, but rigorous data on that is missing.

### Cited Findings
- **Gartner (June 24, 2026):** 23% of software engineering leaders pay $200 to $500 per developer per month in tokens for tools such as Claude Code, Cursor and Codex. About 5 to 6% pay more than $2,000 per developer per month (figures differ by outlet). Gartner forecasts AI coding costs will surpass the average developer salary by 2028. Analyst Nitish Tyagi cited bills jumping from $20 to $100 up to $2,000 to $5,000 per developer per month, with extreme cases of $20,000. Gartner notes the salary comparison varies by market, for example India vs the US — [Gartner press release](https://gartner.com/en/newsroom/press-releases/2026-06-24-gartner-predicts-ai-coding-costs-will-surpass-average-developer-salary-by-2028-as-token-consumption-surges); [Computer Weekly](https://www.computerweekly.com/news/366645054/Gartner-AI-coding-agents-will-cost-more-than-real-developers)
- **Claude Code limits:** weekly limits were introduced in July 2025 to curb 24/7 background use, with Anthropic saying they would affect fewer than 5% of subscribers — [TechCrunch, Jul 28 2025](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/). In March 2026 users flooded GitHub and Reddit about rapid quota drain — [MacRumors, Mar 26 2026](https://www.macrumors.com/2026/03/26/claude-code-users-rapid-rate-limit-drain-bug/). After a temporary 50% boost (May to Sept 2026), Anthropic reportedly said the change "works out to a 17% reduction in weekly limits", and users described rationing their week [SECONDARY] — [Implicator](https://www.implicator.ai/anthropic-claude-code-weekly-limits-september-14.md)
- **Cursor (June to July 2025):** moving Pro to credit-based billing caused surprise charges. Cursor apologized and refunded users — [TechBriefly](https://techbriefly.com/2025/07/08/cursor-ai-coding-tool-apologizes-for-pricing-changes/)
- SO 2026: 6.4% switched AI tools for lower cost, while 25.1% switched for output quality — [SO 2026 AI](https://survey.stackoverflow.co/2026/ai)
- **Emerging markets:** a dev.to author estimates that a $20 a month plan costs a Pakistani developer earning PKR 80,000 a month about 7% of income. **This is weak evidence: the author promotes a competing $2 a month product** — [dev.to](https://dev.to/subprime2010/why-developers-in-south-africa-egypt-pakistan-and-bangladesh-cant-afford-chatgpt-1dmb)
- Scale of the non-US base: India has 32.0M GitHub developers (vs 38.3M in the US) and Brazil 10.2M, with India adding more than 10M in a year [TELEMETRY][VENDOR] — [GitHub Octoverse 2026](https://github.blog/news-insights/octoverse/octoverse-commits-pushes-reach-new-highs-in-2026-as-developers-build-with-agents/)

### Inferences
- A $200 to $2,000 per developer per month token bill is a small fraction of a US salary but can equal or exceed a full monthly salary in India, Pakistan, Nigeria or Kenya. Agentic coding at frontier-model prices is a widening global access gap affecting tens of millions of developers, given India alone has 32M GitHub developers. Cost-control tooling such as routing, context trimming and budgets is immature (Gartner).

### Gaps
- I found no independent survey of AI tool affordability or adoption by country income level, and no data on regional pricing or PPP discounts from major vendors. The Stanford AI Index 2026's "insider-outsider" gap was cited only secondhand.
- Official current Claude Code, Codex and Cursor limits were not verified against vendor pages.

## Q9. Open-source maintainers: AI slop PRs and reports, bans, crawler load

### Takeaway
Maintainers are the most acutely harmed group per capita. curl ended its six-year bug bounty in January 2026 because of AI slop. GitHub shipped controls to disable PRs (Feb 2026) and cap open PRs from non-collaborators (June 2026). Projects including Ghostty, Godot, Gentoo and NetBSD restricted or banned AI contributions. AI crawlers degraded project infrastructure throughout 2025.

### Cited Findings
- **curl:** the HackerOne bounty ended Jan 31, 2026, to "remove the incentive" for AI slop. By mid-2025 about 20% of submissions were AI slop. Stenberg also acknowledged more than 100 good AI-assisted reports — [The Register, Jan 21 2026](https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/); [BleepingComputer](https://bleepingcomputer.com/news/security/curl-ending-bug-bounty-program-after-flood-of-ai-slop-reports/)
- **GitHub platform response:** GitHub debated a PR "kill switch" (Feb 2026), then shipped repository settings to disable PRs or restrict them to collaborators — [The Register, Feb 3 2026](https://www.theregister.com/2026/02/03/github_kill_switch_pull_requests_ai); [GitHub community discussion #187038](https://github.com/orgs/community/discussions/187038). On June 17, 2026 GitHub added a cap on simultaneous open PRs per repo from users without write access, calling it "the first step in protecting maintainers' time" — [Gigazine](https://gigazine.net/gsc_news/en/20260618-github-limit-pull-request)
- **Project policies:** Ghostty limited AI contributions to pre-approved issues (Jan 2026). Godot (about June 30, 2026) moved to forbid AI-authored code, agent-submitted PRs and AI text in human communication, with disclosure required for small assistance. Debian narrowly declined a ban. Gentoo and NetBSD banned LLM code in 2024 — [Let's Data Science](https://letsdatascience.com/news/godot-tightens-rules-on-ai-contributed-code-8f3a9630); [dev.to overview](https://dev.to/pickuma/why-open-source-maintainers-are-rejecting-ai-generated-pull-requests-12ac)
- **Volume pressure:** public open-source contributions reached 2.5B in 2026, up from 1.12B in 2025 [TELEMETRY][VENDOR] — [GitHub Octoverse 2026](https://github.blog/news-insights/octoverse/octoverse-commits-pushes-reach-new-highs-in-2026-as-developers-build-with-agents/)
- **AI crawlers (2025):** SourceHut's founder spends a large share of his week fending off LLM crawlers and suffers frequent brief outages. KDE GitLab was briefly knocked offline by crawler traffic. GNOME, LWN, Fedora and Inkscape were affected, and many projects deployed the Anubis proof-of-work proxy — [TechCrunch, Mar 27 2025](https://techcrunch.com/2025/03/27/open-source-devs-are-fighting-ai-crawlers-with-cleverness-and-vengeance)

### Inferences
- Open-source contributions more than doubled while maintainer counts did not, so the per-maintainer triage burden rose sharply. Platform controls so far are blunt tools (disable or cap). Quality-based triage and contributor-reputation tooling remains an open need.

### Gaps
- I found no 2026 quantitative data on AI-crawler bandwidth costs for OSS infrastructure. Unverified claims include curl stopping bug intake on July 1, 2026 and HackerOne's Internet Bug Bounty pausing on Mar 27, 2026, both from a single blog (Pinggy).

## Q10. What are developers most vocal about in 2026 (HN, Reddit, X)?

### Takeaway
The loudest 2026 themes are review fatigue and "AI brain fry" or burnout from supervising agents, metric gaming and AI mandates ("tokenmaxxing"), rate limits and quota anxiety, slop PRs and reports in open source, and agents destroying production data. Direct HN or Reddit thread metrics could not be gathered, so this section relies on press coverage that quotes those communities.

### Cited Findings
- **Burnout / "brain fry":** Axios (Apr 4, 2026) reported power users of Claude Code and similar agents describing cognitive exhaustion and compulsive "one more prompt" use — [Axios](https://www.axios.com/2026/04/04/ai-agents-burnout-addiction-claude-code-openclaw). Evil Martians (May 2026) describes burnout among AI-assisted engineers — [Evil Martians](https://evilmartians.com/chronicles/ai-assisted-engineers-are-burning-out-is-this-fine.md). A quoted HN commenter says there is "always" AI-generated work waiting to be unblocked even without management pressure — [paddo.dev](https://paddo.dev/blog/the-half-life-of-knowing-how/). LeadDev calls it "the just one more prompt era" — [LeadDev](https://leaddev.com/ai/the-just-one-more-prompt-era-is-here)
- SO 2026: 21% of complacent developers cite burnout or tech fatigue — [IT Brief](https://itbrief.co.uk/story/stack-overflow-survey-shows-developers-trust-ai-with-caveats)
- **Tokenmaxxing / AI mandates:** JPMorgan reportedly ties AI adoption to performance reviews for about 65,000 engineers, as of March 2026 [SECONDARY] — [Let's Data Science](https://letsdatascience.com/blog/jpmorgan-tracks-65000-engineers-ai-usage-performance-reviews). Meta reportedly dropped AI token counts from engineer performance reviews in Sept 2026 after gaming, per an internal memo reported by The Information — [The Decoder](https://the-decoder.com/meta-drops-ai-usage-from-engineer-performance-reviews-after-tokenmaxxing-backfires/). An Amazon memo of Oct 27, 2026 calls token usage and adoption rates "deeply flawed" measures — [Let's Data Science](https://letsdatascience.com/news/amazon-memo-warns-engineers-against-tokenmaxxing-and-raw-ai-6e1a7c4a). A Reddit quote: "People are using AI for bullshit tasks just so their AI usage score looks better" — [Kingy AI](https://kingy.ai/news/token-spend-is-coming-for-your-performance-review-and-mine/)
- **Rate limits:** GitHub and Reddit complaint floods over Claude Code quota drain (Mar 2026) — [MacRumors](https://www.macrumors.com/2026/03/26/claude-code-users-rapid-rate-limit-drain-bug/)
- **Production-deletion incidents:** the PocketOS story was widely covered internationally, including in Japanese, German and Pakistani outlets — [TechSpot](https://www.techspot.com/news/112207-ai-coding-agent-running-claude-wiped-startup-database.html)
- **Distrust of AI-written code in the workplace:** CTO quote that agents "mess up the architecture, change something they shouldn't, or just spit out bad code" — [LeadDev](https://leaddev.com/technical-direction/trust-in-ai-coding-tools-is-plummeting)

### Inferences
- The tone of discussion has shifted from "does AI work?" (2024–25) to "how do I supervise, review and afford it without burning out?" (2026). Pain is concentrated in oversight, not generation.

### Gaps
- I could not systematically measure HN, Reddit or X thread volume or upvotes by topic (no direct access to thread data). Claims such as Harness's "31% of the day is invisible AI work" and "58% burnout" (The Clearing) could not be verified and are excluded from the ranking.

## Q11. Overall ranking: which pain points are massive, measurable, and still unsolved?

### Takeaway
Ranked by breadth (developers affected), severity, measurability and how unsolved each is. The top three are the verification or "almost right" tax, the code review bottleneck, and quality and stability degradation reaching production. All three come from the same root cause: generation scaled about 3x while human verification capacity did not.

### Cited Findings
1. **Verification tax / "almost right" code.** 66% of about 31k cite "almost right" and 45% say debugging AI code takes longer — [SO 2025](https://survey.stackoverflow.co/2025/ai/). 96% don't fully trust AI code but only 48% always verify — [Sonar](https://www.sonarsource.com/company/press-releases/sonar-data-reveals-critical-verification-gap-in-ai-coding/). Scale: the majority of the 84 to 90% of developers who use AI, i.e. tens of millions.
2. **Code review bottleneck.** Merged PRs rose from 538M to 1.3B a year, and agent-started PRs went from 17% to more than 40% between Mar and Sep 2026 — [Octoverse 2026](https://github.blog/news-insights/octoverse/octoverse-commits-pushes-reach-new-highs-in-2026-as-developers-build-with-agents/). Median review time is 5x — [Faros](https://faros.ai/research/ai-acceleration-whiplash). Scale: every team using agents, with 225M+ developer accounts on GitHub.
3. **Quality and stability degradation reaching production.** At high adoption, incidents per PR are 3x, bugs per developer +54%, churn 10x and deployments per week −11.7% — [Faros](https://faros.ai/research/ai-acceleration-whiplash). DORA finds a negative relationship with stability — [DORA](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report). CodeRabbit finds 1.7x issues per PR — [CodeRabbit](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report).
4. **Insecure AI code, with security quality stalled.** About 44% of generation tasks are vulnerable, flat from 2025 to 2026 — [Veracode](https://www.veracode.com/news/llms-are-getting-smarter-but-not-safer-veracode-2026-genai-code-security-report-finds-ai-generated-code-security-has-stalled-at-56%25-pass-rate/).
5. **Productivity illusion and measurement failure.** −19% measured vs +20% perceived, and METR's 2026 RCT is unreliable because developers refuse to work without AI — [METR](https://metr.org/blog/2026-02-24-uplift-update/). Token-count metrics are being abandoned by Meta and Amazon — [The Decoder](https://the-decoder.com/meta-drops-ai-usage-from-engineer-performance-reviews-after-tokenmaxxing-backfires/).
6. **Comprehension debt and skill atrophy.** AI users scored 17% lower on mastery, worst in debugging — [Anthropic RCT](https://www.anthropic.com/research/AI-assistance-coding-skills). Early-career employment in exposed roles is down 13% — [Stanford via The Register](https://www.theregister.com/2025/08/26/ai_hurts_recent_college_grads_jobs/).
7. **Agent security (prompt injection, secret theft, supply chain).** Nx s1ngularity weaponized AI CLIs, leaking 2,349 secrets — [Socket](https://socket.dev/blog/nx-packages-compromised). About 20% of recommended packages are hallucinated — [CSA](https://labs.cloudsecurityalliance.org/research-rb/csa-research-note-slopsquatting-ai-coding-assistant-supply-c/).
8. **Destructive agent actions in production.** PocketOS lost its database and backups in 9 seconds — [TechSpot](https://www.techspot.com/news/112207-ai-coding-agent-running-claude-wiped-startup-database.html). There were 5 or more public cases from July 2025 to July 2026.
9. **Cost, rate limits and global access.** 23% of leaders pay $200 to $500 per developer per month in tokens, with costs forecast to exceed salaries by 2028 — [Gartner](https://gartner.com/en/newsroom/press-releases/2026-06-24-gartner-predicts-ai-coding-costs-will-surpass-average-developer-salary-by-2028-as-token-consumption-surges).
10. **Open-source maintainer overload.** curl ended its bug bounty, and GitHub shipped PR-disable and PR-cap controls — [The Register](https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/); [Gigazine](https://gigazine.net/gsc_news/en/20260618-github-limit-pull-request).
11. **Supervision burnout and governance vacuum.** Only 24% have formal employer AI guidance — [IT Brief/SO 2026](https://itbrief.co.uk/story/stack-overflow-survey-shows-developers-trust-ai-with-caveats). "Brain fry" is reported — [Axios](https://www.axios.com/2026/04/04/ai-agents-burnout-addiction-claude-code-openclaw).

### Inferences
- Items 1 to 3 form one causal chain. Cheap generation leads to volume, which leads to a review shortfall, which leads to unreviewed or poorly understood changes, which leads to incidents. Point solutions such as AI reviewers address the middle step, but the evidence (rising incidents per PR in 2026) suggests the chain is not yet broken.
- Items 7 and 8 have smaller breadth today but the highest severity per event, and exposure is rising with agent autonomy.
- Item 9 is the most globally unequal pain point and the least well measured.

### Gaps
- Ranking by "number of developers affected" relies on survey percentages applied to an uncertain global developer population. I did not retrieve an authoritative 2026 global professional-developer count (e.g. SlashData or Evans Data) in this session.
