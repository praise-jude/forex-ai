import { NextResponse } from "next/server";
import { passwordMatches } from "@/lib/market/basicAuth";
import { recordFailedDashboardAuth } from "@/lib/market/authAttempts";
import { sendNotification } from "@/lib/market/pushNotifier";
import { createSessionCookieValue, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/market/dashboardSession";

export const runtime = "nodejs";

// Reachable without a session (see proxy.ts's own PUBLIC_PATHS) -- this IS the login
// endpoint, so it obviously can't itself require being already logged in. Same failed-
// attempt tracking/alerting as the existing Basic Auth gate (see authAttempts.ts), just
// triggered from the new password FORM instead of a wrong Authorization header.
export async function POST(request: Request) {
  const password = process.env.DASHBOARD_ACCESS_PASSWORD;
  if (!password) {
    return NextResponse.json({ message: "Dashboard password isn't configured yet." }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as { password?: string } | null;
  const supplied = typeof body?.password === "string" ? body.password : "";

  if (!passwordMatches(supplied, password)) {
    const ip = request.headers.get("x-forwarded-for") ?? "unknown";
    if (recordFailedDashboardAuth(ip)) {
      void sendNotification({
        category: "risk_alert",
        title: "JUDE AI — repeated failed dashboard logins",
        body: `Several wrong-password attempts hit your dashboard login page in the last few minutes (from ${ip}). If that wasn't you, consider changing DASHBOARD_ACCESS_PASSWORD in Railway.`,
      });
    }
    return NextResponse.json({ message: "Wrong password" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, createSessionCookieValue(password), {
    httpOnly: true,
    // Railway always serves this app over https -- only relaxed for local `npm run dev`
    // over plain http, where a Secure cookie would otherwise silently never get stored.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
