# R1 — Consistency review: 02 (storage), 03 (group intelligence), 04 (memory)

Reviewer cluster A. Baseline: `01` §14 A1–A28 and `15` §2. Owner decisions D-1..D-8 were not touched. Task IDs were not renumbered; new follow-up tasks use new IDs (M3-T-S2, M7-T-S2, M12-T-S1). Also covers the cross-cluster items the coordinator forwarded from R2 §(b) and R3 X1–X4.

## (a) Fixes made

### 02-domain-model-and-storage.md (47)
1. Header: added the spine v1.1 reconciliation note. Per A7, 02 is the physical schema for all entities; per A8/A10, crypto belongs to 08.
2. §1 "Not in scope": auth/onboarding/extension/feedback **tables** are now defined here; only their semantics live elsewhere.
3. D3: fixed the broken reference §3.13.6 → §3.13.7.
4. D7: vec0 gains a `state` metadata column (04 retrieval state).
5. D8: the DB key is derived from the RDK (08 key tree), not directly from the master key.
6. D13: `libsodium-wrappers` (WASM) is the default. `sodium-native` is used only if SP-2 measures < 40 MB/s on a Pi 5 (A8).
7. D14: blob address uses 08's static blob-id key `K_blobid`. The label lives on the attachment (A8).
8. D19: `VBK1` with backup-kek + recovery-key + optional passphrase slots; restorable with the recovery key alone (A10). Snapshot method is decided by the spike (A8).
9. §3.1 ID prefixes: added prefixes for every new entity (03/04/06/07/09/10/11).
10. §3.2: reader sets now intern outsider `seats` (`reader_set_seats`), and labels intern `coOwners` (A5). Added a statement that `label_id IN (eligible)` is the only eligibility mechanism.
11. §3.3.1 `persons.display_name_source`; `channel_identities.platform_username`, `dm_reachable`, `dm_chat_id` (06).
12. §3.3.1 `groups.primary_conversation_id`, `week_start`, `extensions_version` (A7, 07, 10).
13. §3.3.1 `members.role` enum, `age_band` with check, and `handle`, unique per group (A7, 05 S4).
14. §3.3.1 `member_guardians` → `guardian_relations`, now carrying group, creator and timestamp (03).
15. §3.3.1 conversations:
    - `group_id NOT NULL`, `primary` + a one-primary index (A7).
    - Removed the "unbound conversation" model (A27).
    - Moved the extraction cursor out.
16. §3.3.1 new tables `chat_bindings`, `channel_chat_aliases`, `dm_contexts` (06, A27). Unclaimed chats persist only a binding row.
17. §3.3.2 `declassifications` reshaped to 03 §3.4.2 (kind enum, source/target label, `approved_by` incl. `policy:GS`, content/action digests).
18. §3.3.3 messages:
    - `group_id`/`label_id` are NOT NULL; dropped the unbound-message check.
    - Added `edit_count`, `deleted_at`, `delivered_late`, `truncated`, `turn_id`, `client_message_id`.
    - Attachments: `forbidden`/`unsupported` statuses and `fetch_job_id`.
    - New `message_reactions` table.
    - Explicit `attachment.fetch` rule (A25).
19. §3.3.4 `memory_items`:
    - New columns: `statement`, `search_terms`, `language`, `fingerprint`, `retrieval_state`, `pinned`/`pinned_at`, `archived_at`, `last_confirmed_at`, `superseded_by_id`, `contradicts`, `links`, `retract_reason`.
    - Immutability trigger updated.
    - `memory_sources` made append-only per R13; `embedding_spaces` states `ready`/`failed` added.
20. §3.3.4 new 04 tables R6–R13: `memory_entities`, `memory_entity_aliases`, `memory_item_entities`, `extraction_cursors`, `memory_ops_applied`, `memory_tombstones`, `forget_fingerprints`, `forget_source_blocks`, `memory_events`, `memory_consolidation_state`, `memory_access_stats`.
21. §3.3.5 coordination block aligned to 07 (A7):
    - events: series root, `rdates`, `busy`, `source`, subscription diff keys, `proposed` status.
    - New tables: `event_overrides`, `event_attendee_overrides`, `calendar_subscriptions`, `ics_feed_tokens`.
    - reminders: per-occurrence schedule, plus a new `reminder_firings` table with a unique occurrence key.
    - rotations: strategy enum per 03.
    - tasks: `kind`, `category`, `assignment_state`, `proposed`, proof.
    - New `task_swaps` table; `task_load_entries` renamed to `ledger_entries` (03 ∪ 07 kinds).
    - lists/items: 07 kinds, plus `list_category_overrides`.
    - polls: 07 shape, plus `poll_counts`.
    - plans and steps; decisions get status/origin/topics.
    - New tables: `proactive_candidates`, `proactivity_feedback`, `catchup_cursors`.
    - Attention ledger is derived from outbox class (A24).
