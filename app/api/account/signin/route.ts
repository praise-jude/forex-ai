import { z } from "zod";
import { verifyPassword } from "@/lib/account/passwords";
import { findUserByEmail } from "@/lib/account/users";
import { createSession } from "@/lib/account/sessions";
import { setSessionCookie } from "@/lib/account/sessionCookie";

export const runtime = "nodejs";

const SigninSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

// Deliberately the SAME error for "no such account" and "wrong password" -- never lets
// an attacker use this endpoint to enumerate which emails have accounts.
const INVALID_CREDENTIALS = { error: "invalid_credentials", message: "Incorrect email or password." };

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = SigninSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const user = await findUserByEmail(parsed.data.email);
  if (!user || !user.passwordHash) {
    // No user, OR a Google-only account with no password ever set -- same generic
    // response either way (see the enumeration note above; a real account existing
    // with only Google sign-in is still not something to reveal to an unauthenticated
    // caller).
    return Response.json(INVALID_CREDENTIALS, { status: 401 });
  }

  const valid = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!valid) {
    return Response.json(INVALID_CREDENTIALS, { status: 401 });
  }

  const session = await createSession(user.id, {
    userAgent: request.headers.get("user-agent") ?? undefined,
    ip: request.headers.get("x-forwarded-for") ?? undefined,
  });
  await setSessionCookie(session);

  return Response.json({ id: user.id, email: user.email, emailVerified: Boolean(user.emailVerifiedAt) });
}
