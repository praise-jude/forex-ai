CREATE TABLE "autopilot_lock_state" (
	"id" text PRIMARY KEY NOT NULL,
	"locked" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