22. §3.3.6 governance:
    - `constitution_versions`: `parent_version_id`, `adopted_by`, `adopted_via` incl. `setup`/`migration`/`placeholder` (A27 M3).
    - `proposals`: 03 statuses, rule, frozen electorate, ballot refs, action digest.
    - Votes gain `via` and a label; `private_constraint_policies` stores 03's policy JSON.
    - New tables: `constraint_records`, `standing_approvals`, `confirmation_requests` (A7 name).
23. §3.3.7 runtime:
    - `turns` statuses (`queued`/`timed_out`/`cancelled`) and kinds (`interaction`/`command`/`confirmation_resume`/`system`); `phase`, `root_turn_id`, `retry_of_turn_id`, `effort`, `timed_out_at` (05 S1).
    - `turn_effects`: `idempotency_key` UNIQUE, `status intent|committed|failed`, encrypted result, `root_turn_id`, nullable `committed_at` (A7, A23).
    - `turn_traces`: replay metadata (11). New `turn_trace_debug` table (05).
    - outbox: `message_class` (A24), priority, expiry class, `parts_json`, manifest label ids, `expired`, `in_flight_since`.
    - usage: 5m/1h cache writes, served model, purpose, via, price table (05 S9).
24. §3.3.8 settings scope gains `member:`/`person:`. `identity_link_codes` replaced by `link_codes`; removed the "tables owned by other docs" stub (wrong names).
25. §3.3.11 (new) 06/09/08 tables: `claim_codes` (merged 06+09), `link_codes`, `invite_codes`, `interaction_tokens`, `channel_state`, `rate_limits`, `sessions` (idle 12 h / absolute 7 d, no stored CSRF secret), `login_tokens` keyed by `jti`, `pairings`, `step_up_challenges`, `idempotency_keys`, `ha_links`, `domain_events`, `exports`. ControlToken is noted as file-backed (R3 X4).
26. §3.3.12 (new) 10/11 tables: `plugin_installations`, `plugin_versions`, `group_extensions`, `plugin_delegations`, `plugin_store_entries`, `plugin_egress_log`, `mcp_tokens`, `mcp_access_log`, `mcp_idempotency`, `mcp_client_servers`, `mcp_tool_snapshots`, `skill_records`, `feedback_items`.
27. §3.3.13 (new): A7 entity → table checklist, with a CI check hook.
28. §3.3.9/§3.3.10: JSON and named-query catalogs extended. New queries: Q-OBX-5, Q-GOV-1/2, Q-COO-6, Q-CTX-8, Q-MEM-2/3. Q-ING-2 now goes via binding/DM context.
29. §3.4: `memory_fts(statement, terms, scope)`, FTS5 `secure-delete=1` on all FTS tables. Memory rows are indexed until retracted; the query filters on `retrieval_state`.
30. §3.5: vec0 `state` column, triggers covering state change and retraction, ≤ 64-item insert path, KNN with state/history.
31. §3.6.1: key derivation aligned with 08 (MK/RK/passphrase slots wrap the RDK; HKDF salt = instanceId; static `K_blobid`).
32. §3.6.3 spike: Node 26 + Node 24 ≥ 24.11 matrix (A1), `libsodium-wrappers` pin, SP-2 and SP-3 decision rows.
33. §3.7.1: `MemorySearchPort` callers are `engine/context` + `engine/readmodels` (A11). Added `maxState`, `byEntities`, `aliases`.
34. §3.10.1: **authoritative job-kind catalog** covering every kind from 01/02/03/04/05/06/07/09/10/11/12, including `attachment.fetch`, `backup.verify` and `backup.offsite`. Added `singleFlightByKey` and its claim clause.
35. §3.11 blobs: magic `VBL1`, DEK wrap per 08 (AES-256-GCM, AAD), `K_blobid`, `kek_version` = keyring generation.
36. §3.12.5: `embed.reindex` → `memory.reembed`; retired space is dropped after 7 days (04).
37. §3.13 retention:
    - Removed unbound-chat messages; added memory-off raw retention, auth secrets, sessions, domain events, extension logs, `memory_ops_applied`, `turn_trace_debug`.
    - Cursor is now `extraction_cursors`. Erasure covers the new person tables.
    - tzdata job → `time.tzdata_changed`.
