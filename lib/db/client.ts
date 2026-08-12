import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// globalThis-keyed exactly like every store in lib/market/ (see e.g. deviceStore.ts's
// own comment on why) -- critical here specifically to survive Next dev's hot-reload
// without leaking Postgres connections: without this, every hot-reload of a module that
// imports this file would create a brand new Pool, and the old one's connections are
// never closed.
const globalKey = Symbol.for("forex-ai.db.pool");
type GlobalWithPool = typeof globalThis & { [globalKey]?: Pool };
const g = globalThis as GlobalWithPool;

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Missing required env var: DATABASE_URL");
  return new Pool({ connectionString });
}

const pool: Pool = g[globalKey] ?? (g[globalKey] = createPool());

export const db = drizzle(pool, { schema });
