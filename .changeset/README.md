# Changesets

A changeset is a short note describing a change **in terms a host would recognise**, written by the
person who made it. `pnpm changeset` creates one.

Why author-written rather than generated from commit subjects: a commit message explains a change
to the next engineer, and a release note explains it to somebody deciding whether to upgrade their
family's bot. Those are different sentences. `12` §3.10.2 chose Changesets over release-please
mostly for this.

## Writing one

Start the summary with a type. The changelog formatter groups by it, so the type decides which
heading a host reads it under:

| Type | Use it for | Appears under |
|---|---|---|
| `breaking:` | something that will not work after upgrading | **Breaking changes** |
| `security:` | a vulnerability fix | **Security** |
| `upgrade:` | a step the host must take during the upgrade | **Upgrade notes** |
| `feat:` | something new a member can do | **New** |
| `fix:` | something that was wrong and now is not | **Fixed** |
| `perf:` | measurably faster or lighter | **Performance** |
| `docs:` | documentation only | **Documentation** |

Write the rest for a non-technical reader where you can:

```md
---
'comvivo': minor
---

feat: reminders can now be set for "the day before" something on the calendar, so a packed lunch
gets remembered the night before rather than at 7am.
```

## Which package

- `comvivo` — anything in the product. `comvivo` and `@comvivo/server` are a **fixed** group, so
  they always version together and you only need to name one.
- `@comvivo/plugin-sdk`, `@comvivo/channel-sdk` — versioned independently, because a plugin author
  upgrades the SDK on their own schedule.
- Every other workspace is private and has no version, tag or changelog of its own.

## When a changeset is not needed

A pull request that changes only tests, docs, CI or internal tooling does not need one. If
`changeset-required` disagrees and you are sure, add the `no-changeset` label — the label is in the
record, which is the point.
