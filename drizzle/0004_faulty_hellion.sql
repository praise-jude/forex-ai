CREATE TABLE "push_devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"push_token" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text,
	"notification_prefs" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