38. §3.14 rewritten to `VBK1` (08 §3.7.11): no `keys.json`; `keyringSnapshot`; restore with RK/MK/passphrase; `.vbak` extension kept (R3 X2).
39. §3.15: `memories.jsonl` records are 04's `MemoryExportRecordV1`.
40. CLI references aligned to 09 §C (R3 X3):
    - `keys rotate-db`/`rotate-blob-kek` → `keys rotate-data`.
    - `keys doctor` / `audit verify` / `jobs ls` → `doctor --check …`.
    - `migrate --dry-run` → `migrate status`; `restore --pre-migration latest` → `restore pre-migrate:latest`.
    - Removed `export-db-key`.
41. §4.1: full repository list; search-port consumers (A11); `@village/storage/testing` exports (`createTestDb`, `exportDomainState`) for 11.
42. §5: removed `privacy.unboundRetentionDays`.
43. §6: F24 (recovery-key slot) and F27 (A27) updated.
44. §9.3: backup round-trip must pass with the recovery key only.
45. §10 tasks:
    - M1-T1 (pins, A11 depcruise), M1-T4 (08 key mechanics, SP-2), M1-T7/T8/T16 (new tables), M1-T23 (VBK1, RK-only restore), M9-T-S1 (auth tables).
    - New tasks with acceptance criteria: M3-T-S2 (06 tables), M7-T-S2 (07 tables), M12-T-S1 (10/11 tables).
46. §11: Q6 resolved by A27; Q12 by A10.
47. §12: Status markers on P1–P6.

### 03-group-intelligence.md (34)
1. Header: reconciliation note; §3.1.2 declared the single authoritative catalog (A6).
2. §3.0: module map adds `api.ts`; diff is `semanticDiff`; sealed-set note uses A11 callers.
3. §3.1.2: added `usage.read`, `dashboard.access`, `participate`, `extensions.manage`, `mcp.connect`.
    - Sharpened `audit.read`; `settings.read` no longer covers costs.
    - Plugin capability syntax aligned to 10 (`plugin:<provider>:<tool>`).
    - Defined the `CAPABILITY_CATALOG` shape and a "no capability outside the catalog" rule (A6, R3 X1).
4. §3.1.3: bundles grant `participate`, `dashboard.access` and `mcp.connect` per role; noted `*` coverage.
5. §3.1.4: role-matrix rows for the new capabilities. Teens get `dashboard.access` through band grants; children get `mcp.connect` only via a guardian-approved `memberGrants` entry.
6. §3.1.1: `SystemPrincipal.delegationId` (10).
7. §3.2.1: section list includes the consumer sections.
8. §3.2.2 schema:
    - `GrantToken` plugin syntax; budgets `'auto' | number` (A3).
    - `proactivity.enabled`, `memberDailyBudget`, `memberQuietHours`, `types`. Interjection kinds now equal the 05 router kinds that 07 accepts.
    - `fairness.shoutouts`.
    - New sections `calendar`, `tasks`, `lists`, `polls`, `plans` (07), `memory` (04), `onboarding` (06), `extensions` (10) (R2).
9. §3.2.4: `CompiledPolicy` budgets resolved, plus `bandGrants` and the consumer sections. Compiler steps 5, 10 and 15c updated.
10. §3.2.5: issue spans gain `endLine`/`endColumn`; W030 example now $75.
11. §3.2.9:
    - All 8 template budgets → `auto`; dropped interjection kinds removed.
    - New consumer-section delta table, values from 07 §5, 04 Q7, 06 and 10.
12. §3.2.10 (new): `validate`, `charter` (RichText), `semanticDiff`, `constitutionJsonSchema`, `capabilitiesFor` (09).
13. §3.3.1 registry:
    - Kinds for `participate`, extensions and MCP tokens; plugin kind syntax.
    - 10 new 07 write kinds, all 07/05/04 read kinds, and canonical-name mapping for 07's divergent names (R2).
