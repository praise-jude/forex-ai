import { PAIRS } from "@/lib/market/types";
import { priceStore } from "@/lib/market/priceStore";
import { signalStore } from "@/lib/market/signalStore";
import { positionStore } from "@/lib/market/positionStore";
import { predictionStore } from "@/lib/market/predictionStore";
import { allBlockedOutcomes } from "@/lib/market/blockedOutcomeStore";

export const runtime = "nodejs";

export async function GET() {
  const watchlist = PAIRS.map((pair) => {
    const price = priceStore.get(pair);
    return {
      pair,
      bid: price?.bid ?? null,
      ask: price?.ask ?? null,
      time: price?.time ?? null,
    };
  });

  return Response.json({
    asOf: Date.now(),
    watchlist,
    signals: signalStore.all(),
    executedTrades: positionStore.all(),
    predictions: predictionStore.all(),
    blockedOutcomes: allBlockedOutcomes(),
  });
}
