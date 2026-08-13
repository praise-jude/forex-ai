import type { Candle, MarketRegime, Pair, Signal, SignalEvaluation, Timeframe } from "../types";
import { evaluateSignal } from "../signalEngine";
import { TIMEFRAME_MS } from "../timeframes";
import { detectMarketRegime } from "../marketRegime";
import { calculateAdx } from "../indicators/adx";
import { calculateAtr } from "../indicators/atr";

export interface OutcomeSim {
  exitPrice: number;
  exitTime: number;
  reason: "take_profit" | "stop_loss" | "still_open_at_end";
  /** -1 on stop_loss, the real R-multiple on take_profit, 0 on still_open_at_end (the
   * window ran out before either was touched -- expected near the end of any requested
   * range, not an error). */
  rMultiple: number;
  /** Informational only -- take_profit2 is never actually sent to the broker as a real
   * order (see executionEngine.ts's placeMarketOrder call), so it never drives
   * rMultiple/reason, only this secondary flag. */
  tp2Reached: boolean;
}

export interface BacktestBarResult {
  barTime: number;
  evaluation: SignalEvaluation;
  outcome: OutcomeSim | null;
  /** Computed the same way metaApiConnection.ts's live path does (detectMarketRegime
   * over the same closed-candle series, with the same deterministic newsStatus override
   * evaluateSignal itself gets here) -- real, not fabricated, kept alongside each bar so
   * backtestStats.ts can build a genuine SignalContext for every fired signal, exactly
   * like the live journal does. */
  regime: MarketRegime;
}

/**
 * Scans candles after a fired signal for whichever of stop-loss or take-profit-1 is
 * touched first. Same-candle ambiguity (a single bar's range crosses both) is resolved
 * pessimistically -- stop-loss wins -- since OHLC alone can't reveal real intrabar
 * order, and assuming the worse outcome is the honest default, not the optimistic one.
 */
export function simulateOutcome(signal: Signal, future: Candle[]): OutcomeSim {
  const isLong = signal.direction === "long";
  const risk = Math.abs(signal.entry - signal.stopLoss);

  for (const candle of future) {
    const hitSl = isLong ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
    const hitTp1 = isLong ? candle.high >= signal.takeProfit : candle.low <= signal.takeProfit;

    if (hitSl) {
      return { exitPrice: signal.stopLoss, exitTime: candle.time, reason: "stop_loss", rMultiple: -1, tp2Reached: false };
    }
    if (hitTp1) {
      const hitTp2 = isLong ? candle.high >= signal.takeProfit2 : candle.low <= signal.takeProfit2;
      const rMultiple = risk > 0 ? Math.abs(signal.takeProfit - signal.entry) / risk : 0;
      return { exitPrice: signal.takeProfit, exitTime: candle.time, reason: "take_profit", rMultiple, tp2Reached: hitTp2 };
    }
  }

  const last = future[future.length - 1];
  return {
    exitPrice: last?.close ?? signal.entry,
    exitTime: last?.time ?? signal.createdAt,
    reason: "still_open_at_end",
    rMultiple: 0,
    tp2Reached: false,
  };
}

/** A higher-timeframe candle only counts as "closed and knowable" once its own bar
 * duration has elapsed past its open time (`candle.time` is open time, see types.ts) --
 * the explicit no-lookahead guarantee. Live streaming can only ever see HTF candles
 * that have actually closed by construction; replay holds full future history in
 * memory, so this constraint has to be enforced explicitly here instead. */
function closedAsOf(series: Candle[], cutoffMs: number, tf: Timeframe): Candle[] {
  const durationMs = TIMEFRAME_MS[tf];
  let end = series.length;
  while (end > 0 && series[end - 1].time + durationMs > cutoffMs) end--;
  return series.slice(0, end);
}

export interface RunBacktestInput {
  pair: Pair;
  timeframe: Timeframe;
  /** Oldest-first, includes lead-in history before windowStart -- see
   * historyLoader.ts's lead-in buffers. Lead-in bars are context-only, never
   * individually scored (see startIndex below). */
  primary: Candle[];
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
  windowStart: number;
  windowEnd: number;
  onBar?: (done: number, total: number) => void;
}

/**
 * Walks `primary` bar by bar across the requested window, replaying evaluateSignal
 * exactly as metaApiConnection.ts does live -- same function, same gates, same
 * scoring -- with two deterministic overrides (see evaluateSignal's own doc comment)
 * standing in for the two live-only data sources (news calendar, currency-strength
 * cache) that have no historical archive behind them. On a fired signal, forward-scans
 * the bars after it via simulateOutcome.
 */
export function runBacktest(input: RunBacktestInput): BacktestBarResult[] {
  const { pair, timeframe, primary, h1, h4, d1, windowStart, windowEnd } = input;
  const results: BacktestBarResult[] = [];

  const startIndex = primary.findIndex((c) => c.time >= windowStart);
  if (startIndex === -1) return results;

  let endIndex = primary.length - 1;
  while (endIndex >= startIndex && primary[endIndex].time > windowEnd) endIndex--;
  if (endIndex < startIndex) return results;

  const total = endIndex - startIndex + 1;
  let done = 0;

  for (let i = startIndex; i <= endIndex; i++) {
    const bar = primary[i];
    const barCloseTime = bar.time + TIMEFRAME_MS[timeframe];
    const priorSeries = primary.slice(0, i + 1);
    const higherTimeframes = {
      h1: closedAsOf(h1, barCloseTime, "1h"),
      h4: closedAsOf(h4, barCloseTime, "4h"),
      d1: closedAsOf(d1, barCloseTime, "1d"),
    };

    const evaluation = evaluateSignal(priorSeries, pair, timeframe, higherTimeframes, {
      usdStrength: { status: "unavailable" },
      newsStatus: { status: "clear" },
    });
    const regime = detectMarketRegime(priorSeries, calculateAdx(priorSeries), calculateAtr(priorSeries), { status: "clear" });

    const outcome = evaluation.status === "signal" ? simulateOutcome(evaluation.signal, primary.slice(i + 1)) : null;
    results.push({ barTime: bar.time, evaluation, outcome, regime });

    done++;
    input.onBar?.(done, total);
  }

  return results;
}