14. §3.3.3: Phase-1 capabilities include `bandGrants.teen`.
15. §3.3.6: `BallotPresenter.openForProposal` and the `ProposalService` interface incl. `resolveProposal` (05, 07).
16. §3.3.8: amendment JSON-Patch paths cover the new sections; privacy delta adds memory extraction, MCP server and auto-capture changes.
17. §3.3.11: new `SYSTEM_ACTIONS`: `poll.close`, `chores.materialize`, `coordination.expire`, `lists.autocapture`, `calendar.subscription.sync`, `plugin.job`. Clarified `@standard`.
18. §3.3.12:
    - Buttons use 06 `InteractionToken`, not HMAC-encoded tokens (R2).
    - `ConfirmationSpec` is persisted as `ConfirmationRequest` / `confirmation_requests` (A7).
19. §3.3.13 (new): table of the 8 governance/privacy tools (effect, capability, kind, risk, input) (R2).
20. §3.4.4: `LabelingRules` interface incl. `forExtracted` (04); blob label note.
21. §3.4.6: `GroupScoped<Repo>` (undefined) → `EligibleLabelSet`.
22. §3.4.7: `AudienceResolver.forConversation(conv, at)` (05). New "platforms that cannot list members" rules: seats are readers only (06).
23. §3.5.2: exact consumer names for "not aware" and availability (07).
24. §3.5.4: `ConstraintRecord` status `suspended` (it was used by E23 but undefined).
25. §3.5.5: `describeConstraintForViewer` (05) and `DeclassificationPolicy.mayConsider` (04).
26. §3.6.2: sealed-set search wording (A11).
27. §3.7.1: one DM conversation per group, plus the `DmContext` active group (A27).
28. §3.8.1: `ConsentPolicy.mayExtract` (A16, 04).
29. §3.9.1–3.9.3:
    - `LedgerEntry` kinds unified with 07.
    - Typed `assign()` and `FairnessPort.{proposeAssignee, loadSummary}` (07).
    - 07's `fair` = `least_loaded`.
30. §4.1/§4.2: interfaces list updated to these names. Consumed repositories now use 02 names and `EligibleLabelSet` instead of `item_readers`.
31. §5: `hostBudgetCaps: auto` = per-preset caps (A3), replacing the $20/$2 values.
32. §8: SQL pre-filter = eligible label ids (A8); the reader-predicate text was removed.
33. §10: acceptance criteria updated for M4-T1/T3/T5/T6/T10, M5-T2/T3/T9/T14 and M7-T2.
34. §12: Status markers on P1–P10.

### 04-memory-system.md (23)
1. Header: reconciliation note; physical names belong to 02.
2. D2: a label may only be narrowed (03 D17); widening means a new item.
3. D11: the IFC pre-filter is the eligible-label-id set (A8); dropped FTS ACL tokens.
4. §3.1: module map uses 02 ports. Search callers are `engine/context` + `engine/readmodels` (A11).
5. §3.2.1/§3.2.3: `labelKey`/`LabelKey` → `labelId`/`LabelId`.
6. §3.2.6: R1–R13 table rewritten with a "Realized in 02" column; seq = `rid`; vec0 L2 + `state`.
7. §3.3.1: debouncer uses `JobQueueTx.enqueueDebounced` + single-flight.
8. §3.3.2: edits keyed by `editCount` (no prior text kept, 06); cursor = `extraction_cursors.last_rid`.
9. §3.3.3: reactions read from 02 `message_reactions`.
10. §3.3.5: consent filter = `ConsentPolicy.mayExtract`; `informed` added (A16).
11. §3.3.11: interning via `LabelStore.intern`.
12. §3.4.2/§3.7.6: `labelId`.
13. §3.6 retrieval:
    - Diagram, manifest and FTS expression updated.
    - §3.6.3 rewritten: `computeEligible` cache; FTS join SQL; vec SQL on `vec_memory_<slug>`; entity channel.
14. §3.6.8: `mayConsider` signature matches 03.
15. §3.7.1/§3.7.3/§3.7.5: watermark table, consent wording, `retrieval_state` transitions.
16. §3.8.3/§3.8.6: `embed.items` debounce; vec table names; space states; `memory.reembed`.
17. §3.9.1: eligible set replaces the allowlist.
18. §3.9.5: export container matches 02 §3.15 (no zip or passphrase).
19. §3.9.7: `memory_remember` under taint creates `proposed` (R2).
20. §4.1: new `MemoryQueryService` (engine/readmodels) for 09's explorer. §4.2: consumed names (`MemorySearchPort`, `LabelStore`, `decisionQuorumHint(policy, category)`, `CoordinationCandidate.labelId`).
21. §6/§7: F18 fixed; I1/I4/deletion wording aligned.
22. §9/§10:
    - Tests renamed.
    - M1-T60/61/62 now say which 02 tasks deliver them.
    - Stale spike reference fixed.
    - M6-T6/T7 acceptance includes the dependency-cruiser rule.
