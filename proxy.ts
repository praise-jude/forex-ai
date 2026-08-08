import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized, unauthorizedResponse } from "@/lib/market/basicAuth";

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
 * Single-operator app, no login system -- this is the whole access control story. Before
 * this, every trading-control route (kill switch, engine mode incl. enabling LIVE,
 * signal execution) had zero authentication, and the LIVE confirmation phrase is
 * hardcoded in this (public) repo, so it was never real protection against anyone who
 * could just reach the deployed URL. HTTP Basic Auth (rather than a custom header/token)
 * is deliberate: the browser caches the credential per-origin and auto-attaches it to
 * every subsequent request -- including EventSource, which can't set custom headers at
 * all -- so nothing in the dashboard's existing fetch/EventSource calls needed to change.
 *
 * Named `proxy` (not `middleware`) -- Next.js 16 deprecated and renamed the file
 * convention; the file must be proxy.ts at the project root.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/_next/") || pathname.startsWith("/api/webhooks/tradingview") || PUBLIC_PATHS.has(pathname)) {
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

  return unauthorizedResponse();
}

export const config = {
  matcher: "/:path*",
};
