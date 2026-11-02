# ADR-008 — HTTP layer

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A12** (the MCP server is mounted at `/mcp` on this same listener), **A15** (fixed `/healthz` and `/readyz`), **A29** (token-gated appliance setup page)

## Context

- The dashboard, the HTTP API, the Control API used by the CLI, the ICS feed routes and the MCP endpoint all run **inside the single server process** (`01` §1, §8). One listener has to carry all of them, with different middleware chains and different authentication.
- By default the server binds `127.0.0.1` and needs no public URL (`01` §9). Appliance installs add a Home Assistant ingress listener on a separate port.
- The dashboard must not hand-write an API client. The spec has to be machine-generated from the same schemas the handlers validate with (ADR-010), and CI has to fail on drift.
- Live updates are one-directional: the server pushes invalidation hints and chat messages to open tabs. No client→server streaming is needed.
- Every read must pass through IFC, and HTTP code must not be able to import `@village/storage` at all (ADR-020).

## Decision

| Concern | Choice |
|---|---|
| Framework | **Hono** on **`@hono/node-server`** |
| Typed routes + spec | **`@hono/zod-openapi`** with zod v4; `app.doc31` emits **OpenAPI 3.1** to `apps/server/openapi.json` at build time, committed, with CI failing on drift (`09` §2 D-02) |
| Dashboard client | Generated from that spec into `@village/api-client` (A11), never hand-written and never Hono RPC (`09` §2 D-03) |
| Live updates | **SSE** — one multiplexed stream per tab, IFC-filtered per subscriber, resumable via `Last-Event-ID` (`09` §2 D-10) |
| Errors | RFC 9457 `application/problem+json` (`09` §2 D-05) |
| Health (**A15**) | Fixed `/healthz` (liveness) and `/readyz` (readiness, which **ignores chat-platform outages**) |
| MCP (**A12**) | Served at **`/mcp` on this same listener**, as a separate Hono sub-app with its own middleware chain — no second port (see ADR-021) |

Hono being small is what makes several security requirements implementable: `/mcp` can skip the dashboard's session, CSRF and SPA middleware entirely and reject any request carrying a `Cookie` header, while still sharing TLS, `trustProxy`, exposure modes and health with the rest of the server.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Fastify** | A fine server, but its plugin/encapsulation model and schema story (JSON Schema first) pull against "one zod schema end to end". We would either maintain a second schema language or bolt zod on, and we would gain capacity we do not need for a single-household workload. |
| **Express** | No end-to-end typing, no first-class OpenAPI generation, and middleware typing that would make the "handlers cannot import storage" and `Readable<T>` disciplines harder to express in types rather than in review. |

## Consequences

**Good**
- The OpenAPI spec cannot drift from the handlers, and the dashboard client is generated from it, so a breaking API change fails CI rather than the browser.
- One listener means one place where TLS, host-header allowlisting, exposure mode and health are configured — fewer ways to misconfigure an exposed instance.
- SSE needs no new protocol: native `EventSource` reconnects and resumes, and it passes through the HA ingress and ordinary proxies.
- Mounting MCP as a sibling sub-app keeps bearer-token auth and cookie rejection structurally separate from dashboard sessions.

**Bad / accepted costs**
- Some Hono built-ins are not sufficient for our threat model and are replaced: CSRF (the built-in checks only form content types, so JSON would pass unchecked) and rate limiting are in-house (`09` §2 D-15, D-28).
- A committed generated spec means a regeneration step in every API PR.
- Everything sharing one process means an HTTP-layer memory leak is a chat-availability problem too.

**Follow-ups**
- `M9` — the API, dashboard and CLI milestone owns the routes, the generated client and the auth flows (`09`).
- `M12-T16`, `M12-T17` — MCP server core and security on the `/mcp` sub-app.

## References
- `docs/plan/01-architecture.md` §2 ADR-008, §9, §14 A12, A15, A29
- `docs/plan/09-dashboard-api-cli.md` §2 D-01…D-10, D-15, D-27, D-28; §2.1 (verified versions)
- `docs/plan/10-extensibility.md` §3.7.2 (the `/mcp` middleware chain)