23. §12: Status markers on P1–P7.

## (b) Cross-cluster issues found but not fixed (other clusters' files)

| # | File §section | Problem | Recommended fix |
|---|---|---|---|
| C1 | 07 §4.1 tool catalog | Write kinds `calendar.event.cancel`, `list.items.add`, `list.items.update`, `list.manage`, `chore.rotation.upsert`, `chore.swap.propose`, `chore.swap.respond` and `poll.manage` are not 03 registry names. Without the change, 03:M4-T2's CI cross-check fails. | Adopt 03 §3.3.1's canonical names (mapping given there). Read kinds are already registered verbatim. |
| C2 | 07 §3.1.2, §3.6.3 | Constraint names `availability.unavailable{…strength}` and `awareness.exclude{about, members}` do not exist. | Use `availability.busy` (+ `schedule.do_not_schedule`) and `awareness{topicRef, state:'not_aware', members}` / `secrecy.surprise` (03 §3.5.2). |
| C3 | 07 §3.3.2 `FairnessPort` | Input is precomputed capacity/unavailable/preferences maps, and the return type is not a union. 03 now resolves constraints itself and returns `AssignmentResult` (`assigned` \| `no_eligible`). | Adopt the 03 §3.9.2 signature. |
| C4 | 07 Rotation/LoadLedgerEntry | Several names diverge from 03. | Rename `strategy: 'fair'` → `least_loaded` and ledger kind `completed` → `task_done`. Rename `LoadLedgerEntry` → `LedgerEntry` (02 `ledger_entries`). |
| C5 | 07 Task/Event status | Neither has a `proposed` status, but 03 §3.10.2 taint allowlist needs both (02 added them). Task also lacks a `category` field, which 03 fairness and `tasks.do_not_assign` need (02 added it). | Add `proposed` to both and `Task.category`. |
| C6 | 07 §5 | Keys marked "request to 03" now exist. `quietHours.memberDefault` is named `proactivity.memberQuietHours`. | Drop the "request" wording and use 03 §3.2.2 paths. Read `proactivity.types` and `proactivity.memberDailyBudget`. |
| C7 | 07 polls/governance | `PollService.openForProposal(proposalId, {...})` and `03.resolveProposal(proposalId, tally)` do not match 03. | Implement `BallotPresenter.openForProposal(proposalId, spec, where)` and call `ProposalService.resolveProposal(id, reported, uow)`. 03 recomputes the tally. |
| C8 | 07 §3.7.2, §4.2 | Says "only engine/context touches memory search". | `engine/context` + `engine/readmodels` (A11). |
| C9 | 07 `system.lists.autocapture` | The name is 07's own. | Use the SystemActionKind `lists.autocapture` (03 §3.3.11). |
| C10 | 07 FeedToken vs 09 `ics_feed_tokens` | Fields differ: `scope`/`detail` vs `includePrivate`; `lastUsedAt` vs `lastFetchedAt`. Token sizes differ (256 vs 192 bit), and so do routes (`/ics/v1/{token}.ics` vs `/ics/{token}.ics`). | 02 has one table (`scope`, `detail`, `last_used_at`). 07 and 09 should agree on a 256-bit token and one route. |
| C11 | 09 §4.9 | Several names and shapes differ from 03 §3.2.10. | Call `capabilitiesFor(policy, member)` as a function, not a method. Issue spans are `line/column/endLine/endColumn`. `charter()` returns RichText. `semanticDiff(a, b, locale)` items include `privacyReducing`. |
| C12 | 09 `ReaderPrefilter` | Describes per-row reader columns (`readers_kind='group' OR readers_set CONTAINS…`), which contradicts A8. | Use 02's `EligibleLabelSet` / `label_id IN (eligible)`. |
| C13 | 09 memory explorer | Expects `MemoryQueryService.search(audience, query, filters, cursor)`. | Now defined in 04 §4.1. Confirm the shape. |
| C14 | 09 claim codes | Group claim TTL is "≤ 24 h" and the code is 40-bit. | Use a 30-min single-use code (A27). 06 §C owns the format. |
| C15 | 09 §3.9.5 sessions | If the "7 d idle / 30 d absolute" text remains, it contradicts 08's 12 h / 7 d. | Use 08's values; 02 now follows 08. |
| C16 | 10 §3.3.5 constitution excerpt | The excerpt differs from 03's schema. | `mcpServer.roles` is not in 03: grant `mcp.connect` through role grants. `extensions.enabled` means enabled at adoption; `lockToConstitution` replaces "may require an amendment". `teen` in `grants` maps to `bandGrants.teen`. |
| C17 | 10 vs 08 | MCP token formats conflict (`vmcp_…` vs 08 `vpat_…`). Port 7778 is MCP in 10 but ICS in 08. 10 stores plugin/MCP secrets in plaintext files; 08 uses the vault. | 08/10 owners pick one token format and one port; secrets go in the 08 vault. |
| C18 | 08 §3.7.11 | 02 assumes `keyringSnapshot` includes `static.blobId` (stable blob addresses after restore). 08 lists only master + recovery slots. | Add `static.blobId` to the snapshot. Register HKDF label `fts-token` (fallback mode). |
| C19 | 08 §3.16.2 vs 11 §12-1 | TurnTrace retention is 30 d in 08 and 90 d in 11. | 02 keeps 30 d (configurable 7–365); 11 or 08 to align. |
| C20 | 06 reactions | 06 says reactions are not persisted, but 04 extraction windows need them. | 06 ingestion writes `message_reactions` for messages in bound conversations (02 §3.3.3). |
| C21 | 06 limits | Claim/link failure counters have no storage. | Use 02 `rate_limits`. |
| C22 | 05 §3.3.8 `DisclosureGuard.check` input | `{draft, plain, audience, sealed, usedLabels, turnId}` differs from 03 §3.6.1 `GuardInput`. | Adopt 03's `GuardInput` (`trigger`, `readableContext`, `strictness`, `kind`). |
| C23 | 05 `PendingConfirmation` wording | A7 rename. | Use `ConfirmationRequest` / `confirmation_requests` everywhere. 02 table fields merge 05 §3.6.6 and 03 §3.3.12. |
| C24 | 01 §5, §6.1 step 5, §6.4 | §5 is superseded by 02 §3.3.13. Step 5 ("store attachments as blobs") is superseded by A25. §6.4 is superseded by 02 §3.10.1. | Spine owner adds pointers. |
| C25 | 13 (browser demo P4) | Expects `@village/storage/memory` in-memory repositories; 02 does not define them. | 13/02 owners decide at M12 (SP-10). |
| C26 | 11 harness | Uses `createTestDb` and `exportDomainState`. | Now exposed in 02 §4.1. Confirm the names. |

