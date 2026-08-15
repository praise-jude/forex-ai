import { describe, expect, it } from "vitest";
import {
  computeProfitFactor,
  computeScoreRangeBreakdown,
  computeSharpeRatio,
  computeStreaks,
  toJournalEntries,
  type RealisticSizingConfig,
} from "../backtestStats";
import type { BacktestBarResult } from "../backtestEngine";
import type { JournalEntry, SignalContext } from "../../tradeJournal";
import { buildSignal, buildSpec } from "../../__tests__/fixtures";
import type { Pair } from "../../types";

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "e1",
    signalId: "e1",
    account: "live",
    pair: "EUR/USD",
    timeframe: "15m",
    direction: "long",
    entryPrice: 1.1,
    exitPrice: 1.104,
    profit: 100,
    riskDollars: 100,
    rMultiple: 2,
    reason: "take_profit",
    closedAt: 1000,
    context: null,
    ...overrides,
  };
}

function context(overrides: Partial<SignalContext> = {}): SignalContext {
  return {
    signalId: "e1",
    pair: "EUR/USD",
    timeframe: "15m",
    direction: "long",
    regime: "strong_uptrend",
    setupQuality: { total: 80, breakdown: [] } as unknown as SignalContext["setupQuality"],
    confidence: 92,
    signerBDirection: "long",
    signerBConfidence: 90,
    adx: 27,
    rsi: 58,
    newsStatus: "clear",
    session: "london",
    createdAt: 1000,
    ...overrides,
  };
}

describe("toJournalEntries", () => {
  it("converts a resolved take_profit bar into a JournalEntry", () => {
    const signal = buildSignal({ id: "s1", entry: 1.1, stopLoss: 1.098, takeProfit: 1.104 });
    const results: BacktestBarResult[] = [
      {
        barTime: 1,
        evaluation: { status: "signal", signal },
        outcome: { exitPrice: 1.104, exitTime: 5000, reason: "take_profit", rMultiple: 2, tp2Reached: false },
        regime: "strong_uptrend",
      },
    ];
    const { entries, openAtWindowEnd } = toJournalEntries(results, 100);
    expect(openAtWindowEnd).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "s1", profit: 200, riskDollars: 100, rMultiple: 2, reason: "take_profit", closedAt: 5000 });
    expect(entries[0].context).not.toBeNull();
  });

  it("excludes still_open_at_end bars from entries and counts them separately", () => {
    const signal = buildSignal({ id: "s2" });
    const results: BacktestBarResult[] = [
      {
        barTime: 1,
        evaluation: { status: "signal", signal },
        outcome: { exitPrice: 1.1, exitTime: 5000, reason: "still_open_at_end", rMultiple: 0, tp2Reached: false },
        regime: "range",
      },
    ];
    const { entries, openAtWindowEnd } = toJournalEntries(results);
    expect(entries).toHaveLength(0);
    expect(openAtWindowEnd).toBe(1);
  });

  it("skips no_trade bars entirely", () => {
    const results: BacktestBarResult[] = [
      { barTime: 1, evaluation: { status: "no_trade", reason: { code: "no_setup" } }, outcome: null, regime: "range" },
    ];
    const { entries, openAtWindowEnd } = toJournalEntries(results);
    expect(entries).toHaveLength(0);
    expect(openAtWindowEnd).toBe(0);
  });

  describe("with realistic sizing", () => {
    function resultFor(pair: Pair, rMultiple: number): BacktestBarResult {
      const signal = buildSignal({ id: "rs1", pair, entry: 1.105, stopLoss: 1.103, takeProfit: 1.109 });
      return {
        barTime: 1,
        evaluation: { status: "signal", signal },
        outcome: { exitPrice: 1.109, exitTime: 5000, reason: "take_profit", rMultiple, tp2Reached: false },
        regime: "strong_uptrend",
      };
    }

    it("uses real lot-size math instead of the flat hypothetical stake when a spec is available", () => {
      // risk 20 pips, $10/pip/lot (0.0001 * 100000) -> 1% of $10,000 ($100) risk sizes to
      // 0.5 lots -> riskDollars = 20 * 10 * 0.5 = $100 exactly, matching the requested risk.
      const sizing: RealisticSizingConfig = { specs: new Map([["EUR/USD", buildSpec()]]), equity: 10000, riskPct: 1 };
      const { entries } = toJournalEntries([resultFor("EUR/USD", 2)], 999 /* would-be flat stake, must be ignored */, sizing);
      expect(entries[0].riskDollars).toBe(100);
      expect(entries[0].profit).toBe(200); // 2R * $100
    });

    it("falls back to the flat hypothetical stake for a pair with no fetched spec", () => {
      const sizing: RealisticSizingConfig = { specs: new Map(), equity: 10000, riskPct: 1 };
      const { entries } = toJournalEntries([resultFor("EUR/USD", 2)], 250, sizing);
      expect(entries[0].riskDollars).toBe(250);
      expect(entries[0].profit).toBe(500); // 2R * $250
    });

    it("falls back to the flat hypothetical stake when computeLotSize itself skips (sub-minimum lot)", () => {
      const sizing: RealisticSizingConfig = { specs: new Map([["EUR/USD", buildSpec()]]), equity: 1, riskPct: 1 };
      const { entries } = toJournalEntries([resultFor("EUR/USD", 2)], 250, sizing);
      expect(entries[0].riskDollars).toBe(250);
      expect(entries[0].profit).toBe(500);
    });
  });
});

