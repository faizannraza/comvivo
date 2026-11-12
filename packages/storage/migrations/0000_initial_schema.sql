CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`chain_key` text NOT NULL,
	`seq` integer NOT NULL,
	`group_id` text,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`decision` text NOT NULL,
	`details` text NOT NULL,
	`prev_hash` blob NOT NULL,
	`hash` blob NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "audit_seq_ck" CHECK("audit_events"."seq" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_chain_seq_uq` ON `audit_events` (`chain_key`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_group_at_idx` ON `audit_events` (`group_id`,`at`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`group_id` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`mime` text NOT NULL,
	`storage_addr` text NOT NULL,
	`wrapped_dek` blob NOT NULL,
	`wrap_nonce` blob NOT NULL,
	`kek_version` integer NOT NULL,
	`state` text DEFAULT 'stored' NOT NULL,
	`created_at` integer NOT NULL,
	`unreferenced_since` integer,
	PRIMARY KEY(`group_id`, `sha256`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "blobs_size_ck" CHECK("blobs"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blobs_storage_addr_unique` ON `blobs` (`storage_addr`);--> statement-breakpoint
CREATE INDEX `blobs_unref_idx` ON `blobs` (`unreferenced_since`) WHERE "blobs"."unreferenced_since" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `calendar_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`url_ciphertext` blob NOT NULL,
	`url_host` text NOT NULL,
	`owner_member_id` text NOT NULL,
	`label_id` integer NOT NULL,
	`refresh_interval` text DEFAULT 'PT6H' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`etag` text,
	`last_modified` text,
	`last_fetch_at` integer,
	`last_success_at` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`event_count` integer DEFAULT 0 NOT NULL,
	`color` text,
	`lead_times` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "calendar_subscriptions_counts_ck" CHECK("calendar_subscriptions"."failure_count" >= 0 AND "calendar_subscriptions"."event_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `calendar_subscriptions_group_idx` ON `calendar_subscriptions` (`group_id`,`status`);--> statement-breakpoint
CREATE TABLE `catchup_cursors` (
	`member_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`explicit_marker_rid` integer,
	`read_receipt_rid` integer,
	`last_own_message_at` integer,
	`last_interaction_at` integer,
	`last_catchup_at` integer,
	PRIMARY KEY(`member_id`, `conversation_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`platform_user_id` text NOT NULL,
	`person_id` text NOT NULL,
	`display_name_snapshot` text NOT NULL,
	`platform_username` text,
	`is_bot` integer DEFAULT false NOT NULL,
	`dm_reachable` integer DEFAULT false NOT NULL,
	`dm_chat_id` text,
	`verified_at` integer,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "channel_identities_is_bot_ck" CHECK("channel_identities"."is_bot" IN (0, 1)),
	CONSTRAINT "channel_identities_dm_reachable_ck" CHECK("channel_identities"."dm_reachable" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_identities_platform_uq` ON `channel_identities` (`channel`,`platform_user_id`);--> statement-breakpoint
CREATE INDEX `channel_identities_person_idx` ON `channel_identities` (`person_id`);--> statement-breakpoint
CREATE TABLE `confirmation_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`turn_id` text,
	`conversation_id` text,
	`proposal_id` text,
	`capacity` text NOT NULL,
	`requester_member_id` text NOT NULL,
	`eligible_member_ids` text NOT NULL,
	`quorum` text NOT NULL,
	`reasons` text NOT NULL,
	`action_digest` text NOT NULL,
	`tool_name` text,
	`input_ciphertext` blob,
	`action_request` text,
	`target_version` integer,
	`summary` text NOT NULL,
	`summary_label_id` integer NOT NULL,
	`delivery` text NOT NULL,
	`options` text NOT NULL,
	`nonce` text NOT NULL,
	`prompt_outbox_ids` text NOT NULL,
	`responses` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`on_expire` text NOT NULL,
	`decided_by_member_id` text,
	`decided_at` integer,
	`label_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requester_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `confirmations_pending_idx` ON `confirmation_requests` (`group_id`,`expires_at`) WHERE "confirmation_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `confirmations_pair_idx` ON `confirmation_requests` (`requester_member_id`,`status`);--> statement-breakpoint
CREATE TABLE `consent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`group_id` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`via` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `consent_events_member_idx` ON `consent_events` (`member_id`,`at`);--> statement-breakpoint
CREATE TABLE `constitution_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`version` integer NOT NULL,
	`parent_version_id` text,
	`yaml` text NOT NULL,
	`yaml_sha256` text NOT NULL,
	`charter_text` text NOT NULL,
	`compiled` text NOT NULL,
	`compiler_version` text NOT NULL,
	`adopted_via` text NOT NULL,
	`adopted_by` text NOT NULL,
	`proposal_id` text,
	`adopted_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `constitution_versions_group_version_uq` ON `constitution_versions` (`group_id`,`version`);--> statement-breakpoint
CREATE TABLE `constraint_records` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`catalog_version` text NOT NULL,
	`value` text NOT NULL,
	`subject_member_id` text NOT NULL,
	`owner_member_ids` text NOT NULL,
	`attribution` text NOT NULL,
	`reason_disclosure` text DEFAULT 'none' NOT NULL,
	`scope` text NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`status` text NOT NULL,
	`approved_by` text NOT NULL,
	`approval_mode` text,
	`label_id` integer NOT NULL,
	`sealed_source_refs` text NOT NULL,
	`sealed_label_id` integer NOT NULL,
	`supersedes_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `constraints_active_idx` ON `constraint_records` (`group_id`,`kind`,`valid_from`) WHERE "constraint_records"."status" = 'active';--> statement-breakpoint
CREATE INDEX `constraints_subject_idx` ON `constraint_records` (`subject_member_id`,`status`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`channel` text NOT NULL,
	`platform_chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`member_id` text,
	`primary` integer DEFAULT false NOT NULL,
	`title` text,
	`bound_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversations_dm_ck" CHECK(("conversations"."kind" = 'dm') = ("conversations"."member_id" IS NOT NULL)),
	CONSTRAINT "conversations_primary_ck" CHECK("conversations"."primary" = 0 OR "conversations"."kind" = 'group'),
	CONSTRAINT "conversations_primary_bool_ck" CHECK("conversations"."primary" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_platform_uq` ON `conversations` (`channel`,`platform_chat_id`,`group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_one_primary_uq` ON `conversations` (`group_id`) WHERE "conversations"."primary" = 1;--> statement-breakpoint
CREATE INDEX `conversations_group_idx` ON `conversations` (`group_id`,`kind`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`rid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`summary` text NOT NULL,
	`rationale` text,
	`topic_tags` text NOT NULL,
	`decided_by` text NOT NULL,
	`alternatives_rejected` text NOT NULL,
	`source_refs` text NOT NULL,
	`origin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`supersedes_id` text,
	`superseded_by_id` text,
	`label_id` integer NOT NULL,
	`memory_item_id` text,
	`proposal_id` text,
	`decided_at` integer NOT NULL,
	`decided_tz` text NOT NULL,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memory_item_id`) REFERENCES `memory_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_id_unique` ON `decisions` (`id`);--> statement-breakpoint
CREATE INDEX `decisions_group_decided_idx` ON `decisions` (`group_id`,`decided_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_memory_uq` ON `decisions` (`memory_item_id`) WHERE "decisions"."memory_item_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `declassifications` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_label_id` integer NOT NULL,
	`target_label_id` integer NOT NULL,
	`approved_by` text NOT NULL,
	`content_digest` blob NOT NULL,
	`action_digest` text,
	`constraint_id` text,
	`subject_refs` text NOT NULL,
	`turn_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `declassifications_group_idx` ON `declassifications` (`group_id`,`at`);--> statement-breakpoint
CREATE INDEX `declassifications_action_idx` ON `declassifications` (`group_id`,`action_digest`) WHERE "declassifications"."action_digest" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`subject_ref` text NOT NULL,
	`group_id` text,
	`requested_by` text NOT NULL,
	`status` text NOT NULL,
	`progress` text NOT NULL,
	`requested_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `deletions_status_idx` ON `deletions` (`status`);--> statement-breakpoint
CREATE TABLE `embedding_spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`dims` integer NOT NULL,
	`table_name` text NOT NULL,
	`status` text NOT NULL,
	`backfill_cursor_rid` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	`retired_at` integer,
	CONSTRAINT "embedding_spaces_dims_ck" CHECK("embedding_spaces"."dims" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embedding_spaces_table_name_unique` ON `embedding_spaces` (`table_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `embedding_spaces_one_active_uq` ON `embedding_spaces` (`status`) WHERE "embedding_spaces"."status" = 'active';--> statement-breakpoint
CREATE TABLE `event_attendee_overrides` (
	`event_id` text NOT NULL,
	`member_id` text NOT NULL,
	`recurrence_id` text NOT NULL,
	`rsvp` text NOT NULL,
	PRIMARY KEY(`event_id`, `member_id`, `recurrence_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `event_attendees` (
	`event_id` text NOT NULL,
	`member_id` text NOT NULL,
	`rsvp` text DEFAULT 'needs_action' NOT NULL,
	`note` text,
	`note_label_id` integer,
	`responded_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `member_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `event_attendees_member_idx` ON `event_attendees` (`member_id`);--> statement-breakpoint
CREATE TABLE `event_overrides` (
	`event_id` text NOT NULL,
	`recurrence_id` text NOT NULL,
	`patch` text NOT NULL,
	`cancelled` integer DEFAULT false NOT NULL,
	`start_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`event_id`, `recurrence_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "event_overrides_cancelled_bool_ck" CHECK("event_overrides"."cancelled" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `events` (
	`rid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`series_id` text NOT NULL,
	`split_from_event_id` text,
	`title` text NOT NULL,
	`notes` text,
	`url` text,
	`location` text,
	`all_day` integer DEFAULT false NOT NULL,
	`tz` text NOT NULL,
	`start_local` text NOT NULL,
	`end_local` text,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`rrule` text,
	`rrule_invalid` integer DEFAULT false NOT NULL,
	`rdates` text NOT NULL,
	`exdates` text NOT NULL,
	`recurrence_until_at` integer,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`busy` integer NOT NULL,
	`attendees_mode` text DEFAULT 'none' NOT NULL,
	`lead_times` text,
	`source` text NOT NULL,
	`subscription_id` text,
	`source_uid` text,
	`source_recurrence_id` text,
	`content_hash` blob,
	`plan_id` text,
	`label_id` integer NOT NULL,
	`created_by_member_id` text,
	`updated_by_member_id` text,
	`ics_uid` text NOT NULL,
	`ics_sequence` integer DEFAULT 0 NOT NULL,
	`tzdata_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_all_day_bool_ck" CHECK("events"."all_day" IN (0, 1)),
	CONSTRAINT "events_rrule_invalid_bool_ck" CHECK("events"."rrule_invalid" IN (0, 1)),
	CONSTRAINT "events_busy_bool_ck" CHECK("events"."busy" IN (0, 1)),
	CONSTRAINT "events_ics_sequence_ck" CHECK("events"."ics_sequence" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_unique` ON `events` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_ics_uid_unique` ON `events` (`ics_uid`);--> statement-breakpoint
CREATE INDEX `events_group_start_idx` ON `events` (`group_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `events_group_recurring_idx` ON `events` (`group_id`,`recurrence_until_at`) WHERE "events"."rrule" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `events_series_idx` ON `events` (`series_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_subscription_src_uq` ON `events` (`subscription_id`,`source_uid`) WHERE "events"."subscription_id" IS NOT NULL AND "events"."source_recurrence_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `events_subscription_src_rec_uq` ON `events` (`subscription_id`,`source_uid`,`source_recurrence_id`) WHERE "events"."subscription_id" IS NOT NULL AND "events"."source_recurrence_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `extraction_cursors` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`last_rid` integer DEFAULT 0 NOT NULL,
	`extractor_version` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `forget_fingerprints` (
	`group_id` text NOT NULL,
	`fp_hmac` blob NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `fp_hmac`)
);
--> statement-breakpoint
CREATE TABLE `forget_source_blocks` (
	`group_id` text NOT NULL,
	`message_id_hmac` blob NOT NULL,
	`kind` text NOT NULL,
	`subject_hash` blob NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `message_id_hmac`, `kind`, `subject_hash`)
);
--> statement-breakpoint
CREATE INDEX `forget_source_blocks_expiry_idx` ON `forget_source_blocks` (`expires_at`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`archetype` text NOT NULL,
	`constitution_version_id` text,
	`history_visibility` text DEFAULT 'since_join' NOT NULL,
	`timezone` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`primary_conversation_id` text,
	`week_start` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`membership_epoch` integer DEFAULT 0 NOT NULL,
	`extensions_version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "groups_week_start_ck" CHECK("groups"."week_start" BETWEEN 1 AND 7)
);
--> statement-breakpoint
CREATE INDEX `groups_status_idx` ON `groups` (`status`);--> statement-breakpoint
CREATE TABLE `guardian_relations` (
	`group_id` text NOT NULL,
	`ward_member_id` text NOT NULL,
	`guardian_member_id` text NOT NULL,
	`created_by_member_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`ward_member_id`, `guardian_member_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ward_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`guardian_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `guardian_relations_guardian_idx` ON `guardian_relations` (`guardian_member_id`);--> statement-breakpoint
CREATE TABLE `ics_feed_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`member_id` text NOT NULL,
	`token_hash` blob NOT NULL,
	`scope` text NOT NULL,
	`detail` text DEFAULT 'full' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ics_feed_tokens_token_hash_unique` ON `ics_feed_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ics_feed_tokens_member_idx` ON `ics_feed_tokens` (`member_id`);--> statement-breakpoint
CREATE TABLE `instance` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`owner_person_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "instance_singleton_ck" CHECK("instance"."singleton" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instance_singleton_unique` ON `instance` (`singleton`);--> statement-breakpoint
CREATE TABLE `job_partitions` (
	`partition_key` text PRIMARY KEY NOT NULL,
	`last_claimed_at` integer NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	CONSTRAINT "job_partitions_paused_bool_ck" CHECK("job_partitions"."paused" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `job_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`partition_key` text NOT NULL,
	`spec` text NOT NULL,
	`payload` text NOT NULL,
	`misfire` text NOT NULL,
	`misfire_grace_ms` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`last_fired_at` integer,
	`owner_ref` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "job_schedules_enabled_bool_ck" CHECK("job_schedules"."enabled" IN (0, 1)),
	CONSTRAINT "job_schedules_grace_ck" CHECK("job_schedules"."misfire_grace_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX `job_schedules_due_idx` ON `job_schedules` (`next_run_at`) WHERE "job_schedules"."enabled" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `job_schedules_owner_uq` ON `job_schedules` (`owner_ref`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`partition_key` text NOT NULL,
	`serial` integer NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`run_at` integer NOT NULL,
	`idempotency_key` text,
	`debounce_key` text,
	`debounce_deadline_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`lease_owner` text,
	`lease_until` integer,
	`last_error` text,
	`enqueued_by` text,
	`trace_id` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	CONSTRAINT "jobs_payload_size_ck" CHECK(length("jobs"."payload") <= 65536),
	CONSTRAINT "jobs_serial_bool_ck" CHECK("jobs"."serial" IN (0, 1)),
	CONSTRAINT "jobs_priority_ck" CHECK("jobs"."priority" BETWEEN -10 AND 10),
	CONSTRAINT "jobs_attempts_ck" CHECK("jobs"."attempts" >= 0 AND "jobs"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE INDEX `jobs_queued_due_idx` ON `jobs` (`run_at`,`priority`) WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX `jobs_leased_until_idx` ON `jobs` (`lease_until`) WHERE "jobs"."status" = 'leased';--> statement-breakpoint
CREATE INDEX `jobs_leased_partition_idx` ON `jobs` (`partition_key`) WHERE "jobs"."status" = 'leased' AND "jobs"."serial" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_uq` ON `jobs` (`idempotency_key`) WHERE "jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_debounce_uq` ON `jobs` (`debounce_key`) WHERE "jobs"."debounce_key" IS NOT NULL AND "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX `jobs_terminal_finished_idx` ON `jobs` (`status`,`finished_at`) WHERE "jobs"."status" IN ('succeeded','dead','cancelled');--> statement-breakpoint
CREATE INDEX `jobs_partition_status_idx` ON `jobs` (`partition_key`,`status`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`reader_set_id` integer NOT NULL,
	`owner_member_id` text,
	`co_owner_member_ids` text NOT NULL,
	`sensitivity` text NOT NULL,
	`influence` text NOT NULL,
	`untrusted` integer NOT NULL,
	`canonical_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reader_set_id`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "labels_untrusted_ck" CHECK("labels"."untrusted" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_group_key_uq` ON `labels` (`group_id`,`canonical_key`);--> statement-breakpoint
CREATE INDEX `labels_group_idx` ON `labels` (`group_id`,`id`);--> statement-breakpoint
CREATE INDEX `labels_owner_idx` ON `labels` (`owner_member_id`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`category` text,
	`points` real NOT NULL,
	`task_id` text,
	`rotation_id` text,
	`source_ref` text,
	`reverses_id` text,
	`label_id` integer NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`rotation_id`) REFERENCES `rotations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ledger_group_member_at_idx` ON `ledger_entries` (`group_id`,`member_id`,`at`);--> statement-breakpoint
CREATE TABLE `list_category_overrides` (
	`group_id` text NOT NULL,
	`list_kind` text NOT NULL,
	`normalized_key` text NOT NULL,
	`category` text NOT NULL,
	PRIMARY KEY(`group_id`, `list_kind`, `normalized_key`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `list_items` (
	`rid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`list_id` text NOT NULL,
	`group_id` text NOT NULL,
	`text` text NOT NULL,
	`normalized_key` text NOT NULL,
	`quantity` text,
	`category` text,
	`note` text,
	`checked` integer DEFAULT false NOT NULL,
	`checked_by_member_id` text,
	`checked_at` integer,
	`added_by_member_id` text,
	`added_via` text DEFAULT 'explicit' NOT NULL,
	`source_message_id` text,
	`position` text NOT NULL,
	`label_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`checked_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`added_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "list_items_checked_bool_ck" CHECK("list_items"."checked" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `list_items_id_unique` ON `list_items` (`id`);--> statement-breakpoint
CREATE INDEX `list_items_list_idx` ON `list_items` (`list_id`,`checked`,`position`);--> statement-breakpoint
CREATE INDEX `list_items_key_idx` ON `list_items` (`list_id`,`normalized_key`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'generic' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`categories_enabled` integer DEFAULT true NOT NULL,
	`plan_id` text,
	`label_id` integer NOT NULL,
	`created_by_member_id` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lists_is_default_bool_ck" CHECK("lists"."is_default" IN (0, 1)),
	CONSTRAINT "lists_categories_enabled_bool_ck" CHECK("lists"."categories_enabled" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lists_group_name_uq` ON `lists` (`group_id`,lower("name")) WHERE "lists"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `lists_default_kind_uq` ON `lists` (`group_id`,`kind`) WHERE "lists"."is_default" = 1 AND "lists"."archived_at" IS NULL;--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text NOT NULL,
	`age_band` text DEFAULT 'adult' NOT NULL,
	`handle` text NOT NULL,
	`status` text NOT NULL,
	`consent` text DEFAULT 'unknown' NOT NULL,
	`nickname` text,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "members_ageband_ck" CHECK(("members"."role" = 'child') = ("members"."age_band" <> 'adult'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_group_person_uq` ON `members` (`group_id`,`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_group_handle_uq` ON `members` (`group_id`,`handle`);--> statement-breakpoint
CREATE INDEX `members_person_idx` ON `members` (`person_id`);--> statement-breakpoint
CREATE INDEX `members_group_status_idx` ON `members` (`group_id`,`status`);--> statement-breakpoint
CREATE TABLE `memory_access_stats` (
	`memory_rid` integer PRIMARY KEY NOT NULL,
	`retrieved_count` integer DEFAULT 0 NOT NULL,
	`last_retrieved_at` integer,
	FOREIGN KEY (`memory_rid`) REFERENCES `memory_items`(`rid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memory_access_count_ck" CHECK("memory_access_stats"."retrieved_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `memory_consolidation_state` (
	`group_id` text PRIMARY KEY NOT NULL,
	`watermark_seq` integer DEFAULT 0 NOT NULL,
	`section_hashes` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memory_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`relation` text,
	`is_minor` integer,
	`possible_same_as` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memory_entities_is_minor_ck" CHECK("memory_entities"."is_minor" IS NULL OR "memory_entities"."is_minor" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `memory_entities_group_idx` ON `memory_entities` (`group_id`);--> statement-breakpoint
CREATE TABLE `memory_entity_aliases` (
	`entity_id` text NOT NULL,
	`group_id` text NOT NULL,
	`alias_norm` text NOT NULL,
	`alias_display` text NOT NULL,
	`label_id` integer NOT NULL,
	PRIMARY KEY(`entity_id`, `alias_norm`, `label_id`),
	FOREIGN KEY (`entity_id`) REFERENCES `memory_entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_aliases_lookup_idx` ON `memory_entity_aliases` (`group_id`,`alias_norm`,`label_id`);--> statement-breakpoint
CREATE TABLE `memory_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_events_group_seq_idx` ON `memory_events` (`group_id`,`seq`);--> statement-breakpoint
CREATE TABLE `memory_item_entities` (
	`memory_rid` integer NOT NULL,
	`entity_id` text NOT NULL,
	PRIMARY KEY(`memory_rid`, `entity_id`),
	FOREIGN KEY (`memory_rid`) REFERENCES `memory_items`(`rid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `memory_entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_item_entities_entity_idx` ON `memory_item_entities` (`entity_id`,`memory_rid`);--> statement-breakpoint
CREATE TABLE `memory_items` (
	`rid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`statement` text NOT NULL,
	`search_terms` text NOT NULL,
	`language` text NOT NULL,
	`fingerprint` blob NOT NULL,
	`label_id` integer NOT NULL,
	`provenance` text NOT NULL,
	`confidence` real NOT NULL,
	`status` text NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`supersedes_id` text,
	`superseded_by_id` text,
	`contradicts` text NOT NULL,
	`links` text NOT NULL,
	`retrieval_state` integer NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`pinned_at` integer,
	`archived_at` integer,
	`last_confirmed_at` integer,
	`retract_reason` text,
	`portable` integer DEFAULT false NOT NULL,
	`embedding_state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supersedes_id`) REFERENCES `memory_items`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "memory_confidence_ck" CHECK("memory_items"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "memory_state_ck" CHECK("memory_items"."retrieval_state" BETWEEN 0 AND 3),
	CONSTRAINT "memory_valid_ck" CHECK("memory_items"."valid_to" IS NULL OR "memory_items"."valid_to" >= "memory_items"."valid_from"),
	CONSTRAINT "memory_pinned_bool_ck" CHECK("memory_items"."pinned" IN (0, 1)),
	CONSTRAINT "memory_portable_bool_ck" CHECK("memory_items"."portable" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_items_id_unique` ON `memory_items` (`id`);--> statement-breakpoint
CREATE INDEX `memory_group_status_updated_idx` ON `memory_items` (`group_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `memory_supersedes_idx` ON `memory_items` (`supersedes_id`) WHERE "memory_items"."supersedes_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `memory_label_idx` ON `memory_items` (`label_id`);--> statement-breakpoint
CREATE INDEX `memory_embed_pending_idx` ON `memory_items` (`group_id`,`rid`) WHERE "memory_items"."embedding_state" = 'pending' AND "memory_items"."status" <> 'retracted';--> statement-breakpoint
CREATE INDEX `memory_fingerprint_idx` ON `memory_items` (`group_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `memory_pinned_idx` ON `memory_items` (`group_id`) WHERE "memory_items"."pinned" = 1;--> statement-breakpoint
CREATE TABLE `memory_ops_applied` (
	`window_key` text NOT NULL,
	`op_index` integer NOT NULL,
	`applied_at` integer NOT NULL,
	PRIMARY KEY(`window_key`, `op_index`)
);
--> statement-breakpoint
CREATE TABLE `memory_sources` (
	`memory_rid` integer NOT NULL,
	`source_ref` text NOT NULL,
	`message_id` text,
	`window_key` text,
	`span` text,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`memory_rid`, `source_ref`),
	FOREIGN KEY (`memory_rid`) REFERENCES `memory_items`(`rid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memory_sources_message_idx` ON `memory_sources` (`message_id`) WHERE "memory_sources"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `memory_subjects` (
	`memory_rid` integer NOT NULL,
	`group_id` text NOT NULL,
	`subject_ref` text NOT NULL,
	`role` text DEFAULT 'about' NOT NULL,
	PRIMARY KEY(`memory_rid`, `subject_ref`),
	FOREIGN KEY (`memory_rid`) REFERENCES `memory_items`(`rid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_subjects_lookup_idx` ON `memory_subjects` (`group_id`,`subject_ref`,`memory_rid`);--> statement-breakpoint
CREATE TABLE `memory_tombstones` (
	`memory_id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`forgotten_at` integer NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`file_name` text,
	`mime` text NOT NULL,
	`size_bytes` integer,
	`blob_sha256` text,
	`status` text NOT NULL,
	`platform_ref` text NOT NULL,
	`fetch_job_id` text,
	`derived_message_id` text,
	`label_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`,`blob_sha256`) REFERENCES `blobs`(`group_id`,`sha256`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attachments_size_ck" CHECK("message_attachments"."size_bytes" IS NULL OR "message_attachments"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `message_attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `attachments_blob_idx` ON `message_attachments` (`group_id`,`blob_sha256`) WHERE "message_attachments"."blob_sha256" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`message_rid` integer NOT NULL,
	`member_id` text NOT NULL,
	`emoji` text NOT NULL,
	`group_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`message_rid`, `member_id`, `emoji`),
	FOREIGN KEY (`message_rid`) REFERENCES `messages`(`rid`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`rid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`sender_member_id` text,
	`sender_identity_id` text,
	`platform_message_id` text,
	`platform_thread_id` text,
	`dedupe_key` blob,
	`text` text DEFAULT '' NOT NULL,
	`rich_text` text,
	`reply_to_message_id` text,
	`derived_from_message_id` text,
	`forwarded` text,
	`untrusted` integer DEFAULT false NOT NULL,
	`label_id` integer NOT NULL,
	`sent_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`delivered_late` integer DEFAULT false NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`edited_at` integer,
	`edit_count` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`redacted_at` integer,
	`turn_id` text,
	`client_message_id` text,
	`retention_until` integer,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_identity_id`) REFERENCES `channel_identities`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "messages_untrusted_ck" CHECK("messages"."untrusted" IN (0, 1)),
	CONSTRAINT "messages_delivered_late_ck" CHECK("messages"."delivered_late" IN (0, 1)),
	CONSTRAINT "messages_truncated_ck" CHECK("messages"."truncated" IN (0, 1)),
	CONSTRAINT "messages_edit_count_ck" CHECK("messages"."edit_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_id_unique` ON `messages` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_dedupe_uq` ON `messages` (`dedupe_key`) WHERE "messages"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conv_platform_uq` ON `messages` (`conversation_id`,`platform_message_id`) WHERE "messages"."platform_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_conv_rid_idx` ON `messages` (`conversation_id`,`rid`);--> statement-breakpoint
CREATE INDEX `messages_group_sender_idx` ON `messages` (`group_id`,`sender_member_id`,`rid`);--> statement-breakpoint
CREATE INDEX `messages_retention_idx` ON `messages` (`retention_until`) WHERE "messages"."retention_until" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_client_id_uq` ON `messages` (`conversation_id`,`client_message_id`) WHERE "messages"."client_message_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `outbox_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text,
	`conversation_id` text NOT NULL,
	`turn_id` text,
	`seq` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`message_class` text NOT NULL,
	`priority` text DEFAULT 'interactive' NOT NULL,
	`expiry_class` text DEFAULT 'timely' NOT NULL,
	`payload` text NOT NULL,
	`parts_json` text NOT NULL,
	`content_hash` blob NOT NULL,
	`audience_reader_set_id` integer NOT NULL,
	`label_id` integer,
	`guard_ref` text NOT NULL,
	`manifest_label_ids` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`maybe_sent` integer DEFAULT false NOT NULL,
	`in_flight_since` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer,
	`platform_message_id` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audience_reader_set_id`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_guard_ck" CHECK(length("outbox_messages"."guard_ref") > 0),
	CONSTRAINT "outbox_maybe_sent_bool_ck" CHECK("outbox_messages"."maybe_sent" IN (0, 1)),
	CONSTRAINT "outbox_seq_ck" CHECK("outbox_messages"."seq" >= 0),
	CONSTRAINT "outbox_attempts_ck" CHECK("outbox_messages"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_messages_idempotency_key_unique` ON `outbox_messages` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `outbox_dispatch_idx` ON `outbox_messages` (`next_attempt_at`) WHERE "outbox_messages"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `outbox_conv_seq_idx` ON `outbox_messages` (`conversation_id`,`seq`) WHERE "outbox_messages"."status" IN ('pending','sending');--> statement-breakpoint
CREATE INDEX `outbox_recent_sent_idx` ON `outbox_messages` (`conversation_id`,`content_hash`,`sent_at`) WHERE "outbox_messages"."status" = 'sent';--> statement-breakpoint
CREATE INDEX `outbox_sending_idx` ON `outbox_messages` (`lease_until`) WHERE "outbox_messages"."status" = 'sending';--> statement-breakpoint
CREATE INDEX `outbox_class_idx` ON `outbox_messages` (`group_id`,`message_class`,`sent_at`) WHERE "outbox_messages"."status" = 'sent';--> statement-breakpoint
CREATE TABLE `persons` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`display_name_source` text DEFAULT 'platform' NOT NULL,
	`locale` text,
	`timezone` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`erased_at` integer
);
--> statement-breakpoint
CREATE TABLE `plan_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`group_id` text NOT NULL,
	`position` text NOT NULL,
	`title` text NOT NULL,
	`owner_member_ids` text NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`confirm_state` text DEFAULT 'confirmed' NOT NULL,
	`due` text,
	`due_at` integer,
	`depends_on` text NOT NULL,
	`links` text NOT NULL,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plan_steps_plan_idx` ON `plan_steps` (`plan_id`,`position`);--> statement-breakpoint
CREATE TABLE `plans` (
	`rid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`kind` text DEFAULT 'generic' NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`owner_member_ids` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`secrecy` text,
	`tz` text,
	`starts_on` text,
	`ends_on` text,
	`budget_notes` text NOT NULL,
	`assumptions` text NOT NULL,
	`label_id` integer NOT NULL,
	`created_by_member_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_id_unique` ON `plans` (`id`);--> statement-breakpoint
CREATE INDEX `plans_group_status_idx` ON `plans` (`group_id`,`status`);--> statement-breakpoint
CREATE TABLE `poll_counts` (
	`poll_id` text PRIMARY KEY NOT NULL,
	`counts` text NOT NULL,
	`voter_count` integer NOT NULL,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `poll_votes` (
	`poll_id` text NOT NULL,
	`member_id` text NOT NULL,
	`option_ids` text NOT NULL,
	`source` text NOT NULL,
	`label_id` integer NOT NULL,
	`cast_at` integer NOT NULL,
	PRIMARY KEY(`poll_id`, `member_id`),
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `poll_votes_member_idx` ON `poll_votes` (`member_id`);--> statement-breakpoint
CREATE TABLE `polls` (
	`rid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`purpose` text NOT NULL,
	`proposal_id` text,
	`question` text NOT NULL,
	`options` text NOT NULL,
	`allow_multiple` integer DEFAULT false NOT NULL,
	`rule` text NOT NULL,
	`quorum` text NOT NULL,
	`eligible_member_ids` text NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`results_visibility` text DEFAULT 'live' NOT NULL,
	`mode` text NOT NULL,
	`deadline_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`outcome` text,
	`platform_poll_ref` text,
	`decision_id` text,
	`plan_step_id` text,
	`label_id` integer NOT NULL,
	`created_by_member_id` text,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "polls_allow_multiple_bool_ck" CHECK("polls"."allow_multiple" IN (0, 1)),
	CONSTRAINT "polls_anonymous_bool_ck" CHECK("polls"."anonymous" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `polls_id_unique` ON `polls` (`id`);--> statement-breakpoint
CREATE INDEX `polls_open_deadline_idx` ON `polls` (`group_id`,`deadline_at`) WHERE "polls"."status" = 'open';--> statement-breakpoint
CREATE TABLE `private_constraint_policies` (
	`member_id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`policy` text NOT NULL,
	`label_id` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `proactive_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`type` text NOT NULL,
	`topic_key` text NOT NULL,
	`target` text NOT NULL,
	`value` real NOT NULL,
	`confidence` real NOT NULL,
	`urgency_inputs` text NOT NULL,
	`payload` text NOT NULL,
	`label_id` integer NOT NULL,
	`status` text NOT NULL,
	`decision` text,
	`deliver_after` integer,
	`delivered_outbox_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "proactive_candidates_value_ck" CHECK("proactive_candidates"."value" BETWEEN 0 AND 1),
	CONSTRAINT "proactive_candidates_confidence_ck" CHECK("proactive_candidates"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE INDEX `proactive_candidates_pending_idx` ON `proactive_candidates` (`group_id`,`status`,`deliver_after`);--> statement-breakpoint
CREATE INDEX `proactive_candidates_topic_idx` ON `proactive_candidates` (`group_id`,`topic_key`);--> statement-breakpoint
CREATE TABLE `proactivity_feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`type` text NOT NULL,
	`member_id` text,
	`scope` text NOT NULL,
	`signal` text NOT NULL,
	`weight` real NOT NULL,
	`outbox_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proactivity_feedback_group_idx` ON `proactivity_feedback` (`group_id`,`type`,`at`);--> statement-breakpoint
CREATE TABLE `proposal_votes` (
	`proposal_id` text NOT NULL,
	`member_id` text NOT NULL,
	`choice` text NOT NULL,
	`via` text NOT NULL,
	`label_id` integer NOT NULL,
	`cast_at` integer NOT NULL,
	PRIMARY KEY(`proposal_id`, `member_id`),
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`action_digest` text,
	`rule` text NOT NULL,
	`electorate` text NOT NULL,
	`status` text NOT NULL,
	`proposer_member_id` text NOT NULL,
	`ballot_refs` text NOT NULL,
	`superseded_by_id` text,
	`canonical_diff_hash` text,
	`deadline_at` integer,
	`min_open_until` integer,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`outcome` text,
	`label_id` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposer_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `proposals_open_idx` ON `proposals` (`group_id`,`deadline_at`) WHERE "proposals"."status" = 'open';--> statement-breakpoint
CREATE INDEX `proposals_diff_idx` ON `proposals` (`group_id`,`canonical_diff_hash`) WHERE "proposals"."canonical_diff_hash" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `reader_set_members` (
	`reader_set_id` integer NOT NULL,
	`member_id` text NOT NULL,
	PRIMARY KEY(`reader_set_id`, `member_id`),
	FOREIGN KEY (`reader_set_id`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reader_set_members_member_idx` ON `reader_set_members` (`member_id`,`reader_set_id`);--> statement-breakpoint
CREATE TABLE `reader_set_seats` (
	`reader_set_id` integer NOT NULL,
	`conversation_id` text NOT NULL,
	PRIMARY KEY(`reader_set_id`, `conversation_id`),
	FOREIGN KEY (`reader_set_id`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reader_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`canonical_key` text NOT NULL,
	`member_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reader_sets_group_kind_ck" CHECK("reader_sets"."kind" <> 'group' OR "reader_sets"."member_count" = 0),
	CONSTRAINT "reader_sets_member_count_ck" CHECK("reader_sets"."member_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reader_sets_group_key_uq` ON `reader_sets` (`group_id`,`canonical_key`);--> statement-breakpoint
CREATE TABLE `reminder_firings` (
	`id` text PRIMARY KEY NOT NULL,
	`reminder_id` text NOT NULL,
	`group_id` text NOT NULL,
	`occurrence_key` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`fired_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`outbox_ids` text NOT NULL,
	`acked_by_member_id` text,
	`ack_at` integer,
	FOREIGN KEY (`reminder_id`) REFERENCES `reminders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_firings_occurrence_uq` ON `reminder_firings` (`reminder_id`,`occurrence_key`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`recipients` text NOT NULL,
	`delivery` text NOT NULL,
	`schedule` text NOT NULL,
	`anchor` text NOT NULL,
	`about_ref` text,
	`audience_reader_set_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	`created_by_member_id` text,
	`next_fire_at` integer,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`snoozed_until` integer,
	`stale_after` text,
	`tzdata_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audience_reader_set_id`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reminders_due_idx` ON `reminders` (`group_id`,`next_fire_at`) WHERE "reminders"."status" IN ('scheduled','snoozed');--> statement-breakpoint
CREATE INDEX `reminders_about_idx` ON `reminders` (`about_ref`) WHERE "reminders"."about_ref" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `rotation_participants` (
	`rotation_id` text NOT NULL,
	`member_id` text NOT NULL,
	`position` integer NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`owed_slots` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`rotation_id`, `member_id`),
	FOREIGN KEY (`rotation_id`) REFERENCES `rotations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rotation_participants_active_bool_ck" CHECK("rotation_participants"."active" IN (0, 1)),
	CONSTRAINT "rotation_participants_owed_ck" CHECK("rotation_participants"."owed_slots" BETWEEN 0 AND 1),
	CONSTRAINT "rotation_participants_weight_ck" CHECK("rotation_participants"."weight" > 0)
);
--> statement-breakpoint
CREATE INDEX `rotation_participants_member_idx` ON `rotation_participants` (`member_id`);--> statement-breakpoint
CREATE TABLE `rotations` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`task_template` text NOT NULL,
	`strategy` text NOT NULL,
	`assignment_mode` text DEFAULT 'direct' NOT NULL,
	`announce` text DEFAULT 'dm' NOT NULL,
	`cursor` text NOT NULL,
	`schedule` text,
	`horizon` text,
	`paused_until` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`label_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `standing_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`guardian_member_id` text NOT NULL,
	`ward_member_id` text NOT NULL,
	`action_patterns` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guardian_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ward_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `standing_approvals_ward_idx` ON `standing_approvals` (`ward_member_id`,`expires_at`) WHERE "standing_approvals"."revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE `task_swaps` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`from_member_id` text NOT NULL,
	`to_member_id` text,
	`offered_task_id` text NOT NULL,
	`requested_task_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`expires_at` integer NOT NULL,
	`resolved_by_member_id` text,
	`label_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`offered_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_swaps_open_idx` ON `task_swaps` (`group_id`,`expires_at`) WHERE "task_swaps"."status" = 'open';--> statement-breakpoint
CREATE TABLE `tasks` (
	`rid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`kind` text DEFAULT 'task' NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`category` text,
	`assignee_member_id` text,
	`assignment_state` text DEFAULT 'unassigned' NOT NULL,
	`requested_by_member_id` text,
	`effort_points` integer DEFAULT 1 NOT NULL,
	`due` text NOT NULL,
	`due_at` integer,
	`due_tz` text,
	`due_local` text,
	`recurrence` text,
	`rotation_id` text,
	`occurrence_key` text,
	`proof_policy` text DEFAULT 'off' NOT NULL,
	`proof_blob_sha256` text,
	`status` text DEFAULT 'open' NOT NULL,
	`completed_at` integer,
	`completed_by_member_id` text,
	`verified_by_member_id` text,
	`nudge_count` integer DEFAULT 0 NOT NULL,
	`plan_id` text,
	`plan_step_id` text,
	`label_id` integer NOT NULL,
	`source_ref` text,
	`created_by_member_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rotation_id`) REFERENCES `rotations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`completed_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verified_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_effort_ck" CHECK("tasks"."effort_points" BETWEEN 0 AND 100),
	CONSTRAINT "tasks_nudge_ck" CHECK("tasks"."nudge_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_id_unique` ON `tasks` (`id`);--> statement-breakpoint
CREATE INDEX `tasks_open_due_idx` ON `tasks` (`group_id`,`due_at`) WHERE "tasks"."status" = 'open';--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`group_id`,`assignee_member_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_rotation_occurrence_uq` ON `tasks` (`rotation_id`,`occurrence_key`) WHERE "tasks"."rotation_id" IS NOT NULL AND "tasks"."occurrence_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `turn_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`root_turn_id` text NOT NULL,
	`group_id` text NOT NULL,
	`seq` integer NOT NULL,
	`tool_name` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`result_ciphertext` blob,
	`summary_key` text NOT NULL,
	`summary_params` text NOT NULL,
	`entity_refs` text NOT NULL,
	`label_id` integer NOT NULL,
	`committed_at` integer,
	`ack_outbox_id` text,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "turn_effects_seq_ck" CHECK("turn_effects"."seq" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_effects_idempotency_key_unique` ON `turn_effects` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `turn_effects_turn_seq_uq` ON `turn_effects` (`turn_id`,`seq`);--> statement-breakpoint
CREATE INDEX `turn_effects_root_idx` ON `turn_effects` (`root_turn_id`);--> statement-breakpoint
CREATE INDEX `turn_effects_intent_idx` ON `turn_effects` (`turn_id`) WHERE "turn_effects"."status" = 'intent';--> statement-breakpoint
CREATE INDEX `turn_effects_unacked_idx` ON `turn_effects` (`turn_id`) WHERE "turn_effects"."ack_outbox_id" IS NULL;--> statement-breakpoint
CREATE TABLE `turn_trace_debug` (
	`turn_id` text PRIMARY KEY NOT NULL,
	`ciphertext` blob NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turn_trace_debug_expires_idx` ON `turn_trace_debug` (`expires_at`);--> statement-breakpoint
CREATE TABLE `turn_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`group_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`label_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`disposition` text NOT NULL,
	`context_manifest` text NOT NULL,
	`model_calls` text NOT NULL,
	`tool_calls` text NOT NULL,
	`policy_decisions` text NOT NULL,
	`guard_results` text NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`latency` text NOT NULL,
	`replay` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "turn_traces_cost_ck" CHECK("turn_traces"."cost_micros" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_traces_turn_id_unique` ON `turn_traces` (`turn_id`);--> statement-breakpoint
CREATE INDEX `turn_traces_group_created_idx` ON `turn_traces` (`group_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `turn_traces_expires_idx` ON `turn_traces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`trigger_message_ids` text NOT NULL,
	`requester_member_id` text,
	`audience_reader_set_id` integer NOT NULL,
	`status` text NOT NULL,
	`phase` text,
	`phase_step` integer,
	`effort` text,
	`boot_id` text NOT NULL,
	`root_turn_id` text NOT NULL,
	`parent_turn_id` text,
	`retry_of_turn_id` text,
	`restarts` integer DEFAULT 0 NOT NULL,
	`recovery_done` integer DEFAULT false NOT NULL,
	`started_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`timed_out_at` integer,
	`completed_at` integer,
	`failure` text,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requester_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`audience_reader_set_id`) REFERENCES `reader_sets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "turns_recovery_done_bool_ck" CHECK("turns"."recovery_done" IN (0, 1)),
	CONSTRAINT "turns_restarts_ck" CHECK("turns"."restarts" >= 0)
);
--> statement-breakpoint
CREATE INDEX `turns_running_idx` ON `turns` (`started_at`) WHERE "turns"."status" = 'running';--> statement-breakpoint
CREATE INDEX `turns_timeout_idx` ON `turns` (`deadline_at`) WHERE "turns"."status" IN ('queued','running');--> statement-breakpoint
CREATE INDEX `turns_root_idx` ON `turns` (`root_turn_id`);--> statement-breakpoint
CREATE INDEX `turns_conv_started_idx` ON `turns` (`conversation_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`group_key` text NOT NULL,
	`day_local` text NOT NULL,
	`route` text NOT NULL,
	`calls` integer NOT NULL,
	`cost_micros` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cached_read_tokens` integer NOT NULL,
	PRIMARY KEY(`group_key`, `day_local`, `route`)
);
--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text,
	`turn_id` text,
	`job_id` text,
	`route` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`served_model` text NOT NULL,
	`purpose` text NOT NULL,
	`via` text DEFAULT 'chat' NOT NULL,
	`effort` text,
	`kind` text DEFAULT 'message' NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_read_tokens` integer NOT NULL,
	`cache_write_5m_tokens` integer NOT NULL,
	`cache_write_1h_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_micros` integer NOT NULL,
	`price_table_version` text NOT NULL,
	`batch` integer DEFAULT false NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "usage_batch_bool_ck" CHECK("usage_records"."batch" IN (0, 1)),
	CONSTRAINT "usage_cost_ck" CHECK("usage_records"."cost_micros" >= 0)
);
--> statement-breakpoint
CREATE INDEX `usage_group_at_idx` ON `usage_records` (`group_id`,`at`);