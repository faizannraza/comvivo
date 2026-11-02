# R4 — Final cross-document alignment (02–13)

Reviewer: principal-engineer alignment pass, 2026-11-01. Baseline: `01` §14 A1–A29 (normative), `15` §1–§2, and the open cross-cluster items in R1 §(b) C1–C26, R2 §(b) and R3 §(b) X1–X12. Only `02`–`13` were edited. `00`, `01`, `14`, `15` and `CLAUDE.md` were not touched; what they need is in §(b). Owner decisions D-1..D-8 were not decided. No task was renumbered or deleted; new tasks use non-colliding IDs (`02`:M12-T70, `07`:M7-T70, `07`:M8-T70).

**Coordinator decisions applied** (D1–D7 below refer to the coordinator's numbered decisions):

| # | Decision | Where it now holds |
|---|---|---|
| D1 | Load ledger defaults to own-only; group-visible views are explicit opt-in. 03's enum spelling is `self_only` (the coordinator's "`self`") | 03 schema default + all 8 templates; 07 §3.3, §5, §7, Q14; 09 fairness tab + M9-T911; 13 README/IA/G3 |
| D2 | TurnTrace retention 30 d default (`traces.retentionDays`, 7–365), manifests never content | 08 (reverted R3's 90 d), 11, 05, 02, 09 |
| D3 | MCP: 08 owns token format/crypto; 10 owns transport/endpoint; `/mcp` on the **main listener** (10 had no concrete reason for 7778 that a path-scoped tunnel rule does not cover); `mcpServer.roles` removed in favour of `mcp.connect` + `lockToConstitution` | 08 §3.7.12/§3.14/§3.8.8, 09 route table/CLI/listeners, 10 §3.3.5/§3.7/§5/§7/M12-T11, 12 Umbrel/exposure |
| D4 | ICS: 07 owns semantics (per-member 256-bit `vics_`, SHA-256 at rest, revoked on leave, DM-only delivery, route `/ics/v1/{token}.ics`); 09 mounts with 02/07 fields | 07 §3.1.1/§3.1.5/§4.4/M7-T8, 09 §3.5/§4.6/M9-T911, 08 §3.7.12/§3.8.11, 02 |
| D5 | 09 uses the eligible-label-id set (no `ReaderPrefilter`); claim TTL 30 min; claim/link formats owned by 06 (§3.20.1/§3.18.1 — 06 has no "§C"; the format owner is §3.20.1) | 09 §3.3/§3.7/§4.6/§4.9, 06 §3.20.1, 08 §3.7.12, 02 |
| D6 | 07 adopts 03's action kinds, constraint kinds, fairness port/strategy names, `proposed` statuses, `Task.category`, `BallotPresenter`/`ProposalService` | 07 throughout (§3.1–§3.6, §4.1, §4.2, §5, §9, §10); 03 §3.3.1 + M4-T2; 05 catalog re-verified (all 62 names match) |
| D7 | 08 `keyringSnapshot.static.blobId`; 06 reactions → `message_reactions`; 05 guard input = 03 `GuardInput`; 04 MCP memory writes → `proposed`; 07 plugin digest-section hook; 08↔10 manifest/launch flags | 08 §3.7.11, 06 §3.9, 05 §3.3.8, 04 §3.9.7, 07 §3.9.2/§4.2/M8-T70, 08 §3.14 ↔ 10 §3.3.1/§3.4.2 |

**Grep sweep (02–13) results:** `PendingConfirmation` (only historical rename notes remain); `$20`/`defaultMonthlyUsd` (none left; remaining `$20` hits are eval caps and model prices); `Node 24 LTS` as primary (none; only "supported / degrade" mentions); `add-on` (only "formerly add-ons" history); magic link as default (fixed in 10 §3.7.3/M12-T12 and 11 E2E specs); `sodium-native` as default (none); attachment download at ingest (wording fixed in 02 §4.1 and 06 M3-T12); capability names vs 03 §3.1.2 (none outside the catalog — hits were action kinds, keys or the intentional `calendar.delete` error example); tool names vs 05 §3.6.7 (all 62 + `web_search` match 03/04/07/10; but `memory_pin`, `use_skill`, `read_skill_file` and `web_search` had no 03 ActionKind — registered).

## (a) Fixes made (101)

### 02-domain-model-and-storage.md (5)
1. **§3.13 retention table, §5 config row, Q9, P5** — key `privacy.traceRetentionDays` (1–365) → `traces.retentionDays` (7–365, owned by 11); content-free stated [D2]
2. **§3.3.5 `ics_feed_tokens`, rotations comments** — ICS table notes 07 ownership and that 09 uses `scope`/`detail`; rotation strategy comment updated
3. **§3.6.1 key tree, §3.14 VBK1 notes** — "08 to confirm/registers" notes now cite 08 §3.7.11/§3.7.2 [R1 C18]
4. **§4.1 exposed, §10 (new M12-T70)** — `@village/storage/memory` browser-safe repositories for 13's demo, with acceptance criteria and an SP-10 WASM-SQLite alternative [R1 C25]
5. **§4.1 `BlobStorePort` consumers** — "ingestion media path" → `attachment.fetch`/`media.*` jobs, never the ingest tx (A25) [sweep: attachment download]

### 03-group-intelligence.md (5)
6. **§3.2.2 schema** — `fairness.ledgerVisibility` default `everyone` → `self_only` [D1]
7. **§3.2.9 archetype table + all 8 template YAMLs** — `ledgerVisibility` → `self_only` (was everyone ×5, admins, off); new "Ledger visibility" paragraph: group-visible views only via privacy-reducing amendment [D1, R1 (c), R2 03]
8. **§3.3.1 Canonical names** — notes that 07 now uses registry names verbatim; mapping kept as history [D6]
9. **§10 M4-T2 acceptance** — cross-check is per (tool, op, taint) case, since 07 tools emit per-op registry kinds (was "each tool maps to exactly one kind") [D6]
10. **§3.3.1 registry** — added write kind `memory.item.pin` (04 `memory_pin`) and read kinds `skill.use`, `skill.file.read`, `web.search`, which had no registry entry and would fail M4-T2 [sweep: tool names vs registry]

### 04-memory-system.md (1)
11. **§3.9.7 `memory_remember` row** — every memory write via MCP (`via:'mcp'`) creates a `proposed` item (`memory.note.propose`), activated by the member in DM/dashboard; removed the "MCP remember is explicit and active" exception that contradicted 10 §3.7.4 [D7, R2 04]

### 05-agent-runtime.md (5)
12. **§3.3.8 step 2, §3.7.2 recovery pseudo-code, §4.3 consumed table, M5-T4** — DisclosureGuard.check takes 03 §3.6.1 GuardInput (draft/audience/snapshot/trigger/readableContext/sealed/strictness/kind) and returns GuardOutcome pass/redact/regenerate/fallback/drop (was {draft,plain,audience,sealed,usedLabels,turnId} + pass/redact/block) [D7, R1 C22]
13. **§3.10.1 Retention** — states default 30, range 7–365, manifests never content, owners 11/08 [D2]
14. **§3.6.7 block 10** — owner ref `03 §3.0` → `03 §3.3.13` (governance/privacy tool table)
15. **§3.6.7 runtime tools table** — ActionKinds named (`settings.read`, `settings.update`, `member.list`, all in 03 §3.3.1) [sweep]
16. **§4.3 ContextBuilder row** — `TurnContext` lists `readableContext` (03 `SealedSafeView`) needed by `GuardInput` [D7]

### 06-channels.md (9)
17. **§3.9 Reactions** — inbound reactions by known members on bound-chat messages are persisted to 02 `message_reactions` in the ingest tx (label/retention follow the message; consent-filtered by 04); `observeReactions` default flipped false → true so 04 windows receive them (host can opt out) [D7, R1 C20]
18. **§3.20.1 Created by** — `--channel`/`--group` now exist in 09; "requested from 09" caveat removed [R2 06↔09]
19. **§3.20.1 (new bullet)** — "Format ownership": 06 is the single owner of claim and link code formats; 02/08/09 restate verbatim [D5]
20. **§3.20.1 Stored / Redemption rules** — `ClaimCode` fields = 02 `claim_codes` (kind, failedAttempts, usedByPersonId); per-code burn after 10 failures added; counters in 02 `rate_limits` [D5, R1 C21]
21. **§3.18.1 Abuse limits** — link-code counters stored in 02 `rate_limits` (named keys) [R1 C21]
22. **§4.1 ChannelCapabilities / InboundEnvelope** — adopted 08 PSC-9: `linkPreviewControl`, `massMentionTokens`; `isBot` ≡ `senderKind==='bot'` [R3 X9]
23. **§5.1 Secrets table** — added `VILLAGE_IMAP_PASSWORD` (`_FILE`) for email ingestion, host-only, A29 appliance path [R3 X10]
24. **§5.1 config, §11 Q17** — `observeReactions` default true with rationale; data-minimal opt-out [D7]
25. **§10 M3-T12 deps** — blob writes only from the `attachment.fetch` job (A25) [sweep: attachment download]

### 07-coordination-features.md (29)
26. **§3.1.1 Event** — `status` gains `proposed` (03 `calendar.event.propose`, endorsed via `calendar.event.confirm`) [D6, R1 C5]
27. **§3.1.1 FeedToken** — states the owned ICS semantics: per-member 256-bit `vics_` token, SHA-256 at rest in 02 `ics_feed_tokens`, revoked on leave/removal, DM-only delivery [D4, R1 C10]
28. **§3.1.2 step 4** — `availability.unavailable{…strength}` → 03 `availability.busy` + `schedule.do_not_schedule` (hard) and `preference.flag` (soft) [D6, R1 C2]
29. **§3.1.3 tool 3** — under taint emits `calendar.event.propose` (03 taint allowlist) instead of escalating to high (which 03 would deny) [D6, 03 §3.10.2]
30. **§3.1.3 tool 5, §4.1 row 5** — `calendar.event.cancel` → `calendar.event.delete` [D6, R1 C1]
31. **§3.1.5** — route mounted by 09 with 02 fields; `vics_` token; same-tx revocation on leave/removal; new Delivery bullet (DM only; dashboard shows "sent to your DM"; no token if DM unreachable) [D4]
32. **§3.1.6** — new bullet: built-in subscriptions vs opt-in `ics` plugin; no double subscription; own feed URLs refused [R2 07↔10]
33. **§3.3.1 Task/Rotation** — `Task.category` added; Task `status` gains `proposed`; `Rotation.strategy` `fair` → `least_loaded`; template carries `category` [D6, R1 C4/C5]
34. **§3.3.2** — `FairnessPort` replaced by 03 §3.9.2 signature verbatim (`AssignTask`, `AssignmentResult` union, port resolves constraints itself); `no_eligible` handling; materializer `least_loaded`; explanation default `self_only` [D6, D1, R1 C3]
35. **§3.3.3 tools 13/16** — `task.propose` under taint; `task.reassign` / `task.assign.fair` kinds [D6]
36. **§3.3.3 tool 19** — strategy enum/description `least_loaded`; kind → `rotation.create`/`rotation.update`/`rotation.delete` [D6, R1 C1/C4]
37. **§3.3.3 tools 20/21** — kinds → `task.swap.request` / `task.cover.request` (give_away) / `task.swap.respond` [D6, R1 C1]
38. **§3.3.4, §7, §11 Q14** — ledger visibility text: every template `self_only`, group-visible only by explicit opt-in; Q14 marked resolved [D1]
39. **§3.4.2** — `system.lists.autocapture` → SystemActionKind `lists.autocapture` [R1 C9]
40. **§3.4.3 tools 23/25/26, §4.1 rows** — `list.items.add`/`list.items.update`/`list.manage` → per-op 03 kinds (`list.item.add/check/uncheck/remove/update`, `list.create`/`list.update`) [D6, R1 C1]
41. **§3.5.3** — proposals hook uses 03 `BallotPresenter.openForProposal(proposalId, BallotSpec, ConversationRef)` / `update` / `close` and `ProposalService.castVote`/`resolveProposal(id, reported, uow)` [D6, R1 C7]
42. **§3.5.4 tool 29, §4.1 row 29** — `poll.manage` → `poll.close` / `poll.update` [D6, R1 C1]
43. **§3.6.3** — `awareness.exclude{about,members}` → `awareness{topicRef, state:'not_aware', members}` / `secrecy.surprise` [D6, R1 C2]
44. **§3.9.2 (new paragraph), §4.2** — plugin digest-section hook: `PluginDigestSectionsPort`, eligibility, ≤2 sections × 5×300, timeout, untrusted+guarded, class `digest`, skip-if-empty on built-ins only [D7, R2 07↔10]
45. **§4.1** — rows 3/13/16/19/20/21/23/25/26/29 use 03 registry kinds; footnote states the M4-T2 cross-check guarantee [D6]
46. **§4.2** — DecisionSearchPort comment → `engine/context` + `engine/readmodels` (A11); BallotPresenter note [R1 C8]
47. **§4.4** — ICS route semantics restated; no unversioned alias [D4]
48. **§5** — "request to 03" wording removed; keys use 03 paths (`proactivity.memberQuietHours`, `types`, `memberDailyBudget`, `enabled`); `tasks.assignmentMode` uses 03 enum [R1 C6]
49. **§9.3 GS-29, §10 M7-T20** — interfaces named per 03 §3.3.6 [D6]
50. **§10 (new)** — M7-T70 (03 name-alignment checks) and M8-T70 (plugin digest-section hook) with acceptance criteria [D6, D7]
51. **§10 M7-T8 acceptance** — adds token size/hash, revoke-on-leave and DM-only delivery tests [D4]
52. **§3.4.3 tool 25** — mixed-op batch yields one `ActionRequestDraft` (spine §7.4) with the most restrictive kind, not several requests [D6]
53. **§4.1 escalation rule R5** — exempts 03 taint-allowlist kinds (they become proposals), matching §3.1.3 tool 3 [D6, 03 §3.10.2]
54. **§3.3.7 copy `chore.rotation.created`** — ICU select value `fair` → `least_loaded` [D6]

### 08-security-privacy.md (12)
55. **§3.16.2 retention table, Privacy & Trust page text, §5 `traces.retentionDays`** — TurnTrace 90 d → 30 d default (7–365), manifests never content; reverts R3's 90-day change per coordinator [D2, R1 C19]
56. **§3.14 manifest subset** — field names now 10's (`permissions.network.{hosts,private,raw}`, `fs.scratch`, `secrets[]`, `repos`, `sensitivity`, `jobs`…); 08 keeps the enforcement requirements [D7, R2 08]
57. **§3.14 process isolation** — launch flags restated from 10 §3.4.2 (package read-only, scratch only if approved, `memoryMb` 64–512 default 128, `--disallow-code-generation-from-strings`, `--disable-proto=throw`); RPC line cap and timeouts deferred to 10 (4 MiB; 15/60 s tools, 30 s channel, 120 s jobs) [D7, R2 08]
58. **§3.14 MCP client item 3** — host-entered MCP client secrets are vault entries [R1 C17]
59. **§3.14 MCP server** — endpoint = 10's `/mcp` on the main listener (no separate port), bearer-only, Host/Origin checks; path-scoped exposure [D3]
60. **§3.7.12 token table** — MCP PAT: format/entropy/hashing owned by 08; scopes/TTL/UX/endpoint by 10 (was "owned by 10") [D3]
61. **§3.8.8 rate limits** — MCP limits = 10 §3.7.6 numbers (was 120/min) [D3, R3 X8]
62. **§3.10 Secrets handling** — new bullets: extension secrets in the vault; A29 `keys/secrets.enc` format (vault-key AEAD container, AAD-separated), precedence, step-up, backups [A29, R1 C17, R3 X12]
63. **§3.7.11 VBK1 header** — `keyringSnapshot` now `{generations:[{gen, slots:[master, recovery]}], static:{blobId}}` + "required" note; body includes `secrets.enc` [D7, R1 C18]
64. **§3.7.2 HKDF params, §4 `KeyPurpose`** — registered `fts-token` purpose for 02's FTS fallback [R1 C18]
65. **§3.7.12 ICS row, §3.8.11** — ICS route `/ics/v1/…` per 07, revoked on leave, DM-only delivery [D4]
66. **§3.7.12 host-claim row** — link-code shape stated per 06 §3.18.1 (`XXXX-XXXX` + `lnk_` token, 10 min) instead of "same shapes"; per-chat claim limit added [D5]

### 09-dashboard-api-cli.md (16)
67. **§3.10.6.12 TraceView** — new Retention bullet (30 d default, manifests only, expired → 404 copy) [D2]
68. **§3.10.6.8 Fairness tab** — default view shows only the viewer's own share; per-member chart only after explicit `everyone`/`admins` opt-in [D1]
69. **§3.3 step 4 (read models)** — `ReaderPrefilter` (per-row reader columns) → eligible-label-id set `label_id IN (:eligible)` (A8) [D5, R1 C12]
70. **§3.3 step 6, §4.9 row 04** — `MemoryQueryService.search(audience, query, filters, cursor)` matches 04 §4.1 [R1 C13]
71. **§3.5 calendar feed routes** — fields `includePrivate`/`lastFetchedAt` → 02/07 `scope`/`detail`/`lastUsedAt`; POST delivers the link by DM only (`202 {id, deliveredVia:'dm'}`, `409 dm_needed`); route `/ics/{feedToken}.ics` → `/ics/v1/{token}.ics` with 07 semantics [D4, R1 C10]
72. **§3.9.1 rules, §3.9.8 step-up list** — ICS log path `/ics/v1/***.ics`; step-up applies to `scope:'member'` feeds [D4]
73. **§3.7 `claim.redeem` limit** — adds 06's per-chat limit (≤5 failed/chat/hour, 1 h ignore) next to the per-code burn; counters in 02 `rate_limits` [D5, R2 06↔09, R1 C21]
74. **§4.6 tables** — `claim_codes` columns renamed to 02's (`createdByPersonId`, `usedAt`, `usedInChat`, `usedByPersonId`); `link_codes` split from `invite_codes` with 02/06 shape (10-min code, `tokenHash`, state); `ics_feed_tokens` uses `scope`/`detail`/`lastUsedAt` [D4, D5]
75. **§4.9 rows 02/03** — `ReaderPrefilter` request → `EligibleLabelSet`; 03 API requested by exact 03 §3.2.10 names (`capabilitiesFor(policy, member)` function, `charter(policy, roster, locale)`, `semanticDiff(a, b, locale)`, span fields); stale "capabilities missing" note removed [R1 C11, R3 X1]
76. **§3.3, §3.4 `GET /me`, §4.1 GroupViewer** — `CompiledPolicy.capabilitiesFor(member)` method calls → `capabilitiesFor(policy, member)` [R1 C11]
77. **§3.5 `POST /constitution/validate`** — issue fields `col`/`endCol` → 03 `column`/`endColumn` (+`code`); `semantic` typed as 03 `SemanticChange[]` [R1 C11]
78. **§3.5 route table** — added `POST /mcp` row (owned by 10/08, main listener only when enabled, cookie-less); `/me/mcp-tokens` metadata; CLI row adds `list --person|--group`, `revoke <id>|--person|--all`, `mcp client secret set`; listeners.ts comment [D3, R3 X8]
79. **D-29, /setup screen, Q-2** — A29 exception: appliance installs may write host-only secrets to `keys/secrets.enc` via token-gated `/setup` or host step-up; write-only fields; env precedence [A29]
80. **§10 M9-T911 acceptance** — ICS route/fields/DM-only delivery and `self_only` fairness tests [D1, D4]
81. **§3.11.4 wizard "Port in use"** — suggests 7779 (7778 is 08's optional ICS listener; MCP has no own port) [D3]
82. **§3.5 Control API** — new `PUT/DELETE /control/v1/vault/{namespace}/{name}` so CLI extension-secret commands can write the 08 vault (offline fallback stated) [R1 C17]

### 10-extensibility.md (14)
83. **§3.3.5 Who + excerpt** — `mcpServer.roles` removed; who may connect = `mcp.connect` grants (+ guardian `memberGrants` for children); excerpt now mirrors 03 (`lockToConstitution`, `allowDelegatedJobs`, `teen` = `bandGrants.teen`); amendment-vs-admin defaults expressed as `lockToConstitution` [D3, R1 C16]
84. **§3.7.2 Transports** — MCP served at `/mcp` on the main HTTP listener (mounted by 09 only when `mcp.server.http.enabled`); separate 7778 listener dropped with rationale (path-scoped tunnel rule covers "MCP without dashboard"); cookie rejection; middleware chain kept [D3, R1 C17]
85. **§3.7.3 Format** — token format/entropy/hashing owned by 08 §3.7.12 (restated) [D3, R1 C17]
86. **§3.7.3 CLI** — defined `village mcp token create|list|revoke <id>|--person|--all` and pointed to §3.7.6 per-token limits [R3 X8]
87. **§3.8 Claude Desktop note, §5 config `mcp.server.http`, §7 threat row, §4 deps, M12-T11, §12 item 10** — 7778 → main port `/mcp`; `bind`/`port` keys removed [D3]
88. **§3.3.2 step 8, §3.9.1, §5 Secrets** — plugin and MCP-client secrets stored as 08 vault entries (`plugin/<id>/…`, `mcp/<id>/…`), not plaintext files; env precedence [R1 C17]
89. **§3.4.2 launch spec** — `--disable-proto=delete` → `throw` (08 security requirement) [D7]
90. **§3.2.5 Digest sections** — points to the 07 §3.9.2 hook and its limits [D7]
91. **§3.11.2 `ics` plugin** — refuses URLs already held by a built-in subscription and the instance's own `/ics/v1/` feeds [R2 07↔10]
92. **§3.7.3 issuance via `/mcp` DM, M12-T12** — "sends a magic link" → dashboard link with A9 sign-in (pairing default; magic link only on loopback/HTTPS opt-in) [sweep: magic link default]
93. **§3.7.3 verifier** — "role lacks `mcp.connect`" → member lacks it per `capabilitiesFor` (role, memberGrants, band grants) [D3]
94. **§3.10.3** — `use_skill`/`read_skill_file` name their 03 ActionKinds [sweep]
95. **§3.7.4 Write semantics** — new "Taint allowlist" bullet: MCP writes on 03's allowlist yield proposed event/task/memory and untrusted list items, confirmed by the member in DM [D7, 03 §3.10.2]
96. **§3.3.2 step 8** — secret write path via the Control API vault route [R1 C17]

### 11-quality-evals-observability.md (2)
97. **§1 Q19, §3.10.4 table, §5 config** — TurnTrace 90 d → 30 d default (7–365); dropped "kept ≥ messageRetentionDays" rule (hosts may raise it) [D2]
98. **§3.8 Playwright E2E specs** — "login via a test-mode magic link" → pairing-code login (default) plus loopback magic link [sweep: magic link default]

### 12-packaging-release-ops.md (1)
99. **§3.5 Umbrel compose + note, §3.7 permission audit, §3.12 exposure, §12-6** — `/mcp` added to proxy-auth whitelist with rationale; `secrets.enc` in key-file audit and `keys/` listing; MCP on main port with path-scoped exposure guidance; §12-6 marked Resolved by A29 [D3, A29, R3 X12]

### 13-docs-launch-community.md (2)
100. **§3.G G3 demo storyboard** — notes the demo group opted into `everyone`; default is `self_only` [D1]
101. **§3.B README features table, §3.C IA `/concepts/fairness/`** — "a load ledger everyone can see" → own share by default, group-visible by opt-in [D1]


## (b) Changes needed in `00`, `01`, `14` or `15` (not edited here)

| # | File §section | Needed change | Source |
|---|---|---|---|
| B1 | `01` §6.1 step 2.2 | "Resolve the Conversation (auto-create on first contact…)" contradicts A27: unclaimed chats persist nothing; only a `chat_bindings` row exists until a claim code binds the chat (02 §3.3.1, 06 §3.20.1) | R1 C24, A27 |
| B2 | `01` §6.1 step 2.5 | "Store attachments as blobs" is superseded by A25 (`attachment.fetch` job); step 6's parenthetical already says so — delete step 2.5's text | R1 C24, A25 |
| B3 | `01` §6.1 step 4 (router) | "slash command → `respond`" contradicts 05 S13 / 07 SC-5 (commands and buttons are deterministic `command`/`interaction` dispositions, no model call); "Members with `consent:'memory_off'`" should be "consent ∈ {`unknown`,`informed`,`memory_off`}" (A16) | R2 01, A16 |
| B4 | `01` §5 and §6.4 | Point to `02` §3.3.13 (entity → table checklist) and `02` §3.10.1 (authoritative job-kind catalog) | R1 C24 |
| B5 | `01` §10 config | Add `traces: { retentionDays: 30 }` (7–365, manifests only) and `mcp.server.http: { enabled: false }` (serves `/mcp` on the dashboard listener; no own port) | D2, D3 |
| B6 | `01` §14 A7 | Add `06`'s `ReadMarker`; expand the `10` bullet to the full `10` §4.3 set (plugin installations/versions, group extensions, delegations, store entries, egress log, MCP tokens/access log/idempotency, MCP client servers/tool snapshots, skill records); `07`'s `Task.category` and `proposed` statuses | R2 01 |
| B7 | `01` §14 A12 / ADR-021 | Add `@modelcontextprotocol/node` (stdio) if the 10 M12-T0 spike confirms it; record that the MCP server is served at `/mcp` on the main listener (no separate port) | R2 01, D3 |
| B8 | `01` §14 A29 (or a new A30) | Optional: note that host-entered extension secrets (`village plugin secret set`, `village mcp client secret set`) live in the 08 vault, written via Control API `PUT /control/v1/vault/…` (09) | R1 C17 |
| B9 | `15` §2 | Add resolved rows: ledger visibility default `self_only` (D1); TurnTrace 30 d (D2); MCP on main listener `/mcp`, 08 token format / 10 endpoint (D3); ICS semantics owned by 07, route `/ics/v1/` (D4); MCP memory writes → proposed (D7); 06 `observeReactions` default on (see C1) | D1–D7 |
| B10 | `14` | Register **ADR-023** (tool-catalog strategy, from 05 M2-T12/M13) | R2 14 |
| B11 | `14` | Schedule new tasks: `02`:M12-T70 (browser-safe `@village/storage/memory`), `07`:M7-T70 (03 name-alignment checks, depends on 03:M4-T2), `07`:M8-T70 (plugin digest-section hook, before 10:M12-T7) | this pass |
| B12 | `14` | Merge overlapping tasks: `08`:M12-T80/T81 with `10`:M12-T3/T5 (launcher and approval now share one spec: 10 §3.4.2 command line, 08 §3.14 requirements) | R2 08 |
| B13 | `14` | Carry R3 X11 items: 09 CLI rows (runtime, models, recovery, db checkpoint, `mcp token list/revoke`, eval challenge), 12 `build-reusable.yml`/`repro.yml`, 11 `node24`/`packaging` jobs, TTFV rounds from M13; plus 09's new Control API vault route (M9 or M12) | R3 X11 |
| B14 | `14` | Acceptance changed for `03`:M4-T2 (per tool/op/taint cross-check), `07`:M7-T8, `09`:M9-T911, `10`:M12-T11/T12 (main-listener `/mcp`, A9 sign-in) — reflect them if `14` restates acceptance | this pass |
| B15 | `00` §6.3 | Already says group-visible fairness is opt-in; no change needed. (R3 X6/X7 items for `00`/`01` — magic link, HA "add-on", `npx` placeholder, "3 fresh users", M9 wording — are already fixed in the current `00`/`01` text.) | R3 X6/X7 |

## (c) Still unresolved / risks

- **C1 `observeReactions` default flipped to `true` (06 §3.9, §5.1, Q17).** D7 requires persisting reactions for 04's extraction windows, which needs reactions on members' messages, so 06's data-minimisation default (off) could not stand. Data stays in the bound group, inherits the message label/retention and is consent-filtered, and groups/hosts can switch it off. Flagged because it reverses an owner-doc privacy default; the owner may prefer "off unless the constitution's memory section opts in".
- **C2 MCP writes become proposals.** Because 10's MCP path always runs tainted, `create_event`, `create_task` and `remember` now yield `proposed` artifacts needing one DM tap (03 §3.10.2 allowlist; 07 §3.1.3; 04 §3.9.7; 10 §3.7.4). Safe, but adds friction for members' agents; revisit after M12 dogfooding (a per-token "trusted own speech" scope would need a 03 policy change).
- **C3 07 taint behaviour changed.** `calendar_create_event` under taint previously escalated to high (which 03 denies); it now emits `calendar.event.propose`, per 03's allowlist. 07's R5 ("untrusted → high") now applies only outside the allowlist. 11's injection scenarios that expected a denial for forwarded-letter event creation must expect a proposed event instead.
- **C4 Trace window vs messages.** With traces at 30 d and messages at 90 d, "Why did Village say this?" fails for turns 31–90 days old. Documented in 08/09/11 with the host override.
- **C5 Plugin RPC line cap and timeouts.** 08 now defers to 10 (4 MiB per line, sized for 1 MiB attachment chunks; tool timeout up to 60 s). A security reviewer may still want a lower cap for non-channel plugins; that would need a 10 protocol change.
- **C6 `--disable-proto=throw` for plugins** (08 requirement, now in 10 §3.4.2) may break some npm dependencies that touch `__proto__`; 10:M12-T3 should test the first-party plugins and record any fallback as an 08 decision.
- **C7 Vault writes from the CLI.** Extension secrets now live in the 08 vault via a new 09 Control API route; the offline path (CLI unlocking the keyring when the server is stopped) works only for `keyfile`/`keychain`/`file`/`env` key stores, not `passphrase` without a prompt. 08/09 should confirm in M12.
- **C8 Optional ICS listener port 7778** (08 §3.8.11) is now the only user of 7778; 09's wizard suggests 7779 on conflict. If 08 later drops the separate feed listener in favour of path-scoped exposure (as for `/mcp`), the port can be retired.
- **C9 `list_update_items` mixed batches** pick the most restrictive kind (spine §7.4 allows one `ActionRequestDraft`). If 03 wants per-item contest outcomes for mixed batches, the tool would need to split calls; flagged for M7.
- **C10 Catalog/cost growth (R2 (c)1)** and **charter length (R2 (c)9)** remain open measurement items (05 M7-T1, M3-T5); unchanged by this pass.
