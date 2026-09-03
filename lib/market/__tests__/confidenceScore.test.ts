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
  it("buckets at the documented 90/80/70 thresholds", () => {
    expect(tierOf(100)).toBe("strong_buy");
    expect(tierOf(90)).toBe("strong_buy");
    expect(tierOf(89.9)).toBe("buy");
    expect(tierOf(80)).toBe("buy");
    expect(tierOf(79.9)).toBe("watch");
    expect(tierOf(70)).toBe("watch");
    expect(tierOf(69.9)).toBe("no_trade");
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

  it("does NOT bottleneck the final tier to a weak direction when entry is perfect -- direction's own trend/structure question is already a hard pre-gate upstream, not re-litigated here", () => {
    // 2026-09-01: this used to assert the opposite (direction bottlenecks the tier).
    // Changed after a production investigation found real, well-formed setups that had
    // already cleared signalEngine.ts's own hard D1/H4 trend-agreement + ADX gates were
    // failing the SAME trend question again here, at a stricter bar -- direction and
    // marketStructureMatches were almost never both true even once across 30 days/9
    // pairs, killing setups whose entry side scored 90+ on the exact same candidate.
    const result = scoreSignal(buildInput({ emaStackAligned: false, marketStructureMatches: false, adx: 10 }));
    expect(result.entry.tier).toBe("strong_buy");
    expect(result.direction.tier).toBe("no_trade");
    expect(result.tier).toBe("strong_buy");
    expect(result.total).toBe(result.entry.total);
  });

  it("tiers buy at 80-89 on both dimensions", () => {
    const result = scoreSignal(buildInput({ adx: 15, rsiAgrees: false, volumeAboveAverage: false }));
    expect(result.direction.total).toBe(85); // 45 + 40, no ADX credit below 20
    expect(result.entry.total).toBe(80); // 35 + 25 + 20, no rsi/volume credit
    expect(result.tier).toBe("buy");
    expect(result.total).toBe(80);
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
