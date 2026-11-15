-- `05` §3.10.1's five rows that `turn_traces` had no column for (`M3-T20`).
--
-- §3.10.1's table has thirteen rows and this table held eight of them. The five are not
-- decoration: `/why` (`M5-T22`) opens with "You asked me directly", which is `router`; `03`
-- §3.5's minor rules are audited through `binding.includesMinor`; attributing a prompt-cache miss
-- needs `prompt`'s four breakpoint hashes; and `09`'s dashboard shows what was sent, which is
-- `output`. `cost_by_route` is §3.10.1's "Micro-USD by route", beside the `cost_micros` total
-- rather than instead of it, because Q-USE-1 aggregates the total and cannot sum a JSON column on
-- the budget path.
--
-- Four are nullable and `NULL` means "that phase did not happen" — a turn refused at a gate has
-- no prompt and no output. `cost_by_route` defaults to `{}` so every existing row reads back as a
-- valid empty breakdown rather than as a JSON parse failure (`02` D21 validates on read).
ALTER TABLE `turn_traces` ADD `router` text;--> statement-breakpoint
ALTER TABLE `turn_traces` ADD `binding` text;--> statement-breakpoint
ALTER TABLE `turn_traces` ADD `prompt` text;--> statement-breakpoint
ALTER TABLE `turn_traces` ADD `output` text;--> statement-breakpoint
ALTER TABLE `turn_traces` ADD `cost_by_route` text DEFAULT '{}' NOT NULL;