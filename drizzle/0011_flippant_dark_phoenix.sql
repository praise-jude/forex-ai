CREATE TABLE "spread_block_log" (
	"id" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"pair" text NOT NULL,
	"direction" text NOT NULL,
	"tier" text NOT NULL,
	"confidence" double precision NOT NULL,
	"spread" double precision NOT NULL,
	"stop_distance" double precision NOT NULL,
	"max_spread_fraction_of_stop" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
