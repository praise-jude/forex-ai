import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getOptionalDb } from "@/lib/db/optionalClient";

export const runtime = "nodejs";

/**
 * TEMPORARY, one-shot route to apply pending drizzle migrations against the live
 * database -- exists only because Postgres here has no public endpoint (only
 * postgres.railway.internal, reachable exclusively from inside Railway's own network), so
 * `drizzle-kit migrate` can't be run from a local machine the normal way. Delete this
 * route once the pending migration has been applied; it's not meant to be a permanent
 * part of the app. Already behind the same Basic Auth as every other /api/* route (see
 * proxy.ts) -- no extra guarding needed.
 */
export async function POST() {
  const db = getOptionalDb();
  if (!db) return Response.json({ error: "DATABASE_URL not set" }, { status: 500 });

  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    return Response.json({ status: "ok" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
