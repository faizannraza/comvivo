# Security Policy

Content per `docs/plan/08-security-privacy.md` §3.18. This is the M0 version: the text is final,
but the dedicated `security@` address and PGP key arrive with the domain.

## Supported versions

Before 1.0: only the latest release receives fixes. From 1.0: the latest minor of the current
major. When a new major ships, the previous major's last minor receives security and
data-integrity fixes for 12 months. Release lines are defined in
[`docs/architecture/release.md`](docs/architecture/release.md) and `12` §3.10.6.

**Today there is no release at all** — Comvivo is pre-1.0 and unannounced. If you are reading this
because you found something in `main`, please still report it; it is easier to fix now than later.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:

> Security → Advisories → **Report a vulnerability**
> <https://github.com/faizannraza/comvivo/security/advisories/new>

This is enabled and is the preferred route. If you cannot use GitHub, email
**faizanraza766@gmail.com** with `comvivo security` in the subject. A dedicated `security@` address
and a PGP key replace that once the project domain exists.

Please include: version or commit, deployment (Docker, npm, Home Assistant), the configuration that
matters (exposure mode, providers, plugins), reproduction steps or a scenario transcript, and the
impact.

**For privacy leaks, use synthetic data only.** Never send us real members' messages — a report
about a discretion failure should not itself be a discretion failure. Comvivo's own simulator can
generate a realistic group if you need one.

## What to expect

- Acknowledgement within **3 business days**; triage and severity within **7 days**.
- Fix targets: **Critical 7 days · High 30 days · Medium 90 days · Low** next minor release.
- Coordinated disclosure: we publish a GitHub Security Advisory, with a CVE via GitHub, when a fix
  is released, or at **90 days**, whichever comes first, unless we agree otherwise with you.
- Credit is given unless you ask not to be named.
- **There is no bug bounty.** This is a volunteer project; we would rather be honest about that up
  front than imply a reward that does not exist.

## Scope

**In scope.** Anything that lets someone:

- read data they are not allowed to see — **including another member's private information
  surfacing through Comvivo's replies**, which is the central thing this project claims to prevent;
- act beyond their role, or get a consequential action taken without an authorised confirmation;
- bypass dashboard authentication;
- escape plugin isolation on a supported configuration;
- break encryption at rest or of backups;
- compromise releases.

**Out of scope.**

- Attacks that require the host's machine or keys. The host is trusted by design — see the threat
  model in `docs/plan/08-security-privacy.md`, and `/trust/threat-model/` once the docs site is up.
- Platform vulnerabilities. Report those to Telegram, Signal, Matrix, Discord or Slack.
- Model "jailbreaks" with no privacy or authority impact. Getting Comvivo to say something rude is
  not a security issue; getting it to reveal a private message is.
- Self-XSS.
- Missing headers with no demonstrated impact.
- Denial of service that requires more traffic than a group could plausibly send.

## Safe harbour

We will not pursue or support legal action against good-faith research that respects users'
privacy, avoids data destruction and service disruption, uses only your own instances and test
accounts, and gives us reasonable time to fix an issue before disclosing it.
