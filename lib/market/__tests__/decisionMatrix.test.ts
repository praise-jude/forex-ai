import { describe, expect, it } from "vitest";
import { combineSigners } from "../decisionMatrix";
import type { SignerBResult } from "../signerB";

function signerB(overrides: Partial<SignerBResult> = {}): SignerBResult {
  return {
    direction: "long",
    confidence: 90,
    tier: "buy",
    factors: {
      emaTrend: "bullish",
      rsiZone: "healthy",
      rsiDirection: "rising",
      rsiDivergence: null,
      supertrend: "up",
      currencyStrength: "long",
      volatility: "healthy",
      session: "london",
    },
    ...overrides,
  };
}

describe("combineSigners", () => {
  it("passes through SMC's own tier unchanged when the two agree but Signer B isn't strong", () => {
    const result = combineSigners({ tier: "buy", direction: "long" }, signerB({ tier: "buy", confidence: 90 }));
    expect(result).toEqual({ tier: "buy", blocked: null });
  });

  it("upgrades to strong_buy when SMC is buy-tier and Signer B independently agrees strongly", () => {
    const result = combineSigners({ tier: "buy", direction: "long" }, signerB({ tier: "strong_buy", confidence: 97 }));
    expect(result).toEqual({ tier: "strong_buy", blocked: null });
  });

  it("never downgrades a strong SMC setup just because Signer B agrees weakly (the over-blocking fix)", () => {
    // Only EMA agrees (35/100), everything else unavailable/neutral -- Signer B's own
    // tier lands at "watch" or below, but SMC's own excellent direction+entry score
    // must NOT be dragged down by that.
    const result = combineSigners({ tier: "strong_buy", direction: "long" }, signerB({ tier: "watch", confidence: 35 }));
    expect(result).toEqual({ tier: "strong_buy", blocked: null });
  });

  it("does not upgrade a watch-tier SMC signal even when Signer B strongly agrees (watch stays informational-only)", () => {
    const result = combineSigners({ tier: "watch", direction: "long" }, signerB({ tier: "strong_buy", confidence: 98 }));
    expect(result).toEqual({ tier: "watch", blocked: null });
  });

  it("holds the trade with signer_b_neutral when Signer B has no real opinion", () => {
    const result = combineSigners({ tier: "buy", direction: "long" }, signerB({ direction: "neutral", confidence: 0 }));
    expect(result.blocked).toEqual({ code: "signer_b_neutral", smcDirection: "long" });
  });

  it("holds the trade with signer_conflict when Signer B's independent read opposes SMC's direction", () => {
    const result = combineSigners({ tier: "buy", direction: "long" }, signerB({ direction: "short", confidence: 82 }));
    expect(result.blocked).toEqual({ code: "signer_conflict", smcDirection: "long", signerBDirection: "short", signerBConfidence: 82 });
  });

  it("passes through untouched when SMC's own direction+entry score already failed (nothing to do with Signer B)", () => {
    const result = combineSigners({ tier: "no_trade", direction: "long" }, signerB({ direction: "short", confidence: 99 }));
    expect(result).toEqual({ tier: "no_trade", blocked: null });
  });

  it("works symmetrically for short signals", () => {
    const agree = combineSigners({ tier: "buy", direction: "short" }, signerB({ direction: "short", confidence: 60 }));
    expect(agree).toEqual({ tier: "buy", blocked: null });

    const conflict = combineSigners({ tier: "buy", direction: "short" }, signerB({ direction: "long", confidence: 70 }));
    expect(conflict.blocked).toEqual({ code: "signer_conflict", smcDirection: "short", signerBDirection: "long", signerBConfidence: 70 });
  });
});
