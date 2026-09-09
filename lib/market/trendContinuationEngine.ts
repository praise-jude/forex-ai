import { randomUUID } from "node:crypto";
import type { Candle, Confluence, NoTradeReason, Pair, Signal, SignalEvaluation, Timeframe } from "./types";
import { detectSwingPoints } from "./detectors/swings";
import { detectMarketRegime } from "./marketRegime";
import { calculateAdx } from "./indicators/adx";
import { calculateAtr } from "./indicators/atr";
import { calculateRsi } from "./indicators/rsi";
import { emaTrendDirection } from "./indicators/emaTrend";
import { getActiveSession } from "./sessions";
import type { NewsStatus } from "./newsFilter";
import { checkNews } from "./newsFilter";
import type { HigherTimeframeCandles } from "./signalEngine";

/**
 * Third signal engine, alongside SMC (signalEngine.ts, liquidity-sweep reversals) and
 * Range Engine (rangeEngine.ts, mean-reversion) -- trades a calm, multi-timeframe-
 * agreeing trend continuation that neither of the other two is built to touch (SMC hunts
 * reversals off a sweep; Range Engine only acts in a ranging regime). Real, evidence-
 * backed (operator observation 2026-09-09: a live screenshot showed Signer B and all 5
 * timeframes agreeing BUY while SMC/Range Engine both sat Neutral -- exactly this
 * condition). Validated via a 120-day/5-pair backtest run against the app's OWN real
 * live position-management logic (positionManager.ts's break-even/trailing system, via
 * simulateRealisticOutcome, not an idealized fixed target) before being wired in here:
 * 129 trades, 50.4% win rate, +0.381 average R, 1.88 profit factor. Ships DEMO-only by
 * default (see executionConfig.ts's trendContinuationEnabled) -- same conservative
 * "detection visible, execution opt-in" posture Range Engine launched with.
 *
 * A pure boolean gate cascade, not a graduated score: every signal that fires has
 * cleared the exact same three real gates (established trend regime, higher-timeframe
 * agreement, a genuine pullback-and-resume moment) -- there is no partial credit and,
 * unlike SMC/Range Engine, no near-miss numeric score to report yet (a real future
 * refinement, not a blocker to shipping the validated entry). Fixed at a flat 82/100
 * (buy tier) when it fires -- deliberately not strong_buy (90+), since this is a new,
 * still-small-sample-validated engine, same restrained posture Range Engine itself
 * launched with.
 */

const MIN_CANDLES = 220; // covers the D1 EMA200 warmup this engine's own lead-in needs
const ATR_BUFFER_FRACTION = 0.5;
// A rare "home run" backstop, deliberately far beyond where the real live trailing
// system (armed at 1.5R by default -- see executionConfig.ts's trailingArmTriggerR)
// would normally already have taken over -- lets positionManager.ts's own break-even/
// trailing logic do the real exit work, matching exactly what was validated.
const FAR_TARGET_RISK_REWARD = 8;
const FAR_TARGET_RISK_REWARD_2 = 10;
const SWING_LOOKBACK = 2;
const SWING_WINDOW_CANDLES = 15; // tight, anchored to the pullback's own low/high, not the trend's origin
const RSI_EXTENDED_LOOKBACK = 10; // how far back to look for the impulsive move that started the trend
const RSI_EXTENDED_BULL = 65;
const RSI_EXTENDED_BEAR = 35;
const RSI_RESET_ZONE_BULL: [number, number] = [35, 55];
const RSI_RESET_ZONE_BEAR: [number, number] = [45, 65];
const ANTI_OVERLAP_LOOKBACK = 5; // don't re-fire the same direction within this many candles
const CONFIDENCE_WHEN_QUALIFIED = 82;

function regimeDirection(candles: Candle[], newsStatus: NewsStatus): { direction: "long" | "short" } | { regime: ReturnType<typeof detectMarketRegime> } {
  const adxSeries = calculateAdx(candles);
  const atrSeries = calculateAtr(candles);
  const regime = detectMarketRegime(candles, adxSeries, atrSeries, newsStatus);
  if (regime === "strong_uptrend") return { direction: "long" };
  if (regime === "strong_downtrend") return { direction: "short" };
  return { regime };
}

function bigPictureAgrees(direction: "long" | "short", higherTimeframes: HigherTimeframeCandles): boolean {
  const wants = direction === "long" ? "bullish" : "bearish";
  return emaTrendDirection(higherTimeframes.h4) === wants && emaTrendDirection(higherTimeframes.d1) === wants;
}

/** True if candles' own last candle is a genuine pullback-reset entry in `direction`. */
function pullbackResetAt(candles: Candle[], direction: "long" | "short"): boolean {
  const rsiSeries = calculateRsi(candles);
  const lastIndex = candles.length - 1;
  const rsi = rsiSeries[lastIndex];
  const rsiPrev = rsiSeries[lastIndex - 1];
  if (Number.isNaN(rsi) || Number.isNaN(rsiPrev)) return false;

  const recentWindow = rsiSeries.slice(Math.max(0, lastIndex - RSI_EXTENDED_LOOKBACK), lastIndex);
  const wasExtended =
    direction === "long"
      ? recentWindow.some((v) => !Number.isNaN(v) && v > RSI_EXTENDED_BULL)
      : recentWindow.some((v) => !Number.isNaN(v) && v < RSI_EXTENDED_BEAR);
  if (!wasExtended) return false;

  const [lo, hi] = direction === "long" ? RSI_RESET_ZONE_BULL : RSI_RESET_ZONE_BEAR;
  if (rsi < lo || rsi > hi) return false;

  const ticking = direction === "long" ? rsi > rsiPrev : rsi < rsiPrev;
  if (!ticking) return false;

  const lastCandle = candles[lastIndex];
  const candleRange = lastCandle.high - lastCandle.low;
  if (candleRange <= 0) return false;
  return direction === "long" ? (lastCandle.close - lastCandle.low) / candleRange >= 0.5 : (lastCandle.high - lastCandle.close) / candleRange >= 0.5;
}

