# R2 review log: runtime, channels, features, extensibility (05 / 06 / 07 / 10)

Reviewer cluster: `05-agent-runtime.md`, `06-channels.md`, `07-coordination-features.md`, `10-extensibility.md`. Date: 2026-11-01.
Normative sources applied: `01` §14 (A1–A28), `15` §2. Owner decisions D-1..D-8 were not decided (D-1 is only referenced).

The cluster now shares one set of interface decisions:
1. **Tool catalog.** 05 §3.6.7 is the single ordered built-in catalog: 62 tools plus the optional `web_search`.
2. **Buttons.** Every button uses a 06 `InteractionToken`, dispatched by the 05 router `interaction` decision with no model call.
3. **Confirmations.** They use the `ConfirmationRequest` entity under 03 §3.3.12.
4. **Message classes.** Outbox rows carry the A24 `messageClass`.
5. **Extension tools.** They are named `<providerId>__<tool>` with capability `plugin:<id>:<tool>`, and the cache is keyed by `catalogHash` (A13).
6. **Effects.** `TurnEffect` uses 02's `summaryKey`/`summaryParams` and the A23 `status`.
7. **Receipts.** The model quotes them verbatim.
8. **Private replies.** `replyTarget: 'requester_dm'` sends the reply to the requester's DM for that group (A27).
9. **Polls and read markers.** Polls use 06 `PollSpec`, `closePoll` returns `PollFinalTally | null`, and `permalink?` is available. Read markers arrive as a `ChannelEvent`.

**Fix count: 213** (05: 60 · 06: 41 · 07: 62 · 10: 50).

---

## (a) Fixes made

