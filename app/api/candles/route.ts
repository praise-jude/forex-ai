import { PAIRS, type Pair, type Timeframe } from "@/lib/market/types";
import { candleStore } from "@/lib/market/candleStore";

export const runtime = "nodejs";

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h"];

function isPair(value: string | null): value is Pair {
  return PAIRS.includes(value as Pair);
}

function isTimeframe(value: string | null): value is Timeframe {
  return TIMEFRAMES.includes(value as Timeframe);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pair = searchParams.get("pair");
  const timeframe = searchParams.get("timeframe");

  if (!isPair(pair)) {
    return Response.json({ error: `pair must be one of ${PAIRS.join(", ")}` }, { status: 400 });
  }
  if (!isTimeframe(timeframe)) {
    return Response.json({ error: `timeframe must be one of ${TIMEFRAMES.join(", ")}` }, { status: 400 });
  }

  return Response.json({ pair, timeframe, candles: candleStore.get(pair, timeframe) });
}
