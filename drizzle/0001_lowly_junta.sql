CREATE TABLE `deliveries` (
	`report_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `earnings_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`date` text,
	`known_at` text NOT NULL,
	`source` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`trade_date` text,
	`status` text NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`trade_date` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	`card` text NOT NULL,
	`complete` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`until` integer NOT NULL
);

--> statement-breakpoint
INSERT INTO earnings_events(symbol,date,known_at,source,recorded_at) SELECT symbol,event_date,event_known_at,'manual',COALESCE(updated_at,event_known_at) FROM instruments WHERE event_date IS NOT NULL AND event_known_at IS NOT NULL;