### 05-agent-runtime.md (60)
- 05 header: 01 §14 overrides stated; `@village/tools` scope now includes the three runtime tools.
- 05 §1 consumed table: 02 tables `outbox_messages`, `confirmation_requests` (A7); 06 owns `InteractionToken` + DM context (A27); 07 owns receipts, handlers, message classes (A24).
- 05 §2 D10/D11: catalog is per group (built-ins + group-enabled extensions) keyed by `catalogHash` (A13), replacing "instance catalog".
- 05 §2 D17: confirmations are `ConfirmationRequest` rows under 03 §3.3.12.
- 05 §3.1 file map: broken ref §3.6.8 → §3.6.7; owners 03/04/07/10; added `packages/tools/src/runtime/*`.
- 05 §3.2.1: `ReplyTarget` on `respond`/`command`; DM-redirect spec (`/catchup`, `calendar_feed_link` follow-up turn, `info.sent_privately`, `info.dm_needed`) per 07 SC-5 and A27.
- 05 §3.2.2 R1: unclaimed chats are dropped at ingestion; claim-code binding only (A27).
- 05 §3.2.2 R6: one DM conversation per group, with the active group resolved by 06 (A27).
- 05 §3.2.2 R13 + note: `extract = senderConsent === 'memory_on'` (A16; was `≠ memory_off`).
- 05 §3.2.4 `/catchup`: `catchup_digest` (nonexistent) → `catchup_generate`; group → `replyTarget:'requester_dm'` + `done` reaction (07 §3.8.1).
- 05 §3.2.4 `/forget`: `memory_search` (nonexistent) → `memory_recall`; confirmation always required (04 §3.9.2).
- 05 §3.2.4: added `/memory`, `/pin` (04), `/rules`, `/constraints` (03), `/list` (07), `/village plugins`, `/skill`, `/mcp` (10 §4.4); "Commands owned elsewhere" paragraph (06 channel commands, 09 `pair`/`dashboard`).
- 05 §3.2.4 `/chores`: `tasks.self` → `tasks.read` (view) / `tasks.self` (swap).
- 05 §3.2.4 `/settings`, `/export`: magic link → 09 sign-in per A9 (pairing default); renders `group_settings_view`.
- 05 §3.2.5: `cnf:<id>:<nonce>`, `cmd:…` and `poll:<id>:<opt>` payload strings replaced by 06 `InteractionToken` `action.kind`s. Added the handler registry, the no-model fast path and the full 07 handler list. Confirmation reactions are ✅/👍 or ❌/👎, on the confirmation message only. Telegram answers each callback exactly once. Text answers become synthetic interactions at ingestion. Read markers are `ChannelEvent`s. The nonce was removed.
- 05 §3.2.10: `ProactivityEngine.consider` → `ProactivityPort.submit` per candidate (07 §4.2); constitution `interjections.kinds` filter; 07 drop list.
- 05 §3.3.2: group audience includes outsider seats (A5).
- 05 §3.3.8: commit stamps `messageClass` + non-null `guardRef`; sets `ack_outbox_id`.
- 05 §3.3.9: system-turn classes `proactive` (interjection) / `digest` (A24).
- 05 §3.4.1: request comment → group catalog keyed by `catalogHash`.
- 05 §3.4.2 design notes: BP1 differs only by catalog; capabilities in per-turn system message (A13).
- 05 §3.4.2 charter: "use the receipt's text exactly as written" (07 §3.0.3); skill-subordination rule and attribution rule (10 §3.10.2, §3.11.1, F28).
- 05 §3.4.3: `<available_skills>` block in the group layer and sticky-skill rendering (10 §3.10.3).
- 05 §3.4.4: `<coordination>` snapshot from `CoordinationContextProvider` (07 §4.2) with a 600/300-token budget row.
- 05 §3.4.5: `attachment.fetch` (A25); turn enqueues fetch for still-pending trigger attachments (06 §3.10 step 5 gap).
- 05 §3.4.6: reserved tags + `coordination`, `available_skills`, `skill`.
- 05 §3.4.8: BP1 shared per `catalogHash`; invalidation rows for per-group extension enablement and the skills catalog.
- 05 §3.4.9: catalog order = §3.6.7 table then 10 §3.5.1 provider order (plugins and MCP interleaved); E-CAT ADR **ADR-021 → ADR-023** (021 = MCP per A12, 022 = analytics per A21).
- 05 §3.5.2: provider selection, endpoints and keys are host-only (A14).
- 05 §3.6.1: the built-in registry is frozen and extensions use the `ExtensionRegistry` generation (10). Naming moves from `p_<slug>_`/`mcp_<slug>_` to `<providerId>__<tool>` with `plugin:<id>:<tool>`. Timeouts are split between built-ins and extensions. The A23 fields `uses`, `confirm` and `grantsDelegation` and the 10-only fields are added. A deterministic rule covers the catalog token ceiling.
- 05 §3.6.3 step 4: `ActionRequest` A5 fields and `provenance.via`.
- 05 §3.6.3 step 6: `PendingConfirmation` → `ConfirmationRequest`; `TurnEffect{summaryKey}`.
- 05 §3.6.3 step 7: external effects journaled `intent` → `committed`/`failed` (A23, 10 §3.6.4).
- 05 §3.6.6: rewritten against 03 §3.3.12. Columns are now `capacity`, `eligible`, `quorum`, `reasons`, `summary`/`summaryLabel`, `delivery`, `options`, `onExpire`. Delivery is `inline`/`dm`/`dm_deeplink`, with `dm` forced for MCP. Buttons use tokens; reactions count only on the message, and text only as a reply to it. Added the rate limits, the `decide(ConfirmationResponse)` signature, `quorum:'all'` CAS, exactly one result message and 03's expiry TTLs plus `onExpire`.
- 05 §3.6.7: rebuilt as the single authoritative ordered catalog of 62 tools plus `web_search`. Memory tools follow 04 order, coordination 07 §4.1 order and governance/privacy 03's 8 tools. Runtime tools are defined here, and `use_skill`, `read_skill_file` and `extensions_enable` come from 10. Ten nonexistent names were removed (`memory_about_me`, `memory_search`, `reminder_cancel`, `chore_rotation_manage`, `chore_rotation_view`, `chore_swap_request`, `load_ledger_view`, `list_check_items`/`list_create`/`list_remove_items`, `poll_close`, `catchup_digest`, `constitution_view`).
- 05 §3.7.1: `TurnEffect` fields aligned to 02 (`summaryKey`/`summaryParams`) + A7/A23 (`idempotencyKey`, `status`); effect keys = 07 receipt `templateKey`s; new templates (`settings.updated`, `plugin.external*`); status-dependent rendering; ownership 03/04/07/10.
- 05 §3.7.2: recovery selects `ack_outbox_id IS NULL`, renders by status, never retries `intent`, stamps `messageClass='system'` + `guardRef`, routes `mcp` conversations to the member's DM (10 §12-8).
- 05 §3.7.3: ack check accepts verbatim receipts; acknowledgement via `ack_outbox_id`.
- 05 §3.8.4: `disableLinkPreview` → 06 `linkPreview: false`.
- 05 §3.8.7: outbox field table aligned with 02/06 (`op`, `messageClass` mapping, `priority`, `actions` with tokens, `visibility`/`notify`, `seq`, `guardRef`); Telegram toast exception.
- 05 §3.9.3: per-preset default budgets (A3) and D-1 reference.
- 05 §3.10.3: `/why` DM goes to the viewer's DM for this group (A27).
- 05 §3.11 copy: added `confirm.request.approver_deeplink`, `confirm.result.approved`, `err.generic` (was used but undefined), `info.sent_privately`, `info.dm_needed`.
- 05 §4.2: `ToolDefinition` A23 fields; `EffectResult.summaryKey/summaryParams`; new `ToolExecutionService.executeDirect` (10 MCP server); `ConfirmationService` returns `ConfirmationRequest`, `decide(ConfirmationResponse)`.
- 05 §4.3: consumed interfaces updated (`ProactivityPort`, `CoordinationContextProvider`, handler registry + tokens, `ToolCatalogService`, `SkillCatalogService`, `ConfirmationSpec`/`Response`).
- 05 §4.4: events go on the `DomainEventBus` port (A15).
- 05 §5: `confirmations` TTL keys per 03 rule 5; `budgets.defaultMonthlyUsd: 20` → `budgets.preset: auto` + overrides (A3); DB settings never hold host-only keys (A14).
- 05 §7: egress statement covers `relay_to_group`, ICS fetcher and SafeFetch.
- 05 §8.2: implications rewritten for A3; catalog-size caveat for the cost table.
- 05 §9.2: catalog-consistency CI test (names, order, action kinds).
- 05 §9.4: scenarios for the confirmation rules, the button fast path and `replyTarget`.
- 05 §9.5: `guardRecordId` → `guardRef`.
- 05 §10: acceptance updated for M3-T1, M3-T7, M3-T8, M4-T2, M7-T1 (62 tools, stubs for 10 tools), M7-T2 (`/list`, DM redirect) and M8-T1. Acceptance criteria were added to M9-T1, M10-T1, M11-T1, M12-T1 and M13-T1–T5, which had none. M2-T12 and M13 now reference ADR-023. Nothing was renumbered.
- 05 §11: Q1 resolved by A3 (D-1 referenced); Q12 resolved by 03 rule 1 (`dm_deeplink`).
- 05 §12: Status column on S1–S14 (S1/S2/S3/S4/S9 → A7; S7 → A3; S11 → A13; S12 → Rejected, superseded by A13; S8 → Deferred M13; S5/S6/S10/S13/S14 → Accepted, owned here); S3 text renamed to `ConfirmationRequest`.

