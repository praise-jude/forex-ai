import { getExecutionPolicy, setExecutionPolicy } from "@/lib/market/executionPolicy";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(getExecutionPolicy());
}

// No confirmation-phrase ceremony (unlike POST /api/engine-mode's LIVE path) -- the
// floor invariant in executionPolicy.ts (minTier can't go below "buy", minRiskReward
// can't go below 0) means this can only ever make execution MORE selective than today's
// shipped behavior, never less. Nothing here can newly enable real-money trading.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { minTier?: string; minRiskReward?: number; calibratedGateEnabled?: boolean }
    | null;
  if (!body) {
    return Response.json({ error: "invalid_body", message: "Expected a JSON body." }, { status: 400 });
  }

  if (body.minTier !== undefined && body.minTier !== "buy" && body.minTier !== "strong_buy") {
    return Response.json({ error: "invalid_min_tier", message: 'minTier must be "buy" or "strong_buy"' }, { status: 400 });
  }
  if (body.minRiskReward !== undefined && (!Number.isFinite(body.minRiskReward) || body.minRiskReward < 0)) {
    return Response.json({ error: "invalid_min_risk_reward", message: "minRiskReward must be a number >= 0" }, { status: 400 });
  }
  if (body.calibratedGateEnabled !== undefined && typeof body.calibratedGateEnabled !== "boolean") {
    return Response.json({ error: "invalid_calibrated_gate_enabled", message: "calibratedGateEnabled must be a boolean" }, { status: 400 });
  }

  const updated = setExecutionPolicy({
    minTier: body.minTier as "buy" | "strong_buy" | undefined,
    minRiskReward: body.minRiskReward,
    calibratedGateEnabled: body.calibratedGateEnabled,
  });
  return Response.json(updated);
}
