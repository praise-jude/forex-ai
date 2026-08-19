import type { Candle, ExecutedTrade, MarketRegime, Pair, Signal, SignalEvaluation, SymbolSpec, Timeframe } from "../types";
import { evaluateSignal } from "../signalEngine";
import { TIMEFRAME_MS } from "../timeframes";
import { detectMarketRegime } from "../marketRegime";
import { calculateAdx } from "../indicators/adx";
import { calculateAtr } from "../indicators/atr";
import { evaluatePositionForManagement, type PositionManagementConfig, type PositionManagementState } from "../positionManager";
import { computeHistoricalUsdStrength } from "../currencyStrength";
import { checkHistoricalNews, type EconomicEvent } from "../newsFilter";

export interface OutcomeSim {
  exitPrice: number;
  exitTime: number;
  /** "invalidation" is never produced by simulateOutcome/simulateRealisticOutcome
   * themselves -- only by backtestInvalidation.ts's post-processing pass, which
   * truncates an earlier signal's natural outcome when a later opposite-direction
   * signal fires first (mirroring live's positionInvalidation.ts). Reuses the same
   * value live journal entries already use for this (see tradeJournal.ts's
   * JournalCloseReason), so no downstream consumer needs a new case. */
  reason: "take_profit" | "stop_loss" | "still_open_at_end" | "invalidation";
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

export interface RealisticSimConfig {
  /** Sourced from loadExecutionConfig("live") by the caller, so a realistic run reflects
   * the account's actual configured break-even/trailing triggers, not invented defaults.
   * partialCloseEnabled is deliberately never read as true here regardless of the
   * account's real setting -- see this feature's own scope notes on why partial-close
   * simulation (a blended two-leg outcome) is a separate, later addition. */
  positionManagement: PositionManagementConfig;
  /** Fraction of the signal's own stop distance, same convention as
   * executionConfig.ts's maxSpreadFractionOfStop -- worsens the effective entry price
   * (a market buy fills at ask, sell at bid), the one cost simulateOutcome ignores
   * entirely today. Used as the fallback whenever a real spread reading/spec isn't
   * available (see specs below). */
  spreadFractionOfStop: number;
  /** Real per-pair symbol specs (see historyLoader.ts's loadSymbolSpecs), needed here
   * for their own real broker `point` size -- the only reliable way to convert a fired
   * candle's real spread-in-points reading (see Candle.spread) into a price delta. A
   * broker's own point convention isn't reliably derivable from decimals(pair) (that
   * was tried and produced garbage R-multiples on some pairs -- see this feature's own
   * fix), so this must come from the account's real spec, never guessed. */
  specs?: Map<Pair, SymbolSpec>;
}

/**
 * Like simulateOutcome, but simulates break-even and trailing-stop position management
 * (the two features that default ON in live, see executionConfig.ts) plus spread cost --
 * kept as a separate function rather than a flag on simulateOutcome so the idealized
 * path stays byte-identical for callers that don't opt in.
 *
 * Live delegates actual tick-by-tick trailing to the broker once armed (MetaApi's own
 * server-side trailing) -- this has to simulate that manually: once armed, track a
 * running high/low-water-mark each candle and only ratchet the stop tighter, standard
 * trailing-stop semantics (a trailing stop never loosens).
 *
 * Same pessimistic tie-break philosophy as simulateOutcome: within a single candle, a
 * stop/target hit is always checked BEFORE that candle's own management action is
 * applied -- a management action born from this candle's own close price never
 * retroactively "rescues" a stop this same candle also hit, since OHLC alone can't
 * reveal real intrabar order.
 */
export function simulateRealisticOutcome(
  signal: Signal,
  future: Candle[],
  config: RealisticSimConfig,
  /** The firing candle's own broker-reported spread, in points (see historyLoader.ts's
   * Candle.spread) -- when present and positive, AND a real symbol spec (config.specs)
   * is available for this pair to convert it with, used instead of the fixed
   * spreadFractionOfStop estimate. Falls back to the estimate whenever either is
   * missing (older cached history fetched before spread-plumbing existed, a broker that
   * genuinely reports 0 on that candle, or a pair whose spec fetch failed) -- never
   * fabricated as a real reading either way. */
  realSpreadPoints?: number
): OutcomeSim {
  const isLong = signal.direction === "long";
  const stopDistance = Math.abs(signal.entry - signal.stopLoss);

  const point = config.specs?.get(signal.pair)?.point;
  const spreadCost =
    realSpreadPoints && realSpreadPoints > 0 && point ? realSpreadPoints * point : config.spreadFractionOfStop * stopDistance;
  const effectiveEntry = isLong ? signal.entry + spreadCost : signal.entry - spreadCost;

  const pseudoTrade: ExecutedTrade = {
    id: signal.id,
    signalId: signal.id,
    account: "live",
    pair: signal.pair,
    timeframe: signal.timeframe,
    direction: signal.direction,
    requestedLots: 0,
    requestedEntry: effectiveEntry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    takeProfit2: signal.takeProfit2,
    status: "filled",
    riskPct: 0,
    attemptedAt: signal.createdAt,
  };

  const managementState: PositionManagementState = { breakEvenApplied: false, trailingArmed: false, partialCloseApplied: false };
  let effectiveStop = signal.stopLoss;
  let trailingDistance = 0;
  let trailingWaterMark: number | null = null;

  for (const candle of future) {
    const hitSl = isLong ? candle.low <= effectiveStop : candle.high >= effectiveStop;
    const hitTp1 = isLong ? candle.high >= signal.takeProfit : candle.low <= signal.takeProfit;

    if (hitSl) {
      const rMultiple = stopDistance > 0 ? ((isLong ? effectiveStop - effectiveEntry : effectiveEntry - effectiveStop) / stopDistance) : 0;
      return { exitPrice: effectiveStop, exitTime: candle.time, reason: "stop_loss", rMultiple, tp2Reached: false };
    }
    if (hitTp1) {
      const hitTp2 = isLong ? candle.high >= signal.takeProfit2 : candle.low <= signal.takeProfit2;
      const rMultiple = stopDistance > 0 ? Math.abs(signal.takeProfit - effectiveEntry) / stopDistance : 0;
      return { exitPrice: signal.takeProfit, exitTime: candle.time, reason: "take_profit", rMultiple, tp2Reached: hitTp2 };
    }

    // Neither touched this candle -- ratchet an already-armed trailing stop off this
    // candle's own high/low extreme (the most favorable price actually reached),
    // then check for a fresh break-even/arm-trailing action off its close.
    if (managementState.trailingArmed) {
      const extreme = isLong ? candle.high : candle.low;
      trailingWaterMark = isLong ? Math.max(trailingWaterMark ?? extreme, extreme) : Math.min(trailingWaterMark ?? extreme, extreme);
      const candidate = isLong ? trailingWaterMark - trailingDistance : trailingWaterMark + trailingDistance;
      effectiveStop = isLong ? Math.max(effectiveStop, candidate) : Math.min(effectiveStop, candidate);
    } else {
      const action = evaluatePositionForManagement(pseudoTrade, candle.close, config.positionManagement, managementState);
      if (action.type === "break_even") {
        effectiveStop = action.newStopLoss;
        managementState.breakEvenApplied = true;
      } else if (action.type === "arm_trailing") {
        managementState.trailingArmed = true;
        trailingDistance = action.distance;
        trailingWaterMark = candle.close;
        effectiveStop = isLong ? Math.max(effectiveStop, candle.close - trailingDistance) : Math.min(effectiveStop, candle.close + trailingDistance);
      }
    }
  }

  const last = future[future.length - 1];
  return {
    exitPrice: last?.close ?? effectiveEntry,
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
  /** When set, every fired signal's outcome is simulated via simulateRealisticOutcome
   * (break-even/trailing/spread) instead of simulateOutcome's idealized fixed SL-vs-TP1.
   * Omitted entirely (not just a boolean) keeps the idealized path's call site
   * byte-identical to before this feature existed. */
  realistic?: RealisticSimConfig;
  /** Real historical closes for the 5 majors currency-strength tracks (see
   * currencyStrength.ts's TRACKED_CURRENCIES), keyed by pair -- when supplied, each
   * bar's usdStrength override is computed for real via computeHistoricalUsdStrength
   * instead of the hardcoded "unavailable". Omitted entirely keeps prior behavior
   * (Signer B's currency-strength vote reads as unavailable, same as before this
   * feature existed). */
  currencyStrengthCloses?: Partial<Record<Pair, Candle[]>>;
  /** Real historical high-impact economic events for the whole backtest window (see
   * newsFilter.ts's fetchHistoricalEconomicEvents, a paid FMP subscription -- separate
   * from TickAtlas, which powers the live news_blackout gate but has no historical
   * archive at all) -- when supplied, each bar's newsStatus override is computed for
   * real via checkHistoricalNews instead of the hardcoded "clear". Omitted entirely
   * (no FMP_API_KEY configured) keeps prior behavior exactly -- every bar reads "clear",
   * same as before this feature existed. */
  historicalNewsEvents?: EconomicEvent[];
  onBar?: (done: number, total: number) => void;
  /** Defaults to SMC's own evaluateSignal -- overridable so other engines (e.g.
   * rangeEngine.ts's mean-reversion evaluator, via its own evaluateSignal-shaped
   * adapter) can reuse this exact same window-walking/outcome-simulation scaffolding
   * instead of forking it. */
  evaluate?: typeof evaluateSignal;
}

/**
 * Walks `primary` bar by bar across the requested window, replaying evaluateSignal
 * exactly as metaApiConnection.ts does live -- same function, same gates, same
 * scoring. usdStrength/newsStatus (see evaluateSignal's own doc comment) are computed
 * for real from historical data when currencyStrengthCloses/historicalNewsEvents are
 * supplied, or fall back to the same deterministic "unavailable"/"clear" defaults as
 * before either existed when they aren't (no live connection or subscription
 * configured to source them from). On a fired signal, forward-scans the bars after it
 * via simulateOutcome.
 */
export function runBacktest(input: RunBacktestInput): BacktestBarResult[] {
  const { pair, timeframe, primary, h1, h4, d1, windowStart, windowEnd } = input;
  const evaluate = input.evaluate ?? evaluateSignal;
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

    const usdStrength = input.currencyStrengthCloses
      ? computeHistoricalUsdStrength(input.currencyStrengthCloses, barCloseTime)
      : ({ status: "unavailable" } as const);
    const newsStatus = input.historicalNewsEvents
      ? checkHistoricalNews(input.historicalNewsEvents, pair, barCloseTime)
      : ({ status: "clear" } as const);

    const evaluation = evaluate(priorSeries, pair, timeframe, higherTimeframes, { usdStrength, newsStatus });
    const regime = detectMarketRegime(priorSeries, calculateAdx(priorSeries), calculateAtr(priorSeries), newsStatus);

    const outcome =
      evaluation.status === "signal"
        ? input.realistic
          ? simulateRealisticOutcome(evaluation.signal, primary.slice(i + 1), input.realistic, bar.spread)
          : simulateOutcome(evaluation.signal, primary.slice(i + 1))
        : null;
    results.push({ barTime: bar.time, evaluation, outcome, regime });

    done++;
    input.onBar?.(done, total);
  }

  return results;
}
