import { describe, expect, it } from "vitest";
import { engineEdgeBreakdown, engineSizeMultiplier, sessionEdgeBreakdown, sessionSizeMultiplier } from "../adaptiveEdge";
import type { JournalEntry } from "../tradeJournal";
import type { Session, SignalSource } from "../types";

// Builds a minimal but shape-valid JournalEntry. Only the fields the breakdown actually
// reads (reason, rMultiple, profit, context.source, context.session) carry meaning here;
// the rest are inert filler so the fixture stays honest about what it's testing.
function entry(source: SignalSource, session: Session, rMultiple: number): JournalEntry {
  return {
    id: `deal-${Math.random()}`,
    signalId: `sig-${Math.random()}`,
    account: "live",
    pair: "GBP/USD",
    timeframe: "15m",
    direction: "long",
    entryPrice: 1,
    exitPrice: 1,
    profit: rMultiple * 100, // sign consistent with rMultiple for profitFactor
    riskDollars: 100,
    rMultiple,
    reason: rMultiple >= 0 ? "take_profit" : "stop_loss",
    closedAt: Date.now(),
    context: {
      signalId: "sig",
      pair: "GBP/USD",
      timeframe: "15m",
      direction: "long",
      regime: "strong_uptrend",
      confidence: 90,
      signerBDirection: "long",
      signerBConfidence: 90,
      adx: 30,
      rsi: 60,
      newsStatus: "clear",
      session,
      createdAt: Date.now(),
      source,
    },
  };
}

function entriesOf(source: SignalSource, session: Session, rMultiples: number[]): JournalEntry[] {
  return rMultiples.map((r) => entry(source, session, r));
}

describe("engineSizeMultiplier", () => {
  it("returns no adjustment when there are too few trades", () => {
    const result = engineSizeMultiplier(entriesOf("smc", "london", [1, 1, 1]), "smc", { minSamples: 10 });
    expect(result.sizeMultiplier).toBe(1);
    expect(result.reason).toMatch(/insufficient data/);
  });

  it("returns no adjustment for an unknown engine", () => {
    const result = engineSizeMultiplier(entriesOf("smc", "london", [1, 1, 1]), "mean_reversion", { minSamples: 3 });
    expect(result.sizeMultiplier).toBe(1);
    expect(result.reason).toMatch(/no closed/);
  });

  it("reduces size for a negative-expectancy engine with enough samples", () => {
    // 10 losses of -1R each => clearly negative expectancy.
    const result = engineSizeMultiplier(entriesOf("smc", "london", Array(10).fill(-1)), "smc", { minSamples: 10 });
    expect(result.sizeMultiplier).toBe(0.5);
    expect(result.expectancyR).toBeLessThan(0);
    expect(result.reason).toMatch(/negative expectancy/);
  });

  it("keeps full size for a positive-expectancy engine", () => {
    const result = engineSizeMultiplier(entriesOf("smc", "london", Array(10).fill(1.5)), "smc", { minSamples: 10 });
    expect(result.sizeMultiplier).toBe(1);
    expect(result.reason).toMatch(/positive expectancy/);
  });

  it("never returns a multiplier above 1", () => {
    const result = engineSizeMultiplier(entriesOf("smc", "london", Array(20).fill(3)), "smc", { minSamples: 5 });
    expect(result.sizeMultiplier).toBeLessThanOrEqual(1);
  });
});

describe("sessionSizeMultiplier", () => {
  it("returns no adjustment when there are too few trades in the session", () => {
    const result = sessionSizeMultiplier(entriesOf("smc", "asia", [-1, -1]), "asia", { minSamples: 10 });
    expect(result.sizeMultiplier).toBe(1);
    expect(result.reason).toMatch(/insufficient data/);
  });

  it("reduces size for a negative-expectancy session", () => {
    const result = sessionSizeMultiplier(entriesOf("smc", "asia", Array(12).fill(-1)), "asia", { minSamples: 10 });
    expect(result.sizeMultiplier).toBe(0.5);
    expect(result.reason).toMatch(/negative expectancy/);
  });

  it("scopes the session bucket independently of other sessions", () => {
    // London is profitable, Asia is losing -- each bucket reads its own edge only.
    const entries = [...entriesOf("smc", "london", Array(10).fill(2)), ...entriesOf("smc", "asia", Array(10).fill(-1))];
    expect(sessionSizeMultiplier(entries, "london", { minSamples: 10 }).sizeMultiplier).toBe(1);
    expect(sessionSizeMultiplier(entries, "asia", { minSamples: 10 }).sizeMultiplier).toBe(0.5);
  });
});

describe("edge breakdowns", () => {
  it("returns a bucket per engine with trades", () => {
    const entries = [...entriesOf("smc", "london", Array(10).fill(1)), ...entriesOf("mean_reversion", "london", Array(10).fill(-1))];
    const breakdown = engineEdgeBreakdown(entries, { minSamples: 10 });
    expect(Object.keys(breakdown)).toContain("smc");
    expect(Object.keys(breakdown)).toContain("mean_reversion");
    expect(breakdown.smc.sizeMultiplier).toBe(1);
    expect(breakdown.mean_reversion.sizeMultiplier).toBe(0.5);
  });

  it("returns a bucket per session with trades", () => {
    const entries = entriesOf("smc", "newyork", Array(10).fill(1));
    const breakdown = sessionEdgeBreakdown(entries, { minSamples: 10 });
    expect(breakdown.newyork.sizeMultiplier).toBe(1);
  });
});
