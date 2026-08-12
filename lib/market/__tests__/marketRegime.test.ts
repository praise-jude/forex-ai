import { describe, expect, it } from "vitest";
import { detectMarketRegime } from "../marketRegime";
import { candle } from "../detectors/__tests__/fixtures";
import type { Candle } from "../types";
import type { NewsStatus } from "../newsFilter";

// (MarketRegime itself lives in ../types -- the classifier's return values are
// compared against plain string literals below, so no extra import is needed here.)

const CLEAR: NewsStatus = { status: "clear" };
const NEWS_SOON: NewsStatus = { status: "high_impact_soon", event: "NFP", currency: "USD", minutesUntil: 10 };

function trendingCandles(count: number, direction: "up" | "down"): Candle[] {
  const step = direction === "up" ? 0.001 : -0.001;
  const candles: Candle[] = [];
  let price = 1;
  for (let i = 0; i < count; i++) {
    const open = price;
    price += step;
    candles.push(candle(i, open, Math.max(open, price) + 0.0001, Math.min(open, price) - 0.0001, price));
  }
  return candles;
}

function flatCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => candle(i, 1, 1.001, 0.999, 1));
}

/** Builds an ADX/ATR series of `length` where indices [length-20, length-1) (the
 * averaging window) hold `baseline` and the final index holds `latest` -- lets a test
 * control the exact "current vs. its own recent average" ratio the classifier reads. */
function series(length: number, baseline: number, latest: number): number[] {
  const arr = new Array<number>(length).fill(baseline);
  arr[length - 1] = latest;
  return arr;
}

describe("detectMarketRegime", () => {
  it("prioritizes news_driven over a strong technical trend", () => {
    const candles = trendingCandles(250, "up");
    const adx = series(250, 30, 30); // strong trend by itself would read as strong_uptrend
    const atr = series(250, 0.001, 0.001);
    expect(detectMarketRegime(candles, adx, atr, NEWS_SOON)).toBe("news_driven");
  });

  it("reads breakout when ADX just crossed from weak to strong in the last few candles", () => {
    const candles = trendingCandles(250, "up");
    const adx = new Array(250).fill(15);
    adx[248] = 15; // still weak one candle back
    adx[249] = 27; // now strong
    const atr = series(250, 0.001, 0.001);
    expect(detectMarketRegime(candles, adx, atr, CLEAR)).toBe("breakout");
  });

  it("reads strong_uptrend when ADX is strong and EMA50/200 agrees bullish, with no recent weak-to-strong cross", () => {
    const candles = trendingCandles(250, "up");
    const adx = series(250, 30, 30); // already strong throughout the lookback window -- not a fresh breakout
    const atr = series(250, 0.001, 0.001);
    expect(detectMarketRegime(candles, adx, atr, CLEAR)).toBe("strong_uptrend");
  });

  it("reads strong_downtrend symmetrically", () => {
    const candles = trendingCandles(250, "down");
    const adx = series(250, 30, 30);
    const atr = series(250, 0.001, 0.001);
    expect(detectMarketRegime(candles, adx, atr, CLEAR)).toBe("strong_downtrend");
  });

  it("reads high_volatility when ATR is well above its own recent average and ADX is weak", () => {
    const candles = flatCandles(250);
    const adx = series(250, 10, 10);
    const atr = series(250, 0.001, 0.002); // 2x the averaging window's baseline
    expect(detectMarketRegime(candles, adx, atr, CLEAR)).toBe("high_volatility");
  });

  it("reads low_volatility when ATR is well below its own recent average and ADX is weak", () => {
    const candles = flatCandles(250);
    const adx = series(250, 10, 10);
    const atr = series(250, 0.001, 0.0003); // 0.3x the baseline
    expect(detectMarketRegime(candles, adx, atr, CLEAR)).toBe("low_volatility");
  });

  it("reads consolidation when ADX is weak and ATR has contracted moderately (not enough to be low_volatility)", () => {
    const candles = flatCandles(250);
    const adx = series(250, 10, 10);
    const atr = series(250, 0.001, 0.0007); // 0.7x baseline -- inside [0.6, 0.8)
    expect(detectMarketRegime(candles, adx, atr, CLEAR)).toBe("consolidation");
  });

  it("falls back to range when nothing sharper matches", () => {
    const candles = flatCandles(250);
    const adx = series(250, 10, 10);
    const atr = series(250, 0.001, 0.001); // ratio 1.0 -- neither high, low, nor contracting
    expect(detectMarketRegime(candles, adx, atr, CLEAR)).toBe("range");
  });

  it("never fabricates a confident read when history is too short (NaN ADX/ATR) -- falls back to range", () => {
    const candles = flatCandles(5);
    const adx = new Array(5).fill(NaN);
    const atr = new Array(5).fill(NaN);
    expect(detectMarketRegime(candles, adx, atr, CLEAR)).toBe("range");
  });
});
