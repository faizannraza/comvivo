## What this changes

<!-- One or two sentences. What is different afterwards, from a user's point of view where that applies. -->

Fixes #

**Type:** <!-- feat / fix / perf / docs / refactor / chore / security / breaking -->

## Checks

- [ ] **Tests.** Added or updated. Property-based tests for policy, information flow or fairness
      if this touches them — an example-based test there passes by picking a kind example.
- [ ] **Docs.** Updated in this pull request, or not user-visible.
- [ ] **Changeset.** `pnpm changeset`, written for a host rather than a reviewer. Or the
      `no-changeset` label if this genuinely affects nobody running Comvivo.
- [ ] **DCO.** Every commit signed off (`git commit -s`).
- [ ] `pnpm verify` passes locally.

## AI assistance

<!-- Required. This is not held against you — it tells a reviewer where to look hardest, and this
     project is itself largely built this way. -->

- [ ] None
- [ ] Partial — AI helped with parts of it
- [ ] Substantial — AI wrote most of it

- [ ] **I have reviewed and understand every line, and can explain why it is correct.**

## Privacy and security impact

<!-- Answer even when the answer is "none". "None" is a claim a reviewer can disagree with; a
     blank is not. -->

- [ ] This touches **information flow, policy, context building, the guard, the declassifier,
      network egress, retention or crypto.**

If that box is ticked, this needs **two maintainer approvals**, and an RFC if the semantics change
rather than the implementation. See [GOVERNANCE.md](../GOVERNANCE.md).

<!-- If it is not ticked, say in one line why not. e.g. "Dashboard copy only, no data path." -->

## Screenshots

<!-- For any UI change: before and after, light and dark. -->
