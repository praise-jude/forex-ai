import { describe, expect, it } from "vitest";
import { rankNoTradeCloseness } from "../noTradeCloseness";
import type { NoTradeReason } from "../types";

function dimensionScore(total: number) {
  return { total, tier: "no_trade" as const, reasons: [] };
}

describe("rankNoTradeCloseness", () => {
  it("ranks m5_not_confirmed as the closest (tier 0) -- everything else already agreed", () => {
    const result = rankNoTradeCloseness({ code: "m5_not_confirmed", impliedDirection: "long" });
    expect(result.tier).toBe(0);
  });

  it("ranks signer_b_neutral, signer_conflict, and news_blackout all as tier 1 -- already-qualified setups blocked by an external gate", () => {
    expect(rankNoTradeCloseness({ code: "signer_b_neutral", impliedDirection: "long" }).tier).toBe(1);
    expect(rankNoTradeCloseness({ code: "signer_conflict", impliedDirection: "long", signerBDirection: "short", signerBConfidence: 60 }).tier).toBe(1);
    expect(rankNoTradeCloseness({ code: "news_blackout", impliedDirection: "long", event: "NFP", currency: "USD", minutesUntil: 12 }).tier).toBe(1);
  });

  it("ranks below_threshold as tier 2 and reports the lower of direction/entry as the real score", () => {
    const reason: NoTradeReason = { code: "below_threshold", direction: dimensionScore(82), entry: dimensionScore(61) };
    const result = rankNoTradeCloseness(reason);
    expect(result.tier).toBe(2);
    expect(result.label).toContain("61");
  });

  it("ranks range_below_threshold as tier 2, using its own single total", () => {
    const result = rankNoTradeCloseness({ code: "range_below_threshold", total: 58, impliedDirection: "short" });
    expect(result.tier).toBe(2);
    expect(result.label).toContain("58");
  });

  it("ranks weak_trend_adx, low_volatility, and no_boundary_touch all as tier 3", () => {
    expect(rankNoTradeCloseness({ code: "weak_trend_adx", adx: 17.3 }).tier).toBe(3);
    expect(rankNoTradeCloseness({ code: "low_volatility", atr: 0.0008, atrAverage: 0.0012 }).tier).toBe(3);
    expect(rankNoTradeCloseness({ code: "no_boundary_touch" }).tier).toBe(3);
  });

  it("includes the real ADX value in the label, not a rounded/invented one", () => {
    const result = rankNoTradeCloseness({ code: "weak_trend_adx", adx: 17.3 });
    expect(result.label).toContain("17.3");
  });

  it("ranks trend_disagreement as tier 4 -- further than a numeric threshold miss", () => {
    const result = rankNoTradeCloseness({ code: "trend_disagreement", impliedDirection: "long", d1: "bullish", h4: "bearish", h1: "bullish" });
    expect(result.tier).toBe(4);
  });

  it("ranks no_setup, outside_killzone, not_ranging, and no_range_detected all as the farthest tier (5)", () => {
    expect(rankNoTradeCloseness({ code: "no_setup" }).tier).toBe(5);
    expect(rankNoTradeCloseness({ code: "outside_killzone" }).tier).toBe(5);
    expect(rankNoTradeCloseness({ code: "not_ranging", regime: "range" }).tier).toBe(5);
    expect(rankNoTradeCloseness({ code: "no_range_detected" }).tier).toBe(5);
  });

  it("tiers strictly increase from m5_not_confirmed (closest) to no_setup (farthest)", () => {
    const closest = rankNoTradeCloseness({ code: "m5_not_confirmed", impliedDirection: "long" }).tier;
    const farthest = rankNoTradeCloseness({ code: "no_setup" }).tier;
    expect(closest).toBeLessThan(farthest);
  });
});
