import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized, unauthorizedResponse } from "@/lib/market/basicAuth";
import { recordFailedDashboardAuth } from "@/lib/market/authAttempts";
import { sendNotification } from "@/lib/market/pushNotifier";
import { isValidSessionCookie, SESSION_COOKIE_NAME } from "@/lib/market/dashboardSession";

// Non-sensitive static/PWA plumbing -- no trading data, and keeping these reachable
// without a prompt avoids install-flow/service-worker edge cases. Everything else
// (every page, every /api/* route) is gated.
const PUBLIC_PATHS = new Set([
  "/favicon.ico",
  "/manifest.webmanifest",
  "/sw.js",
  "/icon",
  "/icon-192",
  "/icon-512",
  "/icon-512-maskable",
  "/apple-icon",
  // Temporary: the mobile APK, hosted directly from this app while the usual ngrok
  // tunnel is bandwidth-throttled (see public/forex-ai.apk's own commit message). The
  // installer carries no secrets, so exempting it from the dashboard password is the
  // same tradeoff already made for the icons above -- remove this line along with the
  // file once it's been downloaded.
  "/forex-ai.apk",
  // The real login page/its submit endpoint -- obviously can't require already being
  // logged in (see dashboardSession.ts's own doc comment for why this exists alongside
  // Basic Auth, not instead of it).
  "/login",
]);

/**
 * Gates the OPERATOR's own private trading surface (/dashboard, /chat, /journal, and
 * every existing /api/* trading-control route) behind a single shared password -- this
 * app has no per-user login system for that surface, by design. Before this gate
 * existed, every trading-control route (kill switch, engine mode incl. enabling LIVE,
 * signal execution) had zero authentication, and the LIVE confirmation phrase is
 * hardcoded in this (public) repo, so it was never real protection against anyone who
 * could just reach the deployed URL.
 *
 * Two credential forms are accepted, checked in order below: a session cookie set by
 * /login (a real page/form so a browser password manager can offer to save it -- the
 * original problem this was added to solve, since the Basic Auth prompt below is a
 * native dialog outside the page's DOM that most browsers won't offer to save), or the
 * original `Authorization: Basic` header, kept unchanged specifically because the mobile
 * app authenticates every API call with it directly (see forex-ai-mobile's
 * src/lib/api/client.ts) and has no browser cookie jar to rely on. Basic Auth's own
 * "browser caches the credential per-origin and auto-attaches it to every request --
 * including EventSource, which can't set custom headers at all" property is one the
 * session cookie shares for free (cookies auto-attach same-origin too), so a browser tab
 * that's logged in via /login gets the same seamless EventSource/fetch behavior.
 *

 * `/account` and `/api/account/*` are a SEPARATE, genuinely public surface -- the Stage 1
 * customer-accounts system (see lib/account/), with its own real per-user login (email/
 * password + Google, DB-backed sessions). It's exempted from the operator's own Basic
 * Auth gate below on purpose: a future customer signing up has nothing to do with, and
 * must never need, the operator's own dashboard password.
 *
 * Named `proxy` (not `middleware`) -- Next.js 16 deprecated and renamed the file
 * convention; the file must be proxy.ts at the project root.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/api/webhooks/tradingview") ||
    pathname === "/api/login" ||
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    pathname === "/api/account" ||
    pathname.startsWith("/api/account/") ||
    PUBLIC_PATHS.has(pathname)
  ) {
    return NextResponse.next();
  }

  // Fails open only when the operator hasn't configured a password yet -- matches this
  // app's existing "off by default until explicitly configured" pattern (e.g. the
  // TradingView webhook itself returns 500, not silently-open, until its secret is set).
  const password = process.env.DASHBOARD_ACCESS_PASSWORD;
  if (!password) return NextResponse.next();

  // Either credential is accepted -- the session cookie (set by /login, see
  // dashboardSession.ts) for a real browser tab, OR the original Basic Auth header,
  // completely unchanged, for everything that still relies on it (the mobile app sends
  // its own `Authorization: Basic` header on every request, never a cookie -- see
  // forex-ai-mobile's src/lib/api/client.ts).
  if (isValidSessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value, password)) {
    return NextResponse.next();
  }
  if (isAuthorized(request.headers.get("authorization"), password)) {
    return NextResponse.next();
  }

  // A real browser page load (not an API/fetch/EventSource call) with neither credential
  // goes to the new login page instead of the old Basic Auth popup -- `next` round-trips
  // back to whatever page they were actually trying to reach. Not counted as a failed
  // attempt below: simply never having logged in yet isn't a wrong-password guess.
  const accept = request.headers.get("accept") ?? "";
  if (request.method === "GET" && accept.includes("text/html")) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Alerts rather than blocks -- see authAttempts.ts's doc comment for why a hard
  // lockout on a single shared-password gate is the wrong tradeoff for a solo operator.
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  if (recordFailedDashboardAuth(ip)) {
    void sendNotification({
      category: "risk_alert",
      title: "JUDE AI — repeated failed dashboard logins",
      body: `Several wrong-password attempts hit your dashboard in the last few minutes (from ${ip}). If that wasn't you, consider changing DASHBOARD_ACCESS_PASSWORD in Railway.`,
    });
  }

  return unauthorizedResponse();
}

export const config = {
  matcher: "/:path*",
};
