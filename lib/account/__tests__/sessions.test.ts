import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { sessions, users } from "../../db/schema";
import { createSession, getSessionUserId, revokeSession } from "../sessions";
import { hashToken } from "../tokens";

// Runs against the real local-tunneled Postgres (see README's "Local database access"
// section) rather than a mock -- matches this codebase's own established testing
// philosophy of exercising real integrations where practical. A throwaway user is
// created per test and deleted afterward (cascades to its own sessions via the
// schema's own `onDelete: "cascade"`), so this never leaves rows behind.
async function createThrowawayUser(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `sessions-test-${id}@example.com`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

// `railway connect Postgres --tunnel-only -P 5432` (see README) is a manual, per-
// developer/CI step -- most environments running this suite won't have it up. Skipping
// the whole describe block when the tunnel is down turns that into a clean, honest
// "5 skipped" instead of 5 identical ECONNREFUSED failures that look like a real
// regression on every machine that hasn't started one. Race against a short timeout
// too, not just the connection's own rejection -- a wrong-but-routable host could hang
// instead of refusing fast, and that must not stall the whole test run.
const dbAvailable = await Promise.race([
  db
    .execute(sql`select 1`)
    .then(() => true)
    .catch(() => false),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]);

if (!dbAvailable) {
  console.warn(
    "[sessions.test.ts] skipped -- no reachable Postgres at DATABASE_URL. Run `railway connect Postgres --tunnel-only -P 5432` in another terminal to exercise these for real (see README's 'Local database access')."
  );
}

describe.skipIf(!dbAvailable)("sessions", () => {
  let userId: string;

  afterEach(async () => {
    if (userId) await db.delete(users).where(eq(users.id, userId));
  });

  it("creates a session and can look up the same user id from its raw token", async () => {
    userId = await createThrowawayUser();
    const { rawToken } = await createSession(userId);
    expect(await getSessionUserId(rawToken)).toBe(userId);
  });

  it("returns null for a token that was never issued", async () => {
    expect(await getSessionUserId("never-issued-token")).toBeNull();
  });

  it("revokes a session -- a revoked token no longer resolves to a user", async () => {
    userId = await createThrowawayUser();
    const { rawToken } = await createSession(userId);
    expect(await getSessionUserId(rawToken)).toBe(userId);

    await revokeSession(rawToken);
    expect(await getSessionUserId(rawToken)).toBeNull();
  });

  it("sets a real expiry roughly 30 days out", async () => {
    userId = await createThrowawayUser();
    const before = Date.now();
    const { expiresAt } = await createSession(userId);
    const daysOut = (expiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(29);
    expect(daysOut).toBeLessThan(31);
  });

  it("records optional user-agent/ip metadata on the stored row", async () => {
    userId = await createThrowawayUser();
    const { rawToken } = await createSession(userId, { userAgent: "vitest", ip: "127.0.0.1" });
    const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(rawToken))).limit(1);
    expect(row).toMatchObject({ userAgent: "vitest", ip: "127.0.0.1" });
  });
});
