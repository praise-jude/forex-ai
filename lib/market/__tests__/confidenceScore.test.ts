import { describe, expect, it } from "vitest";
import { scoreSignal, tierOf, type DirectionScoreInput, type EntryScoreInput } from "../confidenceScore";

type FullInput = DirectionScoreInput & EntryScoreInput;

function buildInput(overrides: Partial<FullInput> = {}): FullInput {
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

describe("tierOf", () => {
  it("buckets at the documented 95/90/80 thresholds", () => {
    expect(tierOf(100)).toBe("strong_buy");
    expect(tierOf(95)).toBe("strong_buy");
    expect(tierOf(94.9)).toBe("buy");
    expect(tierOf(90)).toBe("buy");
    expect(tierOf(89.9)).toBe("watch");
    expect(tierOf(80)).toBe("watch");
    expect(tierOf(79.9)).toBe("no_trade");
    expect(tierOf(0)).toBe("no_trade");
  });
});

describe("scoreSignal", () => {
  it("scores a perfect setup at 100/100 and tiers strong_buy", () => {
    const result = scoreSignal(buildInput());
    expect(result.direction.total).toBe(100);
    expect(result.entry.total).toBe(100);
    expect(result.total).toBe(100);
    expect(result.tier).toBe("strong_buy");
  });

  it("bottlenecks the final tier to a weak entry even when direction is perfect", () => {
    // Direction stays perfect (strong_buy on its own); entry has nothing going for it
    // except the zone itself, well below the watch floor -- this is the user's core
    // "trend is bullish but entry confirmation is incomplete" scenario, and it must
    // NOT produce a tradeable signal just because the trend looks great.
    const result = scoreSignal(
      buildInput({ smcZoneType: "fvg", candlestickMatches: false, macdAgrees: false, rsiAgrees: false, volumeAboveAverage: false })
    );
    expect(result.direction.tier).toBe("strong_buy");
    expect(result.entry.tier).toBe("no_trade");
    expect(result.tier).toBe("no_trade");
    expect(result.total).toBe(result.entry.total);
  });

  it("bottlenecks the final tier to a weak direction even when entry is perfect", () => {
    // The symmetric case -- a textbook entry trigger doesn't matter if the
    // higher-timeframe trend evidence isn't actually there.
    const result = scoreSignal(buildInput({ emaStackAligned: false, marketStructureMatches: false, adx: 10 }));
    expect(result.entry.tier).toBe("strong_buy");
    expect(result.direction.tier).toBe("no_trade");
    expect(result.tier).toBe("no_trade");
    expect(result.total).toBe(result.direction.total);
  });

  it("tiers buy at 90-94 on both dimensions", () => {
    const result = scoreSignal(buildInput({ adx: 22, volumeAboveAverage: false }));
    expect(result.direction.total).toBe(92.5); // 45 + 40 + 7.5 (partial ADX credit)
    expect(result.entry.total).toBe(90); // 35 + 25 + 20 + 10, no volume credit
    expect(result.tier).toBe("buy");
    expect(result.total).toBe(90);
  });

  it("gives partial ADX credit between 20 and 25, and none below 20 (direction dimension)", () => {
    const adequate = scoreSignal(buildInput({ adx: 22 })).direction;
    const weak = scoreSignal(buildInput({ adx: 15 })).direction;
    expect(adequate.total - weak.total).toBe(7.5);
    expect(weak.reasons).not.toContain("adx");
  });

  it("gives an order block more credit than an FVG for the same setup otherwise (entry dimension)", () => {
    const withOrderBlock = scoreSignal(buildInput({ smcZoneType: "order_block" })).entry;
    const withFvg = scoreSignal(buildInput({ smcZoneType: "fvg" })).entry;
    expect(withOrderBlock.total - withFvg.total).toBe(10);
  });
});
