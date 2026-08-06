import { describe, expect, it } from "vitest";
import { scoreSignal, type ScoreInput } from "../confidenceScore";

function buildInput(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    emaStackAligned: true,
    adx: 30,
    marketStructureMatches: true,
    smcZoneType: "order_block",
    volumeAboveAverage: true,
    macdAgrees: true,
    rsiAgrees: true,
    candlestickMatches: true,
    ...overrides,
  };
}

describe("scoreSignal", () => {
  it("scores a perfect setup at 95 (the practical ceiling with News excluded) and tiers strong_buy", () => {
    const result = scoreSignal(buildInput());
    expect(result.total).toBe(95);
    expect(result.tier).toBe("strong_buy");
    expect(result.reasons).toEqual([
      "trend_ema_stack",
      "adx",
      "market_structure",
      "volume",
      "macd_crossover",
      "rsi_momentum",
      "candlestick",
    ]);
  });

  it("tiers buy at 90-94", () => {
    const result = scoreSignal(buildInput({ candlestickMatches: false }));
    expect(result.total).toBe(90);
    expect(result.tier).toBe("buy");
    expect(result.reasons).not.toContain("candlestick");
  });

  it("tiers watch at 80-89 (not emitted as a tradeable signal by the caller)", () => {
    const result = scoreSignal(buildInput({ rsiAgrees: false, candlestickMatches: false }));
    expect(result.total).toBe(85);
    expect(result.tier).toBe("watch");
  });

  it("tiers no_trade below 80", () => {
    const result = scoreSignal({
      emaStackAligned: false,
      adx: 15,
      marketStructureMatches: false,
      smcZoneType: "fvg",
      volumeAboveAverage: false,
      macdAgrees: false,
      rsiAgrees: false,
      candlestickMatches: false,
    });
    expect(result.total).toBe(15);
    expect(result.tier).toBe("no_trade");
  });

  it("gives partial ADX credit between 20 and 25, and none below 20", () => {
    const adequate = scoreSignal(buildInput({ adx: 22 }));
    const weak = scoreSignal(buildInput({ adx: 15 }));
    expect(adequate.total - weak.total).toBe(2.5);
    expect(weak.reasons).not.toContain("adx");
  });

  it("gives an order block more credit than an FVG for the same setup otherwise", () => {
    const withOrderBlock = scoreSignal(buildInput({ smcZoneType: "order_block" }));
    const withFvg = scoreSignal(buildInput({ smcZoneType: "fvg" }));
    expect(withOrderBlock.total - withFvg.total).toBe(5);
  });
});
