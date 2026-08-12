import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs as a standalone CLI outside Next.js's own dev server, so it never
// sees .env.local the way the app itself does -- load it explicitly here.
config({ path: ".env.local" });

// Migrations are generated and applied as explicit, manual steps (see package.json's
// db:generate/db:migrate scripts and README's "Local database access" section) -- never
// boot-triggered, matching this app's "nothing auto-enables" philosophy (e.g.
// TRADING_KILL_SWITCH must be set explicitly).
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
