# ADR-014 — Configuration

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A14** (the host-only key class), **A29** (appliance secrets in `keys/secrets.enc`), **A30** (extension secrets in the `08` vault via the Control API)

## Context

Three different audiences configure the same instance, and they want incompatible things:

- **Hosts** want a file they can put in git and diff — the whole appeal of self-hosting.
- **Admins** (a parent, a roommate) want to change behaviour from the dashboard without SSH.
- **Nobody** wants secrets in either of those places: not in a versioned YAML file, not in the database that an admin session can reach.

There is also a trust asymmetry that a naive precedence rule would break: an admin is trusted to set quiet hours, but **not** to redirect the instance to a different model provider, widen the egress allowlist, install a plugin, or switch on debug content logging. A curious admin with a dashboard session must not be able to do any of that (`08` PSC-11).

## Decision

**Three sources, one zod schema, one precedence rule — with a host-only exception.**

| Source | Holds |
|---|---|
| `village.yaml` | Non-secret, versioned configuration (`01` §10) |
| Environment / `.env` (and generic `<SECRET>_FILE`) | **Secrets only** |
| DB-persisted runtime settings | Everything an admin may edit from the dashboard |

**Precedence:** `env > DB settings > village.yaml > defaults`. Secrets are **env or keyfile only** — never in the DB and never in YAML. Everything is validated with zod (ADR-010), and the full configuration reference is **generated from the zod schemas** rather than hand-written.

**A14 — host-only keys.** These are read from env or YAML only and **ignore DB settings entirely**:

- providers and API keys;
- egress allowlists;
- plugins;
- MCP servers;
- debug-content logging;
- the exposure mode.

Everything else follows the precedence rule above.

**Exceptions carved out later, both deliberate and narrow:**

- **A29 (appliance secrets).** On Home Assistant, Umbrel and CasaOS, editing env is impractical, so the host may enter secrets **once** through the token-gated web setup page. They are stored encrypted in `keys/secrets.enc` (format and derivation per `08`), **never in the DB**, remain host-only keys, and changing them later requires the setup token or host step-up. Env and `*_FILE` still take precedence.
- **A30 (extension secrets).** Host-entered plugin and MCP-client secrets are written through the Control API to the `08` vault, never stored in the DB, and handed to extensions only as **references** usable for approved destinations.

In the dashboard, secrets are otherwise read-only: masked to the last 4 characters with a "Test" button (`09` §2 D-29).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Pure env** | Twelve-factor is right for a PaaS and wrong for an appliance. A family instance has dozens of behavioural settings (quiet hours, digest times, retention, proactivity) that an admin should change from a UI, and a host should be able to see the whole configuration in one reviewable file instead of a wall of exported variables. |
| **Pure DB** | Loses the versioned, diffable, restorable file that self-hosters expect, makes bootstrapping circular (you need the DB to find out how to open the DB), and — critically — would put provider keys, egress rules and the exposure mode inside the reach of any admin session. A14 exists precisely to prevent that. |

## Consequences

**Good**
- Hosts get a file they can version; admins get a UI; neither gets the other's secrets.
- The host/admin trust boundary is structural: a DB setting simply cannot override a host-only key, so a stolen admin session cannot redirect egress or enable debug logging.
- One zod schema means the documentation cannot drift from the validator.
- `*_FILE` support makes Docker secrets and appliance key handling work without a special path.

**Bad / accepted costs**
- Three sources plus one exception class is more to explain than one source; the docs must make the precedence rule and the host-only list very plain, or hosts will edit YAML and wonder why nothing changed.
- Some settings legitimately live in two places during a migration, and `village doctor` has to report which source won.
- The A29 appliance path is a real write path for secrets from a web page; it is token-gated and step-up protected, and it is the one place where a session can touch a host-only key.

**Follow-ups**
- `M0-T6` — the config-loader skeleton.
- `M9` — the generated configuration reference and the dashboard settings screens (`09`).
- `M1-T31` — secret loading.
- `M12` — extension secrets through the Control API (A30).

## References
- `docs/plan/01-architecture.md` §2 ADR-014, §10, §14 A14, A29, A30
- `docs/plan/08-security-privacy.md` §12 PSC-11, PSC-12; §5 (configuration)
- `docs/plan/09-dashboard-api-cli.md` §2 D-04, D-29
