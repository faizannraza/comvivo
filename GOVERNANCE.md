# Governance

M0 skeleton; final form at M15 (`13` §3.F.5).

Comvivo has **one maintainer** today. Writing the governance down before there are people to
govern is deliberate: the rules are easier to agree when nobody's specific contribution is at
stake, and a project that asks for trust with people's family conversations should be able to say
who decides things and how.

## The Protected Promises

These are the commitments that do not change with a maintainer vote. Changing one requires an RFC,
a 30-day comment period, and unanimous agreement of the maintainers — and if it ever happens, it
will be announced loudly rather than shipped quietly in a minor release.

1. **No telemetry and no phone-home.** No analytics, no usage counting, no crash reporting, not
   even opt-in. The update check is off by default, reads a static file, and is served from a host
   that gives us no request logs.
2. **The discretion invariants (I1–I7) hold.** No read-up, no write-down, requester authority,
   group isolation, guarded egress, exactly-once intent, acknowledged effects. These are
   machine-checked, not aspirational.
3. **Apache-2.0 core, with no paywalled privacy or safety feature.** If a feature protects someone,
   it is in the free version. There is no "enterprise discretion".
4. **Official platform APIs only.** No unofficial WhatsApp or iMessage clients, no scraping. A
   family's account being banned is not an acceptable cost.
5. **Export everything, delete anything.** Your data stays yours and stays portable.
6. **No feature designed to surveil a member.** Comvivo will not be built into a tool for one
   person to monitor another, including a parent monitoring a child. Age-appropriate behaviour is
   not the same as reporting.

## Roles

| Role | How you get it | What it gives |
|---|---|---|
| **Contributor** | Open a pull request | — |
| **Triager** | About five quality interactions | Triage permissions: labels, assignment, closing duplicates |
| **Committer** | Sustained contribution; nominated by a maintainer; no objection within 7 days | Write access **outside** the protected areas |
| **Maintainer** | Nominated, then two-thirds maintainer approval | Votes; reviews the protected areas |
| **Emeritus** | Stepping back, with thanks | Listed, no permissions |

Non-code contribution counts. Somebody who writes red-team scenarios that find real discretion
failures is doing the work this project exists to do.

[`MAINTAINERS.md`](MAINTAINERS.md) lists who holds which role.

## Decisions

- **Lazy consensus** on pull requests: no objection within the review window means yes.
- A **disputed** decision goes to a maintainer vote, simple majority.
- The **lead maintainer breaks ties** until there are five or more maintainers. After that, a
  three-to-five-person steering council is elected yearly.
- Every decision is recorded in the pull request or the RFC. Nothing is decided in a private
  channel; if it starts there, it gets written down before it counts.

## RFCs

An RFC (`docs/rfcs/NNNN-title.md`) is **required** for:

- breaking changes to `@comvivo/plugin-sdk`;
- constitution schema changes;
- information-flow or label semantics;
- anything that adds network egress, or touches the no-telemetry promise;
- new channels in core;
- default proactivity budgets;
- retention defaults;
- licence, code-of-conduct or governance changes.

**Sections:** Summary · Motivation · Design · **Privacy and information-flow impact (mandatory)** ·
Security impact · Alternatives · Migration · Unresolved questions.

The privacy section is mandatory even when the answer is "none" — writing "none" is a claim
somebody can disagree with, and a blank is not.

**Flow:** Discussion → RFC pull request → 14-day comment period → 7-day final comment period,
announced in Discussions → accepted, rejected or postponed.

## Code of Conduct enforcement

Reports go to the contact in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Maintainers who are the
subject of a report recuse themselves. The enforcement ladder is the Contributor Covenant's:
correction, warning, temporary ban, permanent ban.

**Known gap:** the conduct address reaches one person today, so a report about the lead maintainer
has nowhere neutral to go. `13` §3.F.1 requires at least two, and this is fixed by the second
maintainer.
