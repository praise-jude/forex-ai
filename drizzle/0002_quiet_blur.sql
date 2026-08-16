CREATE TABLE "journal_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"signal_id" text NOT NULL,
	"account" text NOT NULL,
	"pair" text NOT NULL,
	"timeframe" text,
	"direction" text NOT NULL,
	"entry_price" double precision NOT NULL,
	"exit_price" double precision NOT NULL,
	"profit" double precision NOT NULL,
	"risk_dollars" double precision,
	"r_multiple" double precision,
	"reason" text NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"context" jsonb
);
--> statement-breakpoint
CREATE TABLE "journal_pending_contexts" (
	"signal_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"context" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_signal_outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_id" text NOT NULL,
	"pair" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"timestamp" timestamp with time zone NOT NULL
);
