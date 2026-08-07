import { signalStore } from "@/lib/market/signalStore";
import { attemptExecution } from "@/lib/market/executionEngine";
import { getEngineMode, manualExecutionAccount } from "@/lib/market/engineMode";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const signal = signalStore.get(id);
  if (!signal) {
    return Response.json({ status: "not_found" }, { status: 404 });
  }

  // Mode-aware: a click in DEMO engine mode fires against the demo account, never live
  // — so testing in DEMO mode can't accidentally place a real order via a manual click.
  // In ANALYSIS or LIVE mode this resolves to "live", unchanged from before DEMO existed.
  const result = await attemptExecution(signal, manualExecutionAccount(getEngineMode()));
  return Response.json(result);
}
