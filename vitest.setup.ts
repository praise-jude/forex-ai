import { config } from "dotenv";

// Vitest doesn't auto-load .env.local the way Next.js's own dev/build does -- needed
// here specifically for lib/account/__tests__/sessions.test.ts, which runs against the
// real local-tunneled Postgres rather than a mock (see README's "Local database access").
config({ path: ".env.local" });
