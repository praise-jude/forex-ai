CREATE TABLE "processed_deals" (
	"deal_id" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"processed_at" timestamp with time zone NOT NULL
);
