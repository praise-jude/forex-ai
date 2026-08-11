import { describe, expect, it } from "vitest";
import { detectRsiDivergence } from "../rsiDivergence";
import { candle } from "../../detectors/__tests__/fixtures";
import type { Candle, SwingPoint } from "../../types";

function flatCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => candle(i, 1, 1.001, 0.999, 1));
}

function swing(index: number, price: number, type: "high" | "low"): SwingPoint {
  return { index, time: index, price, type };
}

describe("detectRsiDivergence", () => {
  it("detects bullish divergence: price makes a lower low while RSI makes a higher low", () => {
    const candles = flatCandles(60);
    const rsiSeries = new Array(60).fill(50);
    const swings: SwingPoint[] = [swing(10, 1.1, "low"), swing(40, 1.05, "low")]; // lower low in price
    rsiSeries[10] = 25;
    rsiSeries[40] = 35; // higher low in RSI
    expect(detectRsiDivergence(candles, rsiSeries, swings)).toBe("bullish");
  });

  it("detects bearish divergence: price makes a higher high while RSI makes a lower high", () => {
    const candles = flatCandles(60);
    const rsiSeries = new Array(60).fill(50);
    const swings: SwingPoint[] = [swing(10, 1.1, "high"), swing(40, 1.15, "high")]; // higher high in price
    rsiSeries[10] = 75;
    rsiSeries[40] = 65; // lower high in RSI
    expect(detectRsiDivergence(candles, rsiSeries, swings)).toBe("bearish");
  });

  it("returns null when price and RSI move in the same direction (no divergence)", () => {
    const candles = flatCandles(60);
    const rsiSeries = new Array(60).fill(50);
    const swings: SwingPoint[] = [swing(10, 1.1, "low"), swing(40, 1.05, "low")];
    rsiSeries[10] = 35;
    rsiSeries[40] = 25; // also lower -- confirms the move, no divergence
    expect(detectRsiDivergence(candles, rsiSeries, swings)).toBeNull();
  });

  it("returns null when fewer than two qualifying swings exist in the lookback window", () => {
    const candles = flatCandles(60);
    const rsiSeries = new Array(60).fill(50);
    const swings: SwingPoint[] = [swing(40, 1.05, "low")];
    expect(detectRsiDivergence(candles, rsiSeries, swings)).toBeNull();
  });

  it("ignores swings outside the lookback window", () => {
    const candles = flatCandles(200);
    const rsiSeries = new Array(200).fill(50);
    const swings: SwingPoint[] = [swing(10, 1.1, "low"), swing(40, 1.05, "low")];
    rsiSeries[10] = 25;
    rsiSeries[40] = 35;
    expect(detectRsiDivergence(candles, rsiSeries, swings, 50)).toBeNull();
  });

  it("does not fabricate a divergence when RSI is NaN at a swing index (unwarmed)", () => {
    const candles = flatCandles(60);
    const rsiSeries = new Array(60).fill(50);
    const swings: SwingPoint[] = [swing(10, 1.1, "low"), swing(40, 1.05, "low")];
    rsiSeries[10] = NaN;
    rsiSeries[40] = 35;
    expect(detectRsiDivergence(candles, rsiSeries, swings)).toBeNull();
  });
});
