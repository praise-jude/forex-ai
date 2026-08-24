import { createHash, timingSafeEqual } from "crypto";

const REALM = "Forex AI";

/** Fixed-length digest so two different-length secrets never short-circuit
 * timingSafeEqual (which throws on length mismatch) -- this is what actually makes the
 * comparison timing-safe, not the byte-by-byte compare alone. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Checks an `Authorization: Basic ...` header against the configured password. The
 * username portion is ignored -- this gates a single-operator app, not multiple accounts,
 * so any username works as long as the password matches. Never throws: a malformed or
 * non-base64 header (a malicious or buggy client) is just treated as unauthorized rather
 * than crashing the request.
 *
 * Uses a constant-time digest comparison rather than `===` -- this endpoint has no rate
 * limiting of its own (see proxy.ts's failed-attempt notification instead, which alerts
 * rather than blocks so a solo operator can never lock themselves out), so a naive
 * string compare would leak how many leading characters of a guess are correct via
 * response timing. Not a realistic risk over the internet's jitter in practice, but a
 * free fix once you know to make it.
 */
export function isAuthorized(authHeader: string | null, password: string): boolean {
  if (!authHeader?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(authHeader.slice("Basic ".length));
    const suppliedPassword = decoded.slice(decoded.indexOf(":") + 1);
    return timingSafeEqual(digest(suppliedPassword), digest(password));
  } catch {
    return false;
  }
}

/** Triggers the browser's native login prompt, which then caches the credentials for
 * every subsequent same-origin request (including EventSource, which can't set custom
 * headers itself) -- this is the whole reason Basic Auth was chosen over a custom header
 * scheme, which would've needed every fetch/EventSource call in the app touched. */
export function unauthorizedResponse(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${REALM}"` },
  });
}
