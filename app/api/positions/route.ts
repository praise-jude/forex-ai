import { getEngineMode, manualExecutionAccount } from "@/lib/market/engineMode";
import { getOpenPositions } from "@/lib/market/metaApiConnection";
import { positionStore } from "@/lib/market/positionStore";

export const runtime = "nodejs";

function dayKeyFor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// Reports on whichever account a manual Buy/Sell click would currently target -- the
// same account resolution executionEngine and the execute route use -- so what's shown
// here always matches what a click on this page would actually affect.
export async function GET() {
  const accountKey = manualExecutionAccount(getEngineMode());

  return Response.json({
    account: accountKey,
    positions: getOpenPositions(accountKey),
    tradesToday: positionStore.tradesOnDay(dayKeyFor(Date.now()), accountKey).length,
  });
}