### 06-channels.md (41; applied by the 06 sub-reviewer, verified)
- 06 §2 CH-1/CH-8/CH-17/CH-20: §4.1 authoritative (A26); Signal polls native only after SP-8 (A28); A27 DM mapping.
- 06 §3.1, §3.7 step 2, §3.21.1, §3.25 C09: Telegram `answerCallbackQuery` exactly once (fast-path toast or 2 s empty fallback); this fixes a double-answer bug.
- 06 §3.2: Signal `nativePolls:false` in the profile until SP-8 passes.
- 06 §3.3: `ChannelEvent` `read_marker` (Matrix `m.read`, web cursor, Signal own-message receipts).
- 06 §3.4: permalinks (`permalink?`) per platform; ref fix "spine 00 §6.2" → "00 §6.2".
- 06 §3.6: `canPing` uses `messageClass === 'proactive'` (A24).
- 06 §3.7: token example `{pendingActionId}` → `{confirmationId, option}`. Added the action-kind registry (05, 07 and 06 kinds) and the rule that the token is the only payload. The 07 tuple maps onto `InteractionTokenRecord`. The flow goes through the 05 `interaction` decision. Producers set TTLs. Confirmations follow 03 rule 2, with 👍/👎 where ✅/❌ are unavailable.
- 06 §3.8: `PollSpec` aligned to §4.1 (option index = 07 order, `multiSelect`, engine-side visibility); `closePoll` → `PollFinalTally | null`; Signal row gated on SP-8.
- 06 §3.10: no inline download (A25); consent fetch rule broadened to consent ≠ `memory_on` (A16).
- 06 §3.13: priority defaults by `messageClass`; `expiryClass` renamed to avoid clashing with A24 classes.
- 06 §3.16: adapter health affects `/healthz` at most as `degraded` and never `/readyz` (A15).
- 06 §3.17: command ownership (05 `help`/`why`; 06 channel commands; 09 `pair`/`dashboard`).
- 06 §3.18.1, §3.19, §3.23.6: Web login is pairing by default, magic link only where allowed (A9).
- 06 §3.20.1/§3.20.2/§3.20.4: A27 binding rule (single-use, 30-min TTL, host or admin); one unclaimed notice; M3 placeholder constitution, picker in M4; CLI renamed to 09's `village group claim`; `resume` doesn't bypass A27.
- 06 §3.21.4/§3.21.5/§3.21.6: Matrix/Signal/Web emit `read_marker`; new web read route.
- 06 §3.23.1/§3.23.2: setup guides use `village group claim`.
- 06 §4.1: `ChannelEvent` `read_marker`. `OutboundMessage.kind` (`reply|notice|proactive|system`) → `messageClass` with the five A24 classes. Added `PollFinalTally`, `closePoll?(): Promise<PollFinalTally | null>` and `permalink?`.
- 06 §4.3/§4.4: outbox A7 fields; `ReadMarker` record; read route.
- 06 §7: partial member listing → outsider seats (A5).
- 06 §10/§11 Q15: task-ID convention per A20. Extended acceptance on M3-T5, T10, T11, T12, T14, T17, T18 and M10-T10, T11, T12 (all tasks have acceptance criteria).
- 06 §12: Status on all 13 items.

