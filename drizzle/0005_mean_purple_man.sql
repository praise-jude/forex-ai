CREATE TABLE "risk_daily_state" (
	"account" text PRIMARY KEY NOT NULL,
	"day_key" text NOT NULL,
	"start_of_day_equity" double precision NOT NULL,
	"trades_opened_today" integer NOT NULL,
	"halted_for_today" boolean NOT NULL,
	"consecutive_losses" integer NOT NULL,
	"cooldown_until" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone
);
