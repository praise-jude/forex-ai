const REALM = "Forex AI";

/**
 * Checks an `Authorization: Basic ...` header against the configured password. The
 * username portion is ignored -- this gates a single-operator app, not multiple accounts,
 * so any username works as long as the password matches. Never throws: a malformed or
 * non-base64 header (a malicious or buggy client) is just treated as unauthorized rather
 * than crashing the request.
 */
export function isAuthorized(authHeader: string | null, password: string): boolean {
  if (!authHeader?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(authHeader.slice("Basic ".length));
    const suppliedPassword = decoded.slice(decoded.indexOf(":") + 1);
    return suppliedPassword === password;
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
