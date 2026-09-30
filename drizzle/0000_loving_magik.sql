CREATE TABLE `bars` (
	`symbol` text NOT NULL,
	`date` text NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real NOT NULL,
	`raw_close` real NOT NULL,
	`factor` real NOT NULL,
	PRIMARY KEY(`symbol`, `date`)
);
--> statement-breakpoint
CREATE TABLE `instruments` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`error` text,
	`updated_at` text,
	`event_date` text,
	`event_known_at` text,
	`origin` text,
	`lock_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scores` (
	`symbol` text NOT NULL,
	`date` text NOT NULL,
	`score` integer,
	`payload` text NOT NULL,
	`version` text NOT NULL,
	PRIMARY KEY(`symbol`, `date`)
);
--> statement-breakpoint
CREATE TABLE `sync_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`at` text NOT NULL,
	`status` text NOT NULL,
	`rows` integer NOT NULL,
	`message` text
);
