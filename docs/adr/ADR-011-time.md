# ADR-011 — Time, timezones and recurrence

- **Status:** **Accepted (addendum pending SP-7)**
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** related: §14 **A7** (`Group.timezone`/`locale`, per-occurrence reminder schedule and the `ReminderFiring` ledger, all-day events and overrides)

## Context

- Village's groups are families and friends spread across timezones. "Dinner at 7" means a wall-clock time in someone's zone, and a reminder that fires an hour early because of a DST transition is the kind of bug that gets a bot removed from a group.
- `@village/core` is pure: no `Date`, no ambient clock. The clock is injected (ADR-020). Any time library used in core must be deterministic and testable with a `VirtualClock`.
- Calendar features need real RFC 5545 semantics: recurrence, `EXDATE`, per-occurrence overrides, series splits, all-day events, and ICS import/export (`07`).
- Natural-language dates ("next Tuesday after school") arrive in chat, in several languages.

## Decision

| Concern | Choice |
|---|---|
| Date/time API | **Temporal**, via **`temporal-polyfill`**, for all date, time and timezone logic |
| Storage | Instants as `INTEGER` epoch **milliseconds** (UTC); calendar times as IANA `tz` + local `PlainDateTime`/`PlainDate` as the **source of truth**, plus a derived instant for indexing and the `tzdata_version` it was computed with (`02` §2 D2, D3) |
| Recurrence | **RFC 5545 via an RRULE library: `rrule-temporal` preferred, `rrule` as the fallback — decided by SP-7** in the M7 spike (`M7-T1`) |
| Natural language | Parsed by **LLM structured output** and **cross-checked with `chrono-node`**. Disagreement means asking, not guessing |
| `Date` | **Banned in `core`** by a lint rule (ADR-003, ADR-020) |

The addendum to this ADR records SP-7's outcome: whether `rrule-temporal` is correct on DST transitions, `EXDATE` and per-occurrence overrides, or whether we fall back to `rrule` plus a Temporal adapter.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Luxon** | Good timezone support, but it wraps `Date` and the JS `Intl` timezone database rather than offering Temporal's explicit distinction between an instant, a zoned datetime and a plain (wall-clock) datetime. That distinction is exactly what prevents the "dinner at 7" class of bug, and we would be re-encoding it by convention. |
| **date-fns-tz** | A thin timezone layer over `Date`; the same conceptual gap as Luxon with less of the convenience, and `Date` is banned in core. |
| **moment** | Deprecated by its own maintainers, mutable, and large. Not a candidate for new code. |

## Consequences

**Good**
- The wall-clock/instant distinction is in the type system, so "7 pm in Karachi" and "the instant that is 7 pm in Karachi" cannot be confused.
- Storing local time as the source of truth means a tzdb rule change can be handled by recomputing derived instants (`02` §3.13.7) instead of silently moving people's events.
- A pure, injectable clock plus Temporal makes DST tests deterministic and fast.

**Bad / accepted costs**
- `temporal-polyfill` is a real runtime dependency with a bundle and CPU cost until Temporal ships natively everywhere; it is also used by the dashboard's calendar views (`09` §2 D-22).
- Recurrence libraries in the Temporal world are young, which is why SP-7 exists and why a fallback is named up front.
- Keeping `tz` + local + derived instant + `tzdata_version` is four columns where naive designs have one, and every writer must set them consistently.

**Follow-ups**
- `M7-T1` — **SP-7**: recurrence and ICS library spike; writes the addendum.
- `M7-T4` — recurrence expansion, overrides and series splits.
- `M7-T13`, `M7-T14` — ICS serializer, feed tokens, subscriptions.
- `M7-T15` — reminders domain and scheduler.
- `M1-T24` — scheduler and the Temporal schedule evaluator for recurring jobs (`02` §2 D12).
- `M13-T13` — localized templates and the multilingual date eval.

## References
- `docs/plan/01-architecture.md` §2 ADR-011, §14 A7
- `docs/plan/02-domain-model-and-storage.md` §2 D2, D3, D12; §3.13.7 (tzdata changes)
- `docs/plan/07-coordination-features.md` §3 (calendar, reminders, recurrence)
- `docs/plan/15-risks-and-open-questions.md` §4 SP-7
