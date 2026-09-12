import { getEngineMode, manualExecutionAccount } from "@/lib/market/engineMode";
import { getAccountInformation } from "@/lib/market/metaApiConnection";
import { riskState } from "@/lib/market/riskState";

export const runtime = "nodejs";

// Distinct from /api/risk-status/force-resume -- that one clears an active halt but
// deliberately leaves startOfDayEquity untouched (see forceResetHaltedForToday's own
// doc comment: it must not let a further real loss re-trip the halt against a widened
// budget). This route is for the OTHER case: a manual deposit/withdrawal changed real
// equity by an amount that has nothing to do with trading, so today's whole anchor is
// just stale, not something a further loss should be measured against at all. Re-reads
// account.equity fresh right here -- never trusts a client-supplied number for this --
// so the new anchor is always whatever the broker actually reports right now.
export async function POST() {
  const accountKey = manualExecutionAccount(getEngineMode());
  const account = getAccountInformation(accountKey);
  if (!account) {
    return Response.json({ error: "no_account", message: "No account information available yet." }, { status: 400 });
  }

  riskState.reanchorStartOfDayEquity(Date.now(), account.equity, accountKey);
  return Response.json({ ok: true, newStartOfDayEquity: account.equity });
}
