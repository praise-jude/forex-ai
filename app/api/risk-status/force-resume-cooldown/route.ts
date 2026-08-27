import { getEngineMode, manualExecutionAccount } from "@/lib/market/engineMode";
import { getAccountInformation } from "@/lib/market/metaApiConnection";
import { riskState } from "@/lib/market/riskState";

export const runtime = "nodejs";

// Sibling of /api/risk-status/force-resume, but for the consecutive-loss cooldown
// instead of the daily-loss halt -- see riskState.ts's forceResetCooldown doc comment.
// RiskGuardianBanner.tsx gates this behind its own confirmation dialog on the COOLDOWN
// ACTIVE banner, separate from the routine "Resume trading" button.
export async function POST() {
  const accountKey = manualExecutionAccount(getEngineMode());
  const account = getAccountInformation(accountKey);
  if (!account) {
    return Response.json({ error: "no_account", message: "No account information available yet." }, { status: 400 });
  }

  riskState.forceResetCooldown(Date.now(), account.equity, accountKey);
  return Response.json({ ok: true });
}
