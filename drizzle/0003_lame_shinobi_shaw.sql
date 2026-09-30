CREATE TABLE `earnings_calendar` (
	`symbol` text PRIMARY KEY NOT NULL,
	`date` text,
	`end_date` text,
	`status` text DEFAULT 'unavailable' NOT NULL,
	`timing` text DEFAULT 'unknown' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`source_url` text,
	`mode` text DEFAULT 'auto' NOT NULL,
	`checked_at` text,
	`next_check` integer DEFAULT 0 NOT NULL,
	`error` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`write_token` text
);
--> statement-breakpoint
CREATE TABLE `feature_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `earnings_events` ADD `confidence` text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE `earnings_events` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `earnings_events` ADD `timing` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
UPDATE earnings_events SET confidence='estimated' WHERE source='finnhub';
--> statement-breakpoint
INSERT INTO earnings_calendar(symbol,date,status,source,mode,checked_at)
SELECT e.symbol,e.date,CASE WHEN e.date IS NULL THEN 'unavailable' WHEN e.source='finnhub' THEN 'estimated' ELSE 'confirmed' END,e.source,CASE WHEN e.source='manual' THEN 'manual' ELSE 'auto' END,e.recorded_at
FROM earnings_events e WHERE e.id=(SELECT MAX(last.id) FROM earnings_events last WHERE last.symbol=e.symbol);
