CREATE TABLE `channel_chat_aliases` (
	`channel` text NOT NULL,
	`old_platform_chat_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`channel`, `old_platform_chat_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_state` (
	`channel` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`expires_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`channel`, `key`),
	CONSTRAINT "channel_state_value_len_ck" CHECK(length("channel_state"."value_json") <= 65536)
);
--> statement-breakpoint
CREATE INDEX `channel_state_expiry_idx` ON `channel_state` (`expires_at`) WHERE "channel_state"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `chat_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`platform_chat_id` text NOT NULL,
	`status` text NOT NULL,
	`group_id` text,
	`conversation_id` text,
	`first_seen_at` integer NOT NULL,
	`unclaimed_notice_at` integer,
	`leave_at` integer,
	`detached_at` integer,
	`last_probe` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chat_bindings_unclaimed_ck" CHECK("chat_bindings"."status" != 'unclaimed' OR "chat_bindings"."group_id" IS NULL),
	CONSTRAINT "chat_bindings_bound_ck" CHECK("chat_bindings"."status" != 'bound' OR "chat_bindings"."group_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_bindings_platform_uq` ON `chat_bindings` (`channel`,`platform_chat_id`);--> statement-breakpoint
CREATE INDEX `chat_bindings_leave_idx` ON `chat_bindings` (`leave_at`) WHERE "chat_bindings"."status" = 'unclaimed';--> statement-breakpoint
CREATE TABLE `claim_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`code_hash` blob NOT NULL,
	`link_token_hash` blob,
	`channel` text,
	`group_id` text,
	`template` text,
	`created_by_person_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`used_at` integer,
	`used_in_chat` text,
	`used_by_person_id` text,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_codes_code_hash_unique` ON `claim_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `dm_contexts` (
	`channel` text NOT NULL,
	`platform_chat_id` text NOT NULL,
	`person_id` text NOT NULL,
	`active_group_id` text,
	`set_at` integer NOT NULL,
	PRIMARY KEY(`channel`, `platform_chat_id`),
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `dm_contexts_person_idx` ON `dm_contexts` (`person_id`);--> statement-breakpoint
CREATE TABLE `interaction_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` blob NOT NULL,
	`group_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`outbox_message_id` text,
	`action` text NOT NULL,
	`allowed_clickers` text NOT NULL,
	`single_use` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_member_id` text,
	`created_by_turn_id` text,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "interaction_tokens_single_use_bool_ck" CHECK("interaction_tokens"."single_use" IN (0, 1)),
	CONSTRAINT "interaction_tokens_used_ck" CHECK(("interaction_tokens"."used_at" IS NULL) = ("interaction_tokens"."used_by_member_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_tokens_token_hash_unique` ON `interaction_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `interaction_tokens_expiry_idx` ON `interaction_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `link_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` blob NOT NULL,
	`token_hash` blob NOT NULL,
	`issuer_person_id` text NOT NULL,
	`issuer_channel_identity_id` text NOT NULL,
	`state` text NOT NULL,
	`redeemed_by_identity_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`issuer_person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issuer_channel_identity_id`) REFERENCES `channel_identities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "link_codes_redeemer_ck" CHECK(("link_codes"."state" IN ('redeemed', 'confirmed')) = ("link_codes"."redeemed_by_identity_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_codes_code_hash_unique` ON `link_codes` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `link_codes_token_hash_unique` ON `link_codes` (`token_hash`);--> statement-breakpoint
CREATE INDEX `link_codes_issuer_idx` ON `link_codes` (`issuer_person_id`,`state`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL,
	`locked_until` integer
);
