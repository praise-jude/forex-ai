import { PAIRS, type Pair, type Timeframe } from "@/lib/market/types";
import { candleStore } from "@/lib/market/candleStore";
import { evaluateSignal } from "@/lib/market/signalEngine";
import { calculateAdx } from "@/lib/market/indicators/adx";
import { calculateAtr } from "@/lib/market/indicators/atr";
import { detectMarketRegime } from "@/lib/market/marketRegime";
import { checkNews } from "@/lib/market/newsFilter";
import { emaTrendDirection } from "@/lib/market/indicators/emaTrend";

export const runtime = "nodejs";

// The only three timeframes the SMC engine actually generates signals on -- same list
// as metaApiConnection.ts's own (unexported) SIGNAL_TIMEFRAMES and
// TimeframeSelector.tsx's SELECTABLE_TIMEFRAMES; duplicated locally rather than
// exported, matching that existing pattern in this codebase.
const SIGNAL_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h"];

function isPair(value: string | null): value is Pair {
  return PAIRS.includes(value as Pair);
}

function isSignalTimeframe(value: string | null): value is Timeframe {
  return SIGNAL_TIMEFRAMES.includes(value as Timeframe);
}

/**
 * On-demand version of the evaluation metaApiConnection.ts's onCandlesUpdated normally
 * only runs automatically when a candle closes -- lets the dashboard's "check a pair
 * now" widget ask for pair X's current read without waiting for the next real close.
 * Reads the same live candleStore the streaming connection keeps updated, so this is
 * the real engine against real (if momentarily mid-bar) data, never a simulation.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pair = searchParams.get("pair");
  const timeframe = searchParams.get("timeframe");

  if (!isPair(pair)) {
    return Response.json({ error: `pair must be one of ${PAIRS.join(", ")}` }, { status: 400 });
  }
  if (!isSignalTimeframe(timeframe)) {
    return Response.json({ error: `timeframe must be one of ${SIGNAL_TIMEFRAMES.join(", ")}` }, { status: 400 });
  }

  // Drop the store's last entry unconditionally -- it may still be a forming (not yet
  // closed) bar, since candleStore.upsert updates the last candle in place on every
  // tick within it. evaluateSignal's contract is the prior, already-closed series only
  // (see its own doc comment), same guarantee the live onCandlesUpdated path provides
  // via its "snapshot before upsert" trick -- this is the on-demand equivalent of that.
  const closedSeries = candleStore.get(pair, timeframe).slice(0, -1);
  const higherTimeframes = {
    h1: candleStore.get(pair, "1h"),
    h4: candleStore.get(pair, "4h"),
    d1: candleStore.get(pair, "1d"),
  };

  const lastClosed = closedSeries[closedSeries.length - 1];
  if (!lastClosed) {
    // No MarketRegime value means "no data yet" (see marketRegime.ts) -- an empty
    // series can't produce one, so this is a distinct, honest failure rather than
    // guessing a regime or evaluating against nothing. Rare in practice: seedHistory.ts
    // backfills up to 300 bars per pair/timeframe at boot, so this only bites in the
    // brief window before that finishes.
    return Response.json({ error: "not_enough_data", message: "No closed candles yet for this pair/timeframe -- try again shortly." }, { status: 503 });
  }

  const evaluation = evaluateSignal(closedSeries, pair, timeframe, higherTimeframes);
  const trends = {
    d1: emaTrendDirection(higherTimeframes.d1),
    h4: emaTrendDirection(higherTimeframes.h4),
    h1: emaTrendDirection(higherTimeframes.h1),
  };
  const regime = detectMarketRegime(closedSeries, calculateAdx(closedSeries), calculateAtr(closedSeries), checkNews(pair, lastClosed.time));

  return Response.json({
    pair,
    timeframe,
    source: "smc" as const,
    evaluation,
    time: Date.now(),
    regime,
    trends,
  });
}
