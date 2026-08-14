import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as tradingSchema from "./tradingSchema";

// Deliberately independent of lib/db/client.ts's own `db`/`pool` -- that module's pool
// is constructed eagerly at import time and throws if DATABASE_URL is unset (fine there,
// since only /account routes import it, and those already document DATABASE_URL as
// required). signalStore.ts/positionStore.ts are imported from everywhere (bootstrap.ts
// on every server boot, executionEngine.ts, chat tools, most API routes, tests) and must
// keep working with zero DB config exactly as before this feature existed -- so nothing
// in this file may throw or connect merely from being imported. getOptionalDb() only
// touches Postgres the first time it's actually called, and only if DATABASE_URL is set.
const globalKey = Symbol.for("forex-ai.db.optionalPool");
type GlobalWithOptionalPool = typeof globalThis & { [globalKey]?: Pool | null };
const g = globalThis as GlobalWithOptionalPool;

export function getOptionalDb(): ReturnType<typeof drizzle<typeof tradingSchema>> | null {
  if (g[globalKey] === undefined) {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString) {
      g[globalKey] = new Pool({ connectionString });
    } else {
      console.log("[db] DATABASE_URL not set — signal/execution history will not persist across restarts");
      g[globalKey] = null;
    }
  }
  const pool = g[globalKey];
  return pool ? drizzle(pool, { schema: tradingSchema }) : null;
}