### 07-coordination-features.md (62; 60 by the 07 sub-reviewer, verified; 2 by the cluster lead)
- 07 §2 KD-2/KD-9/KD-10/KD-12: 02 effect field names; fast path = 05 `interaction`; native polls via 06 `choosePollMode`, never native-anonymous, Signal after SP-8; catch-up DM per group (A27).
- 07 §3.0.1: `Group.timezone` via A7.
- 07 §3.0.3: receipts quoted verbatim; choice fallback via 06; handlers registered with 05's dispatcher (no model call); payloads = 06 tokens with explicit field mapping.
- 07 §3.0.4: `OutboxMessage.messageClass` (A7/A24) and 06 `OutboundMessage.messageClass`; tied to A22.
- 07 §3.0.7: coordination `catalog.ts` is the block imported by 05's `catalog.ts`.
- 07 §3.1.3: `calendar_rsvp` → `calendar.rsvp`; `calendar_feed_link` group behaviour → 05 follow-up turn with `replyTarget:'requester_dm'`.
- 07 §3.3.x: effort scale {1,2,3,5,8,13}. `LoadLedgerEntry` → 03 `LedgerEntry` with 03's kinds. `ADHOC_LOG_CAP_POINTS` replaces an undefined constitution key. `loadVisibility` → `ledgerVisibility`. `task_list`/`chores_load_view` → `tasks.read` (+ `fairness.ledger.read`).
- 07 §3.4.x: auto-capture requires `memory_on` (A16); `list_view` → `lists.read`.
- 07 §3.5.x: Poll → 06 `PollSpec` mapping. After-close polls are never native. `closePoll` tally reconciliation added. The live-tally edit rate is now 10 s (matching 06). `poll_vote` uses `polls.vote`. Fixed the anonymous-poll edge case.
- 07 §3.6.4 `plan_view` → `plans.read`; §3.7.2 `decision_search` → `decisions.read` (+ `memory.read`); permalinks adopted in 06.
- 07 §3.8.x: DM catch-up covers the active group only (A27). `/catchup` sets `replyTarget`, and the `done` reaction maps to 👌 on Telegram. Read markers arrive as a 06 `ChannelEvent`. `catchup_generate` uses `chat.ask`.
- 07 §3.9.x: digests keyed to 03 `proactivity.digests.*`; recap settings via `constitution_propose_amendment`, primary conversation via `group_settings_update` (05).
- 07 §3.10.x: `ProactivityPort.submit` entry point + router-kind mapping; consent gate per A16; undefined `/village pause` replaced; group budget = 03 `attentionBudgetPerDay`.
- 07 §4.1: declared the coordination block of 05 §3.6.7; capability column aligned to 03 §3.1.2.
- 07 §5/§6/§7/§8/§9.3/§10/§11: 03 constitution paths; A16 consent; `summaryKey`; Economy cost target vs $5 budget (A3); GS-17/GS-21; M7-T7, T11, T19, T24, M8-T2 and M10-T-C3 acceptance updated (all tasks have acceptance criteria); Q4, Q13, Q14 updated.
- 07 §12: Status on SC-1..SC-9.
- **(lead)** 07 §3.8.2 tool 38, §3.9.3 tool 40, §3.10.7 tool 41, §4.1 rows 38/40/41 + footnote: re-aligned to `participate`. The 03 reviewer added `participate` in parallel (A6), with exactly these own-scope meanings and registry kinds. Tool 38's kind `catchup.marker.set` became 03's `catchup.mark_read`.
- **(lead)** 07 §12 SC-1 status rewritten: Resolved by A6, with 03 defining `participate`.

