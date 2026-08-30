import { getEngineMode, manualExecutionAccount } from "@/lib/market/engineMode";
import { getOpenPositions } from "@/lib/market/metaApiConnection";
import { positionStore } from "@/lib/market/positionStore";
import { predictionStore } from "@/lib/market/predictionStore";
import { assessPositionRisk } from "@/lib/market/positionRiskNarration";
import type { PositionRiskAssessment } from "@/lib/market/types";

export const runtime = "nodejs";

function dayKeyFor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// Reports on whichever account a manual Buy/Sell click would currently target -- the
// same account resolution executionEngine and the execute route use -- so what's shown
// here always matches what a click on this page would actually affect.
export async function GET() {
  const accountKey = manualExecutionAccount(getEngineMode());
  const rawPositions = getOpenPositions(accountKey);

  // Enriches each position with when THIS app placed it, for the chart's entry->target
  // path (see PriceChart.tsx). A position opened directly on the broker outside the app
  // (confirmed a real occurrence -- see tradesToday's own doc comment) has no matching
  // record here, so it simply gets no openedAt and the chart draws no path for it.
  const filledByBrokerPositionId = new Map(
    positionStore
      .all()
      .filter((trade) => trade.status === "filled" && trade.brokerPositionId && trade.filledAt !== undefined)
      .map((trade) => [trade.brokerPositionId as string, trade.filledAt as number])
  );
  const positions = rawPositions.map((position) => {
    const openedAt = filledByBrokerPositionId.get(position.id);
    return openedAt !== undefined ? { ...position, openedAt } : position;
  });

  // Always the FRESH, current read -- unlike metaApiConnection.ts's own position-risk
  // wiring (which only emits on a real level change, to keep voice/push notifications
  // from repeating), this passive display has no reason to hide an unchanged "caution"
  // from someone looking at the dashboard right now. Only ever populated for "live"
  // (predictionStore.ts's own regime/trends reads come from the live candle stream --
  // demo positions show no risk read, same "no second signal engine" boundary as the
  // rest of this app's demo-account handling).
  const risk: Record<string, PositionRiskAssessment> = {};
  if (accountKey === "live") {
    for (const position of positions) {
      const prediction = predictionStore.get(position.pair, "15m", "smc");
      if (prediction) risk[position.id] = assessPositionRisk(position.direction, prediction.regime, prediction.trends);
    }
  }

  return Response.json({
    account: accountKey,
    positions,
    risk,
    tradesToday: positionStore.tradesOnDay(dayKeyFor(Date.now()), accountKey).length,
  });
}
