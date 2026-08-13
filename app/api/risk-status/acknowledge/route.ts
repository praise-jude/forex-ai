import { getEngineMode, manualExecutionAccount } from "@/lib/market/engineMode";
import { getAccountInformation } from "@/lib/market/metaApiConnection";
import { riskState } from "@/lib/market/riskState";

export const runtime = "nodejs";

// The explicit human action that lets DEMO/LIVE auto-execution resume after a
// halt/cooldown -- see riskState.ts's own doc comment on why this exists at all (the
// condition clearing on its own, e.g. a cooldown timer or day rollover, is NOT enough).
// No confirmation-phrase ceremony -- resuming here can only ever re-arm auto-execution
// to exactly today's already-configured risk limits, never loosen them.
export async function POST() {
  const accountKey = manualExecutionAccount(getEngineMode());
  const account = getAccountInformation(accountKey);
  if (!account) {
    return Response.json({ error: "no_account", message: "No account information available yet." }, { status: 400 });
  }

  riskState.acknowledge(Date.now(), account.equity, accountKey);
  return Response.json({ ok: true });
}