### 10-extensibility.md (50; applied by the 10 sub-reviewer, verified)
- 10 §2 X-2/X-5/X-7/X-12: Node 26 primary, Node 24 ≥ 24.11 (A1); `<providerId>__<tool>` with `-`→`_`; ADR-021 (A12); catalogHash (A13).
- 10 §3.1: provider ids may not contain `--` (otherwise the model names would be ambiguous).
- 10 §3.2.1: no `node:*` in plugin-sdk root/testing exports (A11).
- 10 §3.2.3/§3.2.4: local names forbid `__`; memory-search callers per A11.
- 10 §3.2.5: channel plugins implement the full 06 §4.1 contract incl. `ingestEvent` (A26); digest sections are class `digest`, outside the attention budget (A24).
- 10 §3.2.6, §3.6.1, §3.7.4: confirmations persisted as `ConfirmationRequest` (A7); the MCP path always uses DM; `get_pending_action` statuses follow `ConfirmationRequest`.
- 10 §3.3.1/§3.3.5: BRAND placeholders (A2); `extensions.manage` per A6; `extensions_enable` fully specified as a 05 catalog member; memo key vs cache key clarified.
- 10 §3.4.4: RPC covers every 06 §4.1 method and `channel/ingestEvent` with `IngestAck` (A26).
- 10 §3.5.1: order file `packages/tools/src/catalog.ts` (was `catalog-order.ts`). Plugins and MCP servers interleave by providerId. Model names over 64 chars are rejected at install. Caching follows A13.
- 10 §3.6.4: intent rows use 02 `summaryKey`/`summaryParams`; intent copy no longer uses the not-yet-existing `{summary}`; never retried; recovery copy owned by 05.
- 10 §3.7.4: MCP server tools declared outside the model catalog (no `catalogHash` impact). The built-in mapping column was fixed to real catalog names, replacing names that didn't exist, and handlers read via `engine/readmodels`. The nonexistent `UsageRecord.via` was removed.
- 10 §3.9.1/§3.9.3: MCP client registration host-only (A14) with step-up (A9); MCP local-name normalization.
- 10 §3.10.3/§3.10.5/§3.11: skills tools declared as 05 catalog members; `school-year-kickoff` uses built-in ICS; only `weather` is preinstalled and `ics` is opt-in, positioned against 07 §3.1.6.
- 10 §4.3/§4.4/§5/§8: A23/A7 effect fields; one `mcp` conversation per (member, group); commands registered in 05/06; host-only keys marked (A14).
- 10 §10/§11/§12: A20 task-ID note. Acceptance updated for M2-T91, M5-T91, M12-T6, T7, T11, T16 (all 33 tasks have acceptance criteria). Q3 resolved by A1; Q13 references D-2. Status added on items 1–11.

---

## (b) Cross-cluster issues (not fixed; other docs)

