import { PAIRS, type Pair } from "@/lib/market/types";
import { candleStore } from "@/lib/market/candleStore";
import { priceStore } from "@/lib/market/priceStore";
import { suggestManualTradeLevels } from "@/lib/market/manualTradeSuggestion";

export const runtime = "nodejs";

const SUGGEST_TIMEFRAME = "15m" as const;

function isPair(value: unknown): value is Pair {
  return typeof value === "string" && PAIRS.includes(value as Pair);
}

/**
 * Auto-suggests a stop-loss/take-profit for the Manual Trade panel, from this pair's own
 * recent volatility (see manualTradeSuggestion.ts) -- so picking a pair and direction is
 * enough to get a real, non-arbitrary starting point instead of the operator having to
 * read the chart and type numbers out of thin air. Always just a pre-fill: the client
 * still shows both fields as ordinary editable inputs, and nothing here ever places or
 * registers a trade.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pair = searchParams.get("pair");
  const direction = searchParams.get("direction");

  if (!isPair(pair)) {
    return Response.json({ error: `pair must be one of ${PAIRS.join(", ")}` }, { status: 400 });
  }
  if (direction !== "long" && direction !== "short") {
    return Response.json({ error: 'direction must be "long" or "short"' }, { status: 400 });
  }

  const price = priceStore.get(pair);
  if (!price) {
    return Response.json({ error: "no live price available for this pair yet" }, { status: 400 });
  }
  const entry = direction === "long" ? price.ask : price.bid;

  const candles = candleStore.get(pair, SUGGEST_TIMEFRAME);
  const suggestion = suggestManualTradeLevels(candles, direction, entry);
  if (!suggestion) {
    return Response.json({ error: "not enough candle history yet to suggest levels" }, { status: 400 });
  }

  return Response.json({ entry, ...suggestion });
}
