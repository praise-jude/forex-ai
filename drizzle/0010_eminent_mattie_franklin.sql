CREATE TABLE "live_recovery_state" (
	"id" text PRIMARY KEY NOT NULL,
	"recent_boots_ms" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
