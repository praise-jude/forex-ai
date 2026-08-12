import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { emailVerificationTokens } from "@/lib/db/schema";
import { hashToken, isExpired } from "@/lib/account/tokens";
import { markEmailVerified } from "@/lib/account/users";

export const runtime = "nodejs";

// A GET, not a POST -- this is what an <a href> link clicked from an email actually
// sends. Still a genuine one-time state change (the token row is deleted on use, so a
// second click of the same link is a clean, honest "invalid or already used" rather
// than silently re-verifying), which is the standard, accepted shape for exactly this
// "click a link in your email" flow.
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  const redirectTo = (status: "verified" | "invalid") => Response.redirect(`${new URL(request.url).origin}/account/verify-email?status=${status}`, 303);

  if (!token) return redirectTo("invalid");

  const tokenHash = hashToken(token);
  const [row] = await db.select().from(emailVerificationTokens).where(eq(emailVerificationTokens.tokenHash, tokenHash)).limit(1);

  // Consumed either way (found-but-expired or found-and-valid) -- a token is only ever
  // usable once, matching password_reset_tokens' own consumed-on-use posture.
  if (row) await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.tokenHash, tokenHash));

  if (!row || isExpired(row.expiresAt)) return redirectTo("invalid");

  await markEmailVerified(row.userId);
  return redirectTo("verified");
}
