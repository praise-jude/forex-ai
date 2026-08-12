import { createHash, randomBytes } from "node:crypto";

// Shared shape for every one-time link token this app issues (email verification,
// password reset, and sessions -- see sessions.ts, which reuses hashToken directly).
// Only the SHA-256 hash is ever persisted; the raw value exists only in the email
// link/cookie, never in the database -- mirrors executionEngine.ts's own
// shortClientId()-style "never store the sensitive raw value" pattern, just for a
// genuinely-secret token here rather than a non-reversible display id.
export interface GeneratedToken {
  raw: string;
  hash: string;
}

export function generateToken(): GeneratedToken {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function isExpired(expiresAt: Date, now: number = Date.now()): boolean {
  return expiresAt.getTime() <= now;
}