describe("computeProfitFactor", () => {
  it("returns gross win / gross loss", () => {
    const entries = [entry({ profit: 200 }), entry({ profit: -100 }), entry({ profit: 50 })];
    expect(computeProfitFactor(entries)).toBe(2.5);
  });

  it("returns null when there are no losing trades", () => {
    expect(computeProfitFactor([entry({ profit: 100 })])).toBeNull();
  });
});

describe("computeSharpeRatio", () => {
  it("returns null with fewer than 2 data points", () => {
    expect(computeSharpeRatio([entry({ rMultiple: 2 })])).toBeNull();
  });

  it("returns null when every R-multiple is identical (zero variance)", () => {
    expect(computeSharpeRatio([entry({ rMultiple: 2 }), entry({ rMultiple: 2 })])).toBeNull();
  });

  it("computes mean/stdev for varied R-multiples", () => {
    const result = computeSharpeRatio([entry({ rMultiple: 2 }), entry({ rMultiple: -1 }), entry({ rMultiple: 1 })]);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("number");
  });
});

describe("computeStreaks", () => {
  it("tracks the longest consecutive win and loss runs in chronological order", () => {
    const entries = [
      entry({ profit: 100, closedAt: 1 }),
      entry({ profit: 100, closedAt: 2 }),
      entry({ profit: -50, closedAt: 3 }),
      entry({ profit: -50, closedAt: 4 }),
      entry({ profit: -50, closedAt: 5 }),
      entry({ profit: 100, closedAt: 6 }),
    ];
    expect(computeStreaks(entries)).toEqual({ maxConsecutiveWins: 2, maxConsecutiveLosses: 3 });
  });

  it("handles an empty entry list", () => {
    expect(computeStreaks([])).toEqual({ maxConsecutiveWins: 0, maxConsecutiveLosses: 0 });
  });
});

describe("computeScoreRangeBreakdown", () => {
  it("buckets entries by their context's confidence score", () => {
    const entries = [
      entry({ profit: 100, rMultiple: 2, context: context({ confidence: 82 }) }),
      entry({ profit: -50, rMultiple: -1, context: context({ confidence: 91 }) }),
      entry({ profit: 100, rMultiple: 2, context: context({ confidence: 96 }) }),
    ];
    const breakdown = computeScoreRangeBreakdown(entries);
    expect(breakdown).toEqual([
      { range: "80-89", count: 1, winRate: 100, averageR: 2 },
      { range: "90-94", count: 1, winRate: 0, averageR: -1 },
      { range: "95-100", count: 1, winRate: 100, averageR: 2 },
    ]);
  });

  it("excludes entries with no context from every bucket", () => {
    const breakdown = computeScoreRangeBreakdown([entry({ context: null })]);
    expect(breakdown.every((b) => b.count === 0)).toBe(true);
  });
});
