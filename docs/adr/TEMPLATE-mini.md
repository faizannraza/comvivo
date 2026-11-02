# Mini-ADR template (new runtime dependency)

Use this when you add a **runtime dependency that is not named in the plan** (`14-milestones.md` §0.5 rule 6). Dev-only dependencies do not need one. Dependencies already named in `01` §2, a spec's §2 key-decisions table, or a spec's "runtime dependencies introduced by this document" list (e.g. `09` §2.1) are already covered and need nothing.

File name: `docs/adr/MINI-<package-name>.md` (kebab-case, scope `@` and `/` flattened to `-`).
Also add a line to `STATUS.md` → "Decisions log" pointing at the file.

Copy the five lines below, fill them in, delete nothing.

---

```markdown
# Mini-ADR — <package@version>

- **Dependency:** <package@version> — runtime, used in <package/path>
- **Why it is needed:** <the capability we need and why existing dependencies or ~20 lines of our own code do not cover it>
- **Alternatives rejected:** <name 1> (<reason>); <name 2> (<reason>); writing it ourselves (<reason>)
- **Risk + license + maintenance check:** license <SPDX id, OSI-approved?>; last release <date>; maintainers <count>; weekly downloads <n>; transitive deps <n>; install scripts <yes/no → `allowBuilds` entry needed?>; native code <yes/no>; known advisories <OSV result>; `minimumReleaseAge` (3 days) satisfied <yes/no>
- **Decision + date:** Adopted / Rejected — <one line on the deciding factor> — <YYYY-MM-DD>, <task ID>
```

---

**Checks that must pass before you commit the dependency**

- An OSI-approved license, recorded with its SPDX id (a non-OSI license needs a full ADR, not a mini-ADR).
- Clean OSV scan, and `pnpm audit` green.
- `minimumReleaseAge` (3 days) and the `trustPolicy` in `M0-T2` are satisfied; if the package runs install scripts, it needs an explicit `allowBuilds` entry.
- It does not break a dependency-boundary rule (ADR-020). If it would, the design changes — not the rule.
- Native code is flagged, because it has to work on linux/amd64, linux/arm64 and macOS, on Node 26 and Node 24 (ADR-001).
- The dependency is added to the package that actually uses it, never hoisted to the root.

Under the autonomous operating mode in `CLAUDE.md` §5, the mini-ADR **is** the decision record: write it, log it in `STATUS.md`, and continue. Stop and ask the human only for the things §5 reserves — money, credentials and account actions, and the brief real-chat smoke test.
