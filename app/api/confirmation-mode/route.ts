import { getConfirmationMode, setConfirmationMode } from "@/lib/market/confirmationMode";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(getConfirmationMode());
}

// No confirmation-phrase ceremony needed here (unlike LIVE engine mode) -- both
// manualMode values are safe (neither auto-executes without a per-trade approval), so
// there's nothing this endpoint could do to newly enable unattended real-money trading.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { manualMode?: string; proposalTtlSeconds?: number } | null;
  if (!body) {
    return Response.json({ error: "invalid_body", message: "Expected a JSON body." }, { status: 400 });
  }

  if (body.manualMode !== undefined && body.manualMode !== "signal_only" && body.manualMode !== "confirm") {
    return Response.json({ error: "invalid_manual_mode", message: 'manualMode must be "signal_only" or "confirm"' }, { status: 400 });
  }
  if (body.proposalTtlSeconds !== undefined && (!Number.isFinite(body.proposalTtlSeconds) || body.proposalTtlSeconds <= 0)) {
    return Response.json({ error: "invalid_proposal_ttl", message: "proposalTtlSeconds must be a number > 0" }, { status: 400 });
  }

  const updated = setConfirmationMode({
    manualMode: body.manualMode as "signal_only" | "confirm" | undefined,
    proposalTtlSeconds: body.proposalTtlSeconds,
  });
  return Response.json(updated);
}
