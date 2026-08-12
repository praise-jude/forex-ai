import { z } from "zod";
import { hashPassword } from "@/lib/account/passwords";
import { createUser, findUserByEmail } from "@/lib/account/users";
import { generateToken } from "@/lib/account/tokens";
import { db } from "@/lib/db/client";
import { emailVerificationTokens } from "@/lib/db/schema";
import { sendVerificationEmail } from "@/lib/account/email";
import { createSession } from "@/lib/account/sessions";
import { setSessionCookie } from "@/lib/account/sessionCookie";

export const runtime = "nodejs";

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const SignupSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().trim().min(1).optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const existing = await findUserByEmail(parsed.data.email);
  if (existing) {
    return Response.json({ error: "email_taken", message: "An account with this email already exists." }, { status: 409 });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const user = await createUser({ email: parsed.data.email, passwordHash, name: parsed.data.name });

  const { raw, hash } = generateToken();
  await db.insert(emailVerificationTokens).values({
    tokenHash: hash,
    userId: user.id,
    email: user.email,
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
  });

  const baseUrl = process.env.APP_BASE_URL ?? new URL(request.url).origin;
  const verifyUrl = `${baseUrl}/api/account/verify-email?token=${raw}`;
  const emailResult = await sendVerificationEmail(user.email, verifyUrl);
  if (!emailResult.success) {
    // Never fabricate success -- the account is genuinely created either way (this
    // isn't fatal to signup), but the real delivery failure is logged so it's visible
    // rather than silently swallowed.
    console.error(`[account] failed to send verification email to ${user.email}: ${emailResult.message}`);
  }

  // Signed in immediately -- email verification is tracked separately (emailVerifiedAt)
  // and surfaced on /account, not a gate on using the account at all in Stage 1.
  const session = await createSession(user.id, {
    userAgent: request.headers.get("user-agent") ?? undefined,
    ip: request.headers.get("x-forwarded-for") ?? undefined,
  });
  await setSessionCookie(session);

  return Response.json({ id: user.id, email: user.email, emailVerified: false });
}
