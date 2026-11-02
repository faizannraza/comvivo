# Mini-ADR 001 — `yaml` (eemeli/yaml)

Template: [`TEMPLATE-mini.md`](TEMPLATE-mini.md). Required by `14` §0.5 rule 6 for any runtime
dependency the plan does not already name.

- **Dependency:** `yaml` (eemeli/yaml), ISC.
- **Why it is needed:** ADR-014 makes `comvivo.yaml` the non-secret, versioned configuration file, so
  the config loader in `@comvivo/shared` must parse YAML. It is also needed immediately by
  `scripts/supply/check-native.ts`, which asserts that `pnpm-workspace.yaml`'s install-script policy
  still matches what `docs/architecture/native-deps.md` documents. Added as a root devDependency now
  and promoted to a `@comvivo/shared` runtime dependency in `M0-T6`.
- **Alternatives rejected:** `js-yaml` — no comment preservation, which the dashboard's constitution
  editor needs when it round-trips a host's file (`09`); and its maintenance is quieter.
  Hand-rolling a parser — a configuration file is a security boundary and YAML has sharp edges
  (anchors, merge keys, `!!` tags) that a naive parser gets wrong. `toml` instead of YAML — would
  contradict ADR-014 and every self-hosting convention our users already follow.
- **Risk, licence, maintenance:** ISC, Apache-2.0-compatible. Single primary maintainer, which is
  the one concern; mitigated by it being the de-facto standard (very widely depended upon),
  actively released, and having **no install script**, so it needs no `allowBuilds` entry. Parsing
  is configured with `{ merge: false }` and schema `core` so anchors and merge keys cannot be used
  to smuggle structure past the zod boundary.
- **Decision and date:** **Accepted**, 2026-11-01, Claude Code under delegated authority
  (`CLAUDE.md` §5). Logged in `STATUS.md` → Plan changes.
