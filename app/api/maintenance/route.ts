import { applyRepair, runMaintenanceScan, type RepairAction } from "@/lib/market/maintenanceCheck";
import { PAIRS } from "@/lib/market/types";
import { SIGNAL_TIMEFRAMES } from "@/lib/market/metaApiConnection";

export const runtime = "nodejs";

// Read-only -- runMaintenanceScan itself never mutates anything (see its own doc
// comment). Always scans "live", the only real account this deployment has configured.
export async function GET() {
  const report = await runMaintenanceScan("live");
  return Response.json(report);
}

function isValidRepairAction(value: unknown): value is RepairAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  if (action.type === "reconnect") return action.account === "live" || action.account === "demo";
  if (action.type === "refresh_market_data") {
    return typeof action.pair === "string" && PAIRS.includes(action.pair as (typeof PAIRS)[number]) && SIGNAL_TIMEFRAMES.includes(action.timeframe as never);
  }
  return false;
}

/**
 * Mode 2 -- applies exactly one repair action the client got from a real scan's own
 * `availableRepairs` list. Deliberately does NOT re-scan or apply "all" server-side --
 * the client already knows which repairs it wants (from the report it's displaying) and
 * applies them one at a time, so each result can be shown to the operator as it
 * completes rather than only at the end. See maintenanceCheck.ts's applyRepair for the
 * real re-verify-before-acting logic.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  if (!isValidRepairAction(body?.action)) {
    return Response.json({ error: "invalid_action" }, { status: 400 });
  }
  const outcome = await applyRepair(body.action, "live");
  return Response.json(outcome);
}
