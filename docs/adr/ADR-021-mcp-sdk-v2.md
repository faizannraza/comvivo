# ADR-021 — MCP (spec version, SDK, transport, auth)

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A12** (spec and SDK packages, conditional `@modelcontextprotocol/node`, `/mcp` on the main listener, ownership split, bearer tokens in 1.0, proposed writes)

## Context

The product line is "**your personal AI can now talk to your group's AI**" (`13`). A member's own agent — Claude Desktop, Claude Code, Cursor, anything that speaks MCP — gets a connection to Village scoped to **one Member**: one person, in one group, with that person's authority and visibility and nothing more. Through it the agent can ask what is on the family calendar this weekend, add oat milk to the groceries, or catch the member up on a group.

That feature sits on top of the most dangerous combination in the system:

- **The member's agent may itself be prompt-injected.** It is a confused deputy by default. Anything it asks for must be treated as a request from an untrusted intermediary acting with the member's authority (`03` trust boundary 3; `08` B-boundaries).
- **An MCP server is an authorization surface.** If the token or the scoping is wrong, one member's agent reads another member's private memories, which is the existential failure mode (`15` §3 R-1).
- **The spec moves.** The 2026-07-28 revision removed sessions and changed discovery, and the TypeScript SDK split into v2 packages. MCP spec churn is a tracked risk (`15` §3 R-13).
- **Hosts have no public HTTPS URL.** A loopback-bound instance on someone's NAS cannot satisfy the requirements that cloud connectors impose, and most hosts will not set up a tunnel.

An earlier draft put MCP on its own listener (port 7778) so a host could expose it without exposing the dashboard. A12 removed that.

## Decision

### Spec and SDK

| Item | Choice |
|---|---|
| Spec revision | **MCP 2026-07-28** (stateless, `server/discover`), with a stateless legacy fallback for 2025-era clients |
| SDK | **TypeScript SDK v2, split packages**: **`@modelcontextprotocol/server`**, **`@modelcontextprotocol/client`**, **`@modelcontextprotocol/hono`** |
| stdio package | **`@modelcontextprotocol/node`** is adopted for stdio **only if the `10` M12 spike confirms it** — that is `M12-T2`. If it is used, `M12-T2` adds it to this ADR; if not, the bridge keeps its own stdio handling |
| Package home | An isolated `@village/mcp` package, plus `@village/mcp-bridge` for stdio clients, so spec churn is contained |

### Endpoint

- The MCP server is served at **`/mcp` on the main HTTP listener** — the dashboard's `dashboard.bind:port`. **There is no separate port.**
- It is mounted **only** when `mcp.server.http.enabled` is true; otherwise `/mcp` is not mounted and returns 404.
- It is never mounted on the Home Assistant ingress listener.
- `/mcp` is a **separate Hono sub-app**: it skips the dashboard's session, CSRF and SPA middleware, **rejects any request carrying a `Cookie` header** (bearer only), and has its own middleware chain — host-header validation, `Origin` validation (a spec MUST), a per-IP pre-auth limiter, the bearer gate, then a per-token rate limiter.
- A host who wants to expose MCP without the dashboard does it with a path-scoped proxy or tunnel rule that forwards only `/mcp` — the same pattern already documented for ICS feeds.

### Ownership split (A12)

| Concern | Owner |
|---|---|
| **Token format** | **`08`** |
| **Endpoint and tool surface** | **`10`** |
| Spec/SDK choice, transport shape, auth model | this ADR |

### Authentication

