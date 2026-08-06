import type { Candle } from "../types";

export type CandlestickPattern =
  | "bullish_engulfing"
  | "bearish_engulfing"
  | "pin_bar_bullish"
  | "pin_bar_bearish"
  | "morning_star"
  | "evening_star";

const SMALL_BODY_RATIO = 0.3;
const LONG_WICK_RATIO = 0.6;
const STRONG_BODY_RATIO = 0.6;
const INDECISION_BODY_RATIO = 0.4;

const isBullish = (c: Candle) => c.close > c.open;
const isBearish = (c: Candle) => c.close < c.open;
const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => c.high - c.low;

function isBullishEngulfing(prev: Candle, cur: Candle): boolean {
  return isBearish(prev) && isBullish(cur) && cur.open <= prev.close && cur.close >= prev.open;
}

function isBearishEngulfing(prev: Candle, cur: Candle): boolean {
  return isBullish(prev) && isBearish(cur) && cur.open >= prev.close && cur.close <= prev.open;
}

/** Small body pinned near the top of the range with a long lower wick (also covers Hammer). */
function isPinBarBullish(c: Candle): boolean {
  const r = range(c);
  if (r <= 0) return false;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return body(c) <= r * SMALL_BODY_RATIO && lowerWick >= r * LONG_WICK_RATIO;
}

/** Small body pinned near the bottom of the range with a long upper wick (also covers Shooting Star). */
function isPinBarBearish(c: Candle): boolean {
  const r = range(c);
  if (r <= 0) return false;
  const upperWick = c.high - Math.max(c.open, c.close);
  return body(c) <= r * SMALL_BODY_RATIO && upperWick >= r * LONG_WICK_RATIO;
}

function isMorningStar(a: Candle, b: Candle, c: Candle): boolean {
  const aRange = range(a);
  const bRange = range(b);
  const cRange = range(c);
  if (aRange <= 0 || bRange <= 0 || cRange <= 0) return false;
  const strongBearishFirst = isBearish(a) && body(a) >= aRange * STRONG_BODY_RATIO;
  const smallMiddle = body(b) <= bRange * INDECISION_BODY_RATIO;
  const strongBullishLast = isBullish(c) && body(c) >= cRange * STRONG_BODY_RATIO;
  const closesAboveFirstMidpoint = c.close > (a.open + a.close) / 2;
  return strongBearishFirst && smallMiddle && strongBullishLast && closesAboveFirstMidpoint;
}

function isEveningStar(a: Candle, b: Candle, c: Candle): boolean {
  const aRange = range(a);
  const bRange = range(b);
  const cRange = range(c);
  if (aRange <= 0 || bRange <= 0 || cRange <= 0) return false;
  const strongBullishFirst = isBullish(a) && body(a) >= aRange * STRONG_BODY_RATIO;
  const smallMiddle = body(b) <= bRange * INDECISION_BODY_RATIO;
  const strongBearishLast = isBearish(c) && body(c) >= cRange * STRONG_BODY_RATIO;
  const closesBelowFirstMidpoint = c.close < (a.open + a.close) / 2;
  return strongBullishFirst && smallMiddle && strongBearishLast && closesBelowFirstMidpoint;
}

/**
 * Checked only at the signal candle. Priority: the more specific 3-candle star
 * patterns first, then 2-candle engulfing, then the single-candle pin bar (which is
 * the easiest shape to satisfy by chance, so it loses to a more specific match).
 */
export function detectCandlestickPattern(candles: Candle[], index: number): CandlestickPattern | null {
  const cur = candles[index];

  if (index >= 2) {
    const a = candles[index - 2];
    const b = candles[index - 1];
    if (isMorningStar(a, b, cur)) return "morning_star";
    if (isEveningStar(a, b, cur)) return "evening_star";
  }

  if (index >= 1) {
    const prev = candles[index - 1];
    if (isBullishEngulfing(prev, cur)) return "bullish_engulfing";
    if (isBearishEngulfing(prev, cur)) return "bearish_engulfing";
  }

  if (isPinBarBullish(cur)) return "pin_bar_bullish";
  if (isPinBarBearish(cur)) return "pin_bar_bearish";

  return null;
}
