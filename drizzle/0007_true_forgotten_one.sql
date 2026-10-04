CREATE TABLE `scheduled_deliveries` (
	`occurrence_date` text NOT NULL,
	`target_key` text NOT NULL,
	`report_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	`message` text,
	PRIMARY KEY(`occurrence_date`, `target_key`),
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scheduled_report` ON `scheduled_deliveries` (`report_id`,`updated_at`);