export function evaluateTrendContinuation(
  candles: Candle[],
  pair: Pair,
  timeframe: Timeframe,
  higherTimeframes: HigherTimeframeCandles,
  overrides?: { newsStatus?: NewsStatus }
): SignalEvaluation {
  const noTrade = (reason: NoTradeReason): SignalEvaluation => ({ status: "no_trade", reason });
  if (candles.length < MIN_CANDLES) return noTrade({ code: "not_trending", regime: "low_volatility" });

  const lastCandle = candles[candles.length - 1];
  const newsStatus = overrides?.newsStatus ?? checkNews(pair, lastCandle.time);
  const regimeResult = regimeDirection(candles, newsStatus);
  if ("regime" in regimeResult) return noTrade({ code: "not_trending", regime: regimeResult.regime });
  const { direction } = regimeResult;

  if (!bigPictureAgrees(direction, higherTimeframes)) return noTrade({ code: "no_higher_timeframe_confluence", impliedDirection: direction });
  if (!pullbackResetAt(candles, direction)) return noTrade({ code: "no_pullback_reset", impliedDirection: direction });

  // Anti-overlap: this same setup must not have already fired in the last few candles
  // (RSI can hover in the reset zone for more than one bar) -- checked by recomputing
  // the full condition on each prior candle.
  for (let back = 1; back <= ANTI_OVERLAP_LOOKBACK; back++) {
    const priorCandles = candles.slice(0, candles.length - back);
    if (priorCandles.length < MIN_CANDLES) break;
    const priorRegime = regimeDirection(priorCandles, newsStatus);
    if ("direction" in priorRegime && priorRegime.direction === direction && bigPictureAgrees(direction, higherTimeframes) && pullbackResetAt(priorCandles, direction)) {
      return noTrade({ code: "no_pullback_reset", impliedDirection: direction });
    }
  }

  const lastIndex = candles.length - 1;
  const atrSeries = calculateAtr(candles);
  const atr = atrSeries[lastIndex];
  if (Number.isNaN(atr) || atr <= 0) return noTrade({ code: "not_trending", regime: "low_volatility" });

  const wantsBullish = direction === "long";
  const swingWindow = candles.slice(Math.max(0, lastIndex - SWING_WINDOW_CANDLES), lastIndex + 1);
  const swings = detectSwingPoints(swingWindow, SWING_LOOKBACK);
  const relevant = swings.filter((s) => s.type === (wantsBullish ? "low" : "high"));
  if (relevant.length === 0) return noTrade({ code: "no_pullback_reset", impliedDirection: direction });
  const structuralStop = wantsBullish ? Math.min(...relevant.map((s) => s.price)) : Math.max(...relevant.map((s) => s.price));

  const entry = lastCandle.close;
  const buffer = atr * ATR_BUFFER_FRACTION;
  const stopLoss = wantsBullish ? structuralStop - buffer : structuralStop + buffer;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0 || risk > atr * 8) return noTrade({ code: "no_pullback_reset", impliedDirection: direction });

  const takeProfit = wantsBullish ? entry + risk * FAR_TARGET_RISK_REWARD : entry - risk * FAR_TARGET_RISK_REWARD;
  const takeProfit2 = wantsBullish ? entry + risk * FAR_TARGET_RISK_REWARD_2 : entry - risk * FAR_TARGET_RISK_REWARD_2;
  const rsiSeries = calculateRsi(candles);

  const confluences: Confluence[] = ["trend_regime", "higher_timeframe_confluence", "pullback_reset"];

  const signal: Signal = {
    id: randomUUID(),
    source: "trend_continuation",
    pair,
    direction,
    entry,
    stopLoss,
    takeProfit,
    takeProfit2,
    riskReward: FAR_TARGET_RISK_REWARD,
    confidence: CONFIDENCE_WHEN_QUALIFIED,
    directionScore: CONFIDENCE_WHEN_QUALIFIED,
    entryScore: CONFIDENCE_WHEN_QUALIFIED,
    adx: calculateAdx(candles)[lastIndex],
    rsi: rsiSeries[lastIndex],
    tier: "buy",
    confluences,
    session: getActiveSession(lastCandle.time),
    timeframe,
    createdAt: Date.now(),
    // Never computes Signer B -- same posture as rangeEngine.ts's own signals, which
    // also skip it entirely (see that file's identical "unavailable" defaults).
    signerBDirection: "unavailable",
    signerBConfidence: 0,
    signerBEmaTrend: "unavailable",
    rsiDivergence: "unavailable",
    supertrendTrend: "unavailable",
    usdStrengthStatus: "unavailable",
    newsStatus: newsStatus.status,
  };
  return { status: "signal", signal };
}

/**
 * Same call signature as signalEngine.ts's evaluateSignal / rangeEngine.ts's
 * evaluateRangeSignalForBacktest, purely so backtestEngine.ts's runBacktest can take
 * this as its `evaluate` override.
 */
export function evaluateTrendContinuationForBacktest(
  candles: Candle[],
  pair: Pair,
  timeframe: Timeframe,
  higherTimeframes: HigherTimeframeCandles,
  overrides?: { newsStatus?: NewsStatus }
): SignalEvaluation {
  return evaluateTrendContinuation(candles, pair, timeframe, higherTimeframes, overrides);
}
