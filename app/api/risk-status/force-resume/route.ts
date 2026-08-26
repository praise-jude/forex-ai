import { getEngineMode, manualExecutionAccount } from "@/lib/market/engineMode";
import { getAccountInformation } from "@/lib/market/metaApiConnection";
import { riskState } from "@/lib/market/riskState";

export const runtime = "nodejs";

// Distinct from /api/risk-status/acknowledge -- that route only lifts the "auto-
// execution stays paused" gate once a halt/cooldown has ALREADY cleared on its own.
// This one force-clears an ACTIVE daily-loss halt the same day it tripped, an explicit
// operator override of a real safety check -- see riskState.ts's forceResetHaltedForToday
// doc comment. RiskGuardianBanner.tsx gates this behind its own confirmation dialog,
// separate from the routine "Resume trading" button.
export async function POST() {
  const accountKey = manualExecutionAccount(getEngineMode());
  const account = getAccountInformation(accountKey);
  if (!account) {
    return Response.json({ error: "no_account", message: "No account information available yet." }, { status: 400 });
  }

  riskState.forceResetHaltedForToday(Date.now(), account.equity, accountKey);
  return Response.json({ ok: true });
}
