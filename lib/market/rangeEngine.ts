import { randomUUID } from "node:crypto";
import type { Candle, Confluence, NoTradeReason, Pair, Signal, SignalEvaluation, Timeframe } from "./types";
import { detectSwingPoints } from "./detectors/swings";
import { detectMarketRegime } from "./marketRegime";
import { calculateAdx } from "./indicators/adx";
import { calculateAtr } from "./indicators/atr";
import { calculateRsi } from "./indicators/rsi";
import { getActiveSession } from "./sessions";
import { checkNews, type NewsStatus } from "./newsFilter";
import { isWithinWeekendCloseWindow, nyWeekdayAndHour } from "./marketHours";
import { tierOf } from "./confidenceScore";
import { WEEKEND_CLOSE_GATE_HOURS, type HigherTimeframeCandles } from "./signalEngine";

// Enough history for ADX's 2*14-candle warmup (the longest of the indicators used
// here), with real headroom -- not a claimed-precise minimum, same "documented
// starting point" posture as every other tuned constant in this codebase.
const MIN_CANDLES = 60;
// How far back to look for the swing highs/lows that define the current range's
// boundaries -- recent enough that the range is still live, generous enough to find a
// real high and low.
const RANGE_LOOKBACK_CANDLES = 50;
const SWING_LOOKBACK = 2; // matches detectSwingPoints' own default, explicit here for clarity
// A range narrower than this (relative to ATR) is too tight to be a meaningful
// mean-reversion setup rather than noise.
const MIN_RANGE_ATR_MULTIPLE = 1.5;
// A range wider than this (relative to ATR) is never a genuine tight consolidation a
// mean-reversion strategy should trade -- same "confirmed via a real backtest" posture
// as MIN_STOP_ATR_FRACTION's own floor below, and the same failure shape: a single
// swing high/low picked up from one outlier candle (a broker feed glitch -- a near-zero
// or wildly-off tick, not a real print) can make Math.min/Math.max over the whole swing
// list pick that one bad price as the range's boundary, since detectSwingPoints has no
// sanity bound of its own on how extreme a "high"/"low" can be. Without this ceiling,
// that boundary becomes this signal's own takeProfit (the opposite boundary) --
// observed in production producing a takeProfit near zero and a negative takeProfit2
// for XAU/USD, both impossible prices for a real setup. A generous, documented starting
// point to observe and tune, not a claimed-optimal figure -- any real consolidation
// range should be nowhere close to this wide relative to current volatility.
const MAX_RANGE_ATR_MULTIPLE = 15;
// How close to a boundary counts as a genuine "touch" this candle, scaled to ATR
// rather than a flat price distance -- same reasoning as signalEngine.ts's own
// ATR-scaled sweep tolerance (see symbols.ts's XAU/USD comment on why pips aren't
// proportional to volatility).
const BOUNDARY_TOUCH_ATR_FRACTION = 0.15;
// SL buffer beyond the touched boundary -- same convention as signalEngine.ts's own
// ATR_BUFFER_FRACTION.
const STOP_BUFFER_ATR_FRACTION = 0.25;
// Floor on the total stop distance (entry to stopLoss), regardless of how close entry
// (the touched candle's own close) happens to land to the boundary itself -- only
// STOP_BUFFER_ATR_FRACTION is guaranteed by construction otherwise, and a weak/
// borderline rejection (close landing almost exactly at the boundary) can leave the
// real entry-to-stop distance far below that. Confirmed via a real backtest: without
// this floor, one such signal priced risk at a few thousandths of a price unit against
// a genuine ~30-pip move, producing a +/-60R+ outcome that swamped every other trade's
// contribution to the stats. Larger than STOP_BUFFER_ATR_FRACTION so it's the actual
// binding floor in the degenerate case; matches nearBoundary's own 0.5 ATR fraction
// used elsewhere in this file.
const MIN_STOP_ATR_FRACTION = 0.5;
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const ADX_RANGE_CEILING = 20; // genuinely non-trending, not just "not currently classified strong"
// Range trades target the opposite boundary, which is often a smaller move than a
// trend-continuation setup -- a lower floor than SMC's 1.5, still a real minimum.
const MIN_RISK_REWARD = 1.2;

function noTrade(reason: NoTradeReason): SignalEvaluation {
  return { status: "no_trade", reason };
}

