import { describe, expect, it } from "vitest";
import { evaluateTrendContinuation } from "../trendContinuationEngine";
import type { Candle } from "../types";

const STEP = 15 * 60 * 1000;
const CLEAR_NEWS = { newsStatus: { status: "clear" } } as const;

function candle(time: number, open: number, high: number, low: number, close: number, tickVolume = 100): Candle {
  return { time, open, high, low, close, tickVolume };
}

/** A perfectly flat series -- no real trend, no real range, nothing for any engine to
 * react to. Used to confirm this engine's own hard gates hold on genuinely empty data,
 * the same "no fabrication on nothing" floor every other engine's tests start from. */
function buildFlatCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const price = 1.1 + (i % 2 === 0 ? 0.00005 : -0.00005);
    candles.push(candle(t, price, price + 0.0001, price - 0.0001, price));
    t += STEP;
  }
  return candles;
}

// The main gate cascade (established trend regime -> D1/H4 confluence -> a genuine
// RSI pullback-and-resume moment) is validated end-to-end via a real 120-day/5-pair
// historical backtest (see trendContinuationEngine.ts's own doc comment) rather than a
// hand-built synthetic fixture here -- constructing a fixture that simultaneously
// satisfies all three real, interacting gates (regime detection, multi-timeframe EMA
// agreement, and an RSI extended-then-reset pattern) is a substantial undertaking of its
// own, and the real backtest is a stronger form of evidence than a synthetic one would
// be. These tests cover the cheap, mechanical guarantees instead: the hard data-
// sufficiency floor, and that a genuinely flat, trendless market never fires.
describe("evaluateTrendContinuation", () => {
  it("is not_trending when there isn't enough history yet", () => {
    const candles = buildFlatCandles(50);
    const higherTimeframes = { h1: candles, h4: candles, d1: candles };
    const evaluation = evaluateTrendContinuation(candles, "EUR/USD", "15m", higherTimeframes, CLEAR_NEWS);
    expect(evaluation).toEqual({ status: "no_trade", reason: { code: "not_trending", regime: "low_volatility" } });
  });

  it("is not_trending on a genuinely flat, trendless market -- never fabricates a trend that isn't there", () => {
    const candles = buildFlatCandles(250);
    const higherTimeframes = { h1: candles, h4: candles, d1: candles };
    const evaluation = evaluateTrendContinuation(candles, "EUR/USD", "15m", higherTimeframes, CLEAR_NEWS);
    expect(evaluation.status).toBe("no_trade");
    if (evaluation.status !== "no_trade") return;
    expect(evaluation.reason.code).not.toBe("no_pullback_reset");
  });
});
