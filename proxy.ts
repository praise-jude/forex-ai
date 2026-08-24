import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized, unauthorizedResponse } from "@/lib/market/basicAuth";
import { recordFailedDashboardAuth } from "@/lib/market/authAttempts";
import { sendNotification } from "@/lib/market/pushNotifier";

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
]);

/**
 * Gates the OPERATOR's own private trading surface (/dashboard, /chat, /journal, and
 * every existing /api/* trading-control route) behind a single shared HTTP Basic Auth
 * password -- this app has no per-user login system for that surface, by design. Before
 * this gate existed, every trading-control route (kill switch, engine mode incl.
 * enabling LIVE, signal execution) had zero authentication, and the LIVE confirmation
 * phrase is hardcoded in this (public) repo, so it was never real protection against
 * anyone who could just reach the deployed URL. HTTP Basic Auth (rather than a custom
 * header/token) is deliberate: the browser caches the credential per-origin and
 * auto-attaches it to every subsequent request -- including EventSource, which can't set
 * custom headers at all -- so nothing in the dashboard's existing fetch/EventSource calls
 * needed to change.
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

  if (isAuthorized(request.headers.get("authorization"), password)) {
    return NextResponse.next();
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