/**
 * Mean-reversion counterpart to signalEngine.ts's evaluateSignal -- same SignalEvaluation
 * shape, deliberately different gating philosophy. SMC requires an active killzone
 * session and full D1/H4/H1 trend agreement; both of those were confirmed (via a real
 * backtest breakdown) to account for ~93% of every SMC rejection, because SMC is
 * specifically hunting trend-continuation setups. This engine wants the opposite market
 * condition -- price bouncing between support and resistance while genuinely NOT
 * trending -- so the regime itself (see marketRegime.ts) is the gate instead, and there
 * is no session/trend-agreement requirement at all: a real range can happen at any hour,
 * regardless of what the daily/4h/1h trend is doing.
 *
 * Skips Signer B/decisionMatrix.ts entirely (those are SMC-specific by design, see their
 * own doc comments) -- signerB* fields are honestly "unavailable", same pattern
 * TradingView-sourced signals already use for the same reason.
 *
 * Detection-only until lib/market/executionConfig.ts's rangeEngineEnabled is explicitly
 * turned on (see autoExecutionListener.ts/positionInvalidation.ts) -- this has zero
 * backtest history yet, unlike SMC's hours of validation, so it ships visible-but-inert
 * by default.
 */
export function evaluateRangeSignal(candles: Candle[], pair: Pair, timeframe: Timeframe, overrides?: { newsStatus?: NewsStatus }): SignalEvaluation {
  if (candles.length < MIN_CANDLES) return noTrade({ code: "no_range_detected" });

  const lastIndex = candles.length - 1;
  const lastCandle = candles[lastIndex];

  const adxSeries = calculateAdx(candles);
  const atrSeries = calculateAtr(candles);
  const rsiSeries = calculateRsi(candles);

  // detectMarketRegime already prioritizes a genuine high-impact-news read as
  // "news_driven" ahead of everything else -- that IS this engine's news blackout,
  // rather than a second explicit gate duplicating the same check.
  const newsStatus = overrides?.newsStatus ?? checkNews(pair, lastCandle.time);
  const regime = detectMarketRegime(candles, adxSeries, atrSeries, newsStatus);
  if (regime !== "range" && regime !== "consolidation") {
    return noTrade({ code: "not_ranging", regime });
  }

  const atr = atrSeries[lastIndex];
  if (Number.isNaN(atr) || atr <= 0) return noTrade({ code: "no_range_detected" });

  const windowStart = Math.max(0, lastIndex - RANGE_LOOKBACK_CANDLES);
  const swings = detectSwingPoints(candles.slice(windowStart, lastIndex + 1), SWING_LOOKBACK);
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  if (highs.length === 0 || lows.length === 0) return noTrade({ code: "no_range_detected" });

  const resistance = Math.max(...highs.map((s) => s.price));
  const support = Math.min(...lows.map((s) => s.price));
  const rangeWidth = resistance - support;
  if (rangeWidth < atr * MIN_RANGE_ATR_MULTIPLE || rangeWidth > atr * MAX_RANGE_ATR_MULTIPLE) {
    return noTrade({ code: "no_range_detected" });
  }

  const touchTolerance = atr * BOUNDARY_TOUCH_ATR_FRACTION;
  const touchedSupport = lastCandle.low <= support + touchTolerance;
  const touchedResistance = lastCandle.high >= resistance - touchTolerance;
  // Neither touched, or both (a degenerate/too-tight range) -- no clean read either way.
  if (touchedSupport === touchedResistance) return noTrade({ code: "no_boundary_touch" });

  const wantsBullish = touchedSupport; // bounced off support -> expect a move back up
  const direction: "long" | "short" = wantsBullish ? "long" : "short";

  // A decisive hold, same shape/reasoning as signalEngine.ts's own weekend_close_blackout
  // -- a genuine boundary touch was just found, but opening now would sit through the
  // weekend gap. Driven by the candle's own time, deterministic in backtests.
  if (isWithinWeekendCloseWindow(pair, lastCandle.time, WEEKEND_CLOSE_GATE_HOURS)) {
    return noTrade({
      code: "weekend_close_blackout",
      impliedDirection: direction,
      hoursUntilClose: Math.max(0, 17 - nyWeekdayAndHour(lastCandle.time).hour),
    });
  }

  const rsi = rsiSeries[lastIndex];
  const rsiExtreme = wantsBullish ? !Number.isNaN(rsi) && rsi <= RSI_OVERSOLD : !Number.isNaN(rsi) && rsi >= RSI_OVERBOUGHT;

  // Rejection quality: closed back away from the touched boundary, not merely wicked
  // into it -- the upper/lower 40% of the candle's own range, away from the touch side.
  const candleRange = lastCandle.high - lastCandle.low;
  const rejection =
    candleRange > 0 &&
    (wantsBullish ? (lastCandle.close - lastCandle.low) / candleRange >= 0.6 : (lastCandle.high - lastCandle.close) / candleRange >= 0.6);

  const adx = adxSeries[lastIndex];
  const cleanRange = !Number.isNaN(adx) && adx < ADX_RANGE_CEILING;

  // Entry proximity: still reasonably close to the touched boundary, not chasing a
  // bounce already well underway. Requires distanceFromBoundary >= 0 -- a negative value
  // means the close is on the WRONG side of the boundary (price broke clean through it
  // rather than bouncing), which must never score as "near" no matter how small the
  // magnitude. Without this guard, a straight breakdown/breakout candle (close far past
  // the boundary, no bounce at all) would still pass here every time, since a negative
  // number is always <= a positive ATR fraction -- silently awarding this confluence to
  // exactly the candles that most clearly disprove the bounce thesis.
  const distanceFromBoundary = wantsBullish ? lastCandle.close - support : resistance - lastCandle.close;
  const nearBoundary = distanceFromBoundary >= 0 && distanceFromBoundary <= atr * 0.5;

  let total = 0;
  const confluences: Confluence[] = ["range_regime", "boundary_touch"];
  // Rejection quality (did price actually close back away from the boundary) is
  // weighted as the strongest single factor -- it's the most direct confirmation the
  // bounce is real, ahead of RSI extremity (a supporting momentum read, not the
  // primary trigger).
  if (rejection) {
    total += 35;
    confluences.push("rejection_candle");
  }
  if (rsiExtreme) {
    total += 30;
    confluences.push("rsi_extreme");
  }
  if (cleanRange) total += 20;
  if (nearBoundary) total += 15;

  const tier = tierOf(total);
  if (tier === "no_trade") {
    return noTrade({ code: "range_below_threshold", total, impliedDirection: direction });
  }

  const entry = lastCandle.close;
  const slBuffer = atr * STOP_BUFFER_ATR_FRACTION;
  let stopLoss = wantsBullish ? support - slBuffer : resistance + slBuffer;
  // Push the stop further past the boundary (never across entry, never tighter than
  // what STOP_BUFFER_ATR_FRACTION already placed it at) when entry itself lands too
  // close to the boundary for the buffer alone to guarantee a sane risk -- see
  // MIN_STOP_ATR_FRACTION's own comment.
  const minRisk = atr * MIN_STOP_ATR_FRACTION;
  if (Math.abs(entry - stopLoss) < minRisk) {
    stopLoss = wantsBullish ? entry - minRisk : entry + minRisk;
  }
  const takeProfit = wantsBullish ? resistance : support; // the opposite boundary
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return noTrade({ code: "no_range_detected" });

  const riskReward = Math.abs(takeProfit - entry) / risk;
  if (riskReward < MIN_RISK_REWARD) {
    return noTrade({ code: "range_below_threshold", total, impliedDirection: direction });
  }
  // Informational only -- like SMC's own TP2, never actually sent to the broker as a
  // real order (see executionEngine.ts's placeMarketOrder call). One further R beyond
  // the range's own opposite boundary, since a range trade has no further swing-based
  // target the way SMC's structure does.
  const takeProfit2 = wantsBullish ? takeProfit + risk : takeProfit - risk;

  const signal: Signal = {
    id: randomUUID(),
    source: "mean_reversion",
    pair,
    direction,
    entry,
    stopLoss,
    takeProfit,
    takeProfit2,
    riskReward,
    confidence: total,
    // Single combined dimension, not SMC's direction/entry split -- mirrored into both
    // fields since Signal has no separate concept of a range-specific single score.
    directionScore: total,
    entryScore: total,
    adx,
    rsi,
    tier,
    confluences,
    session: getActiveSession(lastCandle.time), // display only, never gated on
    timeframe,
    createdAt: Date.now(),
    zoneTop: resistance,
    zoneBottom: support,
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
 * Same call signature as signalEngine.ts's evaluateSignal (`higherTimeframes`/
 * `usdStrength` accepted but unused) purely so lib/market/backtest/backtestEngine.ts's
 * runBacktest can take this as its `evaluate` override and reuse its exact
 * window-walking/outcome-simulation scaffolding, instead of forking it for this engine.
 */
export function evaluateRangeSignalForBacktest(
  candles: Candle[],
  pair: Pair,
  timeframe: Timeframe,
  _higherTimeframes: HigherTimeframeCandles,
  overrides?: { newsStatus?: NewsStatus }
): SignalEvaluation {
  return evaluateRangeSignal(candles, pair, timeframe, overrides);
}
