import type { Candle, MarketRegime } from "./types";
import { emaTrendDirection } from "./indicators/emaTrend";
import type { NewsStatus } from "./newsFilter";

const ADX_STRONG_TREND = 25;
const ADX_WEAK_TREND = 20;
const ATR_AVERAGE_PERIOD = 20; // matches signalEngine.ts's own window
const HIGH_VOLATILITY_RATIO = 1.5;
const LOW_VOLATILITY_RATIO = 0.6;
const CONSOLIDATION_RATIO = 0.8;
// How far back to look for a fresh ADX cross from weak into strong -- a genuine
// "just igniting" breakout, not merely "has been trending for a while".
const BREAKOUT_LOOKBACK_CANDLES = 5;

function average(values: number[]): number {
  const valid = values.filter((v) => !Number.isNaN(v));
  if (valid.length === 0) return NaN;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

/**
 * Classifies the current candle's market condition -- takes the SAME calculateAdx()/
 * calculateAtr() series the caller already computed (signalEngine.ts's own gates need
 * them too) rather than recomputing or adding any new indicator, per the explicit
 * "don't add more indicators" instruction this was built under. emaTrendDirection is
 * still computed here directly (cheap, and not every caller has it to hand). Priority-
 * ordered: the first matching condition wins, so a pending high-impact release always
 * reads as "news_driven" even if the technical picture also looks like a strong trend --
 * the news context is what actually matters most at that moment.
 *
 * Computed independently of evaluateSignal() (see signalEngine.ts) -- this never gates
 * or alters a trade decision, only explains the backdrop it happened against. Thresholds
 * below are documented defaults to observe and tune, not claimed-optimal figures, same
 * posture as every weighted score elsewhere in this codebase.
 */
export function detectMarketRegime(candles: Candle[], adxSeries: number[], atrSeries: number[], newsStatus: NewsStatus): MarketRegime {
  if (newsStatus.status === "high_impact_soon") return "news_driven";

  const lastIndex = candles.length - 1;
  const adx = adxSeries[lastIndex];
  const atr = atrSeries[lastIndex];

  const atrWindow = atrSeries.slice(Math.max(0, lastIndex - ATR_AVERAGE_PERIOD), lastIndex);
  const atrAverage = average(atrWindow);

  if (Number.isNaN(adx) || Number.isNaN(atr) || Number.isNaN(atrAverage) || atrAverage === 0) {
    // Not enough history yet to classify honestly -- "range" is the least specific,
    // most conservative default rather than fabricating a more confident read.
    return "range";
  }

  const wasWeak = adxSeries
    .slice(Math.max(0, lastIndex - BREAKOUT_LOOKBACK_CANDLES), lastIndex)
    .some((v) => !Number.isNaN(v) && v < ADX_WEAK_TREND);
  if (adx >= ADX_STRONG_TREND && wasWeak) return "breakout";

  if (adx >= ADX_STRONG_TREND) {
    const trend = emaTrendDirection(candles);
    if (trend === "bullish") return "strong_uptrend";
    if (trend === "bearish") return "strong_downtrend";
    // ADX is strong but EMA50/200 hasn't resolved a clear side (rare, e.g. right at a
    // crossover) -- volatility read below is still the more honest classification.
  }

  if (atr > atrAverage * HIGH_VOLATILITY_RATIO) return "high_volatility";
  if (atr < atrAverage * LOW_VOLATILITY_RATIO) return "low_volatility";

  if (adx < ADX_WEAK_TREND && atr < atrAverage * CONSOLIDATION_RATIO) return "consolidation";

  return "range";
}
