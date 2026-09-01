CREATE TABLE "evaluation_log" (
	"id" text PRIMARY KEY NOT NULL,
	"pair" text NOT NULL,
	"timeframe" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"reason_code" text,
	"reason_detail" jsonb,
	"signal_tier" text,
	"signal_confidence" double precision,
	"pipeline_stages" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
