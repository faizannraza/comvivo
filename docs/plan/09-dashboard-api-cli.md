# 09 — HTTP API, Auth, Dashboard and CLI

> Status: **draft for review**. Elaborates `01-architecture.md` (ADR-008 Hono, ADR-009 React SPA, ADR-014 config, ADR-017 telemetry, ADR-018 i18n; §9 dashboard security; §10 config) and must not contradict it. Proposed spine changes are listed in §12.
> Owns: the HTTP API (routes, conventions, errors, SSE, rate limits, health), authentication and sessions, the dashboard (information architecture, every screen, design system, accessibility, i18n, performance, embedding), the `comvivo` CLI (commands, `init` wizard, `doctor`), and copy guidelines for the dashboard and CLI.
> Third-party facts were verified on **2026-11-01**. Versions and URLs are listed in §2.1.

---

## 1. Purpose & scope

### 1.1 What this document specifies
1. **HTTP API** (`apps/server/src/http`). It is a resource-oriented JSON API under `/api/v1`, built with `@hono/zod-openapi`. It produces an OpenAPI 3.1 document, from which a typed client is generated for the dashboard. It also covers:
   - the control API used by the CLI (`/control/v1`),
   - the live-update SSE stream,
   - health endpoints for Docker, Home Assistant and Umbrel.
2. **Auth and sessions.** This covers:
   - pairing-code login, **the default** (the browser shows a code and the member approves it in a DM),
   - magic-link login delivered by the bot, **only on loopback, or over HTTPS when the host explicitly opts in** (01 §9, §14 A9),
   - host bootstrap with a claim code,
   - group claim codes,
   - sessions, cookies, CSRF and recent-auth (step-up),
   - reverse-proxy and Home Assistant ingress support (HA users are linked once via a bot code and never trusted from headers alone).
3. **Dashboard** (`apps/dashboard`). This covers:
   - information architecture and navigation,
   - every screen (purpose, data, actions, states, permissions and a wireframe),
   - the design system, accessibility (WCAG 2.2 AA), i18n and the performance budget,
   - embedding in the Home Assistant ingress panel.
4. **CLI** (`apps/cli`; npm package name is the placeholder `<cli>` until owner decision D-2, see 01 §14 A2; this document writes the binary as `comvivo`). This covers:
   - the framework choice,
   - every command with its flags, output and exit codes,
   - the `comvivo init` wizard with exact copy,
   - `comvivo doctor` checks with remediation text.
5. **Copy and UX writing guidelines** for the dashboard and the CLI.

### 1.2 What this document does not specify (owner in brackets)
- Physical tables for sessions, tokens and codes; repositories; the job queue; the backup and export formats [02]. This document lists the **fields it needs** (§4.6). 02 owns the DDL.
- The semantics of `canRead`, labels, capabilities, conflicts, proposals, consent and fairness [03]. This document only **consumes** them.
- Memory search ranking and the "forget" semantics [04]. Turn-trace generation and confirmation mechanics [05].
- Channel adapters, the in-chat commands (`/dashboard`, `/pair`, `/claim`, `/why`), the in-chat group setup flow and the channel probes' internals [06]. This document defines the probe interface it needs (§4.8).
- ICS content, rotation algorithms and digest content [07].
- The threat model, key hierarchy and recovery-key format [08].
- Plugin and MCP semantics [10].
- The test infrastructure [11].
- Docker images, compose files, Home Assistant and Umbrel manifests, the release manifest [12]. This document specifies only what the CLI and server must do in each mode.

### 1.3 Who uses what

| Persona | Primary surface | Dashboard role view |
|---|---|---|
| Host | CLI and dashboard | The **Instance** area (models, channels, backups, plugins, security) and their own group views if they are a member |
| Organizer / Admin | Chat, dashboard on a phone | Group views with management actions their capabilities allow |
| Member, Teen | Chat; dashboard optional | Group views limited to their capabilities. "What Comvivo knows about me", their own traces |
| Child | Chat | No dashboard access unless the constitution grants `dashboard.access` (capability required by 01 §14 A6 in 03 §3.1.2) |

---

## 2. Key decisions

