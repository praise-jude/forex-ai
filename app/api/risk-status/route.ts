import { getEngineMode, manualExecutionAccount } from "@/lib/market/engineMode";
import { loadExecutionConfig } from "@/lib/market/executionConfig";
import { getAccountInformation } from "@/lib/market/metaApiConnection";
import { requiresAcknowledgement, riskState } from "@/lib/market/riskState";

export const runtime = "nodejs";

// Reports on whichever account a manual Buy/Sell click (or a voice hard-confirm) would
// currently target -- same resolution /api/positions and /api/engine-mode already use.
export async function GET() {
  const accountKey = manualExecutionAccount(getEngineMode());
  const config = loadExecutionConfig(accountKey);
  const account = getAccountInformation(accountKey);
  const now = Date.now();

  const dayState = account ? riskState.current(now, account.equity, accountKey) : null;

  return Response.json({
    account: accountKey,
    haltedForToday: dayState?.haltedForToday ?? false,
    cooldownUntil: dayState?.cooldownUntil ?? null,
    consecutiveLosses: dayState?.consecutiveLosses ?? 0,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
    maxDailyLossPct: config.maxDailyLossPct,
    // True once a halt/cooldown has tripped and hasn't been explicitly acknowledged
    // since -- blocks DEMO/LIVE auto-execution even after the condition itself clears
    // (see riskState.ts, autoExecutionListener.ts). Drives RiskGuardianBanner's
    // "Resume trading" button.
    requiresAcknowledgement: dayState ? requiresAcknowledgement(dayState) : false,
  });
}
