PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_link_codes` (
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
	CONSTRAINT "link_codes_redeemer_ck" CHECK(CASE "__new_link_codes"."state" WHEN 'issued' THEN "__new_link_codes"."redeemed_by_identity_id" IS NULL WHEN 'cancelled' THEN 1 ELSE "__new_link_codes"."redeemed_by_identity_id" IS NOT NULL END)
);
--> statement-breakpoint
INSERT INTO `__new_link_codes`("id", "code_hash", "token_hash", "issuer_person_id", "issuer_channel_identity_id", "state", "redeemed_by_identity_id", "created_at", "expires_at") SELECT "id", "code_hash", "token_hash", "issuer_person_id", "issuer_channel_identity_id", "state", "redeemed_by_identity_id", "created_at", "expires_at" FROM `link_codes`;--> statement-breakpoint
DROP TABLE `link_codes`;--> statement-breakpoint
ALTER TABLE `__new_link_codes` RENAME TO `link_codes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `link_codes_code_hash_unique` ON `link_codes` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `link_codes_token_hash_unique` ON `link_codes` (`token_hash`);--> statement-breakpoint
CREATE INDEX `link_codes_issuer_idx` ON `link_codes` (`issuer_person_id`,`state`);