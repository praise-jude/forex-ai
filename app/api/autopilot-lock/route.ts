import { isAutopilotLocked, lockAutopilot, unlockAutopilot } from "@/lib/market/autopilotLock";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ locked: isAutopilotLocked() });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { action?: string } | null;
  const action = body?.action;
  if (action !== "lock" && action !== "unlock") {
    return Response.json({ error: "invalid_action" }, { status: 400 });
  }

  // lockAutopilot/unlockAutopilot update the in-memory switch synchronously (the DB
  // write behind them is best-effort/fire-and-forget, same posture as engineMode.ts's
  // own persistMode) -- so the response below always reflects the real, immediate state.
  if (action === "lock") lockAutopilot();
  else unlockAutopilot();

  return Response.json({ locked: isAutopilotLocked() });
}
