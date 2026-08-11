import { describe, expect, it } from "vitest";
import { evaluateSignerB } from "../signerB";
import { candle } from "../detectors/__tests__/fixtures";
import type { Candle, Pair, SwingPoint } from "../types";
import type { SupertrendPoint } from "../indicators/supertrend";
import type { UsdStrength } from "../currencyStrength";

const PAIR: Pair = "EUR/USD";
const UNAVAILABLE_SUPERTREND: SupertrendPoint = { value: NaN, trend: null };
const UNAVAILABLE_USD: UsdStrength = { status: "unavailable" };

function trendingCandles(count: number, direction: "up" | "down", start = 1): Candle[] {
  const step = direction === "up" ? 0.001 : -0.001;
  const candles: Candle[] = [];
  let price = start;
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

const NEUTRAL_RSI_SERIES = (n: number) => new Array<number>(n).fill(NaN);

describe("evaluateSignerB", () => {
  it("votes long from EMA trend alone when it's the only available factor (confidence 100)", () => {
    const candles = trendingCandles(250, "up");
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries: NEUTRAL_RSI_SERIES(candles.length),
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: UNAVAILABLE_USD,
      session: "london",
    });
    expect(result.direction).toBe("long");
    expect(result.confidence).toBe(100);
    expect(result.tier).toBe("strong_buy");
    expect(result.factors.emaTrend).toBe("bullish");
  });

  it("votes short from EMA trend alone in a sustained downtrend", () => {
    const candles = trendingCandles(250, "down", 2);
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries: NEUTRAL_RSI_SERIES(candles.length),
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: UNAVAILABLE_USD,
      session: "london",
    });
    expect(result.direction).toBe("short");
  });

  it("is neutral with confidence 0 when every factor is unavailable/excluded (never a fabricated lean)", () => {
    const candles = flatCandles(50); // < 200, EMA trend excluded (neutral)
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries: NEUTRAL_RSI_SERIES(candles.length),
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: UNAVAILABLE_USD,
      session: "london",
    });
    expect(result.direction).toBe("neutral");
    expect(result.confidence).toBe(0);
  });

  it("votes from Supertrend alone when it's the only available factor", () => {
    const candles = flatCandles(50);
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries: NEUTRAL_RSI_SERIES(candles.length),
      supertrendPoint: { value: 1, trend: "up" },
      usdStrength: UNAVAILABLE_USD,
      session: "london",
    });
    expect(result.direction).toBe("long");
    expect(result.confidence).toBe(100);
    expect(result.factors.supertrend).toBe("up");
  });

  it("votes from currency strength alone (EUR/USD: weak-USD supports a long)", () => {
    const candles = flatCandles(50);
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries: NEUTRAL_RSI_SERIES(candles.length),
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: { status: "available", index: -0.01 },
      session: "london",
    });
    expect(result.direction).toBe("long");
    expect(result.confidence).toBe(100);
    expect(result.factors.currencyStrength).toBe("long");
  });

  it("counts a currency-strength deadband reading as a real neutral vote, not excluded (dilutes confidence when it's the only factor)", () => {
    const candles = flatCandles(50);
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries: NEUTRAL_RSI_SERIES(candles.length),
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: { status: "available", index: 0.00001 }, // inside the deadband
      session: "london",
    });
    expect(result.factors.currencyStrength).toBe("neutral");
    expect(result.direction).toBe("neutral");
    expect(result.confidence).toBe(0);
  });

  it("votes from RSI alone: rising from a healthy zone votes long, not the naive RSI>50 rule", () => {
    const candles = flatCandles(60);
    const rsiSeries = new Array<number>(60).fill(50);
    rsiSeries[56] = 45;
    rsiSeries[59] = 55; // rising, healthy zone
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries,
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: UNAVAILABLE_USD,
      session: "london",
    });
    expect(result.direction).toBe("long");
    expect(result.confidence).toBe(100);
    expect(result.factors.rsiDirection).toBe("rising");
  });

  it("does not vote from an overbought RSI reading with no confirming divergence (avoids the naive 'buy because overbought' trap)", () => {
    const candles = flatCandles(60);
    const rsiSeries = new Array<number>(60).fill(85);
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries,
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: UNAVAILABLE_USD,
      session: "london",
    });
    expect(result.factors.rsiZone).toBe("overbought");
    expect(result.direction).toBe("neutral");
    expect(result.confidence).toBe(0);
  });

  it("a confirmed bullish RSI divergence votes long even from an overbought reading", () => {
    const candles = flatCandles(60);
    const rsiSeries = new Array<number>(60).fill(85);
    rsiSeries[10] = 25;
    rsiSeries[40] = 35; // higher low in RSI
    const swings: SwingPoint[] = [
      { index: 10, time: 10, price: 1.1, type: "low" },
      { index: 40, time: 40, price: 1.05, type: "low" }, // lower low in price
    ];
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings,
      rsiSeries,
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: UNAVAILABLE_USD,
      session: "london",
    });
    expect(result.factors.rsiDivergence).toBe("bullish");
    expect(result.direction).toBe("long");
  });

  it("a genuine tie between agreeing/disagreeing factors of equal weight is neutral, not a coin flip", () => {
    // RSI (weight 20, votes long) vs currency strength (weight 20, votes short) --
    // EMA and Supertrend both excluded, so this is an exact tie.
    const candles = flatCandles(60);
    const rsiSeries = new Array<number>(60).fill(50);
    rsiSeries[56] = 45;
    rsiSeries[59] = 55; // rising -> votes long
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries,
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: { status: "available", index: 0.01 }, // strong USD -> EUR/USD short
      session: "london",
    });
    expect(result.direction).toBe("neutral");
    expect(result.confidence).toBe(50);
  });

  it("combines multiple available factors with the documented weights", () => {
    // EMA (35, long) + currency strength (20, short) disagree, Supertrend/RSI
    // unavailable -> possible=55, longScore=35, shortScore=20 -> long, ~63.6%.
    const candles = trendingCandles(250, "up");
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries: NEUTRAL_RSI_SERIES(candles.length),
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: { status: "available", index: 0.01 }, // strong USD -> EUR/USD short
      session: "london",
    });
    expect(result.direction).toBe("long");
    expect(result.confidence).toBeCloseTo((35 / 55) * 100, 5);
  });

  it("carries the session through untouched for display", () => {
    const candles = flatCandles(50);
    const result = evaluateSignerB({
      candles,
      pair: PAIR,
      swings: [],
      rsiSeries: NEUTRAL_RSI_SERIES(candles.length),
      supertrendPoint: UNAVAILABLE_SUPERTREND,
      usdStrength: UNAVAILABLE_USD,
      session: "newyork",
    });
    expect(result.factors.session).toBe("newyork");
    expect(result.factors.volatility).toBe("healthy");
  });
});
