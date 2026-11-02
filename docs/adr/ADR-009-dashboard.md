# ADR-009 — Dashboard

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A9** (auth: pairing by default, magic-link rules, HA linking, step-up in DM), **A11** (`packages/api-client` is generated; dashboard imports only it), **A15** (server contracts and roles), **A29** (appliance secrets entered through the token-gated setup page), **A30** (extension secrets written via the Control API)

## Context

The dashboard is not an admin console bolted onto a bot. It is one of the two primary surfaces of the product (chat is the other), and several things only exist there: the constitution editor, the memory explorer, the "Why did Village say this?" trace view, costs, fairness, consent and privacy controls, and the install/claim flow.

The constraints that decide the stack:

- **It ships inside the server.** The server is a single Node process that must also run on a Pi (ADR-001). Adding a second Node runtime for SSR would double the install surface and the memory footprint for no product gain.
- **It must be embeddable.** Home Assistant serves it behind an ingress path that is only known **at request time** (`X-Ingress-Path`), so the base path is a runtime value, not a build-time one (`09` §2 D-18).
- **It must work on a LAN with no internet.** No CDN, no webfont download, no external analytics (ADR-017).
- **It must never bypass IFC.** Every read goes through `@village/engine/readmodels` with a `GroupViewer`; rows are branded `Readable<T>`; HTTP code cannot import `@village/storage`, and the dashboard package may import **only** the generated API client (ADR-020, A11). An unreadable entity returns the same 404 as a nonexistent one (`09` §2 D-07, D-08).
- **Accessibility is a gate, not an aspiration**: WCAG 2.2 AA with axe checks in Playwright (`01` §11.11).
- **Contributor pool matters.** Dashboard work is the most parallelisable part of the project and the most likely to attract outside PRs (`15` §3 R-3).

## Decision

**A pure React SPA, served as static assets by the same server.**

| Concern | Choice |
|---|---|
| UI framework | **React 19** |
| Build | **Vite** (Rolldown), `base: './'`; the server injects `<base href>` and boot JSON per request (`09` §2 D-18) |
| Routing | **TanStack Router** (file routes, `autoCodeSplitting`), runtime `basepath` from boot JSON |
| Server state | **TanStack Query**, driven by the generated client |
| Styling | **Tailwind CSS v4** via `@tailwindcss/vite`, class-based dark mode |
| Components | **shadcn/ui** on **Radix** (`-b radix`), components copied in and themed **through CSS-variable tokens only** |
| Data access | the generated **`@village/api-client`** (openapi-typescript + openapi-fetch + openapi-react-query), plus one multiplexed **SSE** stream for live invalidation (ADR-008) |
| i18n | **i18next** + react-i18next, namespaces loaded per route; `Intl` and Temporal format in the member's locale and timezone (ADR-018) |
| Hosting | **Static assets served by the Village server.** No Node SSR runtime, no separate web service |

Design-system decisions that follow from "themeable and accessible by construction" (`09` §3.10.5):

- OKLCH token pairs for light and dark, including visibility tokens (`--vis-group`, `--vis-private`, `--vis-shared`, `--vis-sensitive`) so a privacy label always looks the same wherever it appears.
- CI computes WCAG contrast from the OKLCH values: body text ≥ 4.5:1, UI parts and focus rings ≥ 3:1.
- Theme options are **System / Light / Dark**, stored in `localStorage.theme`, with a nonce-carrying inline script setting `.dark` **before first paint** so there is no flash. In HA embedded mode the default is System.
- Density is Comfortable (default; ≥ 44 px touch targets on coarse pointers) or Compact, via a `data-density` attribute.
- The **system UI font stack** — no webfont download, so it is faster and works offline on a LAN.
- lucide-react named imports only; Recharts loaded lazily on just two screens, and **every chart has a "View as table" toggle** (`09` §2 D-21).
- The calendar views are built in-house on `temporal-polyfill` and CSS grid, because visibility chips inside events, WCAG grid semantics and theme tokens all needed to be first-class (`09` §2 D-22).

Auth, as amended by **A9** (semantics in `08`, implementation in `09`):

- **Pairing code is the default** in every exposure mode: the browser shows a code, the member sends it to the bot in a DM and taps Approve; the approval message names the browser and OS.
- **Magic links** are a second path only, allowed on loopback or over HTTPS when the host explicitly opts in; the token travels in the **URL fragment** and is exchanged by POST.
- **HA ingress users are never trusted from headers alone** — they are linked once via a bot code.
- **Sensitive actions require step-up** confirmation in the member's own DM.
- **A29:** on appliance installs the token-gated `/setup` page (and later Instance → Secrets with step-up) may write host-only secrets once into `keys/secrets.enc` — never into the database. **A30:** plugin and MCP-client secrets are written through the Control API to the `08` vault.
- Secrets are otherwise **read-only** in the UI: masked to the last 4 characters with a "Test" button (`09` §2 D-29).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Next.js** | Requires a Node SSR runtime inside the appliance, which doubles the surface that has to boot on a Pi, complicates the read-only rootfs and the single-process model, and gains nothing: there is no SEO requirement (the dashboard is private and usually loopback-only) and no first-paint-from-server requirement for an authenticated app. Its routing and base-path assumptions also fight the runtime-unknown HA ingress path. |
| **SvelteKit** | Smaller bundles and a pleasant model, but the same SSR-runtime objection applies to its node adapter, the shadcn/Radix component ecosystem we depend on for accessible primitives is weaker, and the contributor pool for a project that needs outside PRs is smaller than React's. |

## Consequences

**Good**
- One process, one port, one install. The dashboard is just files on disk next to the server.
- Works offline on a LAN with no CDN and no webfont.
- Runtime base path makes HA ingress, sub-path proxies and plain localhost the same build.
- The generated client plus the `Readable<T>` branding make an IFC bypass a **compile or CI error**, not a code-review miss.
- Token-based theming means dark mode and the privacy-visibility colours are consistent everywhere, and contrast is verified by CI rather than by eye.
- Accessibility is enforced by axe in Playwright, so a regression fails the build.

**Bad / accepted costs**
- An SPA pays a client-side bundle cost and must manage its own loading and error states on every screen; size budgets (`size-limit`) exist for this reason.
- No server rendering means first paint is JS-dependent; mitigated by code splitting, boot JSON injection and the pre-paint theme script.
- A copied-in component library (shadcn) is ours to maintain: upstream fixes do not arrive by `pnpm update`.
- Building the calendar views in-house is real work, with Schedule-X documented as the fallback if the Week view slips.
- Charts and the YAML editor are heavy dependencies, so both are lazy-loaded and confined to specific routes.

**Follow-ups**
- `M9` — the dashboard, API and CLI milestone (`09`) owns every screen, the generated client and the auth flows.
- `M9-T34` — CLI rows and packaging items folded in from the alignment pass.
- `M12-T18` — MCP token UX in the dashboard.
- `M13-T29` — fresh-user dry runs that measure time-to-first-value (A22: ≥ 40 attempts, ≥ 95% success).

## References
- `docs/plan/01-architecture.md` §2 ADR-009, §9, §11.11, §14 A9, A11, A15, A29, A30
- `docs/plan/09-dashboard-api-cli.md` §2 D-03, D-07, D-08, D-10, D-18, D-19, D-20…D-24, D-29; §2.1 (verified versions); §3.10.5 (design system)
- `docs/plan/08-security-privacy.md` §12 PSC-6, PSC-7
