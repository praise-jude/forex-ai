import { describe, expect, it } from "vitest";
import { scoreSetupQuality } from "../setupQualityScore";
import { buildSignal } from "./fixtures";

describe("scoreSetupQuality", () => {
  it("scores a perfect long setup at 100, with every sub-score at its documented max", () => {
    const signal = buildSignal({
      direction: "long",
      directionScore: 100,
      entryScore: 100,
      confluences: ["liquidity_sweep", "bos", "order_block", "rsi_momentum", "macd_crossover", "rsi_divergence"],
      newsStatus: "clear",
      session: "london",
    });
    const result = scoreSetupQuality(signal, "strong_uptrend");
    expect(result).toEqual({ smc: 30, trend: 20, momentum: 15, liquidity: 10, volatility: 7, newsRisk: 10, session: 5, total: 97 });
  });

  it("scales SMC and Trend proportionally to entryScore/directionScore", () => {
    const signal = buildSignal({ direction: "long", directionScore: 50, entryScore: 60, confluences: [] });
    const result = scoreSetupQuality(signal, "strong_uptrend");
    expect(result.smc).toBe(18); // 60% of 30
    expect(result.trend).toBe(10); // 50% of 20, regime agrees so no penalty
  });

  it("penalizes the trend sub-score when the independent regime doesn't confirm the same direction", () => {
    const signal = buildSignal({ direction: "long", directionScore: 100, confluences: [] });
    const agreeing = scoreSetupQuality(signal, "strong_uptrend").trend;
    const disagreeing = scoreSetupQuality(signal, "range").trend;
    expect(agreeing).toBe(20);
    expect(disagreeing).toBe(18); // 20 - the fixed mismatch penalty
  });

  it("never lets the trend penalty push the sub-score below zero", () => {
    const signal = buildSignal({ direction: "long", directionScore: 0, confluences: [] });
    expect(scoreSetupQuality(signal, "range").trend).toBe(0);
  });

  it("sums exactly the confluence tags present for momentum, nothing fabricated", () => {
    const none = buildSignal({ confluences: [] });
    const one = buildSignal({ confluences: ["rsi_momentum"] });
    const all = buildSignal({ confluences: ["rsi_momentum", "macd_crossover", "rsi_divergence"] });
    expect(scoreSetupQuality(none, "range").momentum).toBe(0);
    expect(scoreSetupQuality(one, "range").momentum).toBe(5);
    expect(scoreSetupQuality(all, "range").momentum).toBe(15);
  });

  it("gives full liquidity marks only when both a sweep and a structure break are present", () => {
    const both = buildSignal({ confluences: ["liquidity_sweep", "bos"] });
    const sweepOnly = buildSignal({ confluences: ["liquidity_sweep"] });
    const structureOnly = buildSignal({ confluences: ["choch"] });
    expect(scoreSetupQuality(both, "range").liquidity).toBe(10);
    expect(scoreSetupQuality(sweepOnly, "range").liquidity).toBe(0);
    expect(scoreSetupQuality(structureOnly, "range").liquidity).toBe(0);
  });

  it("reads volatility from the independent regime, not a re-derived ATR figure", () => {
    const signal = buildSignal({ confluences: [] });
    expect(scoreSetupQuality(signal, "high_volatility").volatility).toBe(10);
    expect(scoreSetupQuality(signal, "low_volatility").volatility).toBe(3);
    expect(scoreSetupQuality(signal, "range").volatility).toBe(7);
  });

  it("scores news risk honestly -- unavailable is a neutral 5, never treated as clear or as a penalty", () => {
    const clear = buildSignal({ newsStatus: "clear", confluences: [] });
    const unavailable = buildSignal({ newsStatus: "unavailable", confluences: [] });
    expect(scoreSetupQuality(clear, "range").newsRisk).toBe(10);
    expect(scoreSetupQuality(unavailable, "range").newsRisk).toBe(5);
  });

  it("scores session lower outside the London/New York killzone (only reachable by crypto)", () => {
    const london = buildSignal({ session: "london", confluences: [] });
    const asia = buildSignal({ session: "asia", confluences: [] });
    const off = buildSignal({ session: "off-session", confluences: [] });
    expect(scoreSetupQuality(london, "range").session).toBe(5);
    expect(scoreSetupQuality(asia, "range").session).toBe(3);
    expect(scoreSetupQuality(off, "range").session).toBe(2);
  });

  it("total is always the sum of the sub-scores, never independently computed", () => {
    const signal = buildSignal({ directionScore: 73, entryScore: 61, confluences: ["rsi_momentum"], newsStatus: "unavailable", session: "asia" });
    const result = scoreSetupQuality(signal, "consolidation");
    expect(result.total).toBe(result.smc + result.trend + result.momentum + result.liquidity + result.volatility + result.newsRisk + result.session);
  });
});