| ID | Decision | Choice | Alternatives | Rationale |
|---|---|---|---|---|
| D-01 | API style | REST, resource-oriented JSON under `/api/v1`. Group data lives under `/api/v1/groups/{groupId}/…`. camelCase fields. TypeID ids. | GraphQL, tRPC | Simple, cacheable, and maps cleanly to OpenAPI. Group-scoped paths make the authorization scope explicit. |
| D-02 | Spec | `@hono/zod-openapi` 1.6 with zod v4. `app.doc31` produces **OpenAPI 3.1**. The spec is emitted at build time to `apps/server/openapi.json` and committed. CI fails on drift. | Hand-written spec | One schema language end to end (ADR-010). The spec cannot drift from the handlers. |
| D-03 | Dashboard client | **openapi-typescript 7 + openapi-fetch 0.17 + openapi-react-query 0.5**, generated into a new package `@comvivo/api-client`. | `hono/client` RPC | Hono's RPC needs the server's `AppType` imported into the dashboard. That violates "dashboard → generated client only". Its type-checking also slows down with many routes (Hono docs). The OpenAPI client also serves community tools. |
| D-04 | CLI ↔ server | The **Control API** `/control/v1/*` on the same listener uses a bearer token from `dataDir/keys/control.token` (0600, 256-bit). It has its own types via `hono/client`, which is allowed because CLI → apps/server. | Unix socket | A Unix socket doesn't cross Docker Desktop's VM boundary. A token file works everywhere, and having the file proves filesystem access, which equals host trust. |
| D-05 | Errors | **RFC 9457** `application/problem+json` with `type: "urn:comvivo:problem:<slug>"`, a stable `code`, `requestId` and an optional `errors[]` (JSON pointers). | Ad-hoc JSON | Standard and machine-readable. A URN type doesn't depend on the final product name or domain. |
| D-06 | Pagination | Opaque cursor (`limit` default 50, max 200). The response is `{ items, nextCursor }`. **No total counts** on IFC-filtered collections. | Offset/limit | Stable under inserts. A total count would leak hidden rows. |
| D-07 | IFC on reads | Every handler reads through `@comvivo/engine/readmodels`. It works with a `GroupViewer` whose audience is `{kind:'members', memberIds:{viewer}}`. Rows pass `InformationFlow.canRead` and are branded `Readable<T>`. Response mappers accept only `Readable<T>`. **HTTP code cannot import `@comvivo/storage`** (dependency-cruiser rule). | Filtering in the UI or in handlers | It is the same gate as the model context (I1). The type system and the import rules make a bypass a compile or CI error. |
| D-08 | Unreadable ⇒ 404 | An unreadable entity returns the same 404 as a nonexistent one. | 403 | A 403 would confirm that the item exists. |
| D-09 | Writes | Every mutation becomes a **Command** dispatched into the group actor. It runs through the PolicyEngine with the viewer as `ActingAuthority`, writes an `AuditEvent` with `via:'dashboard'`, and returns an `Outcome` union: `done`, `needs_confirmation`, `contested`, or a deny mapped to 403. | Direct repository writes | It keeps per-group serialization (§1 of the spine) and I3. The dashboard and chat behave identically. |
| D-10 | Live updates | One multiplexed **SSE** stream per tab at `/api/v1/stream`. Events are IFC-filtered per subscriber and carry invalidation hints, plus chat messages for readers. Resume uses `Last-Event-ID` from an in-memory ring buffer. If events were missed, the server sends `resync`. | WebSockets | One direction is enough. Native `EventSource` reconnects and resumes on its own, and SSE passes through the HA ingress and proxies. |
| D-11 | Login (default) | A **pairing code** (device flow), the default in every exposure mode (01 §14 A9; semantics 08 SD-09). The browser shows `/pair K7QM-4ZTD`, the member sends it to the bot in a DM and taps **Approve**. The approval message names the browser and OS. Formats per 08 §3.7.12. | Passwords, passkeys (later) | Browser-bound: a code seen by the platform is useless without the browser's pending cookie. It covers "Telegram is on my phone, but I want the dashboard on my laptop" and HA ingress linking. |
| D-12 | Second login path | **Magic link** delivered by the bot in a DM, allowed **only on loopback, or over HTTPS when the host explicitly opts in** (`dashboard.auth.magicLinks: auto \| https \| off`). Token `vml1.…` (08 §3.7.12), single use, expires in 10 minutes, bound to `(personId, instanceId, purpose)`. The token goes in the **URL fragment** and is exchanged by `POST`. Never issued in insecure-LAN mode or on the ingress listener. | GET exchange | A fragment never reaches server logs, `Referer` or link-preview fetchers, so it can't be consumed by mistake. |
| D-13 | Sessions | Opaque 256-bit session ID (`vs1_…`), hashed in the DB, cached in an LRU. **12-hour idle and 7-day absolute expiry** (08 §3.7.12), rotated every 24 h and on privilege change. Revocable, with a sessions list. | JWT | Revocation and listing are first-class requirements. |
| D-14 | Cookie | Name `__Host-comvivo_session` on HTTPS with base path `/`, `__Secure-comvivo_session` on HTTPS with a sub-path, and `comvivo_session` on plain HTTP (the pending-login cookie follows the same rule: `…comvivo_pending`). Always `HttpOnly; SameSite=Strict; Path=<basePath>`. | One fixed name | `__Host-` requires `Path=/` and `Secure` (verified in Hono's cookie helper). The cookie must also work on `http://localhost` and on LAN. |
| D-15 | CSRF | Custom middleware on **all** unsafe methods: `Sec-Fetch-Site: same-origin`, else an allowed `Origin`, else reject. Bodies must be JSON. The per-session header `X-Comvivo-CSRF` must match. | `hono/csrf` | Hono's built-in middleware checks only form content types. JSON requests would pass unchecked. |
| D-16 | Recent auth | Sensitive actions require `authTime` within 10 minutes. Step-up is an **Approve** button in the member's DM, with a 6-digit code as fallback. | Re-entering a password | There are no passwords. The chat identity is the authenticator. |
| D-17 | Host bootstrap | A **host claim code** (typed `VLG-7K2M-9QXA`, 40 bits, plus a 128-bit link token `c_<22 chars>` for deep links; 30-minute TTL; burned after 10 failed attempts; formats per 08 §3.7.12 and 06 §3.20.1) is printed by the server and shown by `comvivo init`. It is redeemed with a Telegram deep link (`?start=c_…` or `?startgroup=c_…`), with the claim command in other chat apps (06 §3.20), or on the web at `/setup`. App-store installs may supply `COMVIVO_SETUP_TOKEN` instead (§3.9.4). | First visitor becomes admin | A first-visitor model is unsafe when the dashboard is reachable on a LAN. |
| D-18 | Base path | Runtime base path. Vite `base: './'`. The server injects `<base href>` and boot JSON into `index.html` per request, using `dashboard.basePath` or a trusted `X-Ingress-Path`. Router `basepath` and the API `baseUrl` come from boot. | Build-time base | The HA ingress path is only known at request time. |
| D-19 | HA ingress | A dedicated ingress listener on port 8099. Only `172.30.32.2` may connect. HA users are identified by `X-Remote-User-Id`, with no cookie, but **a header never authenticates on its own**: an HA user is linked to a Comvivo person once via a bot code (a pairing code approved in the member's DM; or, only while the instance is unclaimed, the console host claim code). Unlinked HA users get the linking screen (01 §14 A9). | Magic links in an iframe | HA docs say not to ask for a second login, and to trust those headers only from the Supervisor. |
| D-20 | Dashboard stack | React 19.3, Vite 8 (Rolldown), TanStack Router 1.170 (file routes, `autoCodeSplitting`), TanStack Query 5.105, Tailwind 4.3 (`@tailwindcss/vite`), shadcn CLI 4 with `--base radix`, lucide-react. | — | Spine ADR-009. Versions verified. |
| D-21 | Charts | **Recharts 3** through the shadcn `chart` component, lazy-loaded only on Costs and Fairness. Every chart has a "View as table" toggle. | uPlot, visx, ECharts | Consistent theming with shadcn tokens and the `accessibilityLayer` prop. It isn't in the initial bundle. |
| D-22 | Calendar UI | **Built in-house**: Agenda, Month and Week views on `temporal-polyfill` and CSS grid. | Schedule-X, FullCalendar | Visibility chips inside events, WCAG grid semantics, theme tokens and a smaller bundle. Schedule-X is the fallback if Week view slips. |
| D-23 | YAML editor | **CodeMirror 6**: `@codemirror/lang-yaml` and `@codemirror/lint`. Syntax errors are linted on the client with `yaml`. Schema errors come from the server (`/constitution/validate`) and map to line/column. `@codemirror/merge` renders diffs. The `cspNonce` facet is set. | Monaco, codemirror-json-schema | Monaco is heavy. codemirror-json-schema documents no YAML setup. Server validation is authoritative and runs the real compiler. |
| D-24 | i18n | i18next 26 + react-i18next 17. Namespaces are loaded per route via `i18next-resources-to-backend` and `import.meta.glob`. Keys are type-checked. `Intl` and Temporal format dates and numbers in the member's locale and timezone. | FormatJS | Spine ADR-018. |
| D-25 | CLI framework | **commander 15 + @commander-js/extra-typings**; **@clack/prompts 1.8** for interactive flows; picocolors. | citty 0.2, clipanion 4.0-rc | commander is the most widely used, has typed options and is ESM-only on Node ≥ 22.12, which fits. clipanion's last release was an rc in Sep 2024. citty is still 0.x. clack 1.8 has async validators, Standard-Schema (zod) validation, `path`, `progress`, `taskLog` and `box`. |
| D-26 | CLI packaging | The CLI is a **thin** pure-JS package (placeholder name `<cli>`, 01 §14 A2): CLI, wizard and probes. It installs the public server-runtime package (`@comvivo/server`, names per 12 §3.1) **on demand** in native mode, or pulls the Docker image. Both downloads start in the background while the wizard asks questions. | One fat package | It makes the 5-minute target realistic. The native modules (better-sqlite3-multiple-ciphers, onnxruntime) are large. |
| D-27 | Health | `GET /healthz` is liveness. `GET /readyz` is readiness. Channels are **not** part of readiness (01 §14 A15). `GET /api/v1/instance/health` gives the host details. The Docker HEALTHCHECK (`/app/healthcheck.mjs`, 12 §3.2.5) and the HA `watchdog` use `/healthz`; the contract is §3.8. | One endpoint | A Telegram outage must not restart-loop the container. |
| D-28 | Rate limiting | An in-house token-bucket middleware (~100 LOC). It is keyed by session, person or IP and emits `RateLimit-Policy`, `RateLimit` and `Retry-After` headers. | hono-rate-limiter | The rate-limiter README says it is "still in development". This is a single-process server, and the behavior must be exact. |
| D-29 | Secrets in UI | **Read-only**: shown masked (last 4 characters), with a "Test" button. They are changed with `comvivo secrets set` or by editing `.env`. **Sole exception (01 §14 A29):** on appliance installs (`COMVIVO_PLATFORM` = `home-assistant`, `umbrel` or `casaos`) the token-gated `/setup` flow, and afterwards Instance → Secrets in a host session with step-up (A9), may **write** host-only secrets once into `keys/secrets.enc` (format and key per 08 §3.10). Inputs are write-only (never echoed back), env and `*_FILE` still take precedence, and nothing is stored in the DB. | Editing in the dashboard everywhere | ADR-014: secrets live only in env, a keyfile or (appliances, A29) `secrets.enc`. Keeping writes to appliance setup and host step-up limits the impact of a stolen session. |
| D-30 | No token streaming in chat | Web chat shows "Comvivo is thinking…" and then the full message. | Streaming tokens | I5: the disclosure guard must see the whole draft before egress. |

### 2.1 Verified third-party facts (2026-11-01)

| Package / API | Version / fact | Source |
|---|---|---|
| `hono` / `@hono/node-server` | 4.13.16 / 2.1.5. `createAdaptorServer`, `serveStatic({ precompressed })` and `streamSSE` (`writeSSE({data,event,id,retry})`, `stream.aborted`, `onAbort`). `csrf()` checks only form content types. Cookie helper: `prefix:'host'` requires `path:'/'` and `secure`; Max-Age is capped at 400 days. `secureHeaders` supports `NONCE`. | https://hono.dev/docs/helpers/streaming · https://hono.dev/docs/middleware/builtin/csrf · https://hono.dev/docs/helpers/cookie · https://hono.dev/docs/middleware/builtin/secure-headers · npm registry |
| `@hono/zod-openapi` | 1.6.3. Peers: `zod ^4`, `hono >=4.10`. `OpenAPIHono({ defaultHook })`, `createRoute`, `app.openapi`, `app.doc31`, `getOpenAPI31Document`, `openAPIRegistry.registerComponent('securitySchemes', …)`, `hide: true`, route `middleware`. Header keys must be lowercase. | https://github.com/honojs/middleware/tree/main/packages/zod-openapi |
| Hono RPC caveats | IDE and type-check slowdown with many routes. Requires exporting `AppType`. | https://hono.dev/docs/guides/rpc |
| openapi-typescript / openapi-fetch / openapi-react-query | 7.13.0 / 0.17.0 / 0.5.4. Middleware `onRequest`, `onResponse`, `onError`. `$api.useQuery('get','/path',{params})`, `useMutation`, `useInfiniteQuery`, `queryOptions`. | https://openapi-ts.dev/openapi-fetch/api · https://openapi-ts.dev/openapi-fetch/middleware-auth · https://openapi-ts.dev/openapi-react-query/ |
| React / Vite | 19.3.1 / 8.3.5. Vite 8 uses Rolldown and needs Node 20.19+ or 22.12+. | https://vite.dev/blog/announcing-vite8 |
| TanStack Router / Query | 1.170.46 (plugin 1.168.48: `tanstackRouter({ target:'react', autoCodeSplitting:true })` placed before `react()`). `basepath` and `rewrite` options. `beforeLoad` with `redirect`. `createRootRouteWithContext`. / 5.105.1 | https://tanstack.com/router/latest/docs/framework/react/installation/with-vite · https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType · https://tanstack.com/router/latest/docs/framework/react/guide/authenticated-routes |
| Tailwind v4 | 4.3.3 with `@tailwindcss/vite`. Class-based dark mode via `@custom-variant dark (&:where(.dark, .dark *));` | https://tailwindcss.com/docs/dark-mode |
| shadcn | CLI 4.23.0: `shadcn@latest init -t vite -b radix` (`--base` is one of base, radix, aria). The `chart` component uses **Recharts v3**. | https://ui.shadcn.com/docs/cli · https://ui.shadcn.com/docs/installation/vite · https://ui.shadcn.com/docs/components/chart |
| CodeMirror 6 | `@codemirror/view` 6.43.15 (has the `EditorView.cspNonce` facet), `lang-yaml` 6.1.3, `merge` 6.12.3, `lint` 6.9.7. `yaml` 2.9.1. | npm registry, package typings |
| i18next | 26.6.0, react-i18next 17.1.10, i18next-resources-to-backend 1.2.3 | npm registry |
| CLI | commander 15.0.0 (ESM-only, Node ≥ 22.12). citty 0.2.2. clipanion 4.0.0-rc.4 (2024-09). @clack/prompts 1.8.1 (`text/password/confirm/select/multiselect/autocomplete/path/group/spinner/progress/tasks/taskLog/log/note/box/isCancel`, async validators, Standard Schema). | https://github.com/tj/commander.js/releases · https://bomb.sh/docs/clack/packages/prompts/ |
| RFC 9457 | Members `type/title/status/detail/instance`. Extension names: ≥ 3 characters, letters, digits and `_`. | https://www.rfc-editor.org/rfc/rfc9457.html |
| Home Assistant ingress | The default `ingress_port` is 8099. Accept connections only from `172.30.32.2`. `X-Ingress-Path` gives the path prefix. `X-Remote-User-Id`, `-Name` and `-Display-Name` are optional and trustworthy only from the Supervisor. SSE and streaming are supported. "Don't ask for a second login." `watchdog: http://[HOST]:[PORT:n]/path` treats any response below 300 as healthy. HA now calls add-ons "apps". | https://contributors.home-assistant.io/apps/guides/ingress/ · https://contributors.home-assistant.io/apps/reference/configuration/ |
| Telegram | `getMe` returns `can_join_groups` and `can_read_all_group_messages` (privacy mode off). Admin bots get all messages. A bot must be **removed and re-added** for a privacy change to apply. Deep links `t.me/<bot>?start=<p>` and `?startgroup=<p>[&admin=…]` take a parameter of ≤ 64 base64url characters. Bot API 10.3 (2026-08-24). | https://core.telegram.org/bots/api#getme · https://core.telegram.org/api/links#bot-links · https://core.telegram.org/bots/features#privacy-mode |
| Discord | `GET /applications/@me` flags: `GATEWAY_GUILD_MEMBERS(_LIMITED)` = 1<<14 / 1<<15, `GATEWAY_MESSAGE_CONTENT(_LIMITED)` = 1<<18 / 1<<19. Install URL: `https://discord.com/oauth2/authorize?client_id=…&scope=bot%20applications.commands&permissions=…`. | https://docs.discord.com/developers/resources/application · https://docs.discord.com/developers/topics/oauth2 |
| Slack | `auth.test` needs no scopes and returns `team`, `user_id` and `bot_id`. `apps.connections.open` validates the app-level `xapp-` token (Authorization header only). App from manifest: `https://api.slack.com/apps?new_app=1&manifest_yaml=<urlencoded>`. | https://docs.slack.dev/reference/methods/auth.test · https://docs.slack.dev/reference/methods/apps.connections.open · https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests |
| Ollama | `GET /api/version`, `GET /api/tags`, `POST /api/pull {model, stream}`. Pull progress streams `status`, `digest`, `total` and `completed`, ending with `success`. OpenAI-compatible API at `/v1`. | https://github.com/ollama/ollama/blob/main/docs/api.md |
| Anthropic | `client.models.list()` and `client.models.retrieve(id)` (Models API). Typed errors: `AuthenticationError` (401), `PermissionDeniedError` (403), `billing_error` (402), `RateLimitError` (429), `overloaded_error` (529). Haiku 5.5 costs $0.10 / $0.50 per MTok. | bundled `claude-api` skill (re-load at implementation time per CLAUDE.md) |
| Others | recharts 3.10.1, lucide-react 1.66.0, sonner 2.0.8, vaul 1.1.2, cmdk 1.1.1, react-hook-form 7.91.0, @tanstack/react-virtual 3.14.25, uqr 0.1.3 (QR), size-limit 14.3.0, @playwright/test 1.64.1, @axe-core/playwright 4.14.0, msw 3.0.3 | npm registry |

**Runtime dependencies introduced by this document.** These are named here so that CLAUDE.md §5 doesn't require separate mini-ADRs.
- **Server:** `hono`, `@hono/node-server`, `@hono/zod-openapi`.
- **api-client:** `openapi-fetch`, `openapi-react-query`.
- **Dashboard:**
  - Framework and data: `react`, `react-dom`, `@tanstack/react-router`, `@tanstack/react-query`, `@tanstack/react-virtual`.
  - Styling and UI: `tailwindcss`, `lucide-react`, the shadcn-generated Radix packages, `sonner`, `vaul`, `cmdk`, `react-hook-form`.
  - Charts and editor: `recharts`, the CodeMirror packages listed above, `yaml`.
  - Other: `i18next`, `react-i18next`, `i18next-resources-to-backend`, `temporal-polyfill`, `uqr`.
- **CLI:** `commander`, `@commander-js/extra-typings`, `@clack/prompts`, `picocolors`, `yaml`, `uqr`.
- **Dev:** `openapi-typescript`, `size-limit`, `@size-limit/file`, `@playwright/test`, `@axe-core/playwright`, `msw`, `execa`, `node-pty`.

---

## 3. Detailed design

### 3.1 Server HTTP composition (`apps/server/src/http`)

```
apps/server/src/http/
├─ app.ts                 # createHttpApp(deps): OpenAPIHono — composes everything below
├─ listeners.ts           # main listener (dashboard.bind:port; also serves 10's /mcp when enabled) + optional ingress listener (8099)
├─ meta/route-meta.ts     # defineRoute() wrapper + typed side-table of x-comvivo metadata
├─ middleware/
│  ├─ request-id.ts       # hono/request-id; echo X-Request-Id
│  ├─ base-path.ts        # strip dashboard.basePath prefix if present (proxies that don't strip)
│  ├─ proxy.ts            # trustProxy: derive client IP/proto/host from X-Forwarded-* only from trusted CIDRs
│  ├─ ingress.ts          # ingress listener only: allowFrom check, X-Ingress-Path, X-Remote-User-* → principal
│  ├─ security-headers.ts # secureHeaders + CSP with NONCE
│  ├─ no-store.ts         # Cache-Control: no-store on /api/* and /control/*
│  ├─ body-limit.ts       # hono/body-limit (api.maxBodyKb)
│  ├─ session.ts          # cookie → Session → RequestPrincipal (rotation, idle bump)
│  ├─ csrf.ts             # Sec-Fetch-Site / Origin + X-Comvivo-CSRF on unsafe methods
│  ├─ rate-limit.ts       # token buckets (§3.7)
│  ├─ group-scope.ts      # /groups/:groupId/* → GroupViewer or 404
│  ├─ recent-auth.ts      # requireRecentAuth(10 min) → 403 step_up_required
│  ├─ idempotency.ts      # Idempotency-Key replay store (24 h)
│  └─ problem.ts          # onError + defaultHook → problem+json
├─ routes/                # one file per resource (§3.5); handlers are 5–30 lines; no business logic
├─ stream/                # SSE hub, ring buffer, per-subscriber IFC filter (§3.6)
├─ control/               # /control/v1 Hono app (bearer), exported type for hono/client in CLI
├─ spa.ts                 # serves apps/dashboard/dist: precompressed static + templated index.html
└─ openapi-emit.ts        # builds app with stub deps → writes apps/server/openapi.json
```

**Middleware order on the main listener:** request-id → base-path → proxy → security-headers → (static/SPA short-circuit) → no-store → body-limit → rate-limit (pre-auth classes) → session → csrf → rate-limit (session classes) → route-level (group-scope, recent-auth, idempotency) → handler. The `problem.ts` `onError` wraps everything.

**`defineRoute`** wraps `createRoute`. It requires metadata, and route registration fails at boot if the metadata is missing:
```ts
type RouteMeta = {
  auth: 'public' | 'session' | 'recent' | 'control' | 'feed' | 'pairing';
  scope: 'none' | 'self' | 'host' | 'group';
  capability?: Capability | readonly Capability[];   // any-of; checked by policy for commands
  ifc: 'readmodel' | 'command' | 'host-infra' | 'none';  // used by the IFC coverage test (§9)
  rateLimit: RateLimitClass;
};
```
The metadata is kept in a typed side-table and also emitted as the `x-comvivo` specification extension on each operation.

**Static assets and the SPA:**
- `serveStatic({ root: dashboardDist, precompressed: true })` serves `/assets/*` with `Cache-Control: public, max-age=31536000, immutable`.
- Any other `GET` that accepts `text/html` and is not under `/api`, `/control`, `/ics`, `/healthz` or `/readyz` returns the **templated `index.html`**. Templating replaces three markers, using a precomputed string split, so there is no per-request parsing:
  - `<base href="{basePath}/">`
  - the CSP nonce
  - `<script type="application/json" id="comvivo-boot">{…}</script>`

  The response carries `Cache-Control: no-store`.
- **Boot JSON** (no secrets): `{ basePath, apiBase, embedded: 'ha'|null, version, setupState: 'needs_host_claim'|'ready', defaultLocale, features: {pairing, magicLink} }`. `features.magicLink` is true only when magic links are allowed for this listener and exposure mode (D-12).

### 3.2 API conventions

| Topic | Rule |
|---|---|
| Base | `/api/v1`. Additive changes only within v1. Breaking changes need `/api/v2`. The API is marked **public-beta** until 1.0. |
| IDs | TypeID strings (`grp_…`, `mbr_…`, `mem_…`, `evt_…`, `tsk_…`, `trn_…`, `sess_…`). The path parameter's prefix is validated. A wrong prefix returns 404, never 400, so no information leaks. |
| Instants | RFC 3339 UTC, e.g. `"2026-11-01T17:00:00Z"`. |
| Zoned times | RFC 9557 / Temporal strings, e.g. `"2026-11-07T18:00:00+01:00[Europe/Madrid]"`. All-day events use a `PlainDate` (`"2026-11-07"`). Recurrence uses an RFC 5545 `rrule` string. |
| Money | `costMicros` is an integer in USD micros. The UI formats it with `Intl.NumberFormat`. |
| Visibility | Every labeled DTO carries `visibility: VisibilityView` (§4.3). It is derived from `Label` for **this viewer** and is never the raw label. |
| Rich text | Chat messages and the charter are returned as the `RichText` AST from 06, never HTML. The dashboard renders the AST to React elements. |
| Lists | `GET` returns `{ items: T[], nextCursor: string \| null }`. `limit` is 1–200 (default 50). `cursor` is opaque base64url of `(sortKey, id, scanPos)`. The order is fixed per resource, with `order=asc\|desc` where meaningful. |
| Filtering | Explicit, typed query parameters per resource (`status`, `assignee`, `from`/`to`, `kind`, `q`). There is no generic filter language. Query schemas are `.strict()`, so unknown parameters return 400 `validation_failed`, which catches typos early. Static path segments (`about-me`, `revoke-others`) are registered before `{id}` routes. |
| Concurrency | Mutable singletons and documents (constitution drafts, plans, settings, lists metadata, events) return `ETag: W/"<version>"`. `PATCH`/`PUT`/`DELETE` on them **require** `If-Match`. A missing `If-Match` returns 428 `etag_required`. A mismatch returns 412 `precondition_failed` with the current resource in `current`. |
| Idempotency | Every `POST` accepts an `Idempotency-Key` header (UUID). The server stores `(sessionId, key) → response` for 24 h. A replay returns the stored response with `Idempotent-Replayed: true`. The dashboard always sends the header. |
| Caching | All `/api` and `/control` responses send `Cache-Control: no-store`. This prevents bfcache and shared-cache leaks after logout. |
| Body | JSON only, ≤ 256 KB by default. Constitution YAML is sent as a JSON string field. No file uploads in v1, except possibly web-chat attachments in M11 (multipart, owned by 06/11, subject to the same CSRF rules). |
| Locale | `Accept-Language` affects only server-rendered charter previews. Problem `detail` text is English. The dashboard localizes by `code` (§3.2.1). |

#### 3.2.1 Problem details

```json
{
  "type": "urn:comvivo:problem:validation_failed",
  "title": "Validation failed",
  "status": 400,
  "detail": "2 fields need attention.",
  "instance": "/api/v1/groups/grp_01j…/events#req_01j9…",
  "code": "validation_failed",
  "requestId": "req_01j9…",
  "errors": [{ "pointer": "/start", "code": "invalid_zoned_datetime", "message": "Use a date and time with a timezone." }]
}
```

| `code` | HTTP | When | Extra members |
|---|---|---|---|
| `validation_failed` | 400 | zod failure from `defaultHook`, or an unknown query parameter | `errors[]` |
| `unauthenticated` | 401 | No session, or the session is expired or revoked | `login: {methods}` |
| `token_invalid` | 401 | A magic link or pairing code is expired, used, unknown or for a different instance. One message covers all cases. | — |
| `csrf_failed` | 403 | CSRF checks failed | — |
| `step_up_required` | 403 | Recent auth is older than 10 minutes | `stepUp: {methods:['dm_approve','dm_code']}` |
| `forbidden` | 403 | Capability or scope missing for a non-policy check (for example, not host) | — |
| `policy_denied` | 403 | `PolicyDecision.deny` | `reason`, `userMessage` (from 03 templates) |
| `not_found` | 404 | Doesn't exist **or is not readable** | — |
| `conflict` | 409 | Domain conflict (for example, a proposal is already closed) | — |
| `setup_required` | 409 | The instance is unclaimed and the endpoint needs a host | — |
| `already_claimed` | 409 | A host claim was attempted after setup | — |
| `precondition_failed` | 412 | `If-Match` doesn't match | `current` |
| `payload_too_large` | 413 | Body over the limit | — |
| `unsupported_media_type` | 415 | Not JSON | — |
| `etag_required` | 428 | `If-Match` missing | — |
| `rate_limited` | 429 | Bucket empty | `retryAfter` (also sent as a header) |
| `internal` | 500 | A bug. No stack trace; the error is logged with `requestId`. | — |
| `actor_busy` | 503 | The group actor didn't accept the command within 8 s and the command was not enqueued | `Retry-After` |
| `server_draining` | 503 | Shutdown is in progress | `Retry-After` |

### 3.3 Information-flow control on the API

**Principle.** The dashboard is just another audience. A viewer sees exactly what Comvivo could say to that viewer alone in a private DM. **Roles never grant read access.** Capabilities such as `members.manage` or `memory.forget.any` grant *actions* on data the viewer can already read. "Admin" therefore never means "can read DMs" (spine §9, invariant I1).

**Resolution pipeline (per request):**
1. `session.ts` produces a `RequestPrincipal { personId, sessionId, instanceRole: 'host' | null, authTime, via }`.
2. `group-scope.ts` runs on `/groups/:groupId/*`. It:
   - loads the `Member` for `(groupId, personId)` with `status:'active'`,
   - otherwise returns **404** (a host who isn't a member also gets 404),
   - builds a `GroupViewer` (§4.1): `audience = {kind:'members', groupId, memberIds: new Set([memberId])}`, `capabilities` from `capabilitiesFor(policy, member)` (03 §3.2.10), and `snapshot = GroupSnapshot` pinned to request start.
3. The handler calls `deps.read.<resource>(viewer, query)` from `@comvivo/engine/readmodels`, or `deps.commands.dispatch(...)` (§3.4). **HTTP code never touches repositories.** A dependency-cruiser rule forbids `apps/server/src/http/** → @comvivo/storage` and `→ @comvivo/engine/**/internal`.
4. **Read models** (owned here and implemented in `packages/engine/src/readmodels/`):
   - **Prefilter in SQL** with the viewer's **eligible-label-id set** (01 §14 A8; 02 §3.2 `EligibleLabelSet`): core `canRead` computes, once per request, the interned `label_id`s the viewer may read (cached per snapshot), and repositories filter with `label_id IN (:eligible)`. SQL never re-implements IFC and there are no per-row reader columns. It is only an optimization.
   - **Authoritative check:** every row passes `InformationFlow.canRead(row.label, viewer.audience, viewer.snapshot)` inside `ifc-gate.ts`. Only that module can construct the brand `Readable<T>`, a unique-symbol-branded type.
   - DTO mappers have the signature `(r: Readable<T>, viewer) => Dto`. Route response schemas are built from these mappers, so serializing an unchecked row is a **compile error**.
   - **Derived data** (counts, the home summary, the fairness ledger, usage aggregates) is computed only from `Readable` rows. The exceptions are aggregates that 03/07 define as group-visible by construction. Those come back from their owning service with an explicit label, which goes through the same gate.
5. **Pagination with post-filtering.** The read model scans in batches of `limit × 2` until it has `limit` readable rows or has scanned 5 batches. It returns `nextCursor` pointing at the **scan position**, not the last returned row. A page may hold fewer than `limit` items, even zero, while `nextCursor` is still non-null. The dashboard keeps loading while `nextCursor` is non-null and the visible list isn't full. Totals are **never** returned.
6. **Search.** Memory search goes through `MemoryQueryService.search(audience, query, filters, cursor)` (04 §4.1, in `engine/readmodels`), which builds the `EligibleLabelSet` and applies `canRead` inside retrieval (01 §14 A11; was §12 P-2).
7. **Errors.** An entity the viewer can't read returns 404 with the same body and the same code path as a missing one. Mutations on unreadable targets also return 404.
8. **SSE.** Every event carries a label, and the hub evaluates `canRead` per subscriber before writing (§3.6).
9. **Host infrastructure views.** `/instance/*` returns **infrastructure metadata only**:
   - group names, platform, member *counts*, budget usage, channel health, job queue depth, DB size,
   - never member names of groups the host isn't in, and never content.

   These routes are tagged `ifc:'host-infra'`, and their DTO schemas are reviewed against an allow-list of fields (§9).

**What each viewer sees.** `R(L)` means "viewer ∈ readers(L)".

| Data | Member | Admin (`members.manage`, `settings.write`, …) | Host, not a member | Host, member |
|---|---|---|---|---|
| Group-labeled memories, events, tasks and messages | ✓ | ✓ | ✗ | ✓ |
| Another member's DM with Comvivo, private memories, private tasks | ✗ | ✗ | ✗ | ✗ |
| Own DM and private items | ✓ | ✓ | n/a | ✓ |
| Traces of group-audience turns | if `traces.read.group` | if `traces.read.group` | ✗ | as member |
| Traces of own DM turns | if `traces.read.own` | same | ✗ | same |
| Other members' consent states | ✗ (own only) | ✓ with `members.manage` (03 may restrict) | ✗ | as member |
| Audit events | `R(label)` and `audit.read` | same | instance-level events only | same plus instance-level |
| Usage by route, model or day | if `usage.read` | same | per-group totals | same |
| Usage per member | only if the constitution enables it | same | ✗ | same |

### 3.4 Mutations: the command path

```
HTTP handler ─▶ CommandBus.dispatch(groupId, Command, principal, origin:'dashboard', idempotencyKey)
                  │ enqueue ActorEvent{kind:'command', priority:'interactive'} to group actor
                  ▼
              group actor (serial) ─▶ CommandHandler (engine/commands/<x>.ts)
                  │ build ActionRequest (capability, target, dataLabels, provenance{initiatedBy:'member'})
                  │ PolicyEngine.authorize(req, principal, compiledPolicy, stateView)   // pure, 03
                  │ allow → tx{ state change + AuditEvent(via:'dashboard') + DomainEvent }
                  │ needs_confirmation / contested → create Approval / Proposal rows (05/03)
                  ▼
              Outcome  ─▶ HTTP: 200 {outcome:'done', result} | 202 {outcome:'needs_confirmation', approval}
                                | 202 {outcome:'contested', proposal} | 403 policy_denied
```

- **Same semantics as chat.** Where a built-in tool exists (calendar, tasks, lists, polls, plans, decisions, memory controls), the command handler **reuses the tool's `action()` and `execute()`** (`@comvivo/tools`) through the tools-executor entry point. It passes `origin:'dashboard'`, and there is no model involvement. This keeps invariants I2 and I3 and avoids duplicate business logic. Commands without a tool, such as constitution proposals, member role changes, consent, and settings, are engine application services. They call the same PolicyEngine.
- **Notifications.** If the policy decision includes `notify`, or the constitution asks for change notices, the engine posts the notice to chat. That is the same behavior as a chat-initiated change, and it goes through the outbox and the guard.
- **Latency.** The handler waits up to **8 s** for the outcome. If the actor is mid-turn and hasn't yet run the command, the API returns `202 {outcome:'queued', commandId}`. The client then waits for the SSE event `command.completed` or polls `GET /api/v1/commands/{commandId}`. If the actor mailbox is full, the API returns 503 `actor_busy`.
- **Interleaving requirement on 05.** Commands carry `priority:'interactive'`. The actor must be able to run them between a turn's model calls, because model calls happen outside the serialized section. See open question Q-12.
- **Confirmations.**
  - A `needs_confirmation` result with `from:'requester'` is shown as a confirm dialog. Approving sends `POST /groups/{g}/approvals/{id}/decision {decision:'approve'}`.
  - Confirmations from an `owner`, `admin` or `guardian` appear in that person's **Approvals** inbox (on the Home screen) and as a chat prompt (05/06).

### 3.5 Route table

**Legend.**
- **Auth:**
  - `pub` = none
  - `S` = session
  - `S+R` = session with recent auth (≤ 10 min)
  - `C` = control bearer
  - `F` = feed token in the path
  - `P` = pairing cookie
- **Who:**
  - `host` = Instance owner
  - `self` = the principal's own data
  - `mbr` = active member of the group, with IFC filtering
  - otherwise a capability from the closed catalog in 03 §3.1.2 (01 §14 A6; it must include `audit.read`, `usage.read` and `dashboard.access`)
- **IFC:** `RM` = read model, `CMD` = command, `INF` = host-infra, `—` = none.
- All paths are relative to `/api/v1` unless they start with `/`.
- Requests and responses are summarized. The zod schemas in `apps/server/src/http/schemas/*` are normative.

#### Meta, health, auth

| Method | Path | Auth | Who | IFC | Request → Response |
|---|---|---|---|---|---|
| GET | `/healthz` | pub | — | — | → `200 {status:'ok'\|'starting'\|'degraded'}` or `503 {status:'draining'\|'fail'}` (§3.8) |
| GET | `/readyz` | pub | — | — | → `200 {status:'ready', degraded:[…]}` or `503` problem listing failing check **names** |
| POST | `/mcp` | MCP PAT (bearer) | the token's member | per 10 | MCP Streamable HTTP endpoint, **owned by 10 §3.7.2** (transport, middleware order, tools) and 08 §3.7.12 (token format). Mounted on the main listener only when `mcp.server.http.enabled`; never on the ingress listener; outside `/api/v1`, the session/CSRF chain and the SPA; requests with a `Cookie` header are rejected. GET/DELETE → 405 |
| GET | `/meta` | pub | — | — | → `{product, apiVersion:'1', setupState, loginMethods:['pairing'] or ['pairing','magic_link'] (D-12), basePath}`. The version is only shown when authenticated. |
| GET | `/openapi.json` | S | — | — | → OpenAPI 3.1 document. The docs site renders it publicly (13). |
| POST | `/auth/magic/exchange` | pub (Origin-checked) | — | — | `{token}` → `200 {me}` + Set-Cookie, or `401 token_invalid`. Mounted only where magic links are allowed (D-12) |
| POST | `/auth/pairing` | pub (Origin-checked) | — | — | `{}` → `{pairingId, code, deepLinks:{telegram?}, expiresAt}` + Set-Cookie `comvivo_pending` (name per D-14) |
| GET | `/auth/pairing/{pairingId}` | P | — | — | → `{status:'pending'\|'approved'\|'denied'\|'expired'}`. On `approved` it sets the session cookie, and the pairing is consumed. |
| POST | `/auth/claim` | pub (Origin-checked) | — | — | `{code, displayName, locale, timezone}` → `200 {me}` + cookie. Only works while `setupState='needs_host_claim'`. |
| POST | `/auth/logout` | S | self | — | → `204`. Revokes the current session. |
| POST | `/auth/step-up` | S | self | — | `{action}` → `{challengeId, expiresAt, delivery:'dm_approve'\|'dm_code'}` |
| GET | `/auth/step-up/{challengeId}` | S | self | — | → `{status}`. On `approved`, `session.authTime` is set to now. |
| POST | `/auth/step-up/{challengeId}/verify` | S | self | — | `{code}` → `204` (fallback for channels without buttons) |

#### Me (person-level)

| Method | Path | Auth | Who | IFC | Request → Response |
|---|---|---|---|---|---|
| GET | `/me` | S | self | RM | → `{person:{id,displayName,locale,timezone}, instanceRole, groups:[{id,name,role,capabilities[],consent,timezone}], session:{id,authTime,expiresAt}, csrfToken, prefs}` |
| PATCH | `/me` | S | self | CMD | `{displayName?, locale?, timezone?, prefs?:{theme,density}}` |
| GET | `/me/sessions` | S | self | — | → `items[{id,current,createdAt,lastSeenAt,via,userAgentSummary,ipPrefix}]` |
| DELETE | `/me/sessions/{sessionId}` | S | self | — | → `204` |
| POST | `/me/sessions/revoke-others` | S | self | — | → `{revoked:n}` |
| GET | `/me/identities` | S | self | — | → linked channel identities (channel, handle, verifiedAt) |
| POST | `/me/identities/link-codes` | S | self | — | → `{code, deepLinks, expiresAt}` (06 consumes the code in chat) |
| DELETE | `/me/identities/{identityId}` | S+R | self | — | → `204`. 409 if it is the last identity. |
| GET | `/me/mcp-tokens` | S | self | — | → `items[{id,groupId,name,scopes,createdAt,lastUsedAt,expiresAt,lastClientInfo?}]` (10 §3.7.3; metadata only) |
| POST | `/me/mcp-tokens` | S+R | self | — | `{groupId,name,scopes,expiresInDays}` → `{token (shown once), …}` |
| DELETE | `/me/mcp-tokens/{id}` | S | self | — | → `204` |
| POST | `/me/exports` | S+R | `export.self` | CMD | `{groupIds?}` → `202 {jobId}` |
| GET | `/me/exports/{exportId}` | S | self | — | → `{status, downloadUrl?, expiresAt}`. `downloadUrl` is single-use and lasts 5 minutes. |
| GET | `/me/approvals` | S | self | RM | → pending approvals addressed to me across groups |

#### Groups, members, conversations, chat

| Method | Path | Auth | Who | IFC | Request → Response |
|---|---|---|---|---|---|
| GET | `/groups` | S | self | RM | → my groups `[{id,name,archetype,role,channels[],unreadApprovals}]` |
| GET | `/groups/{g}` | S | mbr | RM | → `{id,name,archetype,timezone,locale,constitutionVersion,conversations[],budget?}` |
| PATCH | `/groups/{g}` | S | `settings.write` | CMD | `{name?,timezone?,locale?}` + If-Match |
| GET | `/groups/{g}/home` | S | mbr | RM | → `{needsYou:{approvals,polls,proposals}, upcoming:Event[7d], myTasks, recentDecisions[5], recentActivity[5], status:{channels,budgetLevel?}}` |
| GET | `/groups/{g}/members` | S | mbr | RM | → `items[{id,displayName,role,status,joinedAt,channels[],consent?}]`. `consent` is present only for self or `members.manage`. |
| GET | `/groups/{g}/members/{m}` | S | mbr | RM | → member with `capabilities[]` |
| PATCH | `/groups/{g}/members/{m}` | S+R | `members.manage` | CMD | `{role}` → Outcome (may be `contested`) |
| POST | `/groups/{g}/members/{m}/remove` | S+R | `members.manage` | CMD | → Outcome |
| POST | `/groups/{g}/members/{m}/consent-notice` | S | `members.manage` | CMD | → re-sends the consent notice in DM (03/06) |
| PATCH | `/groups/{g}/me/consent` | S | self (`profile.self`, Floor) | CMD | `{consent:'memory_on'\|'memory_off'}` |
| POST | `/groups/{g}/invites` | S | `members.invite` | CMD | `{ttlHours, role?}` → `{code, deepLinks, joinUrl?, expiresAt}`. `joinUrl` is only for web-channel groups. |
| GET | `/groups/{g}/conversations` | S | mbr | RM | → group conversations plus **my** DMs |
| GET | `/groups/{g}/conversations/{c}/messages` | S | mbr | RM | `?cursor&limit&before` → messages (`RichText`, sender, `untrusted`, `visibility`, `turnId?`) |
| POST | `/groups/{g}/chat/dm` | S | `chat.ask` | CMD | → get or create my web DM conversation `{conversationId}` |
| POST | `/groups/{g}/conversations/{c}/messages` | S | `chat.ask` | CMD | `{text, replyToId?, clientMessageId}` → `202 {messageId}`. Web channel only (other channels return 409). The reply arrives over SSE. |

#### Constitution and proposals (semantics: 03)

| Method | Path | Auth | Who | IFC | Request → Response |
|---|---|---|---|---|---|
| GET | `/groups/{g}/constitution` | S | `constitution.read` (Floor) | RM | → `{versionId, version, yaml, charter:RichText, summary:{roles[], grants:Matrix, strategies, privacyDefaults, proactivity}, adoptedAt, adoptedVia}` + ETag |
| GET | `/groups/{g}/constitution/versions` | S | mbr | RM | → `items[{versionId,version,adoptedAt,adoptedVia,proposalId?}]` |
| GET | `/groups/{g}/constitution/versions/{v}` | S | mbr | RM | → version body |
| GET | `/groups/{g}/constitution/diff` | S | mbr | RM | `?from&to` (version or `draft:<proposalId>`) → `{semantic:[{path,kind,before,after,plain}], fromYaml, toYaml}` |
| GET | `/groups/{g}/constitution/schema` | S | mbr | — | → JSON Schema (from `z.toJSONSchema` in 03) for completion and hovers |
| POST | `/groups/{g}/constitution/validate` | S | `constitution.propose` | — | `{yaml}` → `{valid, issues[{code,path,line,column,endLine,endColumn,severity,message}] (03 §3.2.5 `ConstitutionIssue` verbatim), charter?:RichText, summary?, semantic?:SemanticChange[] (03 `semanticDiff`, incl. `plain` and `privacyReducing`)}`. Pure, no writes, rate class `validate`. |
| GET | `/groups/{g}/proposals` | S | mbr | RM | `?status=open\|closed&kind` → proposals with tallies (anonymity per 03) |
| POST | `/groups/{g}/proposals` | S | `constitution.propose` | CMD | `{kind:'amendment', yaml, title, rationale, baseVersionId}` → `201 {proposal}` or Outcome |
| GET | `/groups/{g}/proposals/{p}` | S | mbr | RM | → proposal, my vote, eligibility |
| POST | `/groups/{g}/proposals/{p}/votes` | S | `proposals.vote` (eligible per 03) | CMD | `{choice:'yes'\|'no'\|'abstain'}` |
| POST | `/groups/{g}/proposals/{p}/ratify` | S+R | `constitution.ratify` | CMD | → Outcome (only when the rules allow direct adoption) |
| POST | `/groups/{g}/proposals/{p}/withdraw` | S | proposer | CMD | → `204` |
| GET | `/groups/{g}/approvals` | S | mbr | RM | `?mine=true` → pending confirmations |
| POST | `/groups/{g}/approvals/{a}/decision` | S | approver | CMD | `{decision:'approve'\|'reject', note?}` → Outcome |
| GET | `/commands/{commandId}` | S | self | — | → `{status:'queued'\|'running'\|'done'\|'failed', outcome?}` |

#### Memory (semantics: 04)

| Method | Path | Auth | Who | IFC | Request → Response |
|---|---|---|---|---|---|
| GET | `/groups/{g}/memories` | S | `memory.read` | RM | `?q&kind[]&subject[]&visibility=group\|private\|shared&status[]&sensitivity&pinned&from&to&cursor` → `items[MemoryCard]` |
| GET | `/groups/{g}/memories/about-me` | S | self | RM | → items whose subject is me (including private ones), grouped by kind |
| GET | `/groups/{g}/memories/{id}` | S | `memory.read` | RM | → `{memory, provenance:{sources[],extractedBy,confidence}, history[], visibility}` |
| PATCH | `/groups/{g}/memories/{id}` | S | `memory.write` | CMD | `{content}` + If-Match → creates a superseding item |
| POST | `/groups/{g}/memories/{id}/forget` | S | `memory.forget.own` or `memory.forget.any` | CMD | `{reason?}` → Outcome |
| POST | `/groups/{g}/memories/{id}/pin` | S | `memory.write` | CMD | `{pinned:boolean}` |
| POST | `/groups/{g}/memories/{id}/confirm` | S | `memory.write` | CMD | `{accept:boolean}` (proposed memories) |
| POST | `/groups/{g}/memories/{id}/visibility` | S | owner | CMD | `{readers:'group'\|'private'\|{memberIds}}`. Narrowing is always allowed. Widening is a declassification by the owner (03). |

#### Coordination (semantics: 07)

| Method | Path | Auth | Who | IFC | Notes |
|---|---|---|---|---|---|
| GET | `/groups/{g}/events` | S | `calendar.read` | RM | `?from&to` (≤ 120 days) → **expanded occurrences** in the group timezone, each with `{eventId, occurrenceId, start, end, allDay, recurring}` |
| POST | `/groups/{g}/events` | S | `calendar.write` | CMD | `{title,start,end?,allDay?,rrule?,location?,attendeeIds?,visibility?,reminders?}` |
| GET / PATCH / DELETE | `/groups/{g}/events/{id}` | S | `calendar.read` / `.write` | RM / CMD | PATCH and DELETE take `?scope=this\|following\|all&occurrence=…` + If-Match |
| GET | `/groups/{g}/calendar/feeds` | S | `calendar.read` | — | → my feed tokens `[{id,scope,detail,createdAt,lastUsedAt,revokedAt}]` (02 `ics_feed_tokens`; never the URL or token) |
| POST | `/groups/{g}/calendar/feeds` | S (S+R when `scope:'member'`) | `calendar.read` | — | `{scope:'group'\|'member', detail:'full'\|'busy'}` (default `{scope:'group', detail:'full'}`) → `202 {id, deliveredVia:'dm'}`. Mints or rotates the member's 256-bit `vics_` token (07 §3.1.1) and **delivers the link only in the member's DM for this group** (07 §3.1.5); the URL is never in the response. `409 dm_needed` if the member has no reachable DM |
| DELETE | `/groups/{g}/calendar/feeds/{id}` | S | self | — | → `204` (sets `revokedAt`) |
| GET | `/ics/v1/{token}.ics` | F | feed owner | RM | `text/calendar`, owned by 07 §3.1.5 (route, audience, detail levels, 404 parity, 60/h per token). `scope:'member'` renders with audience `{owner}` incl. their private events; `scope:'group'` includes only group-readable events. Tokens are revoked when the owner leaves |
| GET / POST | `/groups/{g}/reminders` | S | mbr / `reminders.self` or `.others` | RM / CMD | Lists my reminders and group-visible ones. Creating one for others needs `reminders.others`. |
| PATCH / DELETE | `/groups/{g}/reminders/{id}` | S | creator or `reminders.others` | CMD | |
| GET | `/groups/{g}/tasks` | S | `tasks.read` | RM | `?assignee=me\|<id>&status&due=overdue\|today\|week\|later\|none&rotation` |
| POST | `/groups/{g}/tasks` | S | `tasks.self` or `tasks.assign` | CMD | Assigning to others needs `tasks.assign` |
| PATCH | `/groups/{g}/tasks/{id}` | S | `tasks.self` / `tasks.assign` | CMD | + If-Match |
| POST | `/groups/{g}/tasks/{id}/complete` | S | `tasks.self` (assignee) | CMD | `{done:boolean}` |
| GET / POST | `/groups/{g}/rotations` | S | `tasks.read` / `tasks.manage_rotations` | RM / CMD | |
| PATCH / DELETE | `/groups/{g}/rotations/{id}` | S | `tasks.manage_rotations` | CMD | |
| GET | `/groups/{g}/fairness` | S | `fairness.ledger.read` (visibility per the constitution's `ledgerVisibility`) | RM | `?window=30d\|90d` → `{members[{memberId,points,share,targetShare}], method, explanation:RichText}` |
| GET / POST | `/groups/{g}/lists` | S | `lists.read` / `lists.write` | RM / CMD | |
| GET / PATCH / DELETE | `/groups/{g}/lists/{id}` | S | `lists.read` / `lists.write` | RM / CMD | GET includes the items |
| POST | `/groups/{g}/lists/{id}/items` | S | `lists.write` | CMD | `{text}` |
| PATCH / DELETE | `/groups/{g}/lists/{id}/items/{itemId}` | S | `lists.write` | CMD | `{checked?, text?}` |
| POST | `/groups/{g}/lists/{id}/clear-checked` | S | `lists.write` | CMD | |
| GET / POST | `/groups/{g}/polls` | S | mbr / `polls.create` | RM / CMD | POST posts the poll in the group chat (native poll where supported) |
| GET | `/groups/{g}/polls/{id}` | S | mbr | RM | results respect the poll's anonymity setting |
| POST | `/groups/{g}/polls/{id}/votes` | S | `polls.vote` (eligibility per 07) | CMD | `{optionIds[]}` |
| POST | `/groups/{g}/polls/{id}/close` | S | creator or `polls.create` and admin | CMD | |
| GET / POST | `/groups/{g}/plans` | S | `plans.read` / `plans.write` | RM / CMD | |
| GET / PATCH | `/groups/{g}/plans/{id}` | S | `plans.read` / `plans.write` | RM / CMD | Steps are edited through PATCH with JSON Merge Patch on `steps` + If-Match |
| GET / POST | `/groups/{g}/decisions` | S | `decisions.read` / `decisions.record` | RM / CMD | `?q&from&to` |
| GET / PATCH | `/groups/{g}/decisions/{id}` | S | `decisions.read` / `decisions.record` | RM / CMD | PATCH supersedes the decision (03/07) and never edits it in place |

#### Traces, audit, usage, settings, exports

| Method | Path | Auth | Who | IFC | Notes |
|---|---|---|---|---|---|
| GET | `/groups/{g}/traces` | S | `traces.read.own` or `.group` | RM | `?conversation&disposition&from&to&cursor` → `items[{turnId,at,conversation,disposition,status,costMicros,latencyMs,triggerExcerpt?}]` |
| GET | `/groups/{g}/traces/{turnId}` | S | same | RM | → `TraceView` (§3.10.6.12) |
| GET | `/groups/{g}/messages/{messageId}/trace` | S | same | RM | → `{turnId}` of the turn that produced the message, or 404 |
| GET | `/groups/{g}/activity` | S | mbr | RM | Friendly feed (`AuditEvent`s the viewer can read, mapped to i18n templates) |
| GET | `/groups/{g}/audit` | S | `audit.read` | RM | `?actor&action&from&to&decision` → detailed rows `{seq,at,actor,action,target,decision,via}` |
| GET | `/groups/{g}/usage` | S | `usage.read` | RM | `?from&to&groupBy=day\|route\|model` → series. `member` grouping requires the constitution flag. |
| GET / PATCH | `/groups/{g}/budget` | S | `usage.read` / `settings.write` | RM / CMD | `{monthlyUsd,dailyUsd,alertAtPct}` within the instance caps |
| GET / PATCH | `/groups/{g}/settings` | S | `settings.read` / `settings.write` | RM / CMD | Each value is returned as `{value, source:'constitution'\|'group'\|'instance'\|'default', editable, governedBy?}` |
| POST | `/groups/{g}/exports` | S+R | `export.group` | CMD | → `202 {jobId}`. Contains **group-labeled data only** (02 format). |
| GET | `/exports/{exportId}` | S | creator | — | status and a single-use `downloadUrl` |
| GET | `/exports/{exportId}/download` | S | creator | — | Signed for 5 minutes. `Content-Disposition: attachment`. |
| GET | `/stream` | S | self | RM | SSE (§3.6) |

#### Instance (host only; IFC `INF`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/instance` | S | `{name, version, deployment:{mode}, uptimeS, dataDir:{sizeBytes,freeBytes}, groups:n, publicUrl}` |
| PATCH | `/instance` | S+R | `{name?}`. `publicUrl` and `bind` are file/env settings and are shown read-only. |
| GET | `/instance/onboarding` | S | checklist state (§3.10.6.15) |
| GET | `/instance/health` | S | online subset of the doctor checks `[{id,status,title,detail,fix}]` |
| GET / PATCH | `/instance/settings` | S / S+R* | Settings tree with `{value, source:'env'\|'db'\|'file'\|'default', editable, restartRequired}`. Only the DB layer can be changed; **host-only keys** (01 §14 A14: providers and API keys, egress allowlists, plugins, MCP servers, debug-content logging, exposure mode) are `editable:false` and a PATCH on them returns 403 `host_only`. *Recent auth is required for `privacy.*`, `models.*` and `channels.*`. |
| GET | `/instance/models` | S | `{preset, routes:[{route,provider,model,effort}], providers:[{id,keyPresent,keyHint:'…abcd',source:'env'}], local:{baseUrl,model,reachable}}` |
| POST | `/instance/models/test` | S | `{provider, route?}` → `ProbeReport` (rate class `probe`) |
| GET | `/instance/channels` | S | `[{channel, enabled, state:'connected'\|'connecting'\|'error'\|'disabled', identity:{handle,id}, lastEventAt, checks:ProbeCheck[]}]` |
| POST | `/instance/channels/{ch}/check` | S | re-runs the probe → `ProbeReport` |
| POST | `/instance/channels/{ch}/restart` | S | → `202` |
| PATCH | `/instance/channels/{ch}` | S+R | `{enabled?, settings?}` (non-secret only) |
| GET | `/instance/groups` | S | `[{id,name,archetype,channels[],memberCount,createdAt,budgetPct,lastActivityAt}]` |
| POST | `/instance/claim-codes` | S | `{kind:'group', channel?, groupId?, template?, ttlMinutes≤30}` → `{code, deepLinks:{telegram?:{group}}, instructions:{discord?,slack?,matrix?,signal?}, expiresAt}` (TTL 30 min by default and at most, 01 §14 A27) |
| GET / POST | `/instance/backups` | S | list `[{id,createdAt,sizeBytes,verified,kind}]` / create → `202 {jobId}` |
| GET | `/instance/backups/{id}/download` | S+R | encrypted archive stream (02 format) |
| GET | `/instance/usage` | S | totals by group, route, model and day |
| GET | `/instance/audit` | S | instance-level events (logins, settings, plugins, keys) |
| POST | `/instance/audit/verify` | S | → `{ok, groups:[{groupId, ok, brokenAtSeq?}]}` (hash chain, no content) |
| GET | `/instance/plugins` | S | `[{id,version,enabled,permissions[],pendingPermissionChanges[]}]` |
| PATCH | `/instance/plugins/{id}` | S+R | `{enabled?, approvePermissions?:string[]}`. Install and remove are **CLI only** (§3.11.3). |
| GET | `/instance/security` | S | `{encryptionAtRest, keyFileMode, lastKeyRotationAt, recoveryKeyVerifiedAt, controlApiEnabled, sessionsActive}` |
| GET | `/instance/sessions` | S | all sessions (person display name, via, lastSeenAt) |
| DELETE | `/instance/sessions/{id}` | S+R | revoke |
| GET | `/instance/updates` | S | `{enabled, current, latest?, checkedAt?, notesUrl?}`. Only fetches when `updates.check: true`. |

#### Control API (`/control/v1`, bearer `C`, for the CLI only; never on the ingress listener)

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | `{version, schemaVersion, uptimeS, role, mode, groups:n, channels[], queue:{pending,failed}, outboxPending, lastBackupAt, budgets[]}` |
| GET | `/doctor` | online doctor checks |
| POST | `/login-links` | `{deliver:'print'\|'chat'}` → `{url?, sentTo?}` for the host person. If no host exists yet, it claims one (local proof), creating a host Person with a web identity. |
| POST | `/claim-codes` | `{kind:'host'\|'group', channel?, groupId?, template?, ttlMinutes≤30}` → code and deep links |
| GET | `/events` | SSE: `setup.host_claimed`, `group.bound {groupId,name,channel}`, `channel.status`, `job.progress` |
| POST | `/backups` | `{tier?, label?}` → create a backup and stream progress |
| POST / DELETE | `/backups/ha-snapshot` | HA `backup_pre`/`backup_post` hooks (12 §3.5): write or delete `backups/ha-snapshot/*.vbak` |
| POST | `/db/checkpoint` | `wal_checkpoint(TRUNCATE)` (`comvivo db checkpoint`, 12 runbook R2) |
| POST | `/channels/{ch}/restart` | |
| POST | `/sessions/revoke-all` | `{except?:personId}` |
| PUT / DELETE | `/vault/{namespace}/{name}` | Write or remove an extension secret in the 08 vault (`namespace` ∈ `plugin`, `mcp`; 08 §3.10). Used by `comvivo plugin secret set` and `comvivo mcp client secret set` while the server runs (the server holds the vault key); the value travels in the body, never in the URL, and is never returned. When the server is stopped the CLI unlocks the keyring itself (keyfile/keychain modes) and writes the vault directly |
| POST | `/reload` | re-read `.env` and hot-reloadable settings (§5.3) |
| POST | `/shutdown` | `{drainSeconds≤60}` |

### 3.6 SSE live updates

- **Endpoint:** `GET /api/v1/stream?groups=grp_a,grp_b`. The default is all of the viewer's groups. Auth is the session cookie: same-origin `EventSource` sends cookies, and no custom headers are needed. On the ingress listener, the HA identity headers are used instead.
- **Headers:** `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`. Compression is disabled on this route.
- **Framing:** written with `streamSSE`. The first frame is `retry: 3000`, followed by a `hello` event. A comment heartbeat `: ping` is sent every 15 s. The server closes the stream after **30 minutes**, and the client reconnects with `Last-Event-ID`. Reconnecting re-runs session validation and rotation.
- **IDs:** `<bootId>:<seq>`. `bootId` is 8 random characters per process start. `seq` is a monotonic integer.
- **Ring buffer:** the last 2,000 events or 10 minutes, whichever is smaller, kept in memory together with each event's label. On reconnect:
  - **Same `bootId` and the sequence is still buffered:** the server replays the missed events, filtered for this viewer.
  - **Otherwise:** it sends `resync {reason}`, and the client invalidates all queries.
- **Fan-out:**
  1. `DomainEventBus` (engine, post-commit only) publishes `{groupId, kind, resource, ids, label}`.
  2. The hub assigns the ID and buffers the event.
  3. For each subscriber of that group, the hub evaluates `canRead(label, {viewer})` against a cached `GroupSnapshot`. The snapshot is refreshed when a `members` invalidation arrives.
  4. Only then does the hub write the event.
- **Back-pressure:** if a subscriber has more than 1 MB queued, the server closes the connection. The client reconnects and gets `resync`.
- **Limits:** 4 streams per session and 64 per instance. Above that the server returns 429.
- **Revocation:** if a session is revoked, its streams receive `session.revoked` and are closed.
- **Event types** (closed union, exported in OpenAPI as `components.schemas.StreamEvent`):

| `event` | `data` | Delivered to |
|---|---|---|
| `hello` | `{bootId, serverTime, resumed}` | the subscriber |
| `resync` | `{reason:'restart'\|'gap'\|'overflow'}` | the subscriber |
| `invalidate` | `{groupId, resources:ResourceKind[], ids?:string[]}` | readers of the label |
| `chat.message` | `{groupId, conversationId, message:ChatMessageDto}` | readers of the conversation |
| `chat.typing` | `{groupId, conversationId, on}` | readers |
| `turn.status` | `{groupId, conversationId, turnId, status}` | readers of the turn's audience |
| `command.completed` | `{commandId, outcome}` | the issuing session |
| `approval.requested` | `{groupId, approvalId}` | the approver |
| `job.progress` | `{jobId, kind, state, pct?}` | the job creator |
| `budget.status` | `{groupId, level:'ok'\|'warning'\|'degraded'\|'exhausted'}` | members with `usage.read` |
| `channel.status` | `{channel, state, detail?}` | host |
| `session.revoked` | `{reason}` | that session |
| `notice` | `{level, code, params}` | targeted |

`ResourceKind` = `events | reminders | tasks | rotations | fairness | lists | polls | plans | decisions | memories | members | constitution | proposals | approvals | traces | activity | audit | usage | settings | conversations`.

- **Split roles** (`--role=web|worker`): the in-process bus is replaced by a SQLite-tailing implementation that polls a `domain_events` table every 500 ms. 02 owns the table, and it is pruned after 1 hour. With `role=all`, the default, events never touch the DB.

### 3.7 Rate limits

Token buckets in memory, with idle buckets swept every 60 s. The key depends on the class: IP (after `trustProxy`), person, session, or the instance (global). The middleware emits `RateLimit-Policy` and `RateLimit` headers (IETF draft format) and `Retry-After` on 429. The limits below can be overridden under `dashboard.rateLimits`. This table is normative for numbers; 08 §3.8.8 restates the security-relevant rows and must match it.

| Class | Key | Limit | Applies to |
|---|---|---|---|
| `unauth` | IP | 300/min | every request without a session (pre-auth) |
| `auth.exchange` | IP | 10/min, burst 5 | magic exchange, pairing create, claim |
| `auth.issue` | person | 5 per 15 min | magic-link issue (chat `/dashboard`), step-up challenges |
| `auth.stepup` | session | 5/hour | `POST /auth/step-up` |
| `auth.pairing.redeem` | channel identity | 5 failed per 15 min | `/pair` attempts in chat (06 calls `AuthService`) |
| `claim.redeem` | global per code; and per platform chat | 10 failed attempts, then the code is burned; and ≤ 5 failed attempts per chat per hour, then that chat is ignored for 1 h (06 §3.20.1) | host and group claim codes; counters in 02 `rate_limits` |
| `read` | session | 600/min, burst 120 | GET `/api/v1/**` |
| `write` | session | 120/min, burst 30 | unsafe methods |
| `chat.send` | session | 30/min | web chat POST |
| `validate` | session | 60/min | constitution validate |
| `probe` | instance | 6/min | model and channel tests (they cost money or quota) |
| `export` | person | 3/hour | exports and backup downloads |
| `stream` | session / instance | 4 / 64 concurrent | SSE |
| `control` | instance | 120/min | `/control/v1` |
| `feed` | feed token | 60/hour | `/ics/*` |

### 3.8 Health endpoints

| Endpoint | Semantics | Used by |
|---|---|---|
| `GET /healthz` | Liveness (01 §14 A15; the same contract as 12 §4.3). **200** with `{status:'ok'\|'starting'\|'degraded'}` when the process is alive, isn't draining or failed, and the event-loop delay p99 is under 5 s over the last 30 s (`perf_hooks.monitorEventLoopDelay`). `starting` (+ `phase: migrating\|backing-up\|recovering`) covers boot steps 6–9 (12 §3.8.1) so watchdogs don't kill long migrations; `degraded` covers channel auth failures, stale backups (> 36 h) and recovery mode (`phase:'recovery'`; restarting would not help, so liveness stays 200 while `/readyz` is 503). **503** `{status:'draining'}` during shutdown, or `{status:'fail'}` after an unrecoverable DB error or an event-loop stall. No DB access per request (cached state), no auth, and served before migrations finish. Loopback, the trusted ingress source and `COMVIVO_METRICS_TOKEN` holders also get the details in 12 §4.3. | Docker `HEALTHCHECK` (`/app/healthcheck.mjs` in the image; `comvivo healthcheck` runs the same check for other runners), HA `watchdog: "http://[HOST]:[PORT:8099]/healthz"`, Umbrel/CasaOS, systemd `ExecStartPost` probes |
| `GET /readyz` | **200** when all of these hold:<br>• the DB is open and `SELECT 1` succeeds<br>• migrations are at head<br>• the scheduler heartbeat is under 30 s old<br>• the actor system has started<br>• dashboard assets are present (warning only).<br>Channels are listed in `degraded[]` but never fail readiness. **503** returns a problem with failing check IDs only. | `comvivo init` / `comvivo start` wait loop, reverse-proxy health checks, compose `depends_on: service_healthy` for sidecars |
| `GET /api/v1/instance/health` | Detailed online checks, the same registry as `doctor` | Dashboard Settings → Health |

Both health endpoints are served on the main **and** ingress listeners, at the root **and** under `basePath`.

### 3.9 Auth and sessions

#### 3.9.1 Credential inventory

Formats, entropy and TTLs of the credentials 08 lists are **normative in 08 §3.7.12**; this table restates them for implementation and must match it. Claim and link code shapes follow 06 §3.20.1.

| Credential | Format | Entropy | TTL | Bound to | Stored as | Single-use |
|---|---|---|---|---|---|---|
| Magic-link token (D-12 modes only) | `vml1.<b64u(payload)>.<b64u(HMAC)>`, payload `{jti, sub:personId, aud:instanceId, purpose:'login', exp}` | 128-bit jti + MAC | 10 min (configurable down to 2, never up) | personId, instanceId, purpose `login` | jti row (`consumedAt`) | yes |
| Pairing code | `XXXX-XXXX` (8 Crockford base32) + `pairingId` + pending cookie `…comvivo_pending` (`cvp_…`, 256-bit) | 40 bit code + cookie | 10 min | the browser (cookie) until approved, then the person | SHA-256 of code and of cookie | yes |
| Host claim code | typed `VLG-XXXX-XXXX` (8 Crockford base32) + link token `c_<22 chars>` | 40 bit typed / 128 bit link | 30 min (regenerated at boot or by CLI) | instance | SHA-256 | yes; burned after 10 failed attempts |
| Group claim code | same shapes as the host code (06 §3.20.1) | 40 / 128 bit | 30 min (01 §14 A27; `--ttl` may only shorten it) | instance, optional channel, group and template | SHA-256 | yes; burned after 10 failed attempts |
| Invite code | 8 Crockford base32 | 40 bit | ≤ 72 h | group and role | SHA-256 | yes |
| Link code | `XXXX-XXXX` (06 §3.18.1) | 40 bit | 10 min (08 T-S04) | person | SHA-256 | yes |
| Session ID | `vs1_<43 b64url>` | 256 bit | 12 h idle, 7 d absolute | person | SHA-256 | — |
| CSRF token | `HMAC(tokenMac, "csrf"‖sessionDigest)` b64url (08 §3.7.12) | 256 bit | lifetime of the session | session | derived, not stored | — |
| Step-up challenge | `chl_…` + 6-digit code | code: 20 bit, 5 attempts | 5 min | session | SHA-256 | yes |
| Control token | `vctl_<43 b64url>` in `dataDir/keys/control.token` (0600) | 256 bit | until rotated | instance | file (the server compares with a constant-time check) | — |
| ICS feed token | `vics_<43 b64url>` | 256 bit | until revoked | member and group | SHA-256 | — |
| Export / backup download URL | signed `exp` + HMAC | — | 5 min | session and file | — | yes |

**General rules:**
- Generate all tokens with `crypto.randomBytes`.
- Compare all hashes with `crypto.timingSafeEqual`.
- Never log raw tokens. Pino redaction covers `token`, `code`, `cookie` and `authorization`. ICS paths are logged as `/ics/v1/***.ics`.
- Crockford base32 codes are case-insensitive and ignore `-` and spaces. Normalize `O→0` and `I/L→1`.

#### 3.9.2 Magic-link flow (end to end)

```mermaid
sequenceDiagram
  participant M as Member (chat app)
  participant B as Comvivo bot (06)
  participant A as AuthService (engine/auth)
  participant W as Browser (dashboard)
  participant H as HTTP API
  M->>B: /dashboard (in DM or group) — or host runs `comvivo login`
  B->>A: issueLoginLink(personId, via=channelIdentity)
  A->>A: magic links allowed for this exposure mode? (D-12) else reply with the pairing instructions
  A->>A: rate-limit, eligibility (host, or active member with dashboard.access)
  A->>A: token = vml1 (08 §3.7.12); store jti row, expiresAt=now+10m; revoke older unused login tokens of this person
  A-->>B: url = {publicBase}/auth/magic#{token}
  B->>M: DM with link (link preview disabled). A group trigger gets "I sent you a private message."
  M->>W: opens link
  W->>W: /auth/magic reads location.hash, history.replaceState strips it
  W->>H: POST /api/v1/auth/magic/exchange {token} (Origin/Sec-Fetch-Site checked)
  H->>A: exchange(token, ua, ip)
  A->>A: atomic UPDATE login_tokens SET usedAt=now WHERE hash=? AND usedAt IS NULL AND expiresAt>now AND instanceId=?
  A->>A: create Session (authTime=now), AuditEvent auth.login
  H-->>W: 200 {me} + Set-Cookie comvivo_session (name per D-14); navigate to saved redirect or Home
```

**Details:**
0. **Availability.** Magic links exist only on loopback (mode L, `dashboard.auth.magicLinks: auto`) or, over HTTPS, when the host set `magicLinks: https` (01 §14 A9; 08 §3.8.1). Elsewhere `/dashboard` replies with pairing instructions ("Open the dashboard and choose *Get a sign-in code*") and `/auth/magic/exchange` is not mounted.
1. **Triggers:**
   - **Chat.** `/dashboard`, or the natural-language intent "open the dashboard" (06/05).
   - **CLI.** `comvivo login`, via `POST /control/v1/login-links`:
     - `deliver:'print'` prints the URL in the terminal, with an optional QR code and `--open`.
     - `deliver:'chat'` DMs it instead.
   - **Web.** The `/login` page offers no way to *request* a link, because it can't identify the person. It explains how to get one in chat, and it offers the pairing code (§3.9.3).
2. **Eligibility:**
   - The person is the host, **or** an `active` member of at least one group whose compiled policy grants `dashboard.access` (03 §3.1.2 per 01 §14 A6; default granted except to `child`).
   - If neither holds, the bot replies: "The dashboard isn't turned on for your role in this group. Ask an admin if you need it."
3. **Delivery:**
   - The link is always sent by **DM**. It is never sent in a group.
   - If the channel can't start a DM (`dmInitiation:'after-user-contact'`), the bot replies in the group with a deep link to start the DM: Telegram `t.me/<bot>?start=login`. The DM flow then sends the link.
   - Link previews are disabled.
4. **Base URL selection:**
   - `instance.publicUrl` + `basePath`, if set.
   - Otherwise `http://<dashboard.bind, or the detected LAN address when bound to 0.0.0.0>:<port>`.
   - If the URL is loopback-only, the DM adds: "This link only opens on the computer running Comvivo. To use your phone, set a dashboard address: `comvivo config set instance.publicUrl …`." The doctor check `dashboard.reachability` flags this too.
5. **Exchange errors:**
   - Every failure returns the same `token_invalid` 401. The dashboard copy is: "This sign-in link has expired or was already used. Send /dashboard to Comvivo for a new one."
   - Failures count toward the IP bucket `auth.exchange`.
6. **Optional sign-in notice:**
   - Controlled by `dashboard.auth.notifyOnSignIn`: `off`, `host` (default) or `all`.
   - The DM text: "New dashboard sign-in: {browser} on {os}, {time}. Not you? Send /logout-all."

#### 3.9.3 Pairing-code flow (device flow)

1. On `/login`, the user picks **"Get a sign-in code"** (the primary option). The browser calls `POST /auth/pairing`, which returns `{pairingId, code:'K7QM-4ZTD', deepLinks:{telegram:'https://t.me/<bot>?start=pair_K7QM4ZTD'}, expiresAt}` (10-minute TTL) and sets the HttpOnly pending cookie (`…comvivo_pending`, D-14).
2. The page shows the code in large monospace with a copy button and the text: "Send this to Comvivo in a private chat: **/pair K7QM-4ZTD**". On phones, it also offers the Telegram deep link. It shows a countdown.
3. In the DM, 06 calls `AuthService.lookupPairing(code, identity)`. The bot replies with buttons:

   > Sign in to the Comvivo dashboard on **Chrome · macOS** (requested 20 seconds ago from 192.168.1.x)?
   > Only approve if this code is on **your own screen right now**. Someone asking you to send a code is trying to get into your account.
   > [Approve] [Deny]

4. **Approve** binds the pairing to the person. The browser polls `GET /auth/pairing/{id}` every 2 s. The poll must carry the pending cookie. When the status is approved, the server creates the session, sets the cookie, and marks the pairing consumed.
5. **Limits:**
   - Codes are unique among active pairings.
   - 5 failed `/pair` attempts per identity per 15 minutes.
   - A pairing can be approved once.
   - **Deny** expires the pairing immediately.
6. **Other uses.** The same flow links a **Home Assistant user** to a Comvivo person (§3.9.10). It is the recommended path for "Telegram is on my phone, the dashboard is on my laptop".
7. **Configuration.** `dashboard.auth.pairingCodes: false` disables the flow; it is accepted only where magic links are allowed (D-12), otherwise the config is invalid (exit 78) because nobody could sign in.

#### 3.9.4 Host bootstrap and group claim

**State machine:** `setupState = needs_host_claim → ready`. It is stored in instance settings. The host is `Instance.ownerPersonId`.

1. **Code generation.** At boot, if `ownerPersonId` is null and no host claim code is active, the server generates one. It prints the code to stdout as a dedicated log line. In JSON log format, the line uses `event:"setup.claim_code"`; in pretty mode it is a boxed banner:

   ```
   ┌ Comvivo isn't set up yet ──────────────────────────────────────┐
   │ Claim code: VLG-7K2M-9QXA   (expires 17:42, 30 minutes)         │
   │ Telegram: https://t.me/garcia_comvivo_bot?start=c_<link token>  │
   │ Or open the dashboard and choose "Set up", or run:              │
   │   comvivo init   (shows the code and links again)               │
   └─────────────────────────────────────────────────────────────────┘
   ```

   `comvivo init` fetches the code from `POST /control/v1/claim-codes {kind:'host'}`. That call rotates the code, so only the latest one works. **App-store installs without a terminal** (Umbrel, CasaOS; 12 §3.6) may set `COMVIVO_SETUP_TOKEN` (e.g. Umbrel's `APP_PASSWORD`): while `setupState='needs_host_claim'`, `/setup` also accepts that token in place of the claim code (stored hashed in `run/setup-token`, single use, same attempt limit).
2. **Redemption paths.** Each one consumes the code and runs in one transaction with an `AuditEvent setup.host_claimed`:
   - **DM deep link** `?start=c_<code>`. The sender's identity becomes the host Person. The bot replies: "You're the host of this Comvivo. Next, add me to your group: {startgroup link}". The bot also issues a fresh **group claim code**.
   - **Group deep link** `?startgroup=c_<code>`. Telegram adds the bot to a chosen group and sends `/start@bot c_<code>` from the person who added it. That person becomes the host **and** the group is bound. 06's in-chat setup flow then runs (template choice, consent announcement), and the person becomes the group's first admin under the template.
   - **Other platforms.** Add the bot, then the claim command with the typed code (Discord `/comvivo claim code:VLG-…`, Slack `/comvivo claim VLG-…`, Matrix `!comvivo claim VLG-…`, Signal `comvivo claim VLG-…`; exact syntax owned by 06 §3.20).
   - **Web** `/setup`. The person enters the code, a display name, and a timezone (pre-filled from the browser). This creates the host Person with a `web` identity and a session. The onboarding checklist then asks them to connect a chat app with a **link code**.
   - **CLI.** `comvivo login` while unclaimed claims the instance for a new host Person with a web identity. Access to the data directory is the proof.
3. **Group claim codes** (01 §14 A27). A platform chat binds to a group **only** by redeeming a single-use claim code with a 30-minute TTL. The host creates codes from **Instance → Groups → Add a group** or `comvivo group claim [--channel <id>] [--group <grp_…>] [--template <archetype>]`; a group admin with `members.manage` creates a code that adds a chat to **their own** group with `/comvivo addchat` (06 §3.20.1). 06 binds the chat when someone uses the `?startgroup=c_<link token>` deep link or the claim command. Creating a **new** group remains host-only in v1 (Q-15).
4. **Recovery and transfer.**
   - A host who lost every chat identity uses `comvivo login` (machine access).
   - `comvivo host transfer --to <personId>` (CLI, M15) changes `ownerPersonId` with an audit event.
5. **Claim attempts after `ready`** return `409 already_claimed`. The dashboard shows "This Comvivo already has a host."

#### 3.9.5 Sessions

- **Fields needed** (02 owns the DDL; table `sessions`):

  | Group | Fields |
  |---|---|
  | Identity | `id` (`sess_`), `tokenHash`, `personId`, `instanceId` |
  | Timing | `createdAt`, `authTime`, `lastSeenAt`, `rotatedAt`, `idleExpiresAt`, `absoluteExpiresAt` |
  | Origin | `via` (`magic_link\|pairing\|claim\|cli\|ha_ingress\|invite`), `userAgentSummary` (parsed `"Chrome · macOS"`; never the raw UA), `ipPrefix` (IPv4 /24, IPv6 /48) |
  | Revocation | `revokedAt?`, `revokedReason?`, `epoch` (08 `sessionEpoch`) |
  | CSRF | — (derived from the token-MAC key and the session digest; nothing stored, 08 §3.7.12) |

- **Validation:**
  - Load from an LRU (1,000 entries, 60 s TTL) keyed by `tokenHash`, otherwise from the DB.
  - Reject the session if it is revoked or past `idleExpiresAt` or `absoluteExpiresAt`.
  - Update `lastSeenAt` and `idleExpiresAt` at most once every 5 minutes, as a write-behind batch.
- **Rotation:**
  - Issue a new ID when `now − rotatedAt > 24 h`, on step-up, and when `instanceRole` changes.
  - The old ID stays valid for **60 s** of grace, so concurrent requests don't fail.
  - `Set-Cookie` is sent on the response that triggered the rotation.
- **Login always creates a new session** (prevents session fixation).
- **Revocation triggers:**
  - logout, `/me/sessions` revoke, revoke-others, host revoke, `comvivo sessions revoke`, and `/logout-all` in chat (06);
  - restore from backup (all sessions);
  - person deletion;
  - the last membership ending for a person who isn't the host.
- **Effects of revocation:** the LRU entry is evicted, the person's SSE streams get `session.revoked`, and an audit event is written.
- **Capabilities are not stored in the session.** They are computed per request from the current constitution and membership, so a role change takes effect immediately without revocation.

#### 3.9.6 Cookies, base path and reverse proxies

- **Cookie choice:**

  | Context | Name | Attributes |
  |---|---|---|
  | `publicUrl` is `https://…` or (`trustProxy` and `X-Forwarded-Proto: https`), and `basePath = /` | `__Host-comvivo_session` | `Secure; HttpOnly; SameSite=Strict; Path=/` |
  | Same, but `basePath = /comvivo` | `__Secure-comvivo_session` | `Secure; HttpOnly; SameSite=Strict; Path=/comvivo` |
  | Plain HTTP (localhost, LAN) | `comvivo_session` | `HttpOnly; SameSite=Strict; Path=<basePath>` |

  `Max-Age` is set to the remaining absolute lifetime (≤ 7 days). `Domain` is never set. The pending-login cookie (`…comvivo_pending`) follows the same naming rule.
- **Why SameSite=Strict works for a SPA:**
  - A top-level navigation from Telegram to the dashboard is cross-site, so the HTML request carries no cookie. That is fine: the HTML is static.
  - The SPA then makes same-origin `fetch` calls. These are same-site, so Strict cookies are sent.
- **Reverse proxy:**
  - `dashboard.basePath` is the *external* prefix. The server accepts requests with or without the prefix: `base-path.ts` strips it if present. This works with proxies that strip the prefix and with proxies that don't.
  - `dashboard.trustProxy` is `false`, `true`, or a list of CIDRs. It controls whether `X-Forwarded-For`, `-Proto` and `-Host` are used to determine the client IP (rate limits), the scheme (cookie choice) and the origin (CSRF).
- **Allowed origins** for the CSRF fallback:
  - `new URL(publicUrl).origin` if set;
  - otherwise the request's own origin (scheme from proto, plus `Host`), but only when `bind` is loopback or `trustProxy` is set.
- **Documentation recipes** (owned by 13; this document specifies the contract): nginx, Caddy, Traefik, Tailscale Serve, and Cloudflare Tunnel. Each recipe sets `publicUrl`, `trustProxy` and `basePath`.

#### 3.9.7 CSRF

Every `POST`, `PUT`, `PATCH` and `DELETE` on `/api/v1/**` must pass all of these checks, in order. Failures return `403 csrf_failed` and log `csrf.reason`.
1. **Content type.** It must be `application/json`. Multipart is allowed only on routes flagged `upload`. Otherwise the request fails with 415.
2. **Origin.**
   - If `Sec-Fetch-Site` is present, it must be `same-origin`.
   - Otherwise `Origin` must be in the allowed origins.
   - If neither header is present, reject. Non-browser clients use bearer tokens (control, MCP), never cookies.
3. **Session-bound header.** `X-Comvivo-CSRF` must equal the session's CSRF token. The dashboard gets the token from `GET /me`, and the openapi-fetch middleware adds it to every request.

The pre-session `POST`s (`/auth/magic/exchange`, `/auth/pairing`, `/auth/claim`) run checks 1 and 2. This prevents login CSRF.

`/control/v1` uses the bearer token and **rejects** any request that carries a session cookie. This prevents ambient-authority confusion.

#### 3.9.8 Recent auth (step-up)

- **Rule:** `requireRecentAuth(10 min)` checks `session.authTime ≥ now − 10 min`. Otherwise the request fails with `403 step_up_required`.
- **Routes that require it** (marked `S+R` in §3.5; the same list as 08 §3.8.7):
  - backup download, group and self exports;
  - member role change and removal; constitution ratification;
  - privacy settings, and requesting a `scope:'member'` ICS feed (it includes the member's private events);
  - MCP token creation, identity unlink;
  - channel config changes, plugin enable and permission changes;
  - instance session revocation, sensitive instance settings;
  - "forget all memories about me" (04).
- **Dashboard flow:**
  1. The dashboard shows a dialog: "Confirm it's you. We sent a message to your private chat with Comvivo."
  2. It calls `POST /auth/step-up {action:'Download backup'}`.
  3. The bot DMs: "Confirm on the dashboard: **Download backup**? [Confirm] [Cancel]". On channels without buttons, the DM contains a 6-digit code to type into the dashboard instead.
  4. The dialog polls `GET /auth/step-up/{id}`.
  5. On approval, the session rotates with a new `authTime` and the original request is retried automatically.
- **Fresh logins count.** A session created within the last 10 minutes already satisfies the rule.
- **Host shortcut.** `comvivo login` creates a session with a fresh `authTime`.
- **Web-only people** (no chat identity) can't step up. Their sensitive actions show: "Link a chat app to confirm sensitive actions."

#### 3.9.9 Role-based views

- `GET /me` returns `instanceRole` and `groups[].capabilities`. 03 computes these with `capabilitiesFor(policy, member)` (03 §3.2.10), and they describe what the member *may ever* do, together with conditional grants (`{capability, requires:'confirmation'|'vote'}`).
- The dashboard uses `<Can cap="…">` and route `beforeLoad` guards to **hide or disable** UI. The server still authorizes every request.

| Area | Host (infra) | Admin (typical: `members.manage`, `settings.write`, `constitution.ratify`, `audit.read`, `usage.read`, `traces.read.group`) | Member | Teen | Child (no `dashboard.access` by default) |
|---|---|---|---|---|---|
| Instance area | ✓ | — | — | — | — |
| Home, calendar, tasks, lists, polls, plans, decisions | if member | ✓ | ✓ | ✓ (own edits; approvals per 03) | — |
| Chat (own DM) | if member | ✓ | ✓ | ✓ | — |
| Memory explorer | if member | ✓ (own and group) | ✓ (own and group) | ✓ | — |
| Members | if member | manage | view | view | — |
| Constitution | if member | propose and ratify | view, propose if granted | view | — |
| Activity | if member | ✓, plus the Detailed toggle (`audit.read`) | ✓ | ✓ | — |
| Traces | if member | group and own | own | own | — |
| Costs | per-group totals | ✓ (`usage.read`) | — by default | — | — |
| Group settings | if member | edit | view if `settings.read` | — | — |

- **Disabled vs hidden.**
  - An action the user *could* request through a proposal (a conditional grant) is shown with the label "Propose…".
  - An action that is simply unavailable is **hidden**, not shown disabled. This reduces confusion on phones.
  - Read-only screens show a quiet hint: "Only admins can change this."

#### 3.9.10 Home Assistant ingress auth

- The ingress listener (`dashboard.ingress.port`, default 8099) accepts TCP connections only from `dashboard.ingress.allowFrom` (default `[172.30.32.2]`). Anything else is destroyed at the socket level.
- **Base path** comes from `X-Ingress-Path`, which is trusted only on this listener.
- **Identity** comes from `X-Remote-User-Id`, `X-Remote-User-Name` and `X-Remote-User-Display-Name`. Per HA docs these headers are optional; a request without them is treated as unknown and gets the "open from the Home Assistant sidebar" error page.
- **First visit of an HA user** shows the screen "Link your Home Assistant account". The headers alone grant nothing (01 §14 A9). The options are:
  - **(a)** a pairing code shown on this screen, sent to Comvivo in a private chat and approved there (the default; a "bot code");
  - **(b)** only while the instance is unclaimed: the console host claim code.

  On success, the server stores `ha_links(haUserId → personId)` and creates a **header session** keyed by `ha:<haUserId>`. That session has no cookie. It is a server-side row used for `authTime`, listing and revocation.
- **Later requests** from a **linked** HA user resolve the principal from the header with no second login, as the HA guidelines require. Unlinked HA users always get the linking screen. Revoking the header session unlinks the HA user.
- **CSRF on ingress.** Check 2 is `Sec-Fetch-Site: same-origin`, because the iframe is same-origin with HA. The `X-Comvivo-CSRF` value comes from `/me`, and the token is derived from the header session's secret.
- **Step-up on ingress** uses the same DM approval.
- **Control routes and `/auth/magic/exchange` are not mounted** on the ingress listener. The only auth routes mounted there are pairing create and poll, and `/auth/claim`. Both are used for HA linking only.

#### 3.9.11 Web-only members (web-channel groups)

- **Joining.**
  - Web-channel groups are used for demos, tests and groups that have no chat app.
  - An admin creates an invite (`POST /groups/{g}/invites`) that yields `joinUrl = {base}/join#i=<code>`.
  - The invitee chooses a display name. That creates the Person, the `web` identity, the Member (consent flow per 03) and a session.
- **Re-login problem.** Web-only people have no chat channel to receive magic links. The dashboard therefore shows a persistent banner: "Link a chat app so you can sign in again later." Linking uses a link code.
- **No admin-issued logins.** Admins can't issue login links for an existing person, because that would let them read the person's DM. Passkeys are open question Q-6.

### 3.10 Dashboard (`apps/dashboard`)

#### 3.10.1 Structure and routing

```
apps/dashboard/
├─ index.html                 # template: <base href>, nonce, #comvivo-boot placeholders; inline theme script (nonce)
├─ vite.config.ts             # base:'./', plugins: tanstackRouter({target:'react',autoCodeSplitting:true}), react(), tailwindcss()
├─ components.json            # shadcn (style per §3.10.5, base: radix, iconLibrary: lucide)
├─ src/
│  ├─ main.tsx  boot.ts  router.tsx  i18n.ts  theme.ts
│  ├─ api/      client.ts (openapi-fetch + middleware)  query.ts ($api, QueryClient)  stream.ts  invalidation.ts  problems.ts
│  ├─ routes/   (TanStack file routes; see table)
│  ├─ components/ui/          # shadcn-generated (do not hand-edit beyond tokens)
│  ├─ components/             # AppShell, Sidebar, BottomNav, GroupSwitcher, CommandMenu, PageHeader, VisibilityChip,
│  │                          # EmptyState, ErrorState, Skeletons, ResponsiveDialog, Can, RichText, DateTime, Money,
│  │                          # RelativeTime, CopyField, QrCode, StepUpDialog, ConfirmDialog, DataTable, InfiniteList
│  ├─ features/<area>/        # screen-specific components, hooks, i18n keys
│  ├─ lib/                    # temporal.ts, format.ts, capabilities.ts, rrule-presets.ts, yaml-doc.ts
│  ├─ locales/en/*.json       # source strings (namespaces = areas)
│  └─ styles/app.css tokens.css
├─ e2e/                       # Playwright specs + axe
└─ .size-limit.json
```

| Path (relative to basePath) | File route | Screen |
|---|---|---|
| `/login` | `login.tsx` | Sign in (instructions plus pairing code) |
| `/auth/magic` | `auth.magic.tsx` | Magic-link exchange |
| `/setup` | `setup.tsx` | Host claim on the web |
| `/join` | `join.tsx` | Web-group invite |
| `/link-ha` | `link-ha.tsx` | Home Assistant user linking (ingress) |
| `/` | `_app/index.tsx` | Redirect: last group, or `/instance` for a host with no groups |
| `/g/$groupId` | `_app/g.$groupId.tsx` (layout) + `index.tsx` | Group shell + Home |
| `/g/$groupId/chat/$conversationId?` | `chat.tsx` | Chat |
| `/g/$groupId/calendar?view&date` | `calendar.tsx` | Calendar |
| `/g/$groupId/tasks?tab` | `tasks.tsx` | Tasks & chores (tabs: mine, all, chores, fairness) |
| `/g/$groupId/lists[/$listId]` | `lists.*` | Lists |
| `/g/$groupId/polls`, `/decisions` | `polls.tsx`, `decisions.tsx` | Polls & decisions (two tabs, one nav item) |
| `/g/$groupId/plans[/$planId]` | `plans.*` | Plans |
| `/g/$groupId/memory?q&kind&…` | `memory.tsx` (+ `$memoryId` drawer search param) | Memory explorer |
| `/g/$groupId/members[/$memberId]` | `members.*` | Members & roles |
| `/g/$groupId/constitution/{charter,edit,history,proposals}` | `constitution.*` | Constitution |
| `/g/$groupId/activity` | `activity.tsx` | Activity / audit |
| `/g/$groupId/traces[/$turnId]` | `traces.*` | Turn traces |
| `/g/$groupId/costs` | `costs.tsx` | Costs & budgets |
| `/g/$groupId/settings/{general,proactivity,privacy,budget}` | `settings.*` | Group settings |
| `/me/{profile,privacy,sessions,connections,tokens,export}` | `_app/me.*` | My account |
| `/instance/{index,models,channels,groups,backups,plugins,security,about}` | `_app/instance.*` | Host area (`beforeLoad` requires `instanceRole==='host'`) |

**Search params** are validated per route with a zod `validateSearch`. Filters live in the URL so links are shareable and Back works.

**Auth guard:**
- `_app` `beforeLoad` runs `queryClient.ensureQueryData(meQuery)`. On `401` it throws `redirect({to:'/login', search:{redirect: location.href}})`.
- `g.$groupId` `beforeLoad` checks that the group is in `me.groups`, else it redirects to `/` with a toast.
- Router `context` = `{ queryClient, me }` via `createRootRouteWithContext`.

#### 3.10.2 Data layer

- **Client** (`@comvivo/api-client`):

  ```ts
  createClient<paths>({ baseUrl: boot.apiBase, credentials: 'same-origin' })
  ```

  The middleware chain:
  1. **onRequest:**
     - adds `X-Comvivo-CSRF` (from the `me` cache);
     - adds `Idempotency-Key` (`crypto.randomUUID()`) on POST;
     - adds `If-Match` when the caller passes `etag`;
     - sets `Accept-Language`.
  2. **onResponse:**
     - parses `application/problem+json` into a typed `ApiProblem`;
     - on `401`, clears caches and routes to `/login`;
     - on `403 step_up_required`, opens `StepUpDialog` and **replays** the request after approval;
     - on `429` / `503`, retries with backoff using `Retry-After` (max 2 attempts, GET only).
- **Query defaults:**
  - `staleTime: 30_000`, `gcTime: 300_000`, `retry: (n, e) => n < 2 && isTransient(e)`, `refetchOnWindowFocus: true`;
  - Router `defaultPreload: 'intent'`, `defaultPreloadStaleTime: 0` (Query owns freshness).
  - Loaders call `queryClient.ensureQueryData($api.queryOptions('get', path, init))`.
- **Mutations:**
  - `$api.useMutation`. On `onSuccess`, the code switches on `outcome`:
    - `done` → invalidate the affected resources and show a toast;
    - `needs_confirmation` → open the confirm dialog or show "Sent to {name} for approval";
    - `contested` → navigate to the proposal;
    - `queued` → wait for `command.completed`.
  - Optimistic updates **only** for lists (check/uncheck/add) and task completion. On error they roll back and show a toast.
- **Stream client** (`stream.ts`):
  - a single `EventSource(boot.apiBase + '/stream')`;
  - `invalidate` → `queryClient.invalidateQueries({ predicate })` using `INVALIDATION_MAP: Record<ResourceKind, PathTemplate[]>`, where predicates match the openapi-react-query key `['get', path, {params:{path:{groupId}}}]`;
  - `chat.message` → `setQueryData` on the conversation's infinite query;
  - `resync` → `invalidateQueries()`;
  - `session.revoked` → logout;
  - `command.completed` → resolves pending command promises.
- **Visibility.** When the tab is hidden for more than 5 minutes, the stream is closed. On `visibilitychange`, the client reopens it with `Last-Event-ID`.
- **Multiple tabs** (M15): one tab holds the stream, elected with `navigator.locks.request('comvivo-stream')`, and rebroadcasts via `BroadcastChannel`. This avoids the HTTP/1.1 limit of 6 connections per origin on LAN installs.

#### 3.10.3 Information architecture and navigation

**Groups** (in the sidebar):
- **Overview:** Home, Chat.
- **Organize:** Calendar, Tasks, Lists, Polls & decisions, Plans.
- **Knowledge:** Memory, Activity, Traces.
- **Group:** Members, Constitution, Costs, Settings.
- **Host** (hosts only): Overview, Models, Channels, Groups, Backups, Plugins, Security, About.

**Desktop and tablet (≥ 1024 px):**
- shadcn `Sidebar`, 256 px wide, collapsible to icons (state kept in a cookie-less `localStorage` key). It contains:
  - a GroupSwitcher at the top (it lists groups, plus "Host area" for hosts);
  - the nav groups;
  - the account menu at the bottom (profile, language, theme, density, sign out).
- A top bar with breadcrumbs, a `⌘K` command menu (cmdk: jump to screens, members, lists, "New event", "New task") and an Approvals bell with a count.

**Mobile (< 768 px):**
- a top app bar with the group name and switcher, plus the bell;
- a **bottom navigation** with 5 items: Home, Chat, Calendar, Tasks, More. **More** opens a sheet (vaul drawer) with the remaining items in the same groups.
- Floating "+" quick-add on Home, Calendar, Tasks and Lists.
- Dialogs become bottom sheets (`ResponsiveDialog`). Tables become card lists.

**Tablet (768–1023 px):** the sidebar is collapsed to icons by default.

#### 3.10.4 Shared patterns (apply to every screen)

| Pattern | Spec |
|---|---|
| **Loading** | Skeletons that match the final layout. Shown only after a 150 ms delay, so fast loads don't flash. No full-page spinners after the first paint. |
| **Empty** | `EmptyState`: icon, a one-line explanation, one primary action if the viewer has the capability, and a "Learn more" docs link. Copy explains *how data gets here* (usually "from your group chat"). |
| **Error** | A section-level `ErrorState` with the problem title, a "Try again" button and the `requestId` (copyable, small). One failed card never blanks the page. A 404 for an item the viewer can't read shows: "This item doesn't exist or isn't shared with you." |
| **Offline / stream lost** | A slim top banner: "Reconnecting…" (after 5 s), then "You're offline. Changes will fail until you reconnect." No offline writes. |
| **Visibility** | `VisibilityChip` on every labeled object: <br>• lucide `Users` "Everyone in {group}" <br>• `Lock` "Only you" <br>• `UserRound` "You and {name}" / "You, {a} and {n} others" <br>• `ShieldAlert` "Sensitive" add-on <br>Color is never the only signal. Hovering or focusing shows the reader list. |
| **Who did this** | Every mutable object shows "Added by {name} · {relative time}". Automatic objects say "Added by Comvivo from chat · {time}" and link to the source if it is readable. |
| **Time** | Group-facing objects (events, tasks) are shown in the **group timezone**. When it differs from the member's timezone, they add a secondary "{time} your time". Relative times ("in 2 days") have the absolute time in a tooltip and an `aria-label`. |
| **Destructive actions** | A confirm dialog naming the object and its consequence ("Forget this memory? Comvivo will stop using it. This can't be undone."). Irreversible bulk actions use type-to-confirm. |
| **Toasts** | `sonner` with `aria-live=polite`. Each has an Undo action where the API supports it (list items, task completion within 10 s). |

#### 3.10.5 Design system

- **Base:** `shadcn init -t vite -b radix` with the CSS-variables theme. Components are copied in and themed through tokens only.
- **Tokens** (`styles/tokens.css`, OKLCH, light and dark):

  ```css
  @import "tailwindcss";
  @custom-variant dark (&:where(.dark, .dark *));
  :root {
    --radius: 0.625rem;
    --background: oklch(0.99 0.004 95);  --foreground: oklch(0.21 0.02 160);
    --primary: oklch(0.52 0.11 160);     --primary-foreground: oklch(0.99 0 0);   /* "comvivo green" */
    --muted: oklch(0.96 0.006 95);       --muted-foreground: oklch(0.48 0.02 160);
    --accent: oklch(0.94 0.03 160);      --destructive: oklch(0.58 0.2 27);
    --border: oklch(0.91 0.008 95);      --ring: oklch(0.6 0.11 160);
    --vis-group: oklch(0.55 0.12 250);   --vis-private: oklch(0.52 0.14 300);
    --vis-shared: oklch(0.62 0.13 75);   --vis-sensitive: oklch(0.58 0.2 27);
    --ok: oklch(0.6 0.13 150); --warn: oklch(0.75 0.15 80); --err: var(--destructive);
    /* --chart-1 … --chart-5: green, blue, amber, violet, slate — validated for CVD and ≥ 3:1 vs background */
  }
  .dark { /* mirrored values; background oklch(0.17 0.01 160) etc. */ }
  [data-density="compact"] { --row-h: 2rem; --pad: 0.5rem; }   /* default comfortable: 2.75rem / 0.75rem */
  ```

  All text and background token pairs are checked in CI by a script that computes WCAG contrast from the OKLCH values. Body text needs ≥ 4.5:1; UI parts and focus rings need ≥ 3:1.
- **Theme:**
  - Options are System, Light and Dark. The choice is stored in `localStorage.theme`.
  - An inline script carrying the CSP nonce sets `.dark` before first paint.
  - In HA embedded mode the default is System.
- **Density:** Comfortable (default; touch targets ≥ 44 px on coarse pointers) or Compact (desktop tables). Set with the `data-density` attribute.
- **Typography:**
  - The system UI font stack. No webfont download: it is faster and works offline on LAN.
  - `font-variant-numeric: tabular-nums` for costs and times.
  - Type scale: 12 / 14 (body) / 16 / 20 / 24 / 30.
- **Icons:**
  - lucide-react named imports only (tree-shaken), at 16 px inline and 20 px in navigation.
  - Icon-only buttons need `aria-label` and a tooltip.
  - No emoji in UI chrome.
- **Charts:**
  - shadcn `ChartContainer` + Recharts 3, with `accessibilityLayer`.
  - Every chart has a visible title, a caption that summarizes the takeaway, and a "View as table" toggle.
  - Colors come from `--chart-n`. No pie charts.
- **Motion:** 150–200 ms ease-out for overlays. `prefers-reduced-motion` disables non-essential motion.
- **Layout:** a 4 px spacing grid; content max width 1200 px; cards with 1 px borders and no heavy shadows.

#### 3.10.6 Screens

Format for each screen: **Purpose**, **Data**, **Actions**, **States**, **Permissions**, **Wireframe**. Data refers to endpoints in §3.5.

##### 3.10.6.1 Sign-in and setup (`/login`, `/auth/magic`, `/setup`, `/join`, `/link-ha`)

- **Purpose:** get a person into the dashboard without passwords.
- **`/login`:**
  - The heading is "Sign in to {instanceName}".
  - **Card A (primary), "Get a sign-in code":** a button that starts the pairing flow (§3.9.3). It shows the code, a copy button, a Telegram deep link and a countdown, and polls every 2 s.
  - **Card B, "Use a link from your chat app"** (shown only when `boot.features.magicLink` is true, D-12): "Send **/dashboard** to Comvivo in a private chat. You'll get a sign-in link that works once."
  - **Footer:** "Running Comvivo yourself? Run `comvivo login` on the server."
  - **Errors:** an expired code shows "That code expired. Get a new one."
  - **States:** if `setupState='needs_host_claim'`, the page redirects to `/setup`.
- **`/auth/magic`:**
  - Shows a spinner card with "Signing you in…".
  - On error: the `token_invalid` copy with a "Back to sign in" button.
  - No token in the hash: redirects to `/login`.
- **`/setup`:**
  - The heading is "Set up your Comvivo".
  - Fields: claim code (an 8-character code input that auto-formats and accepts an optional `VLG-` prefix; or the app-store setup token), "Your name" and timezone (prefilled).
  - Help text: "The claim code is shown when Comvivo starts and by `comvivo init`. Lost it? Run `comvivo init` on the server, or restart Comvivo to get a new one."
  - **Appliance step (A29; only when `COMVIVO_PLATFORM` is `home-assistant`, `umbrel` or `casaos` and the request carries the setup token):** "Connect your AI provider and chat app" with write-only password fields for the provider key and bot token(s) that the chosen preset and channels need (names from 08 §3.10). Each value is tested (provider probe, channel probe) before it is saved to `keys/secrets.enc`; a value already set in env is shown as "set by the platform" and cannot be overridden here.
  - On success it goes to `/instance` with the onboarding checklist.
- **`/join`:** "You're invited to {group}". Fields: name and timezone. Shows a consent explainer from 03's template. On submit, the member lands in group Home.
- **`/link-ha`:** "Link your Home Assistant account to Comvivo" with the two options of §3.9.10 (pairing code approved in a DM; the host claim code only while unclaimed).
- **Permissions:** public routes. All are rate-limited.

##### 3.10.6.2 Home / group overview (`/g/$groupId`)

- **Purpose:** "What needs me, and what's coming up?" in five seconds.
- **Data:** `GET /groups/{g}/home` (one request) + the SSE invalidations `events`, `tasks`, `approvals`, `polls`, `proposals` and `decisions`.
- **Sections:**
  1. **Needs you:** approvals, polls I haven't voted in, open proposals, and proposed memories about me (count).
  2. **Coming up:** events for the next 7 days as an agenda.
  3. **My tasks:** overdue, then today, then this week.
  4. **Recent decisions:** 5 items.
  5. **What Comvivo did lately:** 5 recent effects visible to me, each with a "Why?" link to its trace when permitted.
  6. **Status strip:** channel state dots, plus the budget level if `usage.read`.
- **Actions:** quick add (event, task, list item) via "+"; vote inline; approve or reject inline (with confirm); open chat.
- **Empty (new group):** "Comvivo is settling in. As your group chats, plans, tasks and decisions will appear here." For admins it adds a mini checklist: "Review your constitution", "Check everyone has seen the privacy notice" (with a consent count), "Try asking Comvivo something in the group".
- **Loading:** 4 card skeletons.
- **Errors:** per card.
- **Permissions:** `mbr`. Each card is hidden when the viewer lacks the read capability (for example `calendar.read`).
- **Wireframe:**

  ```
  Desktop (≥1024)                                         Mobile (<768)
  ┌ Sidebar ┬───────────────────────────────────────────┐ ┌ Garcia Family ▾        🔔2 ┐
  │ ▾Garcia │ Good evening, Ana        [+ Add]  🔔 2    │ │ Needs you (2)              │
  │ Home    │ ┌ Needs you (2) ─────────┐┌ Coming up ───┐│ │  ○ Approve: Leo → Sat ride │
  │ Chat    │ │ Approve: Leo's ride    ││ Fri 6pm Rec. ││ │  ○ Vote: Pizza or tacos?   │
  │ Calendar│ │ Vote: Pizza or tacos?  ││ Sat 9am Swim ││ │ Coming up                  │
  │ Tasks   │ └────────────────────────┘└──────────────┘│ │  Fri 18:00 Recital  👥     │
  │ …       │ ┌ My tasks ──────────────┐┌ Decisions ───┐│ │ My tasks                   │
  │         │ │ ☐ Bins (today)         ││ Camp: Lake A ││ │  ☐ Bins · today            │
  │         │ └────────────────────────┘└──────────────┘│ │ ───────────────────────────│
  │         │ What Comvivo did lately · Why? links       │ │ Home Chat Cal Tasks More   │
  └─────────┴───────────────────────────────────────────┘ └────────────────────────────┘
  ```

##### 3.10.6.3 Chat (web channel) (`/g/$groupId/chat/$conversationId?`)

- **Purpose:** talk to Comvivo privately in the browser. In web-channel groups, this is also the group room.
- **Data:**
  - Conversations: my web DM, plus web group rooms.
  - Messages: an infinite query, newest at the bottom.
  - SSE: `chat.message`, `chat.typing` and `turn.status`.
- **Header:** the conversation name plus an **audience banner**:
  - "Private · only you and Comvivo", or
  - "Group room · visible to all 5 members".

  Clicking the banner lists the readers.
- **Messages:**
  - Comvivo messages render the `RichText` AST: no raw HTML, and links get `rel="noopener noreferrer nofollow"`.
  - Each Comvivo message has a "Why?" action (when permitted), Copy, and a timestamp.
  - Interactive buttons (confirmations, polls) render natively.
  - `untrusted` content (forwards, documents) gets a subtle "Forwarded" frame.
- **Composer:**
  - A multiline textarea: Enter sends, Shift+Enter adds a new line, and the limit is 4,000 characters with a counter near the limit.
  - Sends `clientMessageId` and shows the message optimistically in a "sending" state. A failure shows "Didn't send · Retry".
- **While a turn runs:** "Comvivo is thinking…" (from `turn.status`). The reply is **never** streamed (D-30).
- **Empty:** "This is your private chat with Comvivo. Ask about plans, add reminders, or say 'what do you know about me?'", plus 3 suggestion chips.
- **Errors:** budget exhausted shows Comvivo's own budget message as a normal message.
- **A11y:** the message list is `role="log"` with `aria-live="polite"`; keyboard focus returns to the composer after sending.
- **Permissions:** `chat.ask` to send. The DM is visible only to its member.

##### 3.10.6.4 Members and roles (`/g/$groupId/members[/$memberId]`)

- **Purpose:** who is here, what they can do, and whether they've been told about Comvivo.
- **Data:** `GET members`, `GET members/{m}` (with capabilities), `PATCH`, `remove`, `consent-notice`, `invites`.
- **List:**
  - Each row shows avatar initials, name, role badge, platforms (icons with labels), status, and the consent chip ("Not yet informed", "Informed", "Memory on", "Memory off"). The consent chip is visible to self, or to everyone when the viewer has `members.manage`.
  - Filters: role, status.
  - A legend popover explains the consent states using 03's wording.
- **Member detail (sheet):**
  - Role selector (`members.manage`); the change may produce "This needs a vote →" (contested).
  - "What {name} can do": a capability list in plain language, generated from i18n keys `capabilities.<cap>`.
  - Linked platforms (types only), joined date.
  - Guardian links (family template).
  - Actions:
    - "Resend privacy notice";
    - "Remove from group", with this confirm text: "Comvivo will stop serving {name} here. Their private memories in this group are deleted after {retention} days per your constitution." The exact semantics are 03/04's.
- **Invite (`members.manage`):**
  - For chat groups: "People join by being in your {platform} group. They'll get a privacy notice the first time they talk."
  - For web groups: "Create invite link" (one-time, with an expiry choice) plus a QR code.
- **My consent:** on my own row, a switch for "Comvivo may remember things I say" that calls the consent PATCH, with an explainer.
- **Empty:** "Only you so far. People appear here after they say something in the group."
- **Permissions:** view `mbr`; manage `members.manage`.

##### 3.10.6.5 Constitution (`/g/$groupId/constitution/{charter,edit,history,proposals}`)

- **Purpose:** read, change and govern the group's rules.
- **Data:**
  - `GET constitution`, `versions`, `diff`, `schema`;
  - `POST validate`, `proposals`, `votes`, `ratify`.
- **Tabs:**
  1. **Charter (default):**
     - The plain-language charter (`RichText`) and a "Who can do what" matrix: roles × capability groups, with ✓, "with approval" and "by vote".
     - A version badge and "Adopted {date} via {template\|amendment #n}".
  2. **Edit** (`constitution.propose`). A segmented control switches **Form** and **YAML**, which edit **one draft document**:
     - **Form:**
       - One section per top-level schema area (03): Roles, Permissions, Decisions & conflicts, Privacy defaults, Speaking up (proactivity), Tone.
       - Fields are rendered from the schema with help text.
       - Edits apply to a `yaml` `Document` (`lib/yaml-doc.ts`) through `doc.setIn()`, which **preserves comments and ordering**.
     - **YAML:**
       - CodeMirror 6 (lazy chunk) with `lang-yaml`, line numbers, bracket matching, search and the `EditorView.cspNonce` facet.
       - **Lint layer 1 (instant):** `yaml.parseDocument` errors.
       - **Lint layer 2 (debounced 400 ms):** `POST validate`, with issues mapped to ranges.
       - M15 adds completion and hovers from `GET schema`.
     - **Right pane (desktop) or bottom tab (mobile), "Preview":**
       - the rendered charter for the draft;
       - **"What changes"**, a semantic diff list (for example, "Teens can now add calendar events");
       - the validation status.
     - **Footer:**
       - "Propose change": a dialog with title and rationale that creates a proposal.
       - "Adopt now", shown only when 03 allows direct ratification for this viewer. It uses a confirm dialog.
       - Discard draft.
     - Drafts autosave to `localStorage` per group and base version. The constitution is group-visible, so there is no privacy concern.
     - If the base version changes, a banner says "The constitution changed since you started. Review differences" and opens a three-way view (`@codemirror/merge`).
  3. **History:**
     - The versions list.
     - Selecting two versions shows `@codemirror/merge` in **unified** mode on mobile and **side-by-side** on desktop, plus the semantic list.
  4. **Proposals:**
     - Open and closed cards: title, proposer, status, deadline, tally bar (respecting anonymity), quorum indicator, my vote, and Yes/No/Abstain buttons when eligible.
     - The detail view shows the diff and the rationale.
- **States:**
  - **Invalid YAML:** "Propose" is disabled with "Fix 2 problems first". The problems list is clickable and scrolls to the line.
  - **No proposals:** "No open proposals. Anyone with permission can suggest a change from the Edit tab."
- **Permissions:** view `mbr`; edit and propose `constitution.propose`; ratify `constitution.ratify`.
- **Wireframe (desktop Edit):** `[Form | YAML]` toolbar → left 60 % editor, right 40 % Preview (charter / What changes / ✓ Valid) → sticky footer `[Discard] [Propose change]`.

##### 3.10.6.6 Memory explorer (`/g/$groupId/memory`)

- **Purpose:** see, search and correct what Comvivo remembers. Members feel in control here, and here Comvivo earns trust.
- **Data:** `GET memories` (search and filters), `GET memories/{id}`, `about-me`, and the mutations from §3.5.
- **Layout:**
  - A search field (debounced 250 ms; `q` in the URL).
  - **Filter chips:**
    - Kind: Facts, Preferences, Decisions, Commitments, Notes, Profile.
    - About: member multi-select, plus "Me".
    - Visible to: Everyone, Only me, Specific people.
    - Status: Active (default), Needs review (proposed), Replaced, Forgotten.
    - Sensitive; Pinned; Date range.
  - A toggle: **All | About me**.
- **Result card:**
  - Content text, kind badge, `VisibilityChip`.
  - "From chat · Tue 14 Oct", which opens the source if it is readable and still retained; otherwise it reads "source deleted after {n} days".
  - "Valid since {date}"; confidence (proposed only, shown as "Comvivo isn't sure"); pin icon.
- **Detail drawer:**
  - Full content and **provenance**: source message excerpts, extractor, confidence, and the "replaces" / "replaced by" chain.
  - Label details in plain words.
  - Actions:
    - **Correct** (inline edit creates a new version, "Saved. Comvivo will use the corrected version.");
    - **Pin**;
    - **Forget** (confirm);
    - **Change who can see this** (owner only). Narrowing takes effect immediately. Widening shows: "Make visible to {audience}? They'll be able to see this exact text."
    - For proposed items: **Keep** or **Discard**.
- **Info line** under the filters: "You only see memories shared with you. Other members' private memories never appear here, including for admins."
- **Empty:** "Comvivo hasn't remembered anything yet. It learns from your group's conversations." If the viewer's consent is memory off: "You've turned memory off, so Comvivo doesn't remember what you say."
- **Virtualized list** (`@tanstack/react-virtual`) with infinite loading (§3.3 partial pages).
- **Permissions:** `memory.read`. Mutations need the capabilities in §3.5.

##### 3.10.6.7 Calendar (`/g/$groupId/calendar?view=agenda|month|week&date=YYYY-MM-DD`)

- **Purpose:** the group's schedule, correct across timezones.
- **Data:** `GET events?from&to` (the visible range ±1 week, prefetched when navigating), event CRUD, and `calendar/feeds`.
- **Views** (built in-house; D-22):
  - **Agenda** (mobile default): days grouped, sticky date headers, 30 days with infinite scroll.
  - **Month** (desktop default): a 7-column CSS grid; each day shows up to 3 events and a "+n more" popover. Keyboard navigation follows the ARIA grid pattern (arrows move by day, Enter opens the day).
  - **Week:** a time grid at 30-minute rows. Overlap layout uses a greedy column packer. An all-day lane sits at the top. A "now" line shows in the group timezone.
- **Event chip:** time, title, `VisibilityChip` dot plus an sr-only label, and a recurring icon.
- **Event sheet:** title, when (with timezone), location, attendees, recurrence in plain words ("Every Tuesday until Dec 19"), reminders, source ("Added by Comvivo from chat"), and Edit/Delete.
- **Editing a recurring event** asks: "Change only this event, this and following, or all events?"
- **Create/edit form:**
  - Title; all-day toggle; start and end (date and time pickers using react-day-picker through shadcn `Calendar`, converted to a Temporal `PlainDateTime` in the **group timezone**, with a timezone selector under "More").
  - Recurrence presets: never, daily, weekly on {day}, monthly on {nth weekday}, yearly, custom. Custom is an RRULE builder for FREQ, INTERVAL, BYDAY, UNTIL/COUNT.
  - Location; attendees (member multi-select); "Who can see this" (group, only me, specific); reminders (none, at time, 15 min, 1 h, 1 day, custom).
- **Subscribe dialog** ("Subscribe in your calendar app"):
  - The personal feed URL with copy and QR, "Include my private events" (off by default), and Rotate/Revoke.
  - A warning when `publicUrl` is unset: "Calendar apps like Google Calendar fetch this link from the internet. Set a public address first, or use it in an app on your home network." Also: "Your calendar provider will be able to read these events."
- **Empty:** "No events yet. Mention a date in your group chat ('Recital Friday 6pm') or add one here."
- **Permissions:** read `calendar.read`; write `calendar.write`.

##### 3.10.6.8 Tasks and chores (`/g/$groupId/tasks?tab=mine|all|chores|fairness`)

- **Purpose:** who's doing what, kept fair.
- **Data:** `tasks`, `rotations`, `fairness`, and the mutations.
- **Mine / All:**
  - Grouped by Overdue, Today, This week, Later, No date.
  - Each row has a checkbox (optimistic), title, assignee avatar, due date, effort points (dots), rotation badge and `VisibilityChip`.
  - Filters: assignee, status.
  - Row actions: Reassign (`tasks.assign`; may need approval), Edit, Snooze due date, Delete.
- **Chores (rotations):**
  - One card per rotation: name, schedule ("Weekly, Mondays"), participants in order with "Up next: Leo", strategy ("Round robin", "Least loaded", per 07), and last completions.
  - Edit (`tasks.manage_rotations`): participants are reordered with **Move up/down buttons**, not drag-only (WCAG 2.5.7). Edit also covers strategy and effort.
- **Fairness:**
  - Follows `fairness.ledgerVisibility` (03). Every template defaults to `self_only`: the tab shows only the viewer's own points and share ("Your share: 22% over 30 days; your fair share is 25%") and the note "Only you can see your numbers. The group can choose to share them (constitution → Fairness)." With `off`: "The fairness view is off for this group." Group-visible views are an explicit opt-in by a privacy-reducing amendment (03 §3.3.8).
  - Only when the group opted into `everyone` (or `admins`, for admin viewers): a bar chart of effort points per member over 30 or 90 days, with the target-share line.
  - A caption: "Ana did 38% of the work; the fair share is 25%."
  - "How Comvivo assigns chores", a short `RichText` from 07/03.
  - A table toggle.
- **Empty:** "No tasks yet. Say 'Comvivo, remind Leo to take out the bins every Monday' in your group, or add one here."
- **Permissions:** per §3.5.

##### 3.10.6.9 Lists (`/g/$groupId/lists[/$listId]`)

- **Index:** cards showing name, unchecked count and last updated. "New list" (`lists.write`).
- **Detail:**
  - A sticky "Add item" input at the top (Enter adds and keeps focus), unchecked items, then a collapsible "Checked (n)" section.
  - Rows: a large checkbox (44 px target), the text (inline edit) and an overflow menu (delete).
  - "Clear checked" (with Undo toast). Live updates over SSE, so two people can shop at once.
- **Empty:** "Nothing on this list. Add items here or say 'add milk to groceries' in chat."

##### 3.10.6.10 Polls and decisions (`/g/$groupId/polls`, `/decisions`)

- **Polls:**
  - Open and Closed tabs.
  - A card shows the question, options with result bars (shown after I vote, or per poll setting), my vote, deadline countdown, quorum ("3 of 5 voted · needs 3"), and the decision rule.
  - Vote buttons, single or multi.
  - "New poll" (`polls.create`): question, 2–10 options, multi-select, deadline, anonymous. The submit copy is "Post poll to {group chat}".
  - Closed polls link to the resulting decision.
- **Decisions:**
  - A searchable timeline: summary, date, "Decided by {rule}: {members}", rationale, alternatives considered, and source (poll or chat excerpt if readable).
  - "Record a decision" (`decisions.record`). Superseding shows "Replaced by …".
- **Empty states:**
  - "No polls yet. Ask Comvivo to 'make a poll' in your group."
  - "No decisions recorded yet. Comvivo records decisions when your group agrees on something."

##### 3.10.6.11 Plans (`/g/$groupId/plans[/$planId]`)

- **Index:** plan cards with title, status (Planning, Active, Done), progress bar, next step and owners.
- **Detail:**
  - Steps checklist: owner, due date, status, linked event or task chips.
  - Notes (`RichText`).
  - "Add step" (`plans.write`) and reorder with buttons.
  - Edits use `If-Match`. On 412: "Someone else changed this plan. Review their changes", with a merge prompt.
- **Empty:** "Plans help with multi-step things like trips. Say 'Comvivo, let's plan the lake trip' in your group."

##### 3.10.6.12 Turn traces: "Why did Comvivo say this?" (`/g/$groupId/traces[/$turnId]`)

- **Purpose:** an explainable, IFC-filtered timeline of one turn. The data is from `TurnTrace` (05). The filtering is from §3.3.
- **List:**
  - A table or cards: time, conversation, trigger excerpt (if readable), disposition (Replied / Observed / Ignored / Spoke up), status, cost and latency.
  - Filters: conversation, disposition, date.
  - Entry points: the "Why?" action on chat messages, Home "What Comvivo did", and the `/why` link that the bot posts in chat.
- **Detail (`TraceView`)** is a vertical timeline with a plain-language **summary** at the top. Example: "Comvivo replied because you mentioned it. It used 4 memories shared with the group, checked the calendar, and passed the privacy check. Cost $0.004 · 2.8 s."

  | Step | Shows | IFC rule |
  |---|---|---|
  | Trigger | message excerpt(s), requester, **audience** ("Replying in Garcia Family · visible to 5 members") | excerpt only if the message is readable |
  | Decision to respond | rule (mention, DM, reply, interjection score vs threshold, quiet hours) | — |
  | Context used | grouped by kind with counts and `VisibilityChip`s. Readable items link to memories and events. Unreadable entries collapse into **"{n} items not visible to you"**, with no kind, owner or sensitivity shown. The count is shown unless 03 sets `traces.hideHiddenCount`. | per-item `canRead` |
  | Private constraints | typed constraints used ("Someone is unavailable Saturday morning"), constraint type and visible text. The source is shown only to its **owner** ("From your private note · Edit"). | 03 declassification rules |
  | Model calls | route, provider/model, effort, input/cached/output tokens, cost, latency, `stop_reason`. **Never prompt or response text.** | none needed (no content) |
  | Tool calls | tool name (localized), input summary (if readable), policy decision (Allowed, Denied: reason, Needed approval from {role}), result status, effects with links | per-item |
  | Privacy check (guard) | Passed / Redacted {n} parts / Blocked, plus a reason **category** ("possible private detail"). Never the redacted text. | category only |
  | Result | sent message(s) with links, total cost, total latency, recovery note if `recovered` | — |

- **States:** a turn still running auto-refreshes from `turn.status`. Failed turns show the error category ("The AI provider didn't respond") and the retry outcome.
- **Retention:** traces are kept `traces.retentionDays` (default **30 days**, 7–365; 11 §5, 08 §3.16.2) and hold manifests, never content. An expired trace returns 404 and the list shows "Older activity is no longer explained (kept {n} days)".
- **Permissions:** `traces.read.own` (I am the requester, or a member of the audience of a DM or member-set) or `traces.read.group` (group-audience turns).

##### 3.10.6.13 Activity and audit (`/g/$groupId/activity`)

- **Purpose:** a friendly feed of what happened. Admins can switch to an exact audit log.
- **Default (Activity):** a day-grouped feed of human sentences built from `activity.<action>` templates: "Comvivo added *Recital* to the calendar · from chat", "Ana changed Leo's role to Teen", "Proposal #3 adopted (4 of 5 voted yes)".
- **Detailed (`audit.read`):**
  - Table columns: seq, time, actor (member / Comvivo / system / host), action code, target, decision (allowed, denied, needed approval), via (chat, dashboard, CLI, system).
  - Filters: actor, action, decision, date. Export CSV is client-side over the rows already readable.
  - Hosts also see an "Integrity: ✓ verified {time}" badge via `/instance/audit/verify`.
- **Empty:** "Nothing has happened yet."
- **Permissions:** Activity `mbr` (readable events only); Detailed `audit.read`.

##### 3.10.6.14 Costs and budgets (`/g/$groupId/costs`)

- **Purpose:** know what Comvivo costs and keep it in budget.
- **Data:** `GET usage?groupBy=day|route|model`, `GET/PATCH budget`, and the `budget.status` stream.
- **KPI tiles:** "This month" (spend / budget, with a progress ring), "Projected month end", "Today" (vs daily cap), "Cache savings" (cached tokens × price delta).
- **Charts:**
  - Daily spend as stacked bars by route (Chat, Understanding, Extraction, Privacy checks, Summaries).
  - Spend by model as horizontal bars.
  - Each chart has a "View as table" toggle.
- **Table:** route × model with tokens and cost.
- **Budget form** (`settings.write`):
  - Monthly and daily caps, and "Alert admins at {80}%".
  - An explainer: "Near the limit, Comvivo switches to a cheaper model, then pauses optional messages. At the limit it replies only to say the budget is reached."
- **Local preset:** the tiles read "Running on your own hardware · $0", and the charts show tokens instead.
- **Empty:** "No usage yet this month."
- **Permissions:** `usage.read`; edit `settings.write`. The host sees all groups in Instance → Overview.

##### 3.10.6.15 Onboarding checklist (host) (`/instance`, top card)

- **Purpose:** take a new host from "running" to "loved by the group".
- **Data:** `GET /instance/onboarding`. Each item is `{id, state:'done'|'todo'|'warn', detectedAt}` and is detected automatically.

  | # | Item | Done when |
  |---|---|---|
  | 1 | Claim your Comvivo | host set |
  | 2 | Connect an AI model | `models.test` passed for the `chat` route |
  | 3 | Connect a chat app | ≥ 1 channel is `connected` |
  | 4 | Add Comvivo to a group | ≥ 1 group is bound |
  | 5 | Review the group's constitution | the host viewed the Charter or adopted a version |
  | 6 | Let everyone know about Comvivo | consent notices are sent to all members (03) |
  | 7 | Save your recovery key | `keys verify-recovery` succeeded |
  | 8 | Turn on backups | backups are enabled and the first backup succeeded |
  | 9 | Open the dashboard on your phone (optional) | a session from a mobile UA exists, or `publicUrl` is set |
  | 10 | Ask Comvivo something | the first `respond` turn completed |

- **UI:** a progress bar plus rows. Each row has a one-line why, an action button (deep link to the screen or a copyable CLI command) and a "Mark as done" override. The card is dismissible after 7 of 10 are done and collapses to a "Setup: 9/10" chip.

##### 3.10.6.16 Settings (`/g/$groupId/settings/*`, `/me/*`, `/instance/*`)

Common rule: every field shows its **source**. Values set by an environment variable are locked: "Set by `COMVIVO_…` on the server". Values governed by the constitution link to it: "Set in your constitution → Edit". A "Restart needed" chip appears when `restartRequired`.

| Screen | Contents | Permission |
|---|---|---|
| Group → General | name, timezone, language | `settings.write` |
| Group → Speaking up | attention budget slider ("At most {n} unprompted messages a day"), quiet hours (start and end, group timezone), digests (weekly recap day and time), interjections on/off (constitution-governed) | `settings.write` (constitution-governed fields → propose) |
| Group → Privacy | message retention (days, within instance bounds), "who can see the fairness view", "per-member costs" (constitution) | `settings.write` |
| Group → Budget | same as Costs → budget form | `settings.write` |
| Me → Profile | name, language, timezone, theme, density | self |
| Me → Privacy | memory consent per group, "What Comvivo knows about me" link, morning brief on/off and time, personal quiet hours, "Forget everything about me in {group}" (recent auth, type-to-confirm) | self |
| Me → Sessions | current and other sessions (browser · OS, approx. location as an IP prefix, last active), Sign out, Sign out everywhere else | self |
| Me → Connections | linked chat accounts, "Link another app" (link code), unlink (recent auth) | self |
| Me → Agent access (MCP) | tokens per group with scopes, create (recent auth, shown once with copy), revoke (10) | self |
| Me → Export | "Download my data" (recent auth) → job progress → download | `export.self` |
| Instance → Models | preset cards (Best, Balanced, Economy, Local, Custom) with "≈ ${x}/month for a family of 5" (from preset metadata, M13), per-route overrides table (route, provider, model, effort), provider keys (masked `…abcd`, source `env`, **Test** button → `ProbeReport` checks), local server URL with a reachability check | host |
| Instance → Channels | a card per channel: status dot and text, bot identity ("@garcia_comvivo_bot"), last event time, enabled switch (recent auth), **checks with fix-it hints** (§3.11.6 copy, e.g. Telegram privacy mode), Re-check, Restart, "Add to a group" (claim code dialog), "Change token: run `comvivo secrets set TELEGRAM_BOT_TOKEN`" | host |
| Instance → Groups | table of groups (infra metadata), Add a group (claim code + deep links + QR), archive (CLI only in v1) | host |
| Instance → Backups | schedule, keep N, last result, list (date, size, verified), **Back up now**, Download (recent auth), Restore: "Restoring replaces all data. Run on the server: `comvivo restore <file>`" (copyable) | host |
| Instance → Plugins | installed plugins, permissions in plain words, enable/disable and approve permission changes (recent auth). "Install: `comvivo plugin add <name>`" | host |
| Instance → Security | encryption at rest status, key file permissions, last key rotation, recovery key verified, active sessions (all people), audit integrity, control API on/off | host |
| Instance → About | version, deployment mode, data folder size and free space, update check (opt-in toggle; when off: "Comvivo never contacts the internet to check for updates unless you turn this on"), licenses, docs links | host |

#### 3.10.7 Responsive and mobile

- **Breakpoints:** the Tailwind defaults `sm 640`, `md 768`, `lg 1024`, `xl 1280`. The layout switches at `md` (bottom navigation ↔ icon sidebar) and at `lg` (full sidebar).
- **Phone-first rules:**
  - Primary actions sit in thumb reach (a bottom-right FAB or sticky footer buttons).
  - Touch targets are ≥ 44×44 px on coarse pointers.
  - `env(safe-area-inset-*)` padding.
  - Inputs are ≥ 16 px, so iOS doesn't zoom on focus.
  - Correct `inputmode` and `autocomplete` attributes.
  - No hover-only affordances.
- **Tables → cards** under `md` (`DataTable` has a `renderCard` prop). Filters move into a sheet behind a "Filters (2)" button.
- **Installable:** a `manifest.webmanifest` with icons and `display: standalone`, so admins can add it to their home screen. **No service worker** in v1: we deliberately avoid caching private API data on devices.
- **Performance** is tested on a Moto G Power-class profile (§3.10.10).

#### 3.10.8 Accessibility (WCAG 2.2 AA)

| Area | Requirement |
|---|---|
| Structure | Landmarks `header`, `nav` ("Main", "Sections") and `main`. One `h1` per page. The title is "{Screen} · {Group} · Comvivo". On route change, focus moves to the `h1` and the title is announced politely. |
| Skip link | "Skip to content" focuses `#main` **programmatically**, because `<base href>` breaks fragment-only links. |
| Keyboard | Everything is reachable. Radix provides focus traps and returns focus. Month and Week views use the ARIA grid pattern. `⌘K`/`Ctrl+K` opens the command menu; `?` lists shortcuts (M15). |
| WCAG 2.2 additions | **2.4.11** Focus not obscured: `scroll-padding` under sticky bars.<br>**2.5.7** Dragging: never drag-only.<br>**2.5.8** Target size: ≥ 24 px (≥ 44 px touch).<br>**3.2.6** Consistent help: the Help link is always in the account menu.<br>**3.3.7** Redundant entry: forms and the wizard prefill known values.<br>**3.3.8** Accessible authentication: no passwords, CAPTCHAs or memorization; codes have copy buttons and accept paste. |
| Forms | Visible labels. Hints and errors linked with `aria-describedby`. An error summary at the top links to the fields. Server `errors[].pointer` values map to fields. |
| Color | Token contrast is checked in CI. Chart colors differ in lightness so they hold up under color-vision deficiency, and series have direct labels. Visibility and status never rely on color alone. |
| Live content | Chat uses `role="log"`. Toasts are announced politely and errors assertively. "Comvivo is thinking…" uses `role="status"`. |
| Motion and zoom | `prefers-reduced-motion` is honored. Layouts reflow at 200 % zoom and 320 px width, except Week view, which offers Agenda instead. |
| Verification | `@axe-core/playwright` on every screen in light/dark and desktop/mobile. A manual VoiceOver and NVDA pass in M15. `jsx-a11y`-equivalent lint rules. |

#### 3.10.9 Internationalization

- **Setup:**
  - `i18next` + `react-i18next` + `i18next-resources-to-backend`:

    ```ts
    resourcesToBackend((lng, ns) => import(`./locales/${lng}/${ns}.json`))
    ```

  - Namespaces: `common`, `nav`, `auth`, `home`, `chat`, `members`, `constitution`, `memory`, `calendar`, `tasks`, `lists`, `polls`, `plans`, `traces`, `activity`, `costs`, `settings`, `instance`, `errors`, `capabilities`.
  - Each route preloads its namespace in `loader`.
  - `fallbackLng: 'en'`; `returnNull: false`.
- **Typed keys:** `declare module 'i18next' { interface CustomTypeOptions { defaultNS: 'common'; resources: typeof en } }`. A missing key is a type error.
- **Plurals:** i18next suffixes (`_one`, `_other`, …) backed by `Intl.PluralRules`. No string concatenation for sentences, ever.
- **Formatting:**
  - `lib/format.ts` wraps `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`, `Intl.NumberFormat` (currency USD), `Intl.ListFormat` ("Ana, Leo and Sam") and `Intl.DisplayNames`. They use the member's locale from `/me`, falling back to the browser.
  - Times use Temporal in the relevant timezone (§3.10.4).
- **Errors:** `errors:<code>` keys localize problem codes. The server `detail` is the fallback.
- **RTL:** `dir` is set from the locale. Use only logical Tailwind utilities (`ms-*`, `me-*`, `ps-*`, `start-*`); a Biome or grep CI rule bans `ml-`, `mr-`, `pl-`, `pr-` and `left-`/`right-` in the dashboard source. Directional icons are mirrored.
- **Quality gates:**
  - A **pseudo-locale** `en-XA` (accented and 40 % longer) for layout testing.
  - CI checks unused and missing keys.
  - Translations go through the community workflow in 13. English ships at launch.

#### 3.10.10 Performance budget

| Metric | Budget | Enforcement |
|---|---|---|
| Initial JS (gzip) for `/g/$groupId` Home, including vendor | ≤ 200 KB | `size-limit` in CI |
| Initial CSS (gzip) | ≤ 30 KB | `size-limit` |
| Any lazy route chunk (excluding shared vendor) | ≤ 60 KB gzip | `size-limit` (glob) |
| CodeMirror chunk (Constitution Edit and History only) | ≤ 160 KB gzip | `size-limit` |
| Recharts chunk (Costs and Fairness only) | ≤ 120 KB gzip | `size-limit` |
| LCP, Home, mobile profile (4× CPU, LAN) | ≤ 2.0 s | Lighthouse CI (perf ≥ 90) |
| INP p75 | ≤ 200 ms | Playwright trace on the list check and calendar navigation |
| Memory explorer with 10k results scrolled | 60 fps, ≤ 150 DOM rows | virtualization test |

- **Code splitting:** `autoCodeSplitting` per route. `React.lazy` for CodeMirror, Recharts, the RRULE builder and QR. Prefetch on intent.
- **Assets:** precompressed (brotli and gzip) at build by the Vite compression step in `apps/dashboard/scripts/compress.ts`, which uses `node:zlib` with no plugin dependency. They are served with `precompressed: true`.
- **No runtime CSS-in-JS.** Tailwind only.

#### 3.10.11 Embedding in Home Assistant ingress

- **Detection:** boot sets `embedded:'ha'` when a request arrives on the ingress listener.
- **Behavior in the panel:**
  - The outer brand header is hidden. HA already shows the panel title. The sidebar stays.
  - All URLs are relative to `<base href={X-Ingress-Path}/>`.
  - External links (docs, deep links) open in a new tab.
  - `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`: the iframe is same-origin with HA through the Supervisor proxy, so both allow it.
  - SSE works (the proxy supports streaming).
  - Downloads (exports, backups) use `Content-Disposition: attachment` and open in a new tab, because some HA companion apps block in-iframe downloads.
- **12 sets the HA app manifest** (HA renamed add-ons to "apps"): `ingress: true`, `ingress_port: 8099`, `panel_icon: mdi:home-group`, `panel_admin: true`, `watchdog` on port 8099 `/healthz`.
### 3.11 CLI (`apps/cli`, npm package `<cli>` placeholder until D-2 (01 §14 A2), bin written as `comvivo`)

#### 3.11.1 Framework and layout

- **Parsing:** commander 15 with `@commander-js/extra-typings`. Options are typed, and help is grouped with `.helpGroup()` into **Setup**, **Run**, **Data**, **Security** and **Advanced**.
- **Prompts:** `@clack/prompts` 1.8. Validators receive a zod schema directly (Standard Schema) or an async function, which lets live API checks run inside a prompt.
- **Colors:** `picocolors`, honoring `NO_COLOR` and `FORCE_COLOR`.
- **QR codes:** `uqr` (`renderUnicodeCompact`).
- **Bootstrap:** `bin/comvivo.mjs` is a tiny ES2018-syntax shim. It checks `process.versions.node >= 22.12` before any import and otherwise prints:
  > Comvivo needs Node.js 22.12 or newer (you have {v}). Install it from https://nodejs.org or use Docker: {docs}/install/docker

  The server runtime requires Node ≥ 24.11; Node 26 LTS is the primary target (01 §14 A1). Native mode checks that separately.

```
apps/cli/src/
├─ main.ts                 # program, global options, error → exit-code mapping
├─ context.ts              # resolves install dir, config, data dir, mode, control client
├─ output.ts               # human vs --json printers, symbols with ASCII fallback (clack `unicode`)
├─ exit-codes.ts
├─ control-client.ts       # hono/client typed against apps/server control app + bearer from data/keys/control.token
├─ copy/                   # ALL user-facing CLI strings (versioned templates; snapshot-tested)
├─ commands/<name>.ts      # one file per command
├─ wizard/                 # init steps: mode, folder, models, channels, keys, budgets, access, write, start, claim
├─ probes/                 # adapters over @comvivo/models + channel probe subpath exports (§4.8)
└─ modes/                  # docker.ts (compose CLI), native.ts (runtime install, spawn, pidfile), ha.ts, umbrel.ts
```

#### 3.11.2 Global conventions

| Topic | Rule |
|---|---|
| Install folder | `-C, --dir <path>` or `COMVIVO_DIR`. If neither is given, the CLI searches upward from cwd for `comvivo.yaml`, then tries `./comvivo/comvivo.yaml`. The data dir comes from `instance.dataDir` (relative to the folder) or from `--data-dir` / `COMVIVO_DATA_DIR`. |
| Mode | Read from `deployment.mode` in `comvivo.yaml` (`docker`, `native`, `ha` or `umbrel`). Commands adapt: for example, `logs` uses `docker compose logs` in Docker mode. |
| Output | Human output goes to **stdout**. Progress, warnings and prompts go to **stderr**. `--json` prints exactly one JSON document to stdout (`{ok, data?, error?:{code,message,hint}}`) and disables prompts and spinners. |
| Interactivity | Prompts run only when `stdin.isTTY` and the run is not `--non-interactive`, `CI=true` or `--json`. Otherwise a missing required input fails with exit 3 and names the flag to pass. `--yes` accepts the default confirmations; destructive operations still require their explicit flag. |
| Secrets | Never accepted as flag *values* (shell history). They come from the environment (`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, …), a hidden `password()` prompt, `--*-file <path>`, or stdin (`comvivo secrets set NAME -`). |
| Cancel | Ctrl+C or Esc in a prompt runs `cancel("Setup cancelled. Nothing was changed.")` (or "…Files written so far are kept; run comvivo init again to continue."). The process exits with 130. |
| Server contact | Commands that need the running server use the Control API. If it is unreachable, they exit 5 with "Comvivo isn't running. Start it with: comvivo start". |
| Version skew | If the CLI's major.minor ≠ the server's, the CLI warns: "This CLI is {a}; the server is {b}. Use npx {cli}@{b} …" (`{cli}` from `BRAND`). `migrate`, `restore` and the `keys rotate-*` commands refuse to run with exit 10. |

**Exit codes** (documented in `comvivo help exit-codes`). This table covers CLI commands. The **server process** (`comvivo start` in the foreground, the container's `start`, systemd) exits with the sysexits contract in 12 §4.2 (0, 1, 65 data, 75 temporary, 78 configuration, 130), which orchestrators rely on; 12 §4.2 does not use 64 because CLI usage errors exit 2 here.

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Unexpected failure (bug); prints the `requestId` / log path |
| 2 | Usage error (unknown command or flag) |
| 3 | Invalid config, or missing required input in non-interactive mode |
| 4 | `doctor` found failures (or warnings with `--strict`) |
| 5 | Server not running or unreachable |
| 6 | Already running, lock held, or port in use |
| 7 | Permission or file-mode problem |
| 8 | External dependency unavailable (Docker, network, AI provider, chat platform, Ollama) |
| 9 | Data integrity (DB check failed, backup can't be verified, wrong key) |
| 10 | Version skew, or a migration is needed first |
| 130 | Cancelled by the user |

#### 3.11.3 Commands

| Command | Purpose | Key flags | Output (human) | Exit | Milestone |
|---|---|---|---|---|---|
| `comvivo init [dir]` | Setup wizard (§3.11.5). On an existing install it offers reconfigure options. | `--mode docker\|native`, `--data-dir`, `--preset best\|balanced\|economy\|local\|custom`, `--provider anthropic\|openai\|google\|local`, `--channels telegram,discord,…`, `--budget-monthly <usd>`, `--budget-daily <usd>`, `--access local\|lan\|url:<https://…>`, `--key-store keyfile\|keychain\|file\|env\|passphrase` (08 §3.7.3; default `keyfile`), `--recovery-key-out <file>`, `--from-env` (take secrets from the environment), `--restore <file.vbak>` (skip the wizard and restore; 12 R5), `--no-start`, `--no-wait`, `--skip-validation`, `--force`, `--timing`. Test mode only (`COMVIVO_TEST_MODE=1`, docs-as-tests and the quickstart matrix, 13 §4.4): `--channels simulator`, `--preset fake` | Steps, then summary and claim links | 0, 3, 6, 8, 130 | M3 (min), M9 (full), M14 (modes) |
| `comvivo start` | Start the server. In the foreground it exits with the server codes of 12 §4.2 | `--role web\|worker\|all\|drill`, `--detach` (native), `--port`, `--bind`, `--wait <s>`, `--recovery` (12 §3.8.5), `--allow-downgrade --restore <file\|pre-migrate:latest> [--exit-after-restore]` (12 §3.8.3), `--insecure-permissions` (08 §3.7.3) | "Comvivo is running at {url}" | `--detach`: 0, 6, 8, 10; foreground: 12 §4.2 | M3 |
| `comvivo stop` | Graceful stop (drains ≤ 30 s) | `--timeout <s>` | "Stopped." | 0, 5 | M9 |
| `comvivo restart` | stop + start | same as start | | | M9 |
| `comvivo status` | One-screen health summary | `--json`, `--watch` | version, uptime, mode, groups, channels (●/○), queue, outbox, last backup, budgets | 0, 5 | M3 |
| `comvivo doctor` | Diagnose with remediation (§3.11.6) | `--fix` (safe fixes only), `--strict`, `--offline`, `--check <id-or-prefix,…>` (e.g. `channels,models`), `--deep` (full `integrity_check` and a restore test of the newest backup), `--bundle [path]` (redacted diagnostics bundle, scrub rules 11 §3.11), `--print` (preview the bundle), `--json` | grouped checks | 0, 4 | M3 (min), M9 |
| `comvivo logs` | Show logs (never content above debug) | `-f/--follow`, `--since 1h`, `--level warn`, `--group <id>`, `--json` | pretty pino lines | 0, 5 | M9 |
| `comvivo login` | One-time dashboard sign-in for the host (prints a magic link; on non-loopback without `magicLinks: https` it prints a pairing code to send instead) | `--chat` (DM instead), `--open`, `--qr`, `--print-only` | URL (+ QR) "works once, expires in 10 minutes" | 0, 5 | M9 |
| `comvivo group claim` | Create a group claim code + deep links (01 §14 A27; 06 §3.20.1) | `--channel <id>`, `--group <grp_…>` (add a chat to an existing group), `--template <archetype>`, `--ttl <≤30m>`, `--qr`, `--wait` | code, links, per-platform instructions | 0, 5 | M3 (host code), M9 |
| `comvivo group list` | Groups (infra metadata) | `--json` | table | 0, 5 | M9 |
| `comvivo backup [create]` | Create an encrypted backup now (online through the control API; offline with storage if the server is stopped) | `--out <file>`, `--label <name>`, `--json` | path, size, verified ✓ | 0, 7, 9 | M9 |
| `comvivo backup list` / `verify [file\|--latest\|--all]` / `prune [--before <date>] [--dry-run]` / `rewrap [--all]` / `decrypt <file> --out <dir>` | List backups / verify archive integrity and decryptability / prune (02, 12 §3.9) / rewrite `VBK1` headers after a recovery-key rotation (08 §3.7.7) / standalone decrypt (08 OQ-3) | `--recovery-key-file` | table / ✓ | 0, 9 | M9 (list, verify), M14 (prune, rewrap, decrypt) |
| `comvivo restore <file\|latest\|pre-migrate:latest>` | Replace all data with a backup (server must be stopped) | `--stop` (stop the server first), `--recovery-key-file`, `--drill` (restore into a temp dir and run assertions; 12 §3.9), `--dry-run`, `--yes-i-understand` | summary (date, version, groups) → typed confirm "restore" → moves current data to `data/backups/manual/pre-restore-<ts>/` → restore → migrate → revoke sessions → rotate control token | 0, 6, 9, 10 | M9 (basic), M14 (cross-machine, drill) |
| `comvivo export` | **Shared-data** export of a group (plaintext; group-labeled data only), or `--instance` (encrypted portable archive) | `--group <id\|name>`, `--instance`, `--out` | path | 0, 5 | M9 |
| `comvivo migrate status\|up` | Show and apply DB migrations (a backup is taken first) | `--dry-run`, `--no-backup` | pending list / applied | 0, 6, 9, 10 | M3 (status), M9 |
| `comvivo keys status` | Encryption status | `--json` | key source and mode, keyring generations and slots, last rotation, recovery verified | 0, 7 | M1 (08 M1-T83), M9 |
| `comvivo keys verify-recovery` | Type the recovery key to check it against its slot (changes nothing) | `--recovery-key-file` | ✓ / ✖ | 0, 9 | M1 |
| `comvivo keys rotate-master \| rotate-data [--reencrypt-blobs] \| rotate-recovery \| rotate-sessions \| recover \| add-passphrase \| remove-slot <id> \| purge-retired` | Key operations; mechanics, online/offline behavior and ceremony are normative in 08 §3.7.6–3.7.7. `rotate-recovery` prints a **new** recovery key once; the old one is never shown again (there is no "show recovery key" command, 08 SD-04) | `--yes`, `--recovery-key-out <file>` (rotate-recovery), `--recovery-key-file` (recover) | progress; new recovery key for rotate-recovery | 0, 6, 9, 10 | M1 (08 M1-T83), M9 |
| `comvivo secrets set <NAME> [-]` / `unset` / `list` | Edit `.env` (0600) safely; offers `reload` | `--file <path>` | "Saved. Run comvivo restart to apply." (or reload) | 0, 3, 7 | M9 |
| `comvivo config get\|set\|unset\|validate\|print` | Non-secret config in `comvivo.yaml`. `print --sources` shows the effective value and its source. | `--sources`, `--json` | | 0, 3 | M9 |
| `comvivo sessions list\|revoke` | Dashboard sessions | `--all`, `--person <id>` | table | 0, 5 | M9 |
| `comvivo channels test [name]` | Re-run channel probes | `--json` | probe report with fixes | 0, 8 | M9 |
| `comvivo plugin add <spec>` / `remove <id>` / `list` / `info` / `update` / `outdated` / `restart` / `logs` / `secret set\|unset\|list` / `search` | Plugin management; semantics and the approval screen are owned by 10 §3.3. `add` and `update` show the manifest's permissions and ask for approval. | `--approve <perm,…>` (required with `--non-interactive`), `--version`, `--to <v>`, `--purge` | | 0, 3, 8 | M12 (10 owns) |
| `comvivo skill …` / `comvivo mcp client …` (incl. `secret set`) / `comvivo mcp token create\|list\|revoke` | Skills, MCP client servers and member MCP tokens; semantics owned by 10 (§3.7.3 for tokens: `create --member <id>` only for the host's own membership; `list [--person \| --group]` metadata only; `revoke <mtk_…> \| --person <prs_…> \| --all`) | per 10 | | 0, 3, 5 | M12 (10 owns) |
| `comvivo eval run\|replay\|lint\|generate\|calibrate\|label\|triage\|report\|inspect\|challenge` | Evals. Semantics in 11 §4.7; `challenge` per 13 §3.D.6. `@comvivo/evals` is a **published** package that `comvivo eval` imports **dynamically as an optional dependency** and prints an install hint when absent; `eval replay` lives in engine/server code and works without it (01 §14 A17). `eval run --suite smoke` (≤ 10 scenarios, < $0.01) validates the configured models | `--suite`, `--preset`, `--live` (costs money; asks first), `--report <file>`, others per 11 §4.7 | score table | 0, 1 | M9 (smoke, replay), M13 |
| `comvivo bench` / `comvivo feedback report\|export` | Macro benchmarks (11 §3.9) / local human-feedback reports (11 §3.13) | per 11 §4.7 | | 0, 1 | M8 (feedback), M13 (bench) |
| `comvivo version` | Version info | `--check` (one opt-in fetch of the release manifest; no identifiers) | `comvivo 1.0.0 · server 1.0.0 · node 26.x · linux-arm64 · docker` | 0 | M3 |
| `comvivo update` | Update to the latest release (backup first) | `--to <version>`, `--channel stable\|beta`, `--yes`, `--check` (canary: run the target version's migrations on a restored copy with `--role=drill`; 12 §3.8.4) | | 0, 8, 10 | M14 |
| `comvivo runtime install [ver] \| use <ver> \| list \| prune` | Native runtime management (12 §3.4.3) | | | 0, 8 | M14 |
| `comvivo models list \| pull <id> \| verify` | Pinned model files (12 §3.2.4) | | | 0, 8, 9 | M11 |
| `comvivo recovery status \| restore <backup> \| export-raw` | Recovery mode (12 §3.8.5) | | | 0, 5, 9 | M14 |
| `comvivo db checkpoint` | WAL checkpoint through the control API (12 runbook R2) | | | 0, 5 | M14 |
| `comvivo selftest` | Native-library self-test (12 §4.1) | `--json` | | 0, 1 | M3 |
| `comvivo service install\|uninstall\|status\|start\|stop` | systemd (Linux) / launchd (macOS) unit for native mode; `start`/`stop`/`status` wrap `systemctl`/`launchctl` | `--user\|--system`, `--yes` | unit path + enable instructions | 0, 7 | M14 |
| `comvivo host transfer --to <personId>` | Change the instance owner | | | 0, 5 | M15 |
| `comvivo healthcheck` (hidden) | Exit 0 if `/healthz` is 200 on loopback (same check as the image's `/app/healthcheck.mjs`) | `--url` | none | 0, 1 | M14 |
| `comvivo completion <bash\|zsh\|fish>` | Shell completion script | | | 0 | M15 |

#### 3.11.4 Install modes

| Mode | `start` / `stop` / `logs` | Server runtime | Data and permissions |
|---|---|---|---|
| `docker` (recommended) | `docker compose up -d` / `stop` / `logs`. The CLI waits for `/readyz` via the published port. | The image from 12. Init pulls it in the background immediately after step 1. | The compose file sets `user: "${COMVIVO_UID}:${COMVIVO_GID}"` from `.env`, which the wizard writes from `process.getuid()`. The host CLI can then read `data/keys/control.token`. The dashboard is mapped to `127.0.0.1:7777` unless the access choice is LAN. |
| `native` | Foreground by default. `--detach` spawns a detached child with a pidfile at `data/run/comvivo.pid` and logs at `data/logs/`. `stop` sends SIGTERM and waits. | The server-runtime package (`@comvivo/server@<cliVersion>`, names per 12 §3.1) is installed by `comvivo runtime install` into the managed runtime directory (12 §3.4.3) in the background during the wizard. The CLI imports it dynamically. | Node ≥ 24.11 is required (checked); Node 26 recommended (01 §14 A1). |
| `ha` | Managed by the Supervisor. The CLI is used only inside the container (`docker exec`), for `doctor`, `backup` and `keys`. | HA app image (`comvivo-ha`, 12 §3.5) | Ingress (§3.9.10) |
| `umbrel` / `casaos` | Managed by the app store. Same CLI usage as `ha`. | image | `trustProxy` per 12 |

#### 3.11.5 `comvivo init` wizard (exact copy)

- **Target:** under 5 minutes, measured by `--timing`. Downloads start in the background at step 1 (image pull or runtime install). Nothing is written to disk before step 7.
- **Glyphs:** clack's (`┌ │ ◆ ◇ ● ○ ◼ ◻ ▲ ✖ └`), with an ASCII fallback.
- **Placeholders:** `{docs}` is the docs base URL from 13. Text in `{}` is interpolated.

**Step 0: welcome**
```
┌  Comvivo setup
│
│  This takes about 5 minutes. You'll need:
│    • an API key from Anthropic, OpenAI or Google — or Ollama on this machine
│    • a Telegram account (or admin access to a Discord server or Slack workspace)
│  Nothing is saved until step 7. Press Ctrl+C to quit at any time.
```
If `comvivo.yaml` already exists in the target folder:
```
◆  Comvivo is already set up in ./comvivo. What would you like to do?
│  ● Add or fix a chat app
│  ○ Change AI models or API keys
│  ○ Change spending limits
│  ○ Show the claim code and invite links again
│  ○ Quit
```
Each option runs the matching steps (4, 3, 6, 9). **There is no "start over" option**: the wizard never deletes data. Starting over means choosing a new folder with `comvivo init <newdir>`.

**Step 1: install mode**
```
◆  How do you want to run Comvivo?
│  ● Docker Compose (recommended) — isolated, restarts automatically, easy to update
│  ○ Node.js on this computer — no Docker needed; you keep it running
```
- **Docker missing** (`docker compose version` fails): the option is shown as "Docker Compose (Docker isn't installed or running)". Node becomes the default, and the step adds the note: "To use Docker later: {docs}/install/docker".
- **Node < 24.11 in native mode:**
  ```
  ▲  Comvivo needs Node.js 24.11 or newer to run here (Node 26 recommended; you have {v}). Install it from https://nodejs.org, or choose Docker.
  ```
- After this choice, the background download starts:
  - Docker: `docker compose pull`.
  - Node: the runtime install.

  It is shown later as `◇ Downloading Comvivo in the background ({pct}%)` on step transitions.

**Step 2: folder and data**
```
◆  Where should Comvivo keep its files?
│  ./comvivo
│  Settings, your encrypted database, keys and backups go here. Back up this folder.
```
Validation is an async validator that returns one message:

| Problem | Message | Type |
|---|---|---|
| Not writable | "Can't write to {path}. Choose another folder or fix its permissions." | error |
| Synced folder (iCloud, Dropbox, OneDrive or Google Drive path patterns) | "This folder is synced to the cloud. Syncing a live database can corrupt it. Choose a folder outside {service}." | error; `--force` overrides |
| Free disk < 1 GB | "Only {n} MB free here. Comvivo needs at least 1 GB for the database, models and backups." | warning |
| Existing Comvivo data | "This folder already has Comvivo data. Use `comvivo init` inside it to reconfigure, or choose an empty folder." | error |

**Step 3: AI models**
```
◆  Which AI should Comvivo use?
│  ● Best — Claude Opus 5.5 for conversations (≈ ${best}/month for a family of 5)
│  ○ Balanced — Claude Sonnet 5.5 (≈ ${balanced}/month)
│  ○ Economy — Claude Haiku 5.5 (≈ ${economy}/month)
│  ○ Local — runs on this computer with Ollama; nothing leaves your network
│  ○ Another provider — OpenAI, Google, or a custom mix
│  You can change this any time in the dashboard.
```
- Estimates come from `@comvivo/models` preset metadata, which starts from 05 §8's estimates (about $67/month on Best, $36 on Balanced, $3 on Economy for a family of 5) and is replaced by M13's measured numbers. The estimate is **always shown before the host chooses** (01 §14 A3).
- Default: **Best is pre-selected**, with its estimate shown; any other preset is one key away (01 §14 A3). Whether to pre-select Best or Balanced is **owner decision D-1** (15 §1); until the owner decides, Best stays pre-selected.
- The selected preset sets the default budget in step 6 (A3).

**Data-flow disclosures (after the model choice; copy normative in 08 §3.11.4):**
- "Where your group's data goes", rendered from the chosen preset's per-route egress manifest, with [Continue] [Show per-route details].
- The Google unpaid-tier warning (refused when the group will have child members).
- Hybrid mode is shown as an option when Ollama is reachable; whether it is pre-selected on ≥ 16 GB RAM is **owner decision D-6**.
- The host-trust acknowledgment ("As the host you can technically read everything…") with [I understand].

**Cloud key entry:**
```
◆  Paste your Anthropic API key
│  ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪
│  Create one at https://console.anthropic.com/settings/keys (it starts with "sk-ant-").
```
- **Key already in the environment:**
  ```
  ◆  Found ANTHROPIC_API_KEY in your environment. Use it?  ● Yes / ○ No, paste another
  ```
- **Validation** (async validator, spinner "Checking your key…"). Through `ProviderProbe` (§4.8):
  1. `models.retrieve()` for each model in the preset. This is free.
  2. One minimal Haiku-class call, which verifies billing. It costs under $0.0001.

| Result | Copy |
|---|---|
| OK | `◇  Key works — Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 are available.` |
| 401 `AuthenticationError` | "Anthropic didn't accept this key. Check you copied all of it, or create a new one." |
| 402 `billing_error` | "This key works, but the account has no credit. Add credit at https://console.anthropic.com/settings/billing, then try again." |
| 403 `PermissionDeniedError` / model 404 | "This key can't use {model}. Choose another preset, or check your organization's model access." |
| 429 / 529 | "Anthropic is busy right now. Try again in a minute, or press Enter to continue without checking." |
| Network | "Couldn't reach api.anthropic.com. Check your internet connection or proxy settings." |

OpenAI and Google follow the same pattern through their probes.

**Local preset:**
```
◇  Looking for Ollama at http://localhost:11434…
│  Found Ollama {version}.
◆  Comvivo recommends {model} ({size} GB) for this computer ({ram} GB memory). Download it now?
│  ● Yes, download ({size} GB)   ○ Use a model I already have   ○ Skip for now
```
- The recommendation comes from `@comvivo/models` `LOCAL_PRESETS`, chosen by total RAM (M2 decides the models).
- Download uses `POST /api/pull`, rendered with clack `progress`: "Downloading {model} — {completed}/{total} GB".
- **Ollama not found:** "Ollama isn't running. Install it from https://ollama.com/download, start it, then press Enter to check again — or choose a cloud preset." The options are Retry, Back and Skip.
- **Docker mode:** the URL written is `http://host.docker.internal:11434/v1`. The compose file gets `extra_hosts: host-gateway` (12).

**Step 4: chat apps**
```
◆  Where does your group chat?  (space to select, enter to confirm)
│  ◼ Telegram (recommended to start)
│  ◻ Discord
│  ◻ Slack
│  ◻ Matrix (beta)
│  ◻ Signal (experimental)
│  You can add more later with: comvivo init
```
Only channels whose packages are installed are listed. In M3–M9 that is Telegram only. The web chat is always on and isn't listed.

**Telegram:**
```
│  Create your Telegram bot (about 1 minute):
│    1. Open https://t.me/BotFather and send /newbot
│    2. Pick a name, like "Garcia Family Comvivo", and a username ending in "bot"
│    3. BotFather replies with a token like 123456789:AA…
│    4. Recommended: send /setprivacy, choose your bot, then Disable
│       (Comvivo can then follow plans in the chat. It still only replies when asked.)
◆  Paste the bot token
│  ▪▪▪▪▪▪▪▪▪▪▪▪▪▪
```
The checks are run by 06's `TelegramProbe`:

| Check | Pass copy | Fail copy and action |
|---|---|---|
| `getMe` | `◇  Connected to @{username}` | "Telegram didn't accept this token. Copy it again from @BotFather (it looks like 123456789:AA…)." |
| `can_join_groups` | — | "Your bot can't be added to groups. In @BotFather send /setjoingroups, pick @{username}, then Enable." Options: Check again / Back |
| `can_read_all_group_messages` | `◇  Privacy mode is off — Comvivo can follow your group's plans` | `▲  Privacy mode is on, so Comvivo will only see messages that mention it.` + "To fix: in @BotFather send /setprivacy, pick @{username}, choose Disable. If the bot is already in a group, remove it and add it again afterwards." Options: **I've changed it, check again** / **Continue anyway** |
| `getWebhookInfo.url` empty | — | "This bot is connected to a webhook ({host}), maybe from another app. Comvivo uses its own connection. Remove the webhook?" Options: **Yes, remove it** (calls `deleteWebhook`) / Back |
| `getUpdates` 409 conflict | — | "Another program is already using this bot token. Stop it, or create a new bot for Comvivo." |

**Discord** (M10):
```
│    1. Open https://discord.com/developers/applications and click New Application
│    2. In Bot, click Reset Token and copy it
│    3. In Bot → Privileged Gateway Intents, turn on Message Content and Server Members
◆  Paste the bot token
```
- The probe calls `GET /users/@me` and `GET /applications/@me`. Flags bits 18 or 19 (message content) and 14 or 15 (members) must be set.
- Fail copy: "Message Content intent is off, so Comvivo can't read messages. Turn it on in Bot → Privileged Gateway Intents, then check again."
- The install link is built later (step 9) from `application.id` and 06's `DISCORD_PERMISSIONS`.

**Slack** (M10):
```
│    1. Create the app from our manifest: {https://api.slack.com/apps?new_app=1&manifest_yaml=…}
│    2. Install it to your workspace, then copy the Bot User OAuth Token (xoxb-…)
│    3. In Basic Information → App-Level Tokens, create a token with connections:write (xapp-…)
◆  Paste the bot token (xoxb-…)
◆  Paste the app-level token (xapp-…)
```
- The probe runs `auth.test` with the `xoxb-` token, then `apps.connections.open` with the `xapp-` token (it doesn't connect).
- Success: `◇  Connected to {team} as @{user}`.
- **Matrix** (homeserver URL and access token; `whoami`) and **Signal** (signal-cli JSON-RPC URL, registered account check) follow 06's probe copy.

**Step 5: encryption and recovery key**
```
◇  Creating your encryption key… done
│
│  Your data is encrypted on this computer. If the key file is lost (a dead disk,
│  a new computer), this recovery key is the only way to unlock your backups.
│
│  ┌────────────────────────────────────────────────┐
│  │  RECOVERY KEY                                  │
│  │  {recovery key in 08's format, grouped}         │
│  └────────────────────────────────────────────────┘
│  Write it down or save it in your password manager now. Comvivo cannot show it
│  again. (If you lose it, create a new one with: comvivo keys rotate-recovery.)
◆  Type groups 3 and 11 of the key to confirm you saved it
│  ____ ____
```
- The master key is generated through `@comvivo/storage` crypto (08 / 02) into `data/keys/master.key` (0600; `keys/` is 0700) unless `--key-store` selects another mode (08 §3.7.3). The keyring with the recovery slot and the control token are generated at the same time. The recovery-key format and ceremony are normative in 08 §3.7.6.
- Typing the wrong characters gives: "That doesn't match. Look at the key above and try again."
- `--recovery-key-out <file>` writes the key with mode 0600 and prints: "Saved to {file}. Move it somewhere safe, off this computer."

**Step 6: spending limits** (skipped for the Local preset)
```
◆  Monthly spending limit for AI (USD)
│  {presetMonthly}
│  Near the limit, Comvivo switches to a cheaper model, then pauses optional
│  messages. At the limit it only answers to tell admins.
◆  Daily limit (USD)
│  {presetDaily}
```
- The prefilled values are the **per-preset defaults** (01 §14 A3): Best $75/month and $4/day; Balanced $40 and $2; Economy $5 and $0.30; Local $0 (CPU budget only, so the step is skipped). Accepting them writes `budgets: { preset: auto }`; editing them writes `budgets: { monthlyUsd, dailyUsd }` (01 §10).
- Validation: a positive number ≤ 10,000, and the daily limit ≤ the monthly limit.

**Step 7: dashboard access, then write files**
```
◆  Where will you open the dashboard?
│  ● Only on this computer (most private) — http://localhost:7777
│  ○ From phones and laptops on my home network — http://{lanIp}:7777
│  ○ Through my own web address (HTTPS) or Tailscale — you'll enter it next
```
- **LAN option** sets `dashboard.bind: 0.0.0.0` (Docker publishes `0.0.0.0:7777`) and shows: `▲ Your home network can see the dashboard. Traffic isn't encrypted on your network; that's fine for most homes.`
- **URL option:**
  - It prompts for `https://…`.
  - If `tailscale status --json` succeeds, it suggests the MagicDNS name.
  - It sets `instance.publicUrl` and `trustProxy`.

Then:
```
◇  Writing your setup
│  ✓ comvivo.yaml      settings (safe to keep in git)
│  ✓ .env              secrets — private to you (mode 600); never commit it
│  ✓ compose.yaml      Docker setup
│  ✓ data/keys/        encryption keys (mode 600)
│  ✓ .gitignore        keeps .env and data/ out of git
```
- Writes are atomic: write to a temp file, then rename.
- Existing files are **never** overwritten without a diff and confirmation (`--force` skips the prompt).
- Before writing, one more question (12 §3.4.4): "Check for new versions? (downloads a public file; nothing about you is sent)", default **No**, stored as `updates.check`.

**Step 8: start**
```
◒  Starting Comvivo… (first start downloads about {n} MB)
◇  Comvivo is running — dashboard at {url}
```
- The CLI waits on `/readyz` for up to 180 s.
- **Port in use:**
  ```
  ▲  Port 7777 is already in use. Use 7779 instead?
  ```
  The new port is written into config. The suggestion is the next free port above 7778, which is reserved for 08 §3.8.11's optional ICS feed listener. MCP has no port of its own (`/mcp` on this listener, 10 §3.7.2).
- **Timeout:** "Comvivo didn't start in time. See what happened with: comvivo logs". Exit 8.

**Step 9: claim and add to the group**
```
◆  Last step: add Comvivo to your group chat.
│
│  On your phone, open this link and pick your group:
│    https://t.me/{bot}?startgroup=c_{LINK_TOKEN}
│  {QR code}
│
│  Or add @{bot} to the group yourself, then send:  /start@{bot} {CODE-FMT}
│  This code makes you the host. It works once and expires at {time}.
```
- `{CODE-FMT}` is the typed host claim code (`VLG-XXXX-XXXX`); `{LINK_TOKEN}` is its 128-bit link token (§3.9.1). Per-platform command syntax is owned by 06 §3.20.
- **Discord:** "Invite the bot: {oauth url}, then in any channel type /comvivo claim code:{CODE-FMT}".
- **Slack:** "In a channel, type /invite @{bot}, then /comvivo claim {CODE-FMT}".

**Step 10: wait and celebrate**
```
◒  Waiting for your group… (Ctrl+C to finish later — Comvivo keeps running)
◇  Comvivo joined "{groupName}" on {Platform}. You're the host.
│
│  Try it: in the group, say "Comvivo, what can you do?"
│  Dashboard: comvivo login   ·   Health check: comvivo doctor
└  Set up in {m}m {s}s. Welcome to the comvivo.
```
- The wait listens on the control SSE for `group.bound`.
- **Ctrl+C:** prints "No problem. Comvivo is running. Use the link above any time in the next {n} minutes, or get a new one with: comvivo init". Exit 0.

**Non-interactive example** (CI / automation):
```bash
# `npx comvivo@latest` is the placeholder for `npx <cli>@latest` until owner decision D-2 (01 §14 A2)
ANTHROPIC_API_KEY=… TELEGRAM_BOT_TOKEN=… npx comvivo@latest init ./comvivo \
  --non-interactive --mode docker --preset economy --channels telegram \
  --budget-monthly 10 --budget-daily 1 --access local \
  --recovery-key-out ./comvivo-recovery.txt --json
# → {"ok":true,"data":{"dir":"./comvivo","dashboard":"http://localhost:7777",
#     "claim":{"code":"VLG-7K2M-9QXA","telegram":"https://t.me/…?startgroup=c_<link token>","expiresAt":"…"}}}
```
`--recovery-key-out` is **required** in non-interactive mode. Without it the run exits 3 with: "Non-interactive setup needs --recovery-key-out so your recovery key isn't lost."

#### 3.11.6 `comvivo doctor`

- **Shared registry (the only one).** Checks live in `apps/server/src/diagnostics/checks/*.ts`. The CLI imports the registry for offline checks. The server exposes the online subset at `/control/v1/doctor` and `/api/v1/instance/health`. 08 §3.10 (security checks D-01…D-16, mapped to the ids below or to `security.*`), 11 §3.11 (native modules, audit chain, embeddings, observability, debug flags, test mode, recovery) and 12 (FS type, instance lock, sync markers) register their checks here; this document owns flags, output and exit codes.
- **Check shape:** `{id, alias?, title, run(ctx) → {status:'pass'|'info'|'warn'|'fail'|'skip', detail, fix?:{text, command?, docs?}, fixable?:boolean}}`.

| ID | Checks | Warn / fail when | Remediation copy (`fix.text`) |
|---|---|---|---|
| `runtime.node` | Node version (native mode); permission-model network flag (08 D-08) | < 24.11 → fail; 24.x → warn (plugin network not enforced) | "Comvivo needs Node.js 24.11 or newer (26 recommended). Install it from https://nodejs.org or switch to Docker." |
| `config.valid` | `comvivo.yaml` parses and validates (zod) | invalid → fail | "comvivo.yaml line {n}: {message}. Fix it, or run `comvivo config validate` for details." |
| `config.secrets` | Required env vars for enabled providers and channels | missing → fail | "{NAME} isn't set. Run: comvivo secrets set {NAME}" |
| `fs.folder` | Install and data dirs exist, are writable and owned by the running user | fail | "Comvivo can't write to {path}. Run: sudo chown -R {user} {path}" |
| `fs.modes` | `keys/` is 0700; `master.key`, `control.token` and `.env` are 0600 | looser → fail (`--fix` applies chmod) | "{file} can be read by other users. Run: chmod 600 {file} (or comvivo doctor --fix)" |
| `fs.cloudsync` | Data dir isn't under iCloud, Dropbox, OneDrive or Google Drive | warn | "Your data folder is synced to {service}. Move it: stop Comvivo, move the folder, update instance.dataDir." |
| `fs.disk` | Free space | < 2 GB warn, < 200 MB fail | "Only {n} free. Free up space or move the data folder; Comvivo stops accepting messages when the disk is full." |
| `keys.master` | Key present; DB opens with it (`SELECT count(*) FROM sqlite_master`) | fail | "The encryption key is missing or doesn't match this database. Restore data/keys/master.key from a backup, or use your recovery key: comvivo restore --recovery-key-file …" |
| `keys.recovery` | Recovery key confirmed | never confirmed → warn | "You haven't confirmed your recovery key. Run: comvivo keys verify-recovery" |
| `db.integrity` | `PRAGMA quick_check` (`--deep`: `integrity_check`) | not ok → fail | "Database check failed. Stop Comvivo and restore the latest backup: comvivo restore …" |
| `db.migrations` | Schema version vs binary | pending → warn (auto-applied on start); DB newer → fail | "Database is from a newer Comvivo ({v}). Update Comvivo: comvivo update" |
| `server.running` | Control API reachable | fail (skip offline checks that need it) | "Comvivo isn't running. Start it: comvivo start" |
| `server.version` | CLI vs server skew | minor skew → warn | "This CLI is {a}, the server is {b}. Use npx comvivo@{b}." |
| `server.ready` | `/readyz` | fail | "Comvivo is up but not ready: {checks}. See: comvivo logs --level warn" |
| `channels.<id>` | Probe: connectivity, identity, permissions (privacy mode, intents, socket token, webhook conflicts) | per check | Uses 06's probe copy, e.g. "Telegram privacy mode is on — in @BotFather: /setprivacy → @{bot} → Disable, then remove and re-add the bot to your group." |
| `models.<route>` | Provider reachable; key valid; model accessible; local model present | fail | "Anthropic rejected the key in ANTHROPIC_API_KEY. Create a new key and run: comvivo secrets set ANTHROPIC_API_KEY" |
| `time.clock` | Skew vs the `Date` header of a provider or Telegram response (08 D-14) | > 30 s warn, > 5 min fail | "This computer's clock is {n} off. Reminders may fire at the wrong time. Turn on automatic time sync." |
| `time.zone` | Host TZ is a valid IANA zone; group timezones are valid | warn | "Group '{name}' has no valid timezone. Set it in the dashboard → Settings → General." |
| `backups.recent` | Last successful backup < 36 h (if enabled; the same threshold as `/healthz` `degraded`, 12 §3.9); not on the same disk as data (warn) (08 D-06) | warn | "No backup in {n} days. Run: comvivo backup — and check the logs for backup errors." |
| `jobs.health` | Failed or dead jobs, stuck leases | > 0 dead → warn | "{n} background jobs failed. See: comvivo logs --since 24h --level error" |
| `outbox.stuck` | Outbox rows pending > 10 min | warn | "{n} messages are waiting to send on {channel}. Check the channel status above." |
| `budgets.status` | Any group ≥ 90 % of a cap | warn | "{group} has used {pct}% of its monthly AI budget. Raise it in the dashboard → Costs." |
| `dashboard.exposure` | Bound to non-loopback without HTTPS `publicUrl` | warn | "The dashboard is reachable on your network without HTTPS. Fine at home; otherwise put it behind HTTPS: {docs}/dashboard/https" |
| `dashboard.reachability` | Magic links would point to loopback while chat users are remote | warn | "Sign-in links only open on this computer. Set instance.publicUrl to an address your phone can reach." |
| `docker.compose` | Docker running; container healthy; image tag = CLI version (docker mode) | fail / warn | "The Comvivo container isn't healthy. See: comvivo logs" |
| `updates.available` | Only if `updates.check: true` | newer → warn | "Comvivo {v} is available. Update with: comvivo update" |
| `security.*` | The remaining 08 §3.10 checks (`security.env-git`, `security.secrets-in-config`, `security.encryption`, `security.root`, `security.debug-and-key-source`, `security.egress`, `security.plugins`, `security.proxy`, `security.logs`) | per 08 §3.10 (`info`/`warn`/`fail`) | copy per 08 §3.10 |

**Output:**
```
Comvivo doctor · v1.0.0 · docker mode

  ✔ Configuration is valid
  ✔ Data folder is writable (./comvivo/data · 41 GB free)
  ▲ Recovery key was never confirmed
      Run: comvivo keys verify-recovery
  ✖ Telegram: privacy mode is on
      Comvivo only sees messages that mention it. In @BotFather: /setprivacy → @garcia_comvivo_bot
      → Disable, then remove and re-add the bot to your group.
      Docs: {docs}/channels/telegram#privacy-mode

  21 passed · 1 warning · 1 failed
```
Exit codes: 4 on any fail. With `--strict`, warnings also exit 4. `info` never affects the exit code. (11 §3.11 uses these codes too.)

### 3.12 Copy and UX writing guidelines (dashboard and CLI)

**Voice:** a capable, warm neighbor who helps out. Plain, brief and calm. Never cute, never alarmist. Comvivo is "it"; the reader is "you".

**Rules:**
1. **Say what happened, why (if known), and what to do next.** Every error has an action. Example: "Couldn't reach api.anthropic.com. Check your internet connection." Never write "Something went wrong" on its own; add the `requestId` and one step to try.
2. **Never reveal private data in UI copy or errors.** Write "This item doesn't exist or isn't shared with you", never "This belongs to Sam". Traces say "{n} items not visible to you", never whose they are.
3. **Use user words, not system words:**

   | Internal | User-facing |
   |---|---|
   | label / readers | "Visible to …" |
   | audience | "who will see this reply" |
   | declassified constraint | "a private preference, shared as a hint" |
   | proactivity / interjection | "speaking up" |
   | consent `memory_off` | "Memory off for you" |
   | turn | "reply" |
   | disposition | "why Comvivo replied (or didn't)" |
   | capability | "can …" |
   | proposal | "proposed change" |
   | constitution | "constitution" (subtitle "your group's rules") |
   | IFC, actor, outbox, job, lease | never shown |

4. **Sentence case** for everything (titles, buttons, menu items). Buttons are verbs: "Propose change", "Forget memory", "Get a sign-in code", never "OK" or "Submit".
5. **Be specific with numbers and time.** "Expires in 10 minutes (17:42)", "3 of 5 voted". Use the locale's formats. Show the timezone whenever it differs from the reader's.
6. **One exclamation mark at most**, and only for real celebrations (the end of setup). No emoji in UI chrome or CLI output. Bot messages follow 05's behavior charter.
7. **Don't write "simply", "just", "easy" or "obviously".** Don't blame: write "That code expired", not "You entered an expired code".
8. **Destructive copy names the object and the consequence**, and says whether it can be undone.
9. **Explain privacy positively and precisely.** "Admins can't see your private chats with Comvivo — not even the host through the dashboard." Never over-promise beyond the threat model. The host's machine access is documented in 08, and Security → About links to it.
10. **CLI specifics:**
    - Lines are ≤ 80 columns.
    - Commands to run are on their own line, prefixed `Run:`.
    - Paths are shown relative when shorter.
    - Successes stay quiet (one line).
    - `--json` messages have the same text in `error.message` and a stable `error.code`.
11. **i18n-safe:** full sentences with placeholders, no concatenation, room for 40 % growth, and no text in images.
12. **Where copy lives:**
    - Dashboard: `apps/dashboard/src/locales/en/*.json`.
    - CLI: `apps/cli/src/copy/*.ts`. These are typed template functions, and copy snapshot tests catch accidental changes.
    - Channel fix-it hints: in 06's probe packages, so the CLI, doctor and dashboard share them.
    - Copy is reviewed like code (CODEOWNERS `docs` team).
---

## 4. Interfaces

### 4.1 Viewer and read models (`packages/engine/src/readmodels`)

```ts
export interface RequestPrincipal {
  readonly personId: PersonId; readonly sessionId: SessionId;
  readonly instanceRole: 'host' | null; readonly authTime: Instant;
  readonly via: 'cookie' | 'ha_ingress';
}
export interface GroupViewer {
  readonly principal: RequestPrincipal;
  readonly groupId: GroupId; readonly memberId: MemberId; readonly role: RoleId;
  readonly capabilities: ReadonlySet<Capability>;            // from capabilitiesFor(policy, member) (03 §3.2.10)
  readonly audience: Extract<Audience, { kind: 'members' }>; // { groupId, memberIds: {memberId} }
  readonly snapshot: GroupSnapshot;                          // pinned at request start
}

declare const readable: unique symbol;
export type Readable<T> = T & { readonly [readable]: true }; // constructible ONLY in ifc-gate.ts

export interface IfcGate {
  filter<T extends { label: Label }>(viewer: GroupViewer, rows: readonly T[]): Readable<T>[];
  one<T extends { label: Label }>(viewer: GroupViewer, row: T | undefined): Readable<T> | NotFound;
}

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface ReadModels {           // one method per GET in §3.5; all take the viewer first
  home(v: GroupViewer): Promise<HomeDto>;
  members(v: GroupViewer, q: MembersQuery): Promise<Page<MemberDto>>;
  messages(v: GroupViewer, conversationId: ConversationId, q: CursorQuery): Promise<Page<ChatMessageDto> | NotFound>;
  memories(v: GroupViewer, q: MemoryQuery): Promise<Page<MemoryCardDto>>; // via MemoryQueryService (04)
  events(v: GroupViewer, range: ZonedRange): Promise<OccurrenceDto[]>;
  trace(v: GroupViewer, turnId: TurnId): Promise<TraceViewDto | NotFound>;
  // … tasks, rotations, fairness, lists, polls, plans, decisions, constitution, proposals, approvals,
  //   activity, audit, usage, budget, settings
}
export interface InstanceReadModels { // host-infra; DTO fields allow-listed
  instance(p: RequestPrincipal): Promise<InstanceDto>; groups(p: RequestPrincipal): Promise<InstanceGroupDto[]>; /* … */
}
```

### 4.2 Commands

```ts
export type Origin = 'dashboard' | 'cli' | 'chat' | 'mcp' | 'system';
export interface CommandBus {
  dispatch<C extends Command>(groupId: GroupId, cmd: C, actor: GroupViewer,
    opts: { origin: Origin; idempotencyKey?: string; waitMs?: number }): Promise<Outcome<ResultOf<C>>>;
  status(commandId: CommandId, principal: RequestPrincipal): Promise<CommandStatus | NotFound>;
}
export type Outcome<R> =
  | { outcome: 'done'; result: R }
  | { outcome: 'needs_confirmation'; approval: ApprovalDto }      // from: requester|owner|admin|guardian
  | { outcome: 'contested'; proposal: ProposalDto }
  | { outcome: 'queued'; commandId: CommandId }
  | { outcome: 'denied'; reason: PolicyReason; userMessage: string };   // HTTP maps to 403 policy_denied
```

### 4.3 Shared DTO shapes (zod in `apps/server/src/http/schemas/common.ts`, exported in OpenAPI)

```ts
const VisibilityView = z.object({
  kind: z.enum(['group', 'private', 'shared']),           // group = all current members; private = only viewer
  members: z.array(z.object({ id: MemberId, displayName: z.string() })).optional(), // for 'shared'
  sensitive: z.boolean(),
  ownedByMe: z.boolean(),                                  // may change visibility
  canShapeSuggestions: z.boolean(),                        // influence:'constraints' (03)
}).openapi('VisibilityView');

const Problem = z.object({
  type: z.string(), title: z.string(), status: z.number().int(), detail: z.string().optional(),
  instance: z.string().optional(), code: ProblemCode, requestId: z.string(),
  errors: z.array(z.object({ pointer: z.string(), code: z.string(), message: z.string() })).optional(),
}).passthrough().openapi('Problem');
```

### 4.4 AuthService (`packages/engine/src/auth`, used by HTTP, the control API and 06's in-chat commands)

```ts
export interface AuthService {
  issueLoginLink(personId: PersonId, via: ChannelIdentityId | 'cli'): Promise<Result<{ url: string; expiresAt: Instant }, AuthError>>;
  exchangeLoginToken(token: string, client: ClientInfo): Promise<Result<SessionIssue, 'token_invalid'>>;
  createPairing(client: ClientInfo): Promise<{ pairingId: PairingId; code: string; browserSecret: string; expiresAt: Instant }>;
  lookupPairing(code: string, identity: ChannelIdentityId): Promise<Result<PairingPrompt, 'not_found' | 'rate_limited'>>; // 06 renders buttons
  decidePairing(pairingId: PairingId, identity: ChannelIdentityId, decision: 'approve' | 'deny'): Promise<void>;
  pollPairing(pairingId: PairingId, browserSecret: string): Promise<'pending' | 'denied' | 'expired' | SessionIssue>;
  issueClaimCode(kind: 'host' | 'group', opts: { template?: Archetype; ttl: Duration }): Promise<ClaimCodeIssue>;
  redeemClaimCode(code: string, by: { identity: ChannelIdentityId; groupChat?: PlatformChatRef } | { web: WebClaim })
    : Promise<Result<ClaimRedemption, 'invalid' | 'burned' | 'already_claimed'>>;
  startStepUp(sessionId: SessionId, action: string): Promise<StepUpChallenge>;
  resolveSession(rawToken: string): Promise<SessionView | null>;  // LRU-backed
  rotate(sessionId: SessionId): Promise<SessionIssue>;
  revoke(target: { sessionId: SessionId } | { personId: PersonId } | 'all', reason: string): Promise<number>;
}
```

### 4.5 Domain events and the stream

```ts
export interface DomainEvent { groupId: GroupId | null; resource: ResourceKind; kind: 'created' | 'updated' | 'deleted' | 'other';
  ids: readonly string[]; label: Label | 'host' | { sessionId: SessionId } | { personId: PersonId }; payload?: StreamPayload }
export interface DomainEventBus {   // engine port; publish() is called only AFTER the tx commits
  publish(e: DomainEvent): void; subscribe(fn: (e: DomainEvent) => void): () => void;
}
// Implementations: InProcessEventBus (default), SqliteTailEventBus (role split; 02 owns `domain_events`)
```

### 4.6 Storage needs (fields only; 02 owns the DDL, indexes and retention)

| Table | Fields | Retention |
|---|---|---|
| `sessions` | §3.9.5 | revoked/expired rows pruned after 30 days |
| `login_tokens` | id, jti (unique), personId, instanceId, purpose, createdAt, expiresAt, consumedAt?, requestedVia | 24 h after expiry |
| `pairings` | id, codeHash, browserSecretHash, status, personId?, clientInfo (UA summary, ipPrefix), createdAt, expiresAt, decidedAt?, linkHaUserId? | 24 h |
| `claim_codes` | id, kind (`host`\|`group`), codeHash, linkTokenHash, channel?, groupId?, template?, createdByPersonId?, createdAt, expiresAt, failedAttempts, usedAt?, usedInChat?, usedByPersonId? (02 `claim_codes` ≡ 06 §3.20.1 `ClaimCode`) | 30 days |
| `invite_codes` | id, codeHash, groupId?, personId?, role?, createdAt, expiresAt, usedAt? | 30 days |
| `link_codes` | id, codeHash, tokenHash, issuerPersonId, issuerChannelIdentityId, state (`issued`\|`redeemed`\|`confirmed`\|`cancelled`), redeemedByIdentityId?, createdAt, expiresAt (10 min) (02 `link_codes` ≡ 06 §3.18.1 `LinkCode`) | 24 h after expiry |
| `step_up_challenges` | id, sessionId, action, codeHash, attempts, status, expiresAt | 24 h |
| `idempotency_keys` | sessionId, key, method, path, status, responseBody (≤ 64 KB), createdAt | 24 h |
| `ics_feed_tokens` | id, groupId, memberId, tokenHash, scope (`group`\|`member`), detail (`full`\|`busy`), createdAt, lastUsedAt?, revokedAt? (02 ≡ 07 §3.1.1 `FeedToken`) | until revoked |
| `ha_links` | haUserId, personId, createdAt, lastSeenAt | until unlinked |
| `domain_events` | seq, at, groupId, resource, kind, ids JSON, label JSON | 1 h (role split only) |

### 4.7 Control API typing

`apps/server/src/http/control/app.ts` exports `type ControlApp`. The CLI uses `hc<ControlApp>(baseUrl, { headers: { authorization: 'Bearer …' } })`. The control app has ~10 routes, so RPC typing stays fast. It is **not** in the public OpenAPI document (`hide: true`).

### 4.8 Probes (consumed by the CLI, doctor and dashboard; implemented by 05/M2 and 06)

```ts
export interface ProbeCheck { id: string; status: 'pass' | 'warn' | 'fail'; title: string; detail?: string;
  fix?: { text: string; command?: string; docs?: string; action?: 'recheck' | 'delete_webhook' | 'open_url'; url?: string } }
export interface ProbeReport { ok: boolean; identity?: { id: string; handle: string; displayName?: string }; checks: ProbeCheck[] }

export interface ProviderProbe {       // @comvivo/models/probe (subpath export, no heavy deps)
  probe(provider: 'anthropic' | 'openai' | 'google' | 'local', creds: ProviderCreds, models: string[], opts: { live: boolean }): Promise<ProbeReport>;
  ollama?: { version(baseUrl: string): Promise<string | null>; tags(baseUrl: string): Promise<string[]>;
             pull(baseUrl: string, model: string, onProgress: (p: { completed?: number; total?: number; status: string }) => void, signal: AbortSignal): Promise<void> };
}
export interface ChannelProbe {        // @comvivo/channel-<id>/probe (subpath export; uses fetch only)
  readonly channel: ChannelId;
  probe(creds: Record<string, string>): Promise<ProbeReport>;
  installLinks?(identity: ProbeReport['identity'], claimCode: string): { group?: string; dm?: string; instructions?: string };
  fix?(actionId: 'delete_webhook', creds: Record<string, string>): Promise<ProbeReport>;
}
```

### 4.9 Interfaces requested from other documents

| From | Need |
|---|---|
| 02 | `EligibleLabelSet` / `label_id IN (:eligible)` repository filters (01 §14 A8; replaces the earlier `ReaderPrefilter` idea); tables in §4.6; `domain_events`; transactional `AuditEvent` with `via` |
| 03 | The 03 §3.2.10 functions, by their exact names: `capabilitiesFor(policy, member)` (a function over plain-data `CompiledPolicy`, not a method) returning `CapabilityGrant{capability, requires?}`; `constitutionJsonSchema()`; `validate(yamlText, ctx) → ConstitutionIssue[]` (spans `line/column/endLine/endColumn`); `charter(policy, roster, locale) → RichText`; `semanticDiff(a, b, locale) → SemanticChange[]` (items carry `plain` and `privacyReducing`); `traces.hideHiddenCount` policy; consent-state visibility rule; `dashboard.access`, `audit.read`, `usage.read` (present in 03 §3.1.2 since R1) |
| 04 | `MemoryQueryService.search(audience, query, filters, cursor)`; correct/forget/pin/visibility commands; `aboutMe(viewer)` |
| 05 | `TurnTrace` read API with per-entry labels; confirmation (`Approval`) lifecycle; actor accepts `priority:'interactive'` commands between model calls (Q-12); `ProviderProbe` |
| 06 | In-chat commands `/dashboard`, `/pair`, `/claim`, `/logout-all`, `/why`, step-up buttons → `AuthService`; `ChannelProbe` + fix-it copy per adapter; web adapter `acceptInbound()` and SSE push hook |
| 07 | `renderIcs(audience, range)`; fairness ledger view with explicit label; event occurrence expansion |
| 08 | recovery-key format + `keys` primitives; token formats (§3.7.12); exposure modes and the A9 login rules (signed off) |
| 10 | MCP token issue/revoke service (`comvivo mcp token`); plugin manifest/permission model and the `comvivo plugin`/`skill`/`mcp client` command semantics |
| 12 | compose `user:` UID/GID mapping; image healthcheck (`/app/healthcheck.mjs`, same check as `comvivo healthcheck`); HA app manifest values (§3.10.11); release manifest URL for update checks; the ops commands in 12 §4.1 (listed in §3.11.3) |

---

## 5. Configuration

### 5.1 `comvivo.yaml` additions (extends spine §10; zod schemas in `@comvivo/shared/config`)

```yaml
instance:
  publicUrl: null                   # https://comvivo.example.com — used for links, cookies (Secure), CSRF origin
deployment:
  mode: docker                      # docker | native | ha | umbrel | casaos — written by init; informational for server
dashboard:
  enabled: true
  bind: 127.0.0.1                   # Docker image sets COMVIVO_DASHBOARD_BIND=0.0.0.0 inside the container
  port: 7777
  basePath: /                       # external path prefix behind a reverse proxy
  trustProxy: false                 # false | true | ["10.0.0.0/8", "172.16.0.0/12"]
  ingress: { enabled: false, port: 8099, allowFrom: ["172.30.32.2"] }   # Home Assistant (mode H, 08 §3.8.1)
  sessions: { idleHours: 12, absoluteDays: 7, rotateHours: 24, recentAuthMinutes: 10 }   # values per 08 §3.7.12
  auth: { pairingCodes: true, pairingCodeTtlMinutes: 10, magicLinks: auto, magicLinkTtlMinutes: 10, notifyOnSignIn: host }
        # magicLinks: auto (loopback only) | https (also over HTTPS; explicit opt-in, A9) | off — host-only key
        # notifyOnSignIn: off | host | all
  rateLimits: {}                    # per-class overrides, e.g. { read: { perMinute: 1200 } }
api:
  maxBodyKb: 256
  idempotencyTtlHours: 24
control:
  enabled: true                     # CLI control API (bearer token file)
updates:
  check: false                      # opt-in; fetches a static release manifest daily, no identifiers
```

Constraints enforced by zod:
- `magicLinkTtlMinutes` must be between 2 and 10.
- `absoluteDays` ≤ 7 and `idleHours` ≤ 24 (08 §3.7.12 sets the security ceiling).
- `pairingCodes: false` is valid only where magic links are allowed (D-12).
- `magicLinks: https` requires an `https://` `publicUrl` or direct TLS.
- `basePath` must start with `/` and has no trailing slash, except `/` itself.
- `publicUrl` is http(s) only, with no path when `basePath ≠ /`; the base path is configured separately.

### 5.2 Environment variables

| Variable | Overrides | Notes |
|---|---|---|
| `COMVIVO_DIR`, `COMVIVO_CONFIG`, `COMVIVO_DATA_DIR` | install folder, config file, `instance.dataDir` | CLI and server |
| `COMVIVO_PUBLIC_URL`, `COMVIVO_BASE_PATH` | `instance.publicUrl`, `dashboard.basePath` | |
| `COMVIVO_DASHBOARD_BIND`, `COMVIVO_DASHBOARD_PORT` | `dashboard.bind`, `dashboard.port` | |
| `COMVIVO_TRUST_PROXY` | `dashboard.trustProxy` | `true`, `false` or a CSV of CIDRs |
| `COMVIVO_INGRESS` | `dashboard.ingress.enabled` | set by the HA app |
| `COMVIVO_UID`, `COMVIVO_GID` | compose `user:` | written by init (Docker) |
| `COMVIVO_SETUP_TOKEN` | web-setup token for app-store installs (§3.9.4) | Umbrel/CasaOS (12 §3.6) |
| Image and ops variables of 12 §4.4 (`COMVIVO_CONFIG`, `COMVIVO_LOG_LEVEL`, `COMVIVO_LOG_FORMAT`, `COMVIVO_MODELS_PRESET`, `COMVIVO_LOCAL_BASE_URL`, `COMVIVO_LOCAL_MODEL`, `COMVIVO_SIGNAL_CLI_URL`, `COMVIVO_PROFILE`, `COMVIVO_HEAP_MB`, `COMVIVO_SHUTDOWN_GRACE_MS`, `COMVIVO_UPDATE_CHECK`, `COMVIVO_MODELS_PATH`, `COMVIVO_MODEL_MIRROR`, `COMVIVO_WHISPER_BIN`, `COMVIVO_FFMPEG_BIN`, `COMVIVO_SCRATCH_DIR`, `COMVIVO_PLATFORM`, `COMVIVO_METRICS_TOKEN`) | as listed there | implemented by the shared config loader; every variable also accepts `*_FILE` |
| `COMVIVO_NONINTERACTIVE`, `CI`, `NO_COLOR`, `FORCE_COLOR` | CLI behavior | |
| Provider and channel secrets | — | names per 05 and 06 (`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, …) |

### 5.3 Editing from the dashboard and hot reload

- **DB layer** (dashboard-editable, per ADR-014): budgets, quiet hours, retention within bounds, model preset and per-route model overrides **among providers already configured in env/YAML**, channel `enabled` flags, `notifyOnSignIn`, `updates.check`, and backup schedule and `keep`.
- **File/env only, shown read-only:** `bind`, `port`, `basePath`, `publicUrl`, `trustProxy`, `ingress.*`, `control.enabled`, all secrets, and every **host-only key** (01 §14 A14; marked ● in 08 §5): providers, base URLs and API keys, egress allowlists, plugins, MCP servers, debug-content logging, `dashboard.auth.magicLinks` and the rest of the exposure mode. DB values for these keys are ignored.
- **Hot-reloadable** (`/control/v1/reload` or a DB change): budgets, quiet hours, retention, the model preset and routes (gateway rebuild), channel enable/disable (adapter start/stop), rate limits, and secrets after `comvivo secrets set` (adapter or gateway restart).
- **Restart required:** `bind`, `port`, `basePath`, `ingress.*`, `dataDir`. The UI shows a "Restart needed" chip next to these.

---

## 6. Failure modes and edge cases

| # | Situation | Behavior |
|---|---|---|
| F1 | Magic link points to `localhost`, but the member is on a phone | The DM includes the loopback warning and suggests the pairing code instead. The doctor check `dashboard.reachability` warns. The onboarding checklist item 9 suggests `publicUrl`, LAN access or Tailscale. |
| F2 | A link-preview bot or security scanner fetches the magic link | The token is in the fragment, so it is never sent. The exchange requires a JS POST. Previews are disabled anyway. |
| F3 | A user opens the magic link twice (double tap) | The second exchange returns `token_invalid`. The SPA first checks for an existing valid session (`GET /me`) and redirects silently if one exists. |
| F4 | The DM can't be started (Telegram user never pressed Start) | The group reply includes the `?start=login` deep link. No link is ever posted in a group. |
| F5 | Secure cookie set over plain HTTP | Prevented by the cookie choice table: `Secure` only when HTTPS is detected. A misconfigured `trustProxy` shows the doctor warning `dashboard.exposure`. |
| F6 | The proxy strips `Origin` | `Sec-Fetch-Site` is still present in all supported browsers. If both are missing, the request gets 403 `csrf_failed`, the error is logged with `reason`, and the docs recipe explains `trustProxy`. |
| F7 | The HA ingress path changes (app reinstalled) | No cookies are used on ingress, so nothing breaks. The base is read per request. |
| F8 | The group actor is busy with a long turn | The command waits ≤ 8 s, then returns `202 queued`. The UI shows "Saving…" until `command.completed`. A full mailbox gives 503 `actor_busy` with Retry-After. |
| F9 | Two admins edit the same plan or constitution draft | `If-Match` returns 412 with `current`. The UI offers a merge view. |
| F10 | A member is removed while viewing | The next request gets 404 for the group. SSE `invalidate:members` triggers a refetch of `/me`, and the UI routes to `/` with "You're no longer in {group}." |
| F11 | The SSE buffer gap is exceeded, or the server restarts | `resync` → full invalidation. There is no data loss: the stream carries only hints, apart from chat, which is refetched. |
| F12 | Too many tabs on HTTP/1.1 | Stream limit of 4 per session (429 on the extra ones, with silent fallback to 60 s polling). Leader election in M15. |
| F13 | A post-filtered page comes back empty | `nextCursor` is non-null. `InfiniteList` auto-fetches up to 3 empty pages, then shows "Load more". |
| F14 | The clock jumps (VM resume) | Token expiry uses server time only. Rate-limit buckets clamp negative elapsed time to 0. The doctor warns via `time.clock`. |
| F15 | Restore from backup | Every session is revoked and the control token rotated. The CLI prints "Everyone will need to sign in again." |
| F16 | DB locked or busy (`SQLITE_BUSY`) during a read | Retry once after 50 ms, then 503 `actor_busy` with Retry-After 1. |
| F17 | Wizard: Docker installed but the daemon isn't running | "Docker is installed but not running. Start Docker Desktop, then press Enter to check again." Options: Retry / Use Node instead. |
| F18 | Wizard: Telegram token already polled by another instance (409) | The specific copy in §3.11.5. Never auto-steal the connection. |
| F19 | Wizard is interrupted after step 7 | Files are kept. Re-running `init` detects the folder and offers "Continue setup" (steps 8–10). |
| F20 | Windows | `chmod` is a no-op, so the doctor check `fs.modes` reports `skip` with "Make sure only your account can read {folder}". Paths are normalized. Native mode is supported and Docker is recommended. |
| F21 | Ollama model pull fails because the disk is full | Clack progress shows the error. The wizard offers a smaller model or a cloud preset. |
| F22 | Constitution validate endpoint is slow or unreachable while editing | Client-side syntax linting keeps working. The status shows "Can't check rules right now". Propose stays disabled until a validation succeeds. |
| F23 | Budget exhausted while using web chat | Comvivo's own budget message is shown as a normal message, plus the `budget.status` banner for `usage.read` viewers. |
| F24 | A web-only person's session expires | They can't re-login without a linked chat app. This is prevented by the persistent "Link a chat app" banner (§3.9.11). The host can't impersonate. |
| F25 | The host is not a member of any group | `/` routes to `/instance`. The group switcher shows "You're not in any groups yet" with an "Add a group" action. |

---

## 7. Security and privacy

| Area | Controls (details in the referenced section) |
|---|---|
| IFC | The same `canRead` gate as the model context. Read models are type-gated (`Readable<T>`) and import-gated (HTTP code can't import storage). Unreadable entities return 404. No totals. SSE is filtered per subscriber. Traces contain no content (§3.3). |
| Authority | Every mutation goes through the PolicyEngine with the viewer as principal (I3) and is audited with `via`. The UI hides controls but is never trusted (§3.4). |
| Authentication | No passwords. Pairing is the default login; magic links only on loopback or with HTTPS opt-in (01 §14 A9), single-use and carried in the URL fragment. Pairing approval names the device and warns about code-forwarding. Claim codes are burned after 10 failures. Every auth endpoint is rate-limited. Sensitive actions need recent auth. Sessions can be listed and revoked (§3.9). |
| Cookies and CSRF | HttpOnly, SameSite=Strict, and `__Host-`/`__Secure-` names on HTTPS. Sec-Fetch-Site/Origin checks plus a session-bound header on every unsafe method. JSON-only bodies. **No CORS** at all. |
| Headers | **The header set is normative in 08 §3.8.4** (strict nonce CSP with `'strict-dynamic'` and Trusted Types, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, COOP/CORP/COEP, `Permissions-Policy`). The only exception is the HA ingress listener (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`, §3.10.11). CodeMirror uses the `cspNonce` facet and Radix injected `<style>` gets the nonce via `setNonce()`. If the M9 Playwright CSP tests show Radix needs `style-src-attr 'unsafe-inline'`, that relaxation needs an ADR (08 §3.8.4). M11 may allow `microphone=(self)`. |
| XSS | Rich text is rendered from the AST, never as raw HTML. Links are limited to http, https and mailto, with `rel="noopener noreferrer nofollow"`. |
| Secrets | Never stored in the DB, the API or the UI; only a last-4 hint is shown. The CLI reads them from env, a hidden prompt, a file or stdin, never from flag values. `.env` and `keys/*` are 0600 (doctor checks this and `--fix` repairs it). Init warns if git doesn't ignore `.env`. |
| Control API | 256-bit bearer token (`vctl_…`) in a 0600 file, compared in constant time. Requests carrying cookies are rejected. Not on the ingress listener. Rotated on restore and on `keys rotate-master`. |
| HA ingress | Socket-level allow-list for `172.30.32.2`. Identity headers are read only on that listener and never authenticate on their own: an HA user is linked once through a bot pairing code (or, while unclaimed, the host claim code). No second login after linking. |
| Logs | No request bodies. Tokens and codes are redacted. ICS paths are masked. Only `ipPrefix` is stored. |
| Privacy defaults | Update check off. No webfonts, CDNs or other third-party requests. No service worker cache. ICS feeds exclude private items. Per-member costs off. Consent states are visible only to the member and to managers. |
| Honest limits | The host's machine access can read everything (08). The dashboard says so on Security → About. |

---

## 8. Performance and cost

| Item | Target | Notes |
|---|---|---|
| API read p95 (Pi 5, 50k memories, 5 members) | ≤ 50 ms list endpoints; ≤ 150 ms memory search; ≤ 80 ms `/home` | SQL prefilter + post-filter; measured in 11's perf suite |
| API mutation p95 (actor idle) | ≤ 100 ms | excludes the wait when the actor is busy |
| Session resolution | ≤ 0.2 ms (LRU hit) | write-behind `lastSeenAt` |
| SSE fan-out latency (commit → client) | ≤ 50 ms p95 at 64 subscribers | per-subscriber `canRead` on a cached snapshot |
| SSE memory | ≤ 64 KB per idle stream; ring buffer ≤ 4 MB | |
| Static serving | precompressed; `index.html` templating ≤ 0.1 ms | |
| Server idle RSS impact of HTTP and dashboard | ≤ 25 MB of the 300 MB budget | no SSR, no in-memory asset copies beyond `index.html` |
| Dashboard bundles | §3.10.10 | `size-limit` in CI |
| Wizard wall time | ≤ 5 min (p50 ≤ 4 min) in dry runs | background downloads; `--timing` |
| CLI startup (`comvivo status`) | ≤ 300 ms | thin package; server runtime not loaded |
| Model cost added by this document | key test ≈ $0.0001 per test; web chat = normal turns; charter preview and constitution validation are deterministic (03), so $0 | `probe` rate class prevents abuse |

---

## 9. Testing and evals

| Suite | What it proves | Where / tooling |
|---|---|---|
| **API IFC property suite** | It generates random groups (roles, labels on every resource, DMs, traces with mixed manifests, audit) and random viewers. It then calls **every** `GET` route with `ifc:'readmodel'`, plus SSE replay. It asserts three things:<br>• every returned ID satisfies `canRead(label,{viewer})`;<br>• unreadable IDs give 404 bodies identical to those for nonexistent IDs (ignoring `requestId`);<br>• a canary string planted in every private item never appears.<br>A **coverage guard** fails if any `GET` route lacks a generator fixture. | `apps/server/test/ifc-api.prop.test.ts` (fast-check) |
| Admin/host-cannot-read-DMs red-team | Zero leaks via memory search, traces, activity, audit, usage grouping, exports, SSE, ICS and the conversations list | shared with 11 |
| Authority suite | For each `ifc:'command'` route × role × template, the outcome (done, needs_confirmation, contested, 403) matches 03's policy table. Driven by the route-meta `capability`. | Vitest + `app.request()` |
| Contracts | No OpenAPI drift (`openapi:emit` + `git diff --exit-code`). The generated client compiles. Every problem `code` has an `errors:<code>` key. Every route has `x-comvivo` metadata. | CI |
| Auth and security | Token reuse, expiry and instance mismatch. Fragment-only exchange. Rotation grace. Session fixation. The CSRF matrix (method × content type × Sec-Fetch-Site/Origin × header). The cookie matrix (http/https × basePath × proxy). Rate limits. The control API rejects cookies. Ingress allow-list (simulated `remoteAddress`). CSP is present on HTML. | Vitest |
| SSE | Resume via `Last-Event-ID`. A gap triggers `resync`. Revocation and back-pressure close the stream. Per-subscriber filtering. | Vitest |
| Dashboard | Unit tests: Vitest + Testing Library, with msw handlers generated from OpenAPI examples. Playwright e2e against `pnpm dev` with the simulator channel:<br>• magic link, pairing, setup;<br>• every screen's happy, empty, error and permission states;<br>• 375×812 and desktop, light and dark.<br>Also: axe on every screen, 12 visual snapshots, Lighthouse CI on Home, `size-limit`, i18n missing/unused keys, pseudo-locale overflow check. | `apps/dashboard/{src,e2e}` |
| CLI | `execa` against built binaries in a temp folder. Provider and platform APIs mocked by msw/node fixtures (05/06). Scripted-TTY wizard golden path per mode (`node-pty`, dev-only). Non-interactive matrix. Copy snapshots. Every doctor check has pass, warn and fail fixtures. Exit codes asserted. | `apps/cli/test` |
| Evals | Time-to-first-value dry runs (11 §3.13.6, 13 §9.3; 01 §14 A22): ≥ 40 fresh-user attempts with ≥ 95% success and median ≤ 5 minutes, `--timing` attached to the release checklist. `comvivo eval run --suite smoke` validates the configured models. | release checklist |

---

## 10. Implementation tasks

> **Task numbering:** tasks from this document use numbers 901–999 within each milestone (`M9-T905`). This avoids collisions when `14-milestones.md` merges all documents.

### M3 — minimal path for the alpha (Telegram)

| ID | Task | Files | Acceptance criteria | Depends on |
|---|---|---|---|---|
| M3-T901 | CLI skeleton | `apps/cli/{bin/comvivo.mjs,src/main.ts,context.ts,output.ts,exit-codes.ts,copy/}` | `comvivo --help` and `comvivo version`. Node version shim. `--json` / `--non-interactive` plumbing. Exit-code table tests. | M0 |
| M3-T902 | HTTP foundation + health | `apps/server/src/http/{app.ts,listeners.ts,middleware/{request-id,security-headers,no-store,problem,body-limit}.ts}`, `routes/health.ts` | `/healthz` and `/readyz` follow §3.8 semantics (tests for draining, migrations pending and scheduler stale). problem+json `onError`. Binds `dashboard.bind:port`. | M1 |
| M3-T903 | Control API (min) + token | `http/control/{app.ts,auth.ts}`, `routes: status, claim-codes, login-links(print only), events(SSE: group.bound)`; `storage` keygen of `control.token` | The CLI reaches the server with the bearer. Cookies are rejected. A wrong token gets 401. | M3-T902 |
| M3-T904 | Host claim code (min) | `engine/auth/claim.ts`, boot banner | A code (typed `VLG-…` + 128-bit link token, 30-minute TTL) is generated at boot when unclaimed. It is redeemed through 06's Telegram `/start c_…` and `?startgroup=c_…`, and the group gets bound (placeholder constitution in M3, 01 §14 A27). Burned after 10 failures. Audit event. | M3-T903, 06 M3 Telegram + setup flow |
| M3-T905 | `comvivo init` (min, native, Telegram, Anthropic) | `apps/cli/src/wizard/{welcome,folder,models,telegram,keys,write,start,claim}.ts`, `probes/` | The wizard copy from §3.11.5, steps 0–3, 4 (Telegram only), 5, 7 (local access only), 8–10. It validates the key and token (getMe, privacy, webhook). Writes `comvivo.yaml`, `.env` (0600) and keys. Starts native `--detach`. Prints the startgroup link and waits for `group.bound`. Has a non-interactive mode. | M3-T903, M3-T904, M2 ProviderProbe, 06 TelegramProbe |
| M3-T906 | `comvivo start`/`status`/`doctor` (min) | `commands/{start,status,doctor}.ts`, `apps/server/src/diagnostics/checks/{config,fs,keys,db,server,telegram,models}.ts` | `start` runs in the foreground, plus `--detach` with a pidfile. `status` summary. `doctor` with 8 core checks and their remediation copy. Exit 4 on fail. | M3-T902 |

### M9 — full API, auth, dashboard and CLI

| ID | Task | Files | Acceptance criteria | Depends on |
|---|---|---|---|---|
| M9-T901 | Route metadata, OpenAPI emit, api-client package | `http/meta/route-meta.ts`, `http/openapi-emit.ts`, `apps/server/openapi.json`, `packages/api-client/{package.json,src/{schema.gen.ts,index.ts}}` | Boot fails if a route lacks metadata. `pnpm openapi:emit` is deterministic. The CI drift check is in place. openapi-typescript output compiles. `createApiClient()` exported. | M3-T902 |
| M9-T902 | API conventions middleware | `middleware/{base-path,proxy,rate-limit,idempotency,group-scope,recent-auth}.ts`, `http/pagination.ts`, `http/etag.ts` | Cursor codec. Rate classes (§3.7) with headers. Idempotency replay. If-Match → 412/428. `trustProxy` CIDR logic. Unit-tested. | M9-T901 |
| M9-T903 | AuthService + sessions + cookies + CSRF | `engine/auth/{service.ts,tokens.ts,sessions.ts,pairing.ts,stepup.ts}`, `http/middleware/{session,csrf}.ts`, `routes/auth.ts` | §3.9.1–3.9.8 behaviors. The cookie choice matrix, CSRF matrix, rotation grace and revocation tests all pass. Tokens are hashed, and redaction is verified in logs. | M9-T902, 02 tables |
| M9-T904 | Pairing + magic link + step-up end to end | `routes/{auth,me}.ts`, 06 command hooks | With the simulator channel, pairing approve and deny in every exposure mode; `/dashboard` → DM link → exchange → session on loopback and with `magicLinks: https`, and a pairing-instructions reply (no link) in modes I and H. Step-up approve, with auto-retry of the original request in the dashboard. Copy per §3.9. | M9-T903, 06 |
| M9-T905 | Web setup, invites, link codes, group claim codes | `routes/{auth,groups,instance}.ts` | `/setup` claims the host. Group claim codes with deep links. Web-group invites create a Person, Member and session. Link codes consumed by 06. | M9-T903 |
| M9-T906 | Read-model layer + IFC gate | `packages/engine/src/readmodels/{ifc-gate.ts,viewer.ts,*.ts}`, depcruise rule `http ↛ storage` | `Readable<T>` brand. Post-filter pagination. 404 parity. **The IFC property suite (§9) is green** with the coverage guard. | M5 (IFC), 04 MemoryQueryService |
| M9-T907 | Command path + approvals + commands status | `packages/engine/src/commands/*`, `routes/{approvals,commands}.ts` | Mutations dispatch into the actor and reuse the tool `action/execute` where one exists. The Outcome union is mapped to HTTP. 8 s wait → 202 `queued` + `command.completed`. The authority suite is green. | M4, M7, 05 actor priority |
| M9-T908 | Group, member, conversation and chat routes | `routes/{groups,members,conversations,chat}.ts` | §3.5 tables. Web chat send through 06's web adapter. Replies over SSE. Consent PATCH. | M9-T906/T907, 06 web adapter |
| M9-T909 | Constitution and proposal routes | `routes/{constitution,proposals}.ts` | validate/diff/schema/versions. Propose, vote, ratify, withdraw with If-Match. Issues carry line and column. | M4, 03 APIs |
| M9-T910 | Memory routes | `routes/memories.ts` | search, filters, about-me, correct, forget, pin, confirm, visibility. Canary leak tests. | M6, M9-T906 |
| M9-T911 | Coordination routes + ICS feeds | `routes/{events,reminders,tasks,rotations,fairness,lists,polls,plans,decisions,calendar-feeds,ics}.ts` | Occurrence expansion in the group timezone. Recurring-edit scopes. Feed tokens hashed. The ICS route is `/ics/v1/{token}.ics` with 07 §3.1.5 semantics, rate-limited and masked in logs. Feed endpoints use 02 `ics_feed_tokens` fields (`scope`, `detail`, `lastUsedAt`); `POST /calendar/feeds` never returns the URL (DM delivery only; `409 dm_needed` tested). The fairness route returns only the viewer's own share under the default `self_only` (test). | M7, 07 |
| M9-T912 | Traces, activity, audit, usage, budget, settings, exports | `routes/{traces,activity,audit,usage,budget,settings,exports}.ts` | `TraceView` per §3.10.6.12 with hidden-count collapsing. Audit verify. Settings with sources. Exports need recent auth and produce single-use download URLs. | M5, M8, 02 export |
| M9-T913 | Instance (host) routes + probes | `routes/instance/*.ts` | Allow-listed DTO fields for host-infra. Model and channel tests through the probes. Backups list, create and download (recent auth). Plugins enable and permission changes. Sessions and security. Onboarding state. | M9-T906, M2, 06 probes |
| M9-T914 | SSE hub | `http/stream/{hub.ts,ring-buffer.ts,routes.ts}`, `engine/events/bus.ts` | Event union in OpenAPI. Resume, resync, heartbeat, 30-minute rotation, limits, back-pressure, per-subscriber IFC. Tests per §9. | M9-T906 |
| M9-T915 | Dashboard scaffold | `apps/dashboard/*` (Vite 8, Router plugin, Tailwind 4, shadcn init `-b radix`), `src/{boot,router,i18n,theme}.ts`, `api/*`, `components/{AppShell,Sidebar,BottomNav,GroupSwitcher,…}`, `apps/server/src/http/spa.ts` | Runtime base path through `<base>` and boot JSON. Auth guard. Theme without FOUC (nonce). Problem handling. Stream invalidation map. Command menu. `size-limit` baseline within budget. axe passes on the shell. | M9-T901, M9-T914 |
| M9-T916 | Sign-in screens | `routes/{login,auth.magic,setup,join}.tsx` | §3.10.6.1 including errors and countdowns. Playwright tests for magic, pairing and setup. | M9-T904/T905, M9-T915 |
| M9-T917 | Home + onboarding checklist | `routes/_app/g.$groupId/index.tsx`, `routes/_app/instance/index.tsx`, `features/home/*`, `features/onboarding/*` | §3.10.6.2 and §3.10.6.15, with the mobile layout. Inline approve and vote. | M9-T908, M9-T913 |
| M9-T918 | Chat screen | `features/chat/*`, `components/RichText.tsx` | §3.10.6.3. Optimistic send and retry. Audience banner. "Why?" links. `role=log`. No streaming. | M9-T908 |
| M9-T919 | Members & roles | `features/members/*` | §3.10.6.4, including consent chips visibility and role change → contested. | M9-T908 |
| M9-T920 | Constitution editor | `features/constitution/*`, `lib/yaml-doc.ts` (CodeMirror lazy chunk) | Form and YAML on one draft with comments preserved. Two-layer lint. Preview and semantic diff. History with merge view. Proposals and votes. Three-way view on base change. Chunk ≤ 160 KB gzip. | M9-T909 |
| M9-T921 | Memory explorer | `features/memory/*` | §3.10.6.6. Virtualized. Filters in the URL. Detail drawer with provenance. All controls. Info line. | M9-T910 |
| M9-T922 | Calendar | `features/calendar/{agenda,month,week,event-form,rrule-builder,subscribe}.tsx`, `lib/temporal.ts` | Three views with the keyboard grid. Timezone-correct display (DST property tests on layout helpers). Recurring scopes. Feed dialog with warnings. | M9-T911 |
| M9-T923 | Tasks, chores and fairness | `features/tasks/*` (Recharts lazy) | §3.10.6.8. No drag-only reordering. Fairness gated by the constitution, with a table view. | M9-T911 |
| M9-T924 | Lists, polls & decisions, plans | `features/{lists,polls,decisions,plans}/*` | §3.10.6.9–11. Live list updates via SSE. Optimistic checks. Plan 412 merge prompt. | M9-T911 |
| M9-T925 | Activity, audit and traces | `features/{activity,traces}/*` | §3.10.6.12–13. Hidden-item collapsing. Owner-only constraint sources. Integrity badge. | M9-T912 |
| M9-T926 | Costs & budgets | `features/costs/*` | §3.10.6.14. KPI tiles, charts with tables, budget form. Local-preset variant. | M9-T912 |
| M9-T927 | Settings (group, me, instance) | `features/settings/*`, `routes/_app/{me,instance}/*` | §3.10.6.16. Source and locked indicators. Restart chips. Recent-auth flows. Masked keys with Test. Channel fix-it hints. | M9-T912/T913 |
| M9-T928 | Full `comvivo init` | `apps/cli/src/wizard/*`, `modes/{docker,native}.ts` | Every step and all copy in §3.11.5 for Docker and native modes. Background downloads. Reconfigure menu. Dashboard access step (LAN/Tailscale detection). Port fallback. Non-interactive matrix. ≤ 5-minute dry run. | M3-T905, M9-T903 |
| M9-T929 | CLI commands (rest) | `commands/{stop,restart,logs,login,group,backup,restore,export,migrate,keys,secrets,config,sessions,channels,eval}.ts` | The §3.11.3 table with flags, outputs and exit codes. Restore safety (typed confirm, pre-restore copy, session revocation). No command can print an existing recovery key (08 SD-04). | M9-T903, 02 backup, 08 keys |
| M9-T930 | Full `doctor` + `/instance/health` | `apps/server/src/diagnostics/checks/*` | All §3.11.6 checks with fixtures for pass, warn and fail. `--fix` for modes and dirs. The same registry is used online. | M9-T913 |
| M9-T931 | Quality gates for the dashboard and API | `apps/dashboard/e2e/*`, `.size-limit.json`, `lighthouserc.json`, i18n checks, token contrast script | All §9 dashboard and CLI checks run in CI. Budgets enforced. | all M9 above |

### M10 — channels in the wizard

| ID | Task | Files | Acceptance criteria | Depends on |
|---|---|---|---|---|
| M10-T901 | Wizard and doctor steps for Discord, Slack, Matrix and Signal | `wizard/{discord,slack,matrix,signal}.ts` | Guided copy (§3.11.5). Probes validate intents, tokens and Socket Mode. Install and claim instructions in step 9. Doctor checks. | 06 M10 adapters and probes |

### M14 — packaging-related CLI and server modes

| ID | Task | Files | Acceptance criteria | Depends on |
|---|---|---|---|---|
| M14-T901 | Thin `comvivo` package + on-demand runtime | `apps/cli/package.json`, `modes/native.ts` | `npx comvivo@latest init` installs only the CLI. The native runtime is installed into `.runtime` in the background. The CLI and server versions are pinned together. Cold `npx` ≤ 20 s on broadband. | 12 npm publishing |
| M14-T902 | Docker mode orchestration | `modes/docker.ts` | `start`, `stop`, `logs` and `status` via compose. UID/GID mapping. Waits for readiness. Image tag = CLI version. | 12 compose files |
| M14-T903 | HA ingress mode | `http/middleware/ingress.ts`, `listeners.ts`, `routes/link-ha.tsx`, `engine/auth/ha-links.ts` | Socket allow-list, `X-Ingress-Path` base, header sessions, linking via pairing (or the host claim code while unclaimed), unlinked headers never authenticate (test), embedded UI mode, SSE through ingress. Tested with a simulated Supervisor proxy. | 12 HA app |
| M14-T904 | `comvivo healthcheck`, `update`, `version --check`, `service install` | `commands/{healthcheck,update,version,service}.ts` | Exit semantics. Pre-update backup. Opt-in manifest fetch with no identifiers. systemd and launchd units generated. | 12 release manifest |
| M14-T905 | Cross-machine restore | `commands/restore.ts` | Restore onto a fresh machine with the recovery key. Control token rotated. Sessions revoked. Upgrade-path test with backups from the N-1 and N-2 versions. | 02/08 |

### M15 — polish

| ID | Task | Files | Acceptance criteria | Depends on |
|---|---|---|---|---|
| M15-T901 | Copy review pass (CLI + dashboard) | `copy/*`, `locales/en/*` | Every string reviewed against §3.12. A glossary lint flags banned internal terms in locale files. | M9 |
| M15-T902 | Accessibility audit | — | Manual VoiceOver and NVDA pass. Zero serious or critical axe findings. WCAG 2.2 AA checklist signed off. | M9 |
| M15-T903 | Performance polish + stream leader election | `api/stream.ts` | Lighthouse ≥ 90 on mobile. One stream per browser via Web Locks + BroadcastChannel. INP ≤ 200 ms. | M9 |
| M15-T904 | YAML schema completion and hovers; keyboard shortcuts sheet; `completion` command | `features/constitution/completion.ts`, `commands/completion.ts` | Completion of keys and enum values from JSON Schema. `?` shows shortcuts. | M9-T920 |
| M15-T905 | Pseudo-locale, RTL verification, translation contributor guide hooks | `locales/en-XA`, CI | No overflow or clipping. Logical properties only (lint). | M9 |
| M15-T906 | Wizard timing dry runs + `host transfer` + installable manifest | `wizard/*`, `commands/host.ts`, `public/manifest.webmanifest` | Wizard median ≤ 4 minutes within the A22 dry runs (≥ 40 attempts, ≥ 95% success; 13 §9.3). Fixes applied. | M14 |

---

## 11. Open questions (with recommended defaults)

| # | Question | Recommended default |
|---|---|---|
| Q-1 | Which preset should the wizard select by default? Best is the spine default and may surprise cost-sensitive hosts on $5 VPSes. | **Owner decision D-1 (15 §1); not decided here.** Until then: Best pre-selected with per-preset estimates and budgets (01 §14 A3). Revisit after M13 publishes measured costs. |
| Q-2 | Should the dashboard ever write secrets? | **Only on appliance installs** (01 §14 A29; D-29): token-gated `/setup` or host step-up, into `keys/secrets.enc`. Elsewhere use `comvivo secrets set`. |
| Q-3 | Generic forward-auth (Authelia, oauth2-proxy `Remote-User` headers)? | **Not in 1.0.** HA ingress only. Design `trustedHeaderAuth` after launch, using the same `ha_links`-style linking. |
| Q-4 | Personal REST API tokens for scripts? | **No** in 1.0. MCP tokens (10) cover agent integrations. Revisit with demand. |
| Q-5 | Should traces show "{n} items not visible to you"? | **Show the count.** It is honest and reveals no owner or kind. 03 may disable it per constitution (`traces.hideHiddenCount`). |
| Q-6 | Re-login for web-only people (no chat identity)? | Post-1.0 **passkeys** (WebAuthn) for web identities. In 1.0, a persistent "Link a chat app" banner. |
| Q-7 | Pairing codes enable code-forwarding phishing ("send me the code you see"). | **Resolved (01 §14 A9):** pairing is the default login, with the warning copy and device details in the approval message. Hosts can disable it only where magic links are allowed (D-12). |
| Q-8 | `comvivo import` for logical exports? | **Not in 1.0.** `restore` covers machine moves. Logical import arrives with the Postgres backend. |
| Q-9 | Calendar: in-house views or Schedule-X? | **In-house** (D-22). Switch the Week view to Schedule-X only if M9-T922 slips by more than 3 days. |
| Q-10 | Sign-in notifications default | **`host`** (notify only for host sessions). Quiet by default. |
| Q-11 | Session lifetime for family phones | **Resolved by 08 §3.7.12:** 12-hour idle, 7-day absolute; not raisable. Members re-login with a pairing code (or `/dashboard` where magic links are allowed). |
| Q-12 | Can the actor interleave dashboard commands during a long turn (05)? | **Yes:** commands run between model calls with `priority:'interactive'`. Until 05 confirms, the 8 s → 202 `queued` fallback covers it. |
| Q-13 | Should `/openapi.json` be public? | **Session-only** on instances. The public docs site renders the committed spec. |
| Q-14 | Should members (not admins) have dashboard access by default? | **Yes** for adult roles and teens (memory controls, traces, privacy). **No** for `child`. Configured by the `dashboard.access` capability per template (03). |
| Q-15 | Who may create new groups? | **Host only** in 1.0. Group admins can add further chats to their own group with `/comvivo addchat` (01 §14 A27, 06 §3.20.1). A `groups.create` instance setting comes later. |
| Q-16 | Should `comvivo eval run --suite smoke` ship to end users? | **Yes**, with ≤ 10 scenarios and a cost under $0.01, via the published `@comvivo/evals` loaded as an optional dependency (01 §14 A17). It validates Local models before people rely on them. |

---

## 12. Proposed spine changes

| # | Change | Rationale | Status |
|---|---|---|---|
| P-1 | Add `packages/api-client` (`@comvivo/api-client`, generated from OpenAPI). Dependency rule: `apps/dashboard → api-client` (only). `api-client → (nothing internal)`. | The spine says "dashboard → generated API client only" but gives it no home. A package lets community tools reuse it. | → Resolved: 01 §14 A11 |
| P-2 | Amend §4: "Only `engine/context` **and `engine/readmodels`** may call `MemoryRepository.search*`, both via `MemoryQueryService` (04), which applies `canRead` inside retrieval." | The memory explorer needs search. Routing it through one IFC-applying service keeps the rule's intent. | → Resolved: 01 §14 A11 |
| P-3 | Add the dependency-cruiser rule `apps/server/src/http/** ↛ @comvivo/storage` (HTTP reads and writes only through `engine/readmodels` and `engine/commands`). Add modules `engine/readmodels`, `engine/commands`, `engine/auth`, `engine/events`. | Structural enforcement of IFC and authority on the API, mirroring "policy before power". | → Accepted, owned here (rule enforced in M9-T906; dependency-cruiser enforcement per 01 §14 A11) |
| P-4 | Add capabilities `audit.read`, `usage.read` and `dashboard.access` to §7.3. | Audit and cost visibility are distinct governance decisions. Dashboard access must be configurable (children). | → Resolved: 01 §14 A6 (catalog lives in 03 §3.1.2; `usage.read` and `dashboard.access` still missing there, see the R3 review log) |
| P-5 | §5 domain model: add infrastructure entities `Session`, `LoginToken`, `Pairing`, `ClaimCode`, `InviteCode`/`LinkCode`, `StepUpChallenge`, `IdempotencyKey`, `IcsFeedToken`, `HaLink`, `DomainEvent` (02 owns the schema). | They are persisted state with retention and security properties. | → Resolved: 01 §14 A7 (lists Session, LoginToken, PairingCode, ClaimCode, ControlToken; the remaining tables are specified in §4.6 for 02) |
| P-6 | §9: "magic link … bound to the member" → "bound to the **person** and instance, delivered in a DM, token in the URL fragment, exchanged by POST". Add "pairing-code login" and "HA ingress header auth (Supervisor-only)". Clarify "CSRF tokens on mutations" as Sec-Fetch-Site/Origin checks plus a session-bound header token. | A dashboard session spans the person's groups. These refinements close link-preview consumption and proxy gaps. | → Resolved: 01 §14 A9 (pairing default; magic links on loopback or HTTPS opt-in; HA users linked via a bot code, never headers alone) |
| P-7 | §10 config: add `deployment.mode`, `dashboard.{enabled,basePath,trustProxy,ingress,sessions,auth,rateLimits}`, `api.*`, `control.enabled`, `updates.check`. | Needed for reverse proxies, HA, the CLI control channel and the opt-in update check (ADR-017). | → Accepted, owned here (§5.1; host-only keys per 01 §14 A14) |
| P-8 | §4 / ADR-015: `apps/cli` is a **thin** npm package. It loads `@comvivo/server` dynamically (installed on demand in native mode; unused in Docker mode). Allow `apps/cli → models` and `channels/*` **probe subpath exports only**. | Makes `npx <cli>@latest init` fast enough for the 5-minute target. The probes are light. | → Resolved: 01 §14 A2 (thin CLI + public server runtime) and A11 (probe entry points) |
| P-9 | §6: add a `DomainEventBus` port (post-commit events; in-process by default, SQLite-tailed when roles are split). | Required for SSE and correct under `--role=web\|worker`. | → Resolved: 01 §14 A15 |
| P-10 | Name the health contract: `GET /healthz` (liveness) and `GET /readyz` (readiness, channels excluded). | 12 (Docker, HA watchdog, Umbrel) depends on fixed paths and semantics. | → Resolved: 01 §14 A15 (contract in §3.8 = 12 §4.3) |
