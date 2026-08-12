import { z } from "zod";
import { findUserByEmail } from "@/lib/account/users";
import { generateToken } from "@/lib/account/tokens";
import { db } from "@/lib/db/client";
import { passwordResetTokens } from "@/lib/db/schema";
import { sendPasswordResetEmail } from "@/lib/account/email";

export const runtime = "nodejs";

const RESET_TTL_MS = 60 * 60 * 1000;

const RequestResetSchema = z.object({ email: z.string().trim().email() });

// Always the same generic response, whether or not the email has an account -- never
// lets this endpoint be used to enumerate registered emails (same reasoning as
// signin's own INVALID_CREDENTIALS constant).
const GENERIC_RESPONSE = { ok: true, message: "If an account exists for that email, a reset link has been sent." };

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = RequestResetSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const user = await findUserByEmail(parsed.data.email);
  if (user) {
    const { raw, hash } = generateToken();
    await db.insert(passwordResetTokens).values({ tokenHash: hash, userId: user.id, expiresAt: new Date(Date.now() + RESET_TTL_MS) });

    const baseUrl = process.env.APP_BASE_URL ?? new URL(request.url).origin;
    const resetUrl = `${baseUrl}/account/reset-password?token=${raw}`;
    const emailResult = await sendPasswordResetEmail(user.email, resetUrl);
    if (!emailResult.success) {
      console.error(`[account] failed to send password reset email to ${user.email}: ${emailResult.message}`);
    }
  }

  return Response.json(GENERIC_RESPONSE);
}
