# M0-T2 evidence: minimumReleaseAge rejects a fresh version

Captured 2026-11-01. `pnpm install` with `minimumReleaseAge: 4320` (three days) against a
lockfile that had resolved `eslint@10.14.0`, published 2026-10-30:

```
Scope: all 25 workspace projects
? Verifying lockfile against supply-chain policies (251 entries)...
✗ Lockfile failed supply-chain policy check (251 entries in 6.9s)
Lockfile is up to date, resolution step is skipped
Error: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION

  × installing dependencies
  ╰─▶ 1 lockfile entries failed verification:
        eslint@10.14.0 was published at 2026-10-30T14:12:27.179Z, within the
      minimumReleaseAge cutoff (2026-10-30T05:49:15.519Z)
  help: The lockfile contains entries that the active policies reject. This
        can mean the lockfile is stale, or that someone committed a lockfile
```

## A fresh resolution picks the newest *eligible* version

Deleting `node_modules` and `pnpm-lock.yaml` and reinstalling resolves `eslint` to **10.13.0**
instead of 10.14.0, with no manual pin:

```
+ eslint 10.13.0
+ dependency-cruiser 18.7.0      # 18.7.1 published 2026-11-01, also inside the window
```

So the policy holds in both directions: it refuses a too-fresh version that someone else
resolved, and it steers a fresh resolution away from one. Neither behaviour needs a human to
remember anything, which is the point.
