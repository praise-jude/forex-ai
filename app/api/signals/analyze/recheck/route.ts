import { PAIRS, type Pair, type Timeframe } from "@/lib/market/types";
import { candleStore } from "@/lib/market/candleStore";
import { evaluateSpecificDirection } from "@/lib/market/signalEngine";

export const runtime = "nodejs";

// Same three timeframes the SMC engine actually generates signals on -- see
// /api/signals/evaluate/route.ts's own identical list and doc comment.
const SIGNAL_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h"];

function isPair(value: string | null): value is Pair {
  return PAIRS.includes(value as Pair);
}

function isSignalTimeframe(value: string | null): value is Timeframe {
  return SIGNAL_TIMEFRAMES.includes(value as Timeframe);
}

function isDirection(value: string | null): value is "long" | "short" {
  return value === "long" || value === "short";
}

/**
 * Powers the mobile/web "Check a Pair" signal-weakening monitor (spec section 11): once
 * a result card is showing a real BUY or SELL read, this is polled every ~10s to ask
 * "is THAT specific direction still holding up right now" -- see
 * evaluateSpecificDirection's own doc comment for why this can't just reuse the plain
 * /api/signals/evaluate route (that one always follows whichever sweep is currently
 * most recent, which can silently drift to the other side). Also reports whether the
 * OPPOSITE direction has independently become a real, qualifying signal in the
 * meantime -- a genuine reversal, the clearest possible real signal that the original
 * setup is done, same condition positionInvalidation.ts already treats as a hard
 * invalidation for an open position.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pair = searchParams.get("pair");
  const timeframe = searchParams.get("timeframe");
  const direction = searchParams.get("direction");

  if (!isPair(pair)) {
    return Response.json({ error: `pair must be one of ${PAIRS.join(", ")}` }, { status: 400 });
  }
  if (!isSignalTimeframe(timeframe)) {
    return Response.json({ error: `timeframe must be one of ${SIGNAL_TIMEFRAMES.join(", ")}` }, { status: 400 });
  }
  if (!isDirection(direction)) {
    return Response.json({ error: "direction must be one of long, short" }, { status: 400 });
  }

  const closedSeries = candleStore.get(pair, timeframe).slice(0, -1);
  if (closedSeries.length === 0) {
    return Response.json({ error: "not_enough_data", message: "No closed candles yet for this pair/timeframe -- try again shortly." }, { status: 503 });
  }
  const higherTimeframes = {
    h1: candleStore.get(pair, "1h"),
    h4: candleStore.get(pair, "4h"),
    d1: candleStore.get(pair, "1d"),
  };

  const evaluation = evaluateSpecificDirection(closedSeries, pair, timeframe, higherTimeframes, direction);
  const opposing = evaluateSpecificDirection(closedSeries, pair, timeframe, higherTimeframes, direction === "long" ? "short" : "long");

  return Response.json({
    pair,
    timeframe,
    direction,
    evaluation,
    opposingSignal: opposing.status === "signal",
    time: Date.now(),
  });
}
