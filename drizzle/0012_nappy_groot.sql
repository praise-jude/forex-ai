CREATE TABLE "fill_price_check_log" (
	"id" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"pair" text NOT NULL,
	"direction" text NOT NULL,
	"requested_entry" double precision NOT NULL,
	"broker_position_id" text,
	"found" boolean NOT NULL,
	"attempts" integer NOT NULL,
	"open_price" double precision,
	"present_position_ids" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
