import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { passwordResetTokens } from "@/lib/db/schema";
import { hashToken, isExpired } from "@/lib/account/tokens";
import { hashPassword } from "@/lib/account/passwords";
import { updatePasswordHash } from "@/lib/account/users";

export const runtime = "nodejs";

const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = ResetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const tokenHash = hashToken(parsed.data.token);
  const [row] = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, tokenHash)).limit(1);

  if (!row || isExpired(row.expiresAt) || row.consumedAt) {
    return Response.json({ error: "invalid_token", message: "This reset link is invalid or has expired." }, { status: 400 });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await updatePasswordHash(row.userId, passwordHash);
  // Consumed, not deleted -- consumedAt is what stops a still-unexpired link from being
  // replayed a second time (see schema.ts's own comment on this column).
  await db.update(passwordResetTokens).set({ consumedAt: new Date() }).where(eq(passwordResetTokens.tokenHash, tokenHash));

  return Response.json({ ok: true });
}
