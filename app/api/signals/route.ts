import { PAIRS } from "@/lib/market/types";
import { priceStore } from "@/lib/market/priceStore";
import { signalStore } from "@/lib/market/signalStore";

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
  });
}
