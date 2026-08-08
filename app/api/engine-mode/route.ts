import { enableLiveMode, getEngineMode, manualExecutionAccount, setEngineMode } from "@/lib/market/engineMode";
import { loadExecutionConfig } from "@/lib/market/executionConfig";
import { isAccountConfigured } from "@/lib/market/metaApiConnection";

export const runtime = "nodejs";

export async function GET() {
  const mode = getEngineMode();
  // The account a manual click (or a voice hard-confirm, which goes through the same
  // execute route) would currently target -- so the risk % JUDE speaks always matches
  // what a confirmation would actually risk.
  const riskPerTradePct = loadExecutionConfig(manualExecutionAccount(mode)).riskPerTradePct;
  return Response.json({ mode, demoConfigured: isAccountConfigured("demo"), riskPerTradePct });
}

// Switching to "analysis"/"demo" is immediate, no confirmation -- both are the "safe"
// directions (no real money, or no auto-execution at all), matching the kill switch's
// existing "pause needs no confirm, resume does" asymmetry. Switching to "live" requires
// a confirmationPhrase re-stated in the body, re-validated here server-side -- never
// trust a client-only confirm dialog for something that unlocks real-money auto-trading.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { mode?: string; confirmationPhrase?: string } | null;

  if (body?.mode === "analysis") {
    setEngineMode("analysis");
    return Response.json({ mode: getEngineMode() });
  }

  if (body?.mode === "demo") {
    if (!isAccountConfigured("demo")) {
      return Response.json(
        { error: "demo_not_configured", message: "Set METAAPI_DEMO_TOKEN/METAAPI_DEMO_ACCOUNT_ID first." },
        { status: 400 }
      );
    }
    setEngineMode("demo");
    return Response.json({ mode: getEngineMode() });
  }

  if (body?.mode === "live") {
    const result = enableLiveMode(body.confirmationPhrase ?? "");
    if (!result.ok) {
      return Response.json({ error: "confirmation_mismatch", message: result.error }, { status: 400 });
    }
    return Response.json({ mode: getEngineMode() });
  }

  return Response.json({ error: "invalid_mode", message: 'mode must be "analysis", "demo", or "live"' }, { status: 400 });
}