## (c) Remaining risks

- **Schema size.** 02 now defines about 100 tables. JSON-schema identifiers such as `EventSourceSchema` and `ReminderScheduleSchema` are placeholders; the owning docs define them in M1-T8/M3/M7. Drizzle-kit output is unverified until M1-T7/T8.
- **Template YAMLs** do not yet contain the new consumer sections. The schema defaults apply until M4-T3 writes the delta-table values.
- **03 ↔ 07 action-kind and fairness alignment** (C1–C5) depends on cluster B. Until then, M4-T2's CI cross-check and M7 integration fail.
- **04 retrieval mechanics changed.** The ACL-token FTS was replaced by a join plus an eligible-set filter. Three vec0 metadata constraints at once (`IN` + `state` + `valid_to_ms`) are unverified; the M1-T2 spike must cover them. The BM25 corpus-statistics side channel is unchanged (accepted, 04 Q9).
- **`retrieval_state`** time transitions rely on nightly maintenance. Between `validTo` and archiving, the validity filter is applied at query time.
- **Crypto alignment** with 08 (AES-GCM wraps, RDK tree, `K_blobid` in the snapshot) assumes 08's current text. Any 08 change must be mirrored in 02 §3.6.1/§3.11/§3.14.
- **Owner-level question (not a D-item).** `fairness.ledgerVisibility: everyone` in most templates may conflict with 00 §6.3 ("opt-in per constitution") and 07's `self_only` proposal. Left unchanged; recommend the owner confirm.
- **Budgets.** Constitution budgets now default to `auto` (per-preset caps). A group that sets explicit numbers below the preset estimate will degrade early; the compiler warns only when clamping down.
