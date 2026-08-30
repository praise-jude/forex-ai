import { createHash, createHmac, timingSafeEqual } from "crypto";

// Lets a real browser password manager offer to save/autofill the dashboard password --
// the pre-existing HTTP Basic Auth prompt (still supported, see proxy.ts) is a native
// browser dialog outside the page's DOM, which Chrome/most browsers don't offer to save
// credentials for. This is purely an ADDITIONAL way in for the web /login page; mobile's
// own Basic-Auth API calls are completely untouched (see proxy.ts's own doc comment).
export const SESSION_COOKIE_NAME = "forex-ai-dashboard-session";
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days -- the whole point is not asking again for a long time
export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

/** Derived from the operator's own password, not a separate secret -- deliberate: no new
 * env var to configure, and rotating DASHBOARD_ACCESS_PASSWORD in Railway automatically
 * invalidates every existing session cookie everywhere, the same "if that wasn't you,
 * change the password" remedy authAttempts.ts already points the operator to. */
function sessionSecret(password: string): Buffer {
  return createHash("sha256").update(password, "utf8").digest();
}

function sign(expiresAt: number, password: string): string {
  return createHmac("sha256", sessionSecret(password)).update(String(expiresAt)).digest("hex");
}

/** Cookie value is `${expiresAt}.${signature}` -- stateless (no session store, no DB row),
 * matching this app's existing "no persistence needed for solo-operator ephemeral state"
 * posture (see authAttempts.ts/engineMode.ts's own in-memory globalThis singletons). */
export function createSessionCookieValue(password: string): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return `${expiresAt}.${sign(expiresAt, password)}`;
}

/** Never throws: a missing, malformed, expired, or forged cookie value all just read as
 * "not authorized" rather than crashing the request (same posture as isAuthorized's own
 * handling of a malformed Basic header). */
export function isValidSessionCookie(value: string | undefined, password: string): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const expiresAtRaw = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  try {
    const expected = Buffer.from(sign(expiresAt, password), "hex");
    const actual = Buffer.from(signature, "hex");
    // Different-length buffers would make timingSafeEqual throw rather than just return
    // false -- both are sha256 hex digests when genuine, so a length mismatch only
    // happens for a forged/corrupt value, caught by the same catch as a bad hex string.
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
