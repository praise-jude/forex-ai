import { describe, expect, it } from "vitest";
import type { Candle } from "../types";
import { confirmsDirection } from "../m5Confirmation";

function buildCandle(overrides: Partial<Candle> = {}): Candle {
  return { time: 0, open: 1.1, high: 1.105, low: 1.095, close: 1.1, tickVolume: 100, ...overrides };
}

describe("confirmsDirection", () => {
  it("confirms a long when the most recent M5 candle closed bullish", () => {
    const candles = [buildCandle({ open: 1.1, close: 1.102 })];
    expect(confirmsDirection(candles, "long")).toBe(true);
  });

  it("confirms a short when the most recent M5 candle closed bearish", () => {
    const candles = [buildCandle({ open: 1.1, close: 1.098 })];
    expect(confirmsDirection(candles, "short")).toBe(true);
  });

  it("does not confirm a long when the most recent M5 candle closed bearish", () => {
    const candles = [buildCandle({ open: 1.1, close: 1.098 })];
    expect(confirmsDirection(candles, "long")).toBe(false);
  });

  it("does not confirm a short when the most recent M5 candle closed bullish", () => {
    const candles = [buildCandle({ open: 1.1, close: 1.102 })];
    expect(confirmsDirection(candles, "short")).toBe(false);
  });

  it("only looks at the LAST candle in the series, not earlier ones", () => {
    const candles = [
      buildCandle({ time: 1, open: 1.1, close: 1.098 }), // bearish, but not the last one
      buildCandle({ time: 2, open: 1.098, close: 1.101 }), // bullish -- this is what matters
    ];
    expect(confirmsDirection(candles, "long")).toBe(true);
  });

  it("fails closed (not confirmed) on an empty candle list, e.g. a failed REST fetch", () => {
    expect(confirmsDirection([], "long")).toBe(false);
    expect(confirmsDirection([], "short")).toBe(false);
  });

  it("fails closed on a flat (doji) candle -- neither direction is confirmed", () => {
    const candles = [buildCandle({ open: 1.1, close: 1.1 })];
    expect(confirmsDirection(candles, "long")).toBe(false);
    expect(confirmsDirection(candles, "short")).toBe(false);
  });
});
