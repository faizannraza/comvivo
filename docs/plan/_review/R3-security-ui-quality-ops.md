# R3 review log: security, UI, quality, ops (08, 09, 11, 12, 13)

Reviewer scope: consistency of `08`, `09`, `11`, `12` and `13` with `01` §14 (A1–A28), `15` §1–§2 and with each other. Only these five files were edited. Owner decisions D-1…D-8 were not decided; places that had decided them were re-marked as owner decisions.

## (a) Fixes made

### 08 — Security & privacy
1. SD-07, §3.7.11: `VBK1` now has slots for the derived backup key, the recovery key and an **optional passphrase** (A10); archive extension aligned to `.vbak` (as in 02/12).
2. SD-09: dashboard login rewritten to A9 (pairing default; magic links only on loopback or HTTPS with explicit opt-in, fragment + POST; HA users linked via a bot code, never headers alone; step-up in DM).
3. SD-19, §3.15 "Containers"/"SBOM", M14-T81/T82: SBOM and signing aligned with 12 (BuildKit attestations off; `actions/attest` provenance + Syft SBOM per image digest; `pnpm sbom` per npm package; cosign `--recursive`; verify regex now `release.yml@refs/heads/(main|release/.+)`).
4. T-S02: group binding only via single-use 30-minute claim code (A27).
5. T-S03 + §3.7.12: instance claim token (`vclaim_`, 1 h) replaced with the host claim code shapes shared with 09/06 (typed `VLG-…` 40-bit attempt-limited + 128-bit link token; 30 min; burned after 10 failures).
6. §3.3 compromised-account controls: nonexistent `village members freeze` → `village sessions revoke --person` + `village mcp token revoke --person`.
7. S8: added the sole exception for host-enabled HTTPS magic links (A9), with residual risk documented.
8. §3.7.3: "the wizard asks for the storage mode" → keyfile default plus `village init --key-store <mode>`.
9. §3.7.6: `--save-to` → `--recovery-key-out` (09's flag).
10. §3.7.7: `village tokens revoke --all-pats` → `village mcp token revoke --all` (10); note that online key ops go through the Control API.
11. §3.7.8: `restore <file.vbk> --recovery-key` (secret as a flag value) → `restore <file.vbak> --recovery-key-file <path>`.
12. §3.7.12 token table: pairing command `/login` → `/pair` with 5-per-15-min limit; magic link limited to A9 modes and `bind` dropped; session cookie adds `__Secure-` sub-path variant; PAT row replaced by the 10 `vmcp_` MCP token; added control token (`vctl_`) row.
13. §3.7.12 login flows: pairing deep link `start=pair_CODE`; magic-link paragraph rewritten to A9; new HA ingress (mode H) paragraph.
14. §3.8.1: exposure table states magic-link availability per mode; added **mode H (HA ingress)**; `trustProxy` example made a CIDR list.
15. §3.8.4: documented the HA ingress `frame-ancestors 'self'`/`SAMEORIGIN` exception used by 09 §3.10.11.
16. §3.8.7: step-up list unified with 09 §3.9.8 (identical lists both sides).
17. §3.8.8: rate limits aligned to 09 §3.7 numbers and class names (09 normative for numbers).
18. §3.8.10, M14-T85: Docker UID 10001 → non-root 1000:1000 default (12 P7); systemd exposure target ≤ 2.5 (= 12 M14-T11).
19. §3.10 redaction prefixes: `vpat_`/`vclaim_` → `vmcp_`, `vctl_`, `VLG-`.
20. §3.10 doctor table: added a "09 id" column mapping D-01…D-16 to the single 09 registry; D-06 48 h → 36 h; D-14 adds fail > 5 min; D-08 adds Node < 24.11 fail.
21. §3.10, SD-22, §3.17, M9-T85: `village doctor --report` → `--bundle` (09/11/12 name).
22. §3.11.1 and §3.16.3: update check uses `release-manifest.json` and a generic User-Agent (no version), per 12.
23. §3.11.4: nonexistent `village config privacy` → `village config set privacy.…`.
24. §3.14, §6: `village plugins approve`/`review` → `village plugin add`/`update` (10).
25. §3.15 pnpm block: `allowBuilds` aligned with 12's dependency facts (matrix crypto only; ORT explicitly denied).
26. §3.15 CI table: workflow file names added, DAST trigger/gate aligned with 11 (`security-dast.yml`, `.zap/rules.tsv`), Grype and Jazzer rows added; required checks point to 11 §3.8.3.
27. §3.16.2: TurnTrace retention 30 d → 90 d (`traces.retentionDays`, 11); backups row now shows 12's GFS tiers; Privacy & Trust page text updated accordingly (it said "about two weeks").
28. §3.18 SECURITY.md supported versions aligned with 12 §3.10.6; "HA add-on" → "Home Assistant app".
29. §3.21, M15-T80, SECURITY.md scope link: docs paths moved to 13's IA (`/trust/…`, `/operate/…`).
30. §4: `TokenKind` adds `control`; `ExposureMode` adds `ha-ingress` and `magicLinksAllowed`; `DoctorCheck` uses 09's registry shape.
31. §5: `security.sessions`/`security.login` merged into 09's `dashboard.sessions`/`dashboard.auth` (one namespace); `magicLinks: auto|https|off`; `trustProxy` type aligned; ingress keys added; `privacy.traceRetentionDays` → `traces.retentionDays`.
32. §9 `dast.zap.*` gate and M9-T84 workflow name aligned with 11; M13-T80 split (fuzz here, red-team in 11's workflows).
33. §11 OQ-1, OQ-2 marked resolved (A9, A8); OQ-6 re-marked as owner decision D-6.
34. §12: Status added to PSC-1…PSC-12.

### 09 — Dashboard, API, CLI
35. §1.1, D-11/D-12: pairing is the default login; magic links only on loopback or HTTPS opt-in (A9).
36. D-13, §3.9.1, §3.9.5, §5.1, Q-11: session lifetimes 7 d idle / 30 d absolute → 12 h / 7 d (08 owns the semantics).
37. D-14, §3.9.6, §3.9.2: cookie names `village_sid`/`village_pair` → `village_session`/`village_pending` (08 §3.7.12).
38. D-17, §3.9.1, §3.9.4, wizard step 9, non-interactive example: host and group claim code shapes aligned with 06/08; group claim TTL ≤ 24 h → 30 min (A27); admins may add chats via `/village addchat`; `village group claim` gains `--channel`/`--group` (requested by 06).
39. D-19, §3.9.10, §3.10.6.1, §7, M14-T903: HA headers never authenticate alone; linking via a bot pairing code (A9 wording identical to 08).
40. D-26, §1.1, §3.11 header, wizard example: `village` npm name marked as placeholder (A2); public server runtime per 12.
41. D-27, §3.5, §3.8: `/healthz` unified with 12 §4.3 (`ok|starting|degraded` 200, `draining|fail` 503; recovery mode = 200 degraded); Docker healthcheck = `/app/healthcheck.mjs`.
42. §3.1 boot JSON, `/meta`, `/auth/magic/exchange`, `/auth/pairing`: magic-link availability flag; mounting conditional.
43. §3.5 route table: capability names aligned to 03 §3.1.2 (`tasks.read`, `lists.read`, `plans.read`, `decisions.read`, `fairness.ledger.read`, `polls.vote`, `proposals.vote`, `members.invite`, `constitution.read`, `profile.self`); member role change/removal and ratify now `S+R` (08 step-up list); private ICS feeds need recent auth; host-only keys return 403 `host_only`.
44. §3.5 Control API: added `/backups/ha-snapshot` and `/db/checkpoint` (replaces 12's control socket); claim-code TTL ≤ 30.
45. §3.7: added `unauth` and `auth.stepup` classes; table declared normative for 08 §3.8.8.
46. §3.9.1: credential inventory restated from 08 §3.7.12 (magic link `vml1.`, pairing `XXXX-XXXX`/10 min, session `vs1_`, CSRF derivation, control `vctl_`, ICS `vics_` 256-bit; link code 10 min vs invite 72 h).
47. §3.9.2–3.9.3: magic-link availability step; pairing code/TTL/cookie aligned; `pairingCodes:false` only where magic links exist.
48. §3.9.8: step-up route list unified with 08 §3.8.7.
49. §3.10.6.1: `/login` puts the pairing card first; magic-link card only when allowed; `/setup` accepts `VLG-` and the app-store setup token.
50. §3.10.11, §3.11.4, §5.2, F7: HA "add-on" → "app"; ingress port 8099 confirmed for 12.
51. §3.11.1, §3.11.4, wizard step 1, doctor `runtime.node`, `village version`: server Node ≥ 24.11, Node 26 primary (A1).
52. §3.11.2: version-skew copy uses `{cli}`; exit-code table scoped to CLI commands, server process codes delegated to 12 §4.2.
53. §3.11.3 commands table: removed `keys show-recovery` (contradicted 08 SD-04) and `keys rotate`; added 08's `keys` subcommands, `--key-store`, `--from-env`, `--restore`, test-mode `--channels simulator --preset fake` (13), `start --recovery/--allow-downgrade/--insecure-permissions/--role drill`, `doctor --check/--bundle/--print/--deep`, backup `prune/rewrap/decrypt/--label/verify` variants, `restore --drill`, `update --check/--channel`, and rows for `runtime`, `models`, `recovery`, `db checkpoint`, `selftest`, `service start|stop|status`, `plugin …` (10's set), `skill`/`mcp client`/`mcp token`, `eval run|replay|…|challenge` (A17 dynamic import), `bench`, `feedback`.
54. Wizard step 3: estimates shown before choosing from 05 §8 (no more "cost shown after setup"); Best pre-selected per A3 and marked owner decision D-1; added 08 §3.11.4 disclosures and D-6 note.
55. Wizard step 5: recovery-key confirmation = retype groups 3 and 11 (08 §3.7.6); removed "print it later" promise.
56. Wizard step 6: hard-coded $20/$2 replaced by per-preset defaults (A3) and `budgets.preset: auto`.
57. Wizard step 7: added the opt-in update-check question (12 §3.4.4); step 10 Ctrl+C points to `village init`.
58. §3.11.6 doctor: declared the single registry for 08/11/12 checks; added `info` status, `security.*` row; `time.clock` 60 s → 30 s warn; `backups.recent` 48 h → 36 h.
59. §4.6: `login_tokens` uses `jti`; `claim_codes` gains `linkTokenHash`, `channel`, `groupId`; sessions drop `csrfSecret` (derived).
60. §4.9: requests to 03/08/10/12 updated (capability catalog gap noted).
61. §5.1: config constraints for sessions, `magicLinks`, `pairingCodes`.
62. §5.2: added `VILLAGE_SETUP_TOKEN` and 12's image/ops env vars.
63. §5.3: host-only keys (A14) explicitly file/env-only; dashboard preset changes limited to already-configured providers.
64. §7 Headers: CSP/frame headers delegated to 08 §3.8.4 (they contradicted it); `style-src-attr 'unsafe-inline'` only via ADR.
65. §9 Evals, M15-T906: TTFV per A22 (≥40 attempts, ≥95%).
66. M3-T904, M9-T904, M9-T929, M14-T903: acceptance criteria updated for claim shapes, A9 modes, no recovery-key display, HA linking.
67. §11 Q-1 → D-1; Q-7, Q-11 resolved; Q-15 notes `/village addchat`; Q-16 → A17.
68. §12: Status added to P-1…P-10.

### 11 — Quality, evals, observability
69. §1.1 table, §3.6 S6 definitions, Q13: "unsolicited" = class `proactive` (A22/A24).
70. §1.1, §3.9.1 B6, Q9: idle RSS = 10 min after the last turn, embedder unloaded (A22).
71. §1.1, §3.12 M15 row, §3.13.6, M15-T2: TTFV method ≥ 40 attempts, ≥ 95% success, median ≤ 5 min (A22); `npx` placeholder note (A2).
72. §3.8.1: `security-dast.yml` triggers aligned with 08; added rows for 08's security workflows, 12's release workflows (incl. `build-reusable.yml`) and 13's docs workflows (single CI inventory).
73. §3.8.2: Node 26 primary with a `node24` job (A1); added 12's `packaging` job to `ci.yml`.
74. §3.8.3: required checks now name 08's blocking checks (`codeql`, `osv-scanner`, `dependency-review`, `supply-policy`) and conditionally required `zizmor`/`security-dast`.
75. §3.8.6: OpenAPI path `/api/openapi.json` → `/api/v1/openapi.json`; ZAP gate wording equals 08's.
76. §3.8.4, Q2: docs site is on Cloudflare Pages (13), main repo Pages serves only the release manifest (12).
77. §3.9.1 B5: cold start measured to `/readyz` (liveness `/healthz` is not readiness).
78. §3.10.1, §5: file logging off by default and `maxSizeMiB`, same key/default as 12 §5.
79. §3.10.3: `/metrics` on the dashboard listener only (12 had a separate 9464 port); added the 4 series 12 needs.
80. §3.11 doctor: exit codes and `--fix` per 09 (was 0/1/2 and `--fix-safe`); thresholds for disk, outbox, clock, backups now defer to 09.
81. §4.7: added `village eval challenge` (13 D10); doctor flags match 09.
82. M0-T4: setup action Node 26 + `node24` leg.
83. §12: Status added to items 1–11.

### 12 — Packaging, release, ops
84. Header: placeholders `DOCS_DOMAIN` and the `npx` placeholder (A2).
85. P1, §3.2.1, Dockerfile, §3.2.7, M14-T1, Q3, §3.10.6: base image `node:26-trixie-slim`, fallback `node:24-trixie-slim` only if the M14-T1 matrix fails (A1).
86. P11, §3.12 beta checklist, M12-T90: `@village/evals` added to the public packages (A17; five packages).
87. §3.1 names.json, Umbrel/CasaOS/Unraid/systemd URLs: docs URL → Cloudflare `DOCS_DOMAIN` (13 D5); release manifest stays on the main repo's GitHub Pages (no request logs, 13 §3.G).
88. §3.2.5, §3.5 backups, §3.7, §4.9: control socket removed; ops use 09's Control API (09 D-04 rejected Unix sockets).
89. §3.2.5 health, §3.8.5, §4.3: `/healthz` contract unified with 09 (draining added; recovery mode = 200 degraded so watchdogs don't restart-loop).
90. §3.3, §4.4, §5: `VILLAGE_TRUSTED_PROXIES`/`trustedProxies` → `VILLAGE_TRUST_PROXY`/`trustProxy` (09); `GOOGLE_API_KEY` → `GEMINI_API_KEY` (05); `EMAIL_IMAP_PASSWORD` → `VILLAGE_IMAP_PASSWORD` (08).
91. §3.4.2: `/readyz` wait 120 s → 180 s (09); no-Node path and non-interactive flags aligned with 09 (`init /work`, no `--out`).
92. §3.5 HA: ingress port 7777 → 8099 and watchdog on 8099 (09 D-19); HA options default `model_preset: balanced` + `$20` → `best` + per-preset budget (A3); retention max 3650 → 365 (08 ceiling); `google_api_key` → `gemini_api_key`; budget mapping → `budgets.monthlyUsd`; main listener on loopback; auth paragraph and DOCS.md step rewritten to A9 (pairing link, never headers alone).
93. §3.6.5: systemd `--foreground` (nonexistent flag) removed; `ProtectHome=read-only` → `yes` (08 §3.8.10).
94. §3.7: `keys/` contents aligned with 08 keyring (no `retired/` dir); key files readable by group/world now refuse start (08), others auto-tighten.
95. §3.9: "key-backup reminders"/`village keys backup` (contradicted A10) → recovery-key verification reminders with 08's 180-day cadence.
96. §3.10.4: `ci.yml` description aligned with 11; added `build-reusable.yml` (SLSA L3, 08) and `repro.yml` (08 M14-T83); `docs-deploy` publishes the manifest to GitHub Pages.
97. §3.10.5: security fix targets aligned with 08 §3.18 (was 7 d high / 48 h critical).
98. §3.11.4: metrics port aligned with 11; `village_turns_total` labels aligned.
99. Runbooks R1–R7: commands aligned with 09/08 (`doctor --check`, `sessions revoke --all`, `keys rotate-*`, `purge-retired`, recovery key instead of "retired key").
100. §3.12: recovery-key reminder; 1.0 TTFV gate per A22.
101. §4.1: ops command semantics aligned with 08/09 (keys set, `update --check`, restore flags, doctor flags).
102. §4.2: exit codes scoped to the server process; 64 removed (CLI usage = 2 in 09).
103. §6 F21, M0-T90, M0-T93 (pnpm ≥ 11, allowlist = 08), M8-T91, M14-T8, M14-T9: acceptance criteria aligned.
104. §11 Q1 → D-2; Q3, Q4 resolved (A1, A9).
105. §12: Status added to items 1–10 (§12-6 `secrets.enc` deferred).

### 13 — Docs, launch, community
106. D1, §3.A.5, M12-T4, Q1: naming deadline M8 exit (A2/D-2); M12 only as owner-approved contingency.
107. D3, Q2, Q6: marked owner decisions D-3 and D-7.
108. D5, §3.G, §4.8: release manifest hosted on main repo GitHub Pages (not the docs site), consistent with 12.
109. D21, P6: Umami docs analytics cited as ADR-022 (A21); P6 said "ADR-021", which is MCP.
110. README Docker quickstart: nonexistent `deploy/compose/docker-compose.yml` + `docker compose run` (would fail on `VILLAGE_VERSION`) → 12's no-Node `docker run … init /work --mode docker`.
111. README cost line: "$2/day and $20/month by default" → per-preset caps and wizard estimate (A3).
112. README "Works with": Node 24 → Node 26 (or 24.11+); "Home Assistant add-on" → "app" (also IA, G11, T−1d, venue rows, r/selfhosted and HA post copy, 3.A.4).
113. IA `/operate/dashboard-access/`: pairing default, magic links per A9, HA linking.
114. Troubleshooting seeds: Node thresholds (22.12 CLI / 24.11 native); "lost master key = unrecoverable" corrected to recovery-key restore (A10).
115. G2: includes 08's pre-1.0 external security review (launch gates 11/13/08 consistent).
116. `doctor --report` → `doctor --bundle` in beta loop, saved replies, CONTRIBUTING, bug form, dogfooding, §4.8, §7.
117. CONTRIBUTING setup: Node 26 (24.11+), pnpm via `packageManager`, no Corepack.
118. §4.4, §9.2: docs-test and quickstart-matrix containers `node:26-slim` (+ 24); init flags `--channels simulator --preset fake` (now defined in 09).
119. Q10: Balanced recommendation re-marked as input to owner decision D-1; current plan Best pre-selected (A3).
120. §12: Status added to P1–P9.

## (b) Cross-cluster issues found but not fixed

| # | File & section | Problem | Recommended fix |
|---|---|---|---|
| X1 | `03` §3.1.2 (catalog), §3.1.3–3.1.4 | A6 requires `usage.read`, `dashboard.access` (09), `extensions.manage`, `mcp.connect` (10) and `participate` (07). None are in the catalog; 09's routes and 10's token verifier use them. | Add the five capabilities with meanings, bundle membership and the role matrix row (`dashboard.access` granted to adults and teens, not `child`; `usage.read` admin by default). |
| X2 | `02` D19, §3.14 (`.vbak` header), M1-T23, `backups.passphraseSlot` | Backup slots are "master-derived + optional Argon2id passphrase"; **no recovery-key slot** (A10 violation). Argon2id via libsodium contradicts 08 SD-01 (libsodium only for secretstream; slot KDF is scrypt). Payload `keys.json` holds `dbKeyHex`; 08 §3.7.11 carries a keyring snapshot. No `VBK1` magic. | Adopt 08 §3.7.11 verbatim: `VBK1` magic, slots `backup-kek` + `recovery` + optional `passphrase` (scrypt), keyring snapshot; keep `.vbak` extension and sidecar. |
| X3 | `02` §3.x key/backup CLI mentions (`keys rotate-db`, `keys export-db-key`, `keys rotate-blob-kek`, `keys doctor`, `restore --pre-migration latest`) | Commands don't exist in 09/08 (08 defines `keys rotate-master|rotate-data|…`; 12/09 use `restore pre-migrate:latest`). `export-db-key` is said to be "gated by 08" but 08 doesn't define it. | Map to 08's set (`rotate-data` covers DB and blob KEK rotation), use `doctor` and `restore pre-migrate:latest`; if `export-db-key` is wanted, 08 must specify it and 09 must list it. |
| X4 | `02` `sessions` schema (`csrfSecret`, "HMAC(csrfSecret,…)"), `login_tokens.tokenHash` | 08/09 now derive CSRF from the token-MAC key + session digest (nothing stored) and magic links use a `jti` row. | Drop `csrfSecret`, store `jti`/`consumedAt`; add `claim_codes.linkTokenHash/channel/groupId` (09 §4.6). |
| X5 | `05` §5 config (`budgets.defaultMonthlyUsd: 20`, `defaultDailyUsd: 2`) | Contradicts A3 per-preset budgets and 01 §10 `budgets: { preset: auto } | { monthlyUsd, dailyUsd }`. | Replace with `budgets.preset: auto` + per-preset table (Best $75/$4, Balanced $40/$2, Economy $5/$0.30, Local $0). |
| X6 | `00` §6.1 Dashboard, §6.1 Packaging, §7 TTFV | Still says "Magic-link login sent by the bot", "Home Assistant add-on", `npx village@latest init` and "3 fresh users". | Update to A9 (pairing default), HA "app", A2 placeholder, A22 method. |
| X7 | `01` §3 layout comment (`# HA add-on`), §12 M9 ("Magic-link auth"), M14 ("HA add-on") | Superseded wording in the spine body (A9, ADR-015 "apps"). | Spine owner: change to "pairing-code auth (magic links per §9)" and "HA app". |
| X8 | `10` §3.7.3 (MCP tokens) | 08/09 now reference `village mcp token revoke --person <id>|--all` and `list`; 10 only defines `create` and says "the host can revoke any token". Per-token rate limit number is unspecified (08 uses 120/min). | Define `village mcp token list|revoke [--person|--all]` and the per-token limit. |
| X9 | `06` §A (channel contract) | 08 PSC-9 asks for `linkPreviewControl`, `massMentionTokens` and `InboundEnvelope` `isBot`; 08 S4–S6 gates depend on them, but 06 §A is authoritative (A26). | 06 to adopt them (or equivalent) and confirm. |
| X10 | `06`/`07` email ingestion | IMAP password env var is unnamed; 08 and now 12 use `VILLAGE_IMAP_PASSWORD`. | Name it explicitly in the email-ingestion config section. |
| X11 | `14-milestones.md` (not reviewed here) | New/renamed tasks and commands from this pass: 09 CLI rows (runtime, models, recovery, db checkpoint, mcp token, eval challenge), 12 `build-reusable.yml`/`repro.yml`, 11 `node24`/`packaging` jobs, TTFV rounds starting M13. | Consolidate with doc-prefixed IDs (A20). |
| X12 | `12` §12-6 / `08` vault (needs spine decision) | Appliance installs (Umbrel/CasaOS) have no terminal; 12 proposed `keys/secrets.enc` entered via web setup. That conflicts with A14 (provider keys env/YAML only) and 09 D-29. Marked Deferred. | Spine owner decides: either allow 08's vault as a host-only secret source written only during the setup-token-gated first run, or require platform env UIs. |

## (c) Remaining risks

- **S8 exception.** HTTPS magic links (A9 opt-in) let a platform-observed or forwarded link create a remote session; documented in 08 S8/D-07, but hosts may enable it casually. Consider a doctor warning that stays visible in the dashboard.
- **Session lifetime UX.** Moving 09 to 08's 12 h idle / 7 d absolute means phone users re-pair often; dry-run feedback (A22 rounds) should check whether this hurts the beta. Changing it needs an 08 decision, not a 09 edit.
- **Health semantics.** Treating recovery mode as liveness-200 avoids restart loops but means Docker shows "healthy" while the instance is down; monitors must alert on `degraded`/`/readyz`, as 12 §3.11.4 says.
- **CSP vs Radix.** 09 previously relied on `style-src-attr 'unsafe-inline'`; under 08's strict CSP the M9 Playwright CSP tests may fail and force an ADR.
- **Capability catalog gap (X1)** blocks 09 route metadata and 10 token checks until 03 adds the capabilities.
- **Backup format (X2)** is the largest open contradiction: until 02 adopts `VBK1` with a recovery slot, A10's "restorable with the recovery key alone" is not implementable from 02's spec.
- **Node 26 base image** is new (Active LTS since 2026-10-28); the M14-T1 matrix may force the documented Node 24 fallback.
- **Owner decisions** D-1 (preset), D-2 (name, M8 deadline), D-3 (public at M8), D-6 (Hybrid pre-select) and D-7 (community home) remain open; the docs now say so where they had pre-decided them.
