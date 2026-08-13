import { getEngineMode, manualExecutionAccount } from "@/lib/market/engineMode";
import { closeAllPositions } from "@/lib/market/metaApiConnection";

export const runtime = "nodejs";

// Same account resolution as GET /api/positions and the execute route -- closes exactly
// whichever account a manual Buy/Sell click would currently target. This is a
// destructive action (closes real, currently-open positions) -- the UI gates it behind
// its own confirmation dialog (EmergencyStopControl.tsx), matching KillSwitchControl's
// existing resume-confirmation precedent.
export async function POST() {
  const accountKey = manualExecutionAccount(getEngineMode());
  const result = await closeAllPositions(accountKey);
  return Response.json({ account: accountKey, ...result });
}
