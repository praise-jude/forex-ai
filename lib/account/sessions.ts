import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { sessions } from "../db/schema";
import { generateToken, hashToken, isExpired } from "./tokens";

// Fixed TTL at creation -- no sliding-window renewal in Stage 1 (see the plan's own
// reasoning: DB-backed opaque tokens over stateless JWT, specifically so a compromised
// session is revocable by deleting one row, which matters once this gates a paid API).
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreatedSession {
  rawToken: string;
  expiresAt: Date;
}

export async function createSession(userId: string, meta: { userAgent?: string; ip?: string } = {}): Promise<CreatedSession> {
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: hash, userId, expiresAt, userAgent: meta.userAgent, ip: meta.ip });
  return { rawToken: raw, expiresAt };
}

/** Null for both "no such session" and "expired" -- an expired session is never treated
 * as valid, and the caller never needs to distinguish the two (both mean "not signed
 * in"). Does not auto-delete an expired row here -- that's fine to leave for a future
 * cleanup pass rather than doing a write on every read of an expired session. */
export async function getSessionUserId(rawToken: string): Promise<string | null> {
  const [session] = await db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(rawToken))).limit(1);
  if (!session || isExpired(session.expiresAt)) return null;
  return session.userId;
}

export async function revokeSession(rawToken: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(rawToken)));
}
