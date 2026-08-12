import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

// Double-submit CSRF protection for the Google OAuth redirect round trip -- a random
// value set in its own short-lived httpOnly cookie before redirecting to Google, then
// compared against the `state` query param Google echoes back on callback. No server
// secret/store needed, same reasoning as the session cookie's own CSRF posture.
const STATE_COOKIE_NAME = "oauth_state";
const STATE_TTL_SECONDS = 10 * 60;

export async function setOAuthState(state: string): Promise<void> {
  const store = await cookies();
  store.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
}

export async function consumeOAuthState(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(STATE_COOKIE_NAME)?.value ?? null;
  store.delete(STATE_COOKIE_NAME);
  return value;
}

export function generateState(): string {
  return randomBytes(24).toString("hex");
}
