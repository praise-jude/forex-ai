import { cookies } from "next/headers";
import type { CreatedSession } from "./sessions";

export const SESSION_COOKIE_NAME = "session";

/** Call BEFORE returning a response from a Route Handler -- cookies() operates on the
 * current request's outgoing response implicitly (see Next.js's own cookies() docs),
 * so nothing needs to be attached to the Response object manually. httpOnly+secure+
 * sameSite=lax is the entire CSRF story here (see the Stage 1 plan's own reasoning) --
 * no separate CSRF-token library. */
export async function setSessionCookie(session: CreatedSession): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, session.rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });
}

export async function getSessionCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value ?? null;
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}
