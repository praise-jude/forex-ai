import { describe, expect, it } from "vitest";
import { candle } from "../detectors/__tests__/fixtures";
import { assembleSignals } from "../signalEngine";

// Sellside liquidity sweep (idx7) -> BOS_BULLISH (breaks the idx5 swing high at idx10) ->
// price pulls back into the bullish FVG left behind by the impulsive move, tagging it for
// the first time on the final (killzone-hour) candle.
const START = Date.UTC(2024, 1, 1, 8, 0, 0) - 13 * 15 * 60 * 1000;
const t = (i: number) => START + i * 15 * 60 * 1000;

function buildCandles() {
  return [
    candle(t(0), 1.0, 1.005, 0.995, 1.002),
    candle(t(1), 1.002, 1.01, 1.0, 1.006),
    candle(t(2), 1.006, 1.008, 0.985, 0.99), // swing low @ 0.985
    candle(t(3), 0.99, 1.006, 0.995, 1.0),
    candle(t(4), 1.0, 1.012, 0.998, 1.008),
    candle(t(5), 1.008, 1.015, 1.005, 1.012), // swing high @ 1.015
    candle(t(6), 1.012, 1.014, 1.004, 1.01),
    candle(t(7), 1.01, 1.011, 0.978, 1.005), // sellside sweep of the 0.985 low
    candle(t(8), 1.005, 1.014, 1.0, 1.012),
    candle(t(9), 1.012, 1.014, 1.008, 1.01),
    candle(t(10), 1.01, 1.033, 1.005, 1.032), // closes above 1.015 -> BOS_BULLISH
    candle(t(11), 1.032, 1.035, 1.028, 1.033),
    candle(t(12), 1.033, 1.036, 1.03, 1.034),
    candle(t(13), 1.034, 1.036, 1.015, 1.018), // pulls back into the FVG
  ];
}

describe("assembleSignals", () => {
  it("produces a long signal when a sweep, BOS, and FVG retest line up in a killzone", () => {
    const signals = assembleSignals(buildCandles(), "EUR/USD", "15m");

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      pair: "EUR/USD",
      direction: "long",
      timeframe: "15m",
      session: "london",
      confluences: ["liquidity_sweep", "bos", "fvg", "killzone"],
    });
    expect(signals[0].entry).toBeCloseTo(1.021, 5);
    expect(signals[0].stopLoss).toBeLessThan(signals[0].entry);
    expect(signals[0].takeProfit).toBeGreaterThan(signals[0].entry);
    expect(signals[0].riskReward).toBeGreaterThanOrEqual(1.5);
  });

  it("does not fire outside a killzone even with the same setup", () => {
    const candles = buildCandles();
    const offSession = new Date(candles[candles.length - 1].time);
    offSession.setUTCHours(18); // well outside London/NY killzones
    candles[candles.length - 1] = { ...candles[candles.length - 1], time: offSession.getTime() };

    expect(assembleSignals(candles, "EUR/USD", "15m")).toEqual([]);
  });

  it("does not re-fire once price has already tagged the zone", () => {
    const candles = buildCandles();
    // One extra candle that also taps the FVG, followed by another tap - only the
    // first tap (already covered above) should ever produce a signal.
    candles.push(candle(t(14), 1.018, 1.02, 1.014, 1.016));

    expect(assembleSignals(candles, "EUR/USD", "15m")).toEqual([]);
  });
});
