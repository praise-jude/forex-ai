import { describe, expect, it } from "vitest";
import { scoreSignal, type DirectionScoreInput, type EntryScoreInput, type ConfirmationScoreInput } from "../confidenceScore";

type FullInput = DirectionScoreInput & EntryScoreInput & ConfirmationScoreInput;

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
    supertrendAgrees: true,
    usdStrengthSupports: true,
    ...overrides,
  };
}

describe("scoreSignal", () => {
  it("scores a perfect setup at 100/100/100 and tiers strong_buy", () => {
    const result = scoreSignal(buildInput());
    expect(result.direction.total).toBe(100);
    expect(result.entry.total).toBe(100);
    expect(result.confirmation.total).toBe(100);
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

  describe("confirmation dimension", () => {
    it("bottlenecks the final tier to WAIT when direction and entry are perfect but confirmation conflicts", () => {
      // The user's core "SMC found a setup but Supertrend/currency strength disagree"
      // scenario -- must produce no_trade, not a forced trade riding on SMC alone.
      const result = scoreSignal(buildInput({ supertrendAgrees: false, usdStrengthSupports: false }));
      expect(result.direction.tier).toBe("strong_buy");
      expect(result.entry.tier).toBe("strong_buy");
      expect(result.confirmation.total).toBe(0);
      expect(result.confirmation.tier).toBe("no_trade");
      expect(result.tier).toBe("no_trade");
    });

    it("rescales around whichever single input is available rather than zeroing out the missing one", () => {
      // Supertrend alone (60 of the 60 available points) should score 100, not 60/100 --
      // an unavailable currency-strength reading must not silently sink the score.
      const result = scoreSignal(buildInput({ supertrendAgrees: true, usdStrengthSupports: "unavailable" }));
      expect(result.confirmation.total).toBe(100);
      expect(result.confirmation.reasons).toEqual(["supertrend"]);
    });

    it("scores a neutral 100 (never the bottleneck) when both confirmation inputs are unavailable", () => {
      // e.g. right after boot, before candle history has warmed up for either --  must
      // never behave as if confirmation actively disagreed.
      const result = scoreSignal(buildInput({ supertrendAgrees: "unavailable", usdStrengthSupports: "unavailable" }));
      expect(result.confirmation.total).toBe(100);
      expect(result.confirmation.reasons).toEqual([]);
      expect(result.tier).toBe("strong_buy");
    });

    it("still gates on real disagreement even when the other confirmation input is unavailable", () => {
      const result = scoreSignal(buildInput({ supertrendAgrees: false, usdStrengthSupports: "unavailable" }));
      expect(result.confirmation.total).toBe(0);
      expect(result.tier).toBe("no_trade");
    });
  });
});