**02-domain-model-and-storage.md**
- 02 §3.3.7 `turn_effects`: missing A7/A23 `idempotency_key` (unique), `status` (`intent|committed|failed`) and 05's stored `result_json` (05 §3.6.5 needs it to return the stored result on an idempotency hit). Also, `committed_at NOT NULL` contradicts `intent` rows. Fix: add the columns and make `committed_at` nullable, or add `created_at`.
- 02 §3.3.7 `turns`: `status` lacks A7's `queued|timed_out|cancelled`, and there are no `phase`/`root_turn_id`/`retry_of`/`effort` columns (05 S1). `kind` enum (`respond|interject|continuation|digest|reminder|recovery`) lacks `interaction`, `command`, `confirmation_resume` and `system` used by 05 §3.2.5/§3.6.6 and 07 §3.0.3. Fix: extend the enums per 05 §3.3.1.
- 02 §3.3.7 `outbox_messages`: no `message_class` column (A7/A24), although 02's own attention-ledger note (Q-OBX-5) filters on it. 06 also needs `parts_json`, `expiry_class`, `priority`, `in_flight_since` and `possible_duplicate`. Fix: add them.
- 02: no `confirmation_requests` table (A7; 03 says table `confirmation_requests`, prefix `cnf_`). Columns per 05 §3.6.6, statuses `pending|approved|rejected|expired|superseded|cancelled` (10 `get_pending_action` depends on them).
- 02: missing tables for 06 (`chat_bindings` or `conversations.status`, `channel_chat_aliases`, `dm_contexts`, `interaction_tokens`, `claim_codes`, `channel_state`, `read_markers`). Also missing for 07: `reminder_firings`, `event_overrides`, `calendar_subscriptions`, `feed_tokens`, `task_swaps`, `ledger_entries`, `proactive_candidates` and `proactivity_feedback`. And for 10: §4.3 entities, while 02's `plugin_state`/`plugin_approvals`/`mcp_clients` names don't match. `Conversation.channel` must allow `'mcp'`. Fix: add per the owning sections.
- 02 §3.2 (~line 316): "06 (§11 Q6)" for DM group choice is a wrong ref → 06 §3.4.

**03-group-intelligence.md**
- 03 §3.3.12 rule 3: button tokens defined as `HMAC-SHA256(instanceKey, confirmationId‖memberId‖option)`. A per-member token cannot sit on a shared group button, and this conflicts with 06 CH-7. Fix: reference 06 §3.7 opaque `InteractionToken` (`action.kind:'confirm'`, `{confirmationId, option}`, `allowedClickers` = eligible, single-use, hashed, constant-time).
- 03 §3.3.1 `ACTION_REGISTRY` vs 07 §4.1 "ActionRequest kind": 27 of the 42 coordination kinds are not registered in 03. Some are reads (`calendar.event.read`, `task.read`, …). Others are named differently (`list.items.add` vs `list.item.add`, `chore.rotation.upsert` vs `rotation.update`, `chore.swap.propose` vs `task.swap.request`, `calendar.event.cancel` vs `calendar.event.delete`, …). Nor are the kinds of 05's runtime tools or 10's `extensions_enable` (03 has `extension.enable`). 03:M4-T2's CI cross-check will fail. Fix: 03 and 07 agree one kind list, either by 03 registering 07's kinds or by 07 adopting 03's per-op kinds. Recommend 03 registers read kinds as low-risk `*.read` patterns and 07 adopts 03's write kinds.
- 03 §3.0/§10: the 8 governance/privacy tools (`constitution_show` … `privacy_info`) have names only, with no capability/effect/risk/schema table. 05 §3.6.7 lists effects inferred from names. Fix: add a tool table like 04 §3.9.7.
- 03 §3.2.2: the constitution schema lacks ~18 keys 07 consumes, among them `calendar.defaultDuration`, `tasks.assignmentMode`, `polls.defaultRule`, `proactivity.memberDailyBudget` and `quietHours.memberDefault` (full list in 07 §5). It also lacks the `extensions:` block (10 §3.3.5/§3.7.7) and `delegationId` on `SystemAuthority{onBehalfOf}`. Fix: add them, or declare them code constants.
- 03 §3.2.2 `proactivity.interjections.kinds` (`deadline_risk`, `decision_detected`) vs the 05 §3.2.10 router kinds (`missing_information`, `decision_made`, `task_request`) and the 07 candidate types. Fix: define the constitution kinds as the router kinds that 07 accepts, and map 07's detector-only types explicitly.
- 03 §3.2.9 templates: `ledgerVisibility: everyone` default vs 00 §6.3 "opt-in per constitution" and 07 Q14 (`self_only`). An owner-level call may be needed if 03 keeps `everyone`. `attentionBudgetPerDay` values for club/parents-class/trip differ from 07's proposals (07 now defers to 03).

**04-memory-system.md**
- 04 §3.9.7 `memory_remember`: should state that untrusted provenance (`via:'mcp'`) yields a `proposed` item, as 10's MCP `remember` assumes.

