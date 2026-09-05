import type { Pair, Timeframe } from "@/lib/market/types";
import { ALL_PAIRS } from "@/lib/market/symbols";
import { computeDurationStats, tradeJournal, type PerformanceFilter } from "@/lib/market/tradeJournal";

export const runtime = "nodejs";

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];

// Validated against every Pair the type allows, not just the currently active watchlist
// (types.ts's PAIRS) -- a position opened before a pair was retired from that watchlist
// is still a real Pair value the journal can hold, and rejecting it here silently dropped
// the filter instead of erroring, blending every pair's stats into what's supposed to be
// a single pair's duration read.
function isPair(value: string | null): value is Pair {
  return ALL_PAIRS.includes(value as Pair);
}

function isTimeframe(value: string | null): value is Timeframe {
  return TIMEFRAMES.includes(value as Timeframe);
}

/**
 * Deliberately separate from the full /api/trade-journal GET, which recomputes every
 * breakdown/calibration bucket over the whole ledger on every call -- this is the one
 * slice of that data PriceChart re-fetches on every pair/timeframe switch (see its own
 * forecast-label effect), so it stays a single cheap aggregation instead of paying for
 * everything else on that endpoint just to read two numbers.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pair = searchParams.get("pair");
  const timeframe = searchParams.get("timeframe");

  const filter: PerformanceFilter = {};
  if (isPair(pair)) filter.pair = pair;
  if (isTimeframe(timeframe)) filter.timeframe = timeframe;

  return Response.json(computeDurationStats(tradeJournal.all(), filter));
}