- **1.0: per-member opaque bearer tokens (PATs).** Each token is bound to exactly one Member — and therefore to exactly one group — with scopes and a **mandatory expiry**. Format per `08`.
- **OAuth arrives in 1.1** (CIMD-first). It is not in 1.0: authorization is OPTIONAL in the spec, most hosts have no public HTTPS URL, and an authorization server would add CIMD fetching (an SSRF surface), consent UI and refresh-token storage — real risk against the 1.0 timeline. Claude Code, Cursor and the stdio bridge all support static bearer tokens.
- stdio clients use **`@village/mcp-bridge`**, launched by the client, which reads `VILLAGE_MCP_TOKEN` from the environment (the spec's rule for stdio credentials) and proxies to the HTTP endpoint.

### Tool surface and write semantics

- **A curated, static tool list**, identical for every member, ordered deterministically. Authorization happens **at call time**. Tools are thin adapters over built-in tool definitions and run through the same tool executor with `ActingAuthority = member` — no second code path for policy or IFC.
- Every MCP write carries **`provenance.untrustedInContext = true`**.
- **A12: writes from members' agents create *proposed* items that need one confirmation tap in the member's own DM.** The confirmation never happens through the external agent, and never via MCP elicitation, because the agent may be the thing that was injected. (The taint rule is `03` §3.10.2; it is revisited after M12 dogfooding.)
- `subscriptions/listen` is not offered in 1.0 — tools only, with static lists.

### Village as an MCP *client*

Village can also consume external MCP servers as gated tool providers. Their tool definitions are **pinned snapshots approved by the host or an admin**: remote changes stay pending until re-approved, descriptions are sanitized, prefixed with their origin and editable. This defeats tool poisoning and "rug pulls" and keeps the catalog hash stable (ADR-023, A13).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **SDK v1 (`@modelcontextprotocol/sdk`)** | v1 receives fixes only; v2 is the stable line that implements the current spec. Starting on v1 would mean shipping 1.0 on a package in maintenance and migrating during the launch window. |
| **A separate MCP port (7778)** — the pre-A12 draft | The only motivation was exposing MCP without the dashboard, and a path-scoped proxy or tunnel rule already does that. A second listener would duplicate TLS, `trustProxy`, exposure modes and health checks, giving two places to misconfigure an internet-facing surface for no capability gain. |
| **An OAuth 2.1 authorization server in 1.0** | Authorization is OPTIONAL in the spec; most hosts have no public HTTPS URL; and an AS brings CIMD fetching (SSRF), a consent UI and refresh-token storage. Deferred to 1.1. |
| **Per-member tool lists** | The spec says list endpoints should not vary per connection and should be ordered deterministically. Varying lists would also leak which capabilities a member has, and would multiply the cached-catalog surface. Authorization at call time achieves the same effect safely. |
| **Elicitation via MCP for write confirmations** | The confirming channel would be the possibly-injected agent itself. An out-of-band human tap in Village's own DM is the only gate that survives a confused deputy. |
| **Live `tools/list` from external MCP servers** | Invites tool poisoning and silent description changes after approval, and destabilises the catalog hash that prompt caching depends on. Pinned snapshots with re-approval instead. |

## Consequences

**Good**
- A member's personal agent gains real, useful access to the group's state with exactly that member's authority — no new privilege model, because policy and IFC are reused.
- One listener keeps TLS, host validation, exposure mode and health in one place; `/mcp` still gets its own strict middleware chain and rejects cookies outright.
- Bearer tokens work for every client we care about today, with no public HTTPS requirement and no authorization server to secure.
- Proposed-by-default writes mean an injected agent can, at worst, create a proposal the member must tap to accept.
- Containing MCP in `@village/mcp` plus a bridge means spec churn (R-13) is a package-level change, not an engine-level one.

**Bad / accepted costs**
- Bearer tokens are long-lived credentials in a member's local client configuration; they are scoped, expiring and revocable, and that is the mitigation, not a solution.
- Every MCP write costs the member a confirmation tap, which is friction on exactly the flow that is supposed to feel magical. Accepted for 1.0 and revisited after dogfooding.
- A static tool list means the surface is as wide as the least-privileged member's view allows, with denials surfacing at call time rather than being invisible.
- `/mcp` on the main listener couples the MCP endpoint's availability to the dashboard listener's configuration.
- The stdio bridge is an extra published package that members install themselves.
- `@modelcontextprotocol/node` is a conditional dependency: the decision is not final until `M12-T2`.

**Follow-ups**
- `M12-T2` — re-verify external facts and run the MCP SDK v2 spike; confirms `createMcpHandler` serving both 2026-07-28 and 2025-11-25 clients via Hono with `authInfo`, the `serveStdio` bridge round trip, a client transport with a custom `fetch`, and the Node 24 vs 26 `--permission` matrix. **Adds `@modelcontextprotocol/node` to this ADR if it is used.**
- `M12-T16`, `M12-T17` — MCP server core and security.
- `M12-T18` — MCP token UX in the dashboard.
- `M12-T19` — `@village/mcp-bridge`.
- `M12-T20` — MCP client and hardening (pinned snapshots, sanitized descriptions).
- `M12-T26` — MCP red-team suite.
- 1.1 — OAuth (CIMD-first).

## References
- `docs/plan/01-architecture.md` §2 ADR-021, §14 A12
- `docs/plan/10-extensibility.md` §2 X-7…X-12; §3.7 (MCP server: positioning, transports, middleware chain); §3.8 (bridge); §3.9 (MCP client)
- `docs/plan/08-security-privacy.md` §3 (token formats and the vault)
- `docs/plan/03-group-intelligence.md` §3.10.2 (taint rule for agent-originated writes)
- `docs/plan/15-risks-and-open-questions.md` §2 (MCP endpoint, MCP memory/event writes), §3 R-1, R-13
