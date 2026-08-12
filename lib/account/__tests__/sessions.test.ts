import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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

describe("sessions", () => {
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
