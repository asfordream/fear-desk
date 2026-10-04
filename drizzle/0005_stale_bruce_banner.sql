CREATE TABLE `daily_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`reason` text,
	`checkpoint` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_job_number` ON `daily_attempts` (`job_id`,`attempt_no`);--> statement-breakpoint
CREATE TABLE `daily_commits` (
	`job_id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`completed_epoch` integer NOT NULL,
	`committed_at` text NOT NULL,
	`assertion_ok` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publication_assertion" CHECK("daily_commits"."assertion_ok" = 1)
);
--> statement-breakpoint
CREATE TABLE `daily_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text,
	`kind` text NOT NULL,
	`at` text NOT NULL,
	`detail` text NOT NULL,
	`assertion_ok` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "step_assertion" CHECK("daily_events"."assertion_ok" = 1)
);
--> statement-breakpoint
CREATE INDEX `event_job` ON `daily_events` (`job_id`,`id`);--> statement-breakpoint
CREATE TABLE `daily_inputs` (
	`job_id` text NOT NULL,
	`input_generation` integer NOT NULL,
	`symbol` text NOT NULL,
	`kind` text NOT NULL,
	`chunk_no` integer NOT NULL,
	`payload` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`job_id`, `input_generation`, `symbol`, `kind`, `chunk_no`),
	FOREIGN KEY (`job_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "input_chunk_bound" CHECK(length(CAST("daily_inputs"."payload" AS BLOB)) <= 131072)
);
--> statement-breakpoint
CREATE TABLE `daily_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`requested_at` text NOT NULL,
	`job_id` text NOT NULL,
	`send_intent` text NOT NULL,
	`schedule_occurrence` text,
	`scope_hash` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "manual_never_sends" CHECK("daily_requests"."source" != 'manual' OR "daily_requests"."send_intent" = 'none')
);
--> statement-breakpoint
CREATE INDEX `request_job` ON `daily_requests` (`job_id`);--> statement-breakpoint
CREATE TABLE `daily_resources` (
	`name` text PRIMARY KEY NOT NULL,
	`accepted_revision` integer DEFAULT 0 NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`token` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `report_current` (
	`desk` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`trade_date` text NOT NULL,
	`accepted_revision` integer NOT NULL,
	`version` integer NOT NULL,
	`legacy` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `job_runs` ADD `pipeline_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `active_key` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `requested_closed_day` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `scope_hash` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `pool_version` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `algorithm_version` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `card_version` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `calendar_version` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `stage` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `active_token` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `attempt_id` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `last_progress_at` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `validation_hash` text;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `input_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `checkpoint` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `lease_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `lease_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `failed_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `active_budget_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `reserved_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `next_eligible_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `completed_epoch` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `job_active_key` ON `job_runs` (`active_key`);--> statement-breakpoint
CREATE INDEX `job_resume_scan` ON `job_runs` (`pipeline_version`,`status`,`next_eligible_at`,`lease_until`);--> statement-breakpoint
ALTER TABLE `reports` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `input_revision` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `report_content_hash` ON `reports` (`content_hash`);--> statement-breakpoint
CREATE INDEX `report_causal_order` ON `reports` (`trade_date`,`input_revision`);