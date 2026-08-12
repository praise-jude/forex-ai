import { revokeSession } from "@/lib/account/sessions";
import { clearSessionCookie, getSessionCookie } from "@/lib/account/sessionCookie";

export const runtime = "nodejs";

export async function POST() {
  const rawToken = await getSessionCookie();
  if (rawToken) await revokeSession(rawToken);
  await clearSessionCookie();
  return Response.json({ ok: true });
}