**06 ↔ 09**
- 09 §3.9.4/§3.11.3 claim codes vs 06 §3.20.1 (CH-3). The link tokens differ: 40-bit in 09, 128-bit in 06. The prefix maps differ: 09 uses `c_` for the host and `g_` for groups, while 06 uses `c_` for groups. The display formats differ (`7K2M-9QXA` vs `VLG-XXXX-XXXX`). `village group claim` lacks `--channel`/`--group`. 09 says "only the host creates group codes in v1", but A27 allows host or admin. The attempt limits are not reconciled. Fix: align on one scheme (recommend 06's 128-bit link token) and state both limits.

**07 ↔ 10**
- 07 §3.9: no hook for plugin digest sections (`defineDigestSection`, 10 §3.2.5; class `digest`, untrusted, ≤ 5 lines). 07 §3.1.6 should mention the opt-in `ics` plugin and warn against subscribing one URL both ways.

**08-security-privacy.md**
- 08 §3.14: plugin manifest field names (`net.hosts`, `fs.data`, `data.ceiling`…), the CLI (`village plugins approve`) and the launch flags (`--disable-proto=throw`, 256 MB heap, 1 MiB RPC line, 30 s timeouts) differ from 10's authoritative schema and values. 08 M12-T80/T81 overlap 10 M12-T3/T5. Fix: 08 defers names and numbers to 10, and 14 merges the tasks.

**13-docs-launch-community.md**
- 13 (P6 area): "ADR-021 'Project website analytics'" collides with ADR-021 = MCP SDK (A12). A21 assigns analytics to ADR-022. 05 now uses ADR-023 for the tool-catalog decision. Fix: renumber 13's ADR to 022.

**01-architecture.md / 14**
- 01 §14 A7: the entity list omits 06's `ChatBinding`, `ChannelChatAlias`, `DmContext`, `InteractionToken`, `LinkCode` and `ReadMarker`, and 10's full §4.3 set. Fix: add "06:" and expand "10:" bullets.
- 01 §6.1 router: "slash command or button callback → `respond`" contradicts 05 S13/07 SC-5 (deterministic `interaction`, no model call). 05 S13 is marked Accepted and pending the 14 consistency pass.
- 01 §14 A12 lists SDK packages server/client/hono; 10 §3.0 also uses `@modelcontextprotocol/node` (stdio). The M12-T0 spike must confirm, then add `node` to ADR-021.
- 14: register **ADR-023** (tool-catalog strategy, from 05 M2-T12/M13) in the ADR list.

---

## (c) Remaining risks

1. **Catalog size and cost.** The authoritative built-in catalog grew from 42 to 62 tools, plus `web_search`. 05's 7 000-token CI ceiling and the Economy ≤ $3/month estimate (and therefore the A3/D-1 cost basis) are likely to be exceeded, and extension tools add up to 8k per group. A deterministic rule is in 05 §3.6.1: measure in M7-T1, record in ADR-023 and recompute §8.2 in M13-T3. The published cost numbers may still move.
2. **Action-kind registry mismatch (03 ↔ 07).** It will fail 03:M4-T2's CI cross-check until 03 and 07 agree one list. This is the largest integration risk for M4/M7.
3. **02 schema lag.** `confirmation_requests`, `TurnEffect.status`/`idempotency_key`, `outbox.message_class`, turn statuses/kinds, and most 06/07/10 tables are not yet in 02. M3-T6, M3-T8, M3-T10–T12, M4-T2 and M7 cannot start until 02 adds them. A parallel reviewer may already be fixing this.
4. **03 constitution-schema gaps** (07 and 10 keys): until they are added, 07/10 defaults are code constants, and a strict-schema mismatch would reject valid constitutions.
5. **Telegram fast path.** The single `answerCallbackQuery` must happen within ~2 s, or the denial toast is lost and the ephemeral fallback is used instead. 06 M3-T14 has the timing test. Channel plugins proxy this over RPC, and that latency is unmeasured.
6. **Claim-code scheme divergence (06 ↔ 09)** stays unresolved, and the setup guides depend on it.
7. **Signal native polls** depend on SP-8. Both poll paths must stay tested (07 GS-25 variants).
8. **Inferred semantics.** The three runtime tools (`group_settings_view`, `group_settings_update`, `member_list`) and the effects of 03's eight tools were defined or inferred here. 03 and 09 should confirm them.
9. **Charter length.** The charter grew by about 150 tokens (receipt and skill rules) against the ≤ 2 300-token CI budget. Re-measure in M3-T5.
10. **`participate` churn.** 07 briefly dropped `participate` and is now re-aligned with 03's new definition. If 03 later removes it, 07 tools 38, 40 and 41 must move back to `chat.ask`/`profile.self`.
