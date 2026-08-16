import { describe, expect, it } from "vitest";
import { getSlippageBreakdownByPair, getSlippagePoints, getSlippageStats, type SlippagePoint } from "../slippage";
import type { ExecutedTrade } from "../types";

function trade(overrides: Partial<ExecutedTrade> = {}): ExecutedTrade {
  return {
    id: "t1",
    signalId: "s1",
    account: "live",
    pair: "EUR/USD",
    timeframe: "15m",
    direction: "long",
    requestedLots: 1,
    requestedEntry: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    takeProfit2: 1.14,
    status: "filled",
    filledEntry: 1.1,
    riskPct: 1,
    attemptedAt: 1000,
    ...overrides,
  };
}

describe("getSlippagePoints", () => {
  it("computes adverse (positive) slippage for a long filled worse than requested", () => {
    const points = getSlippagePoints([trade({ direction: "long", requestedEntry: 1.1, filledEntry: 1.1005 })]);
    expect(points).toHaveLength(1);
    expect(points[0].slippagePips).toBeCloseTo(5, 5); // EUR/USD pip = 0.0001
  });

  it("computes favorable (negative) slippage for a long filled better than requested", () => {
    const points = getSlippagePoints([trade({ direction: "long", requestedEntry: 1.1, filledEntry: 1.0995 })]);
    expect(points[0].slippagePips).toBeCloseTo(-5, 5);
  });

  it("flips the sign for a short -- filling lower than requested is adverse", () => {
    const points = getSlippagePoints([trade({ direction: "short", requestedEntry: 1.1, filledEntry: 1.0995 })]);
    expect(points[0].slippagePips).toBeCloseTo(5, 5);
  });

  it("excludes trades that never reached a broker fill", () => {
    expect(getSlippagePoints([trade({ status: "pending", filledEntry: undefined })])).toHaveLength(0);
    expect(getSlippagePoints([trade({ status: "rejected", filledEntry: undefined })])).toHaveLength(0);
  });

  it("excludes a filled trade with no recorded fill price", () => {
    expect(getSlippagePoints([trade({ status: "filled", filledEntry: undefined })])).toHaveLength(0);
  });
});

describe("getSlippageStats", () => {
  it("reports an honest empty state for zero points", () => {
    expect(getSlippageStats([])).toEqual({ count: 0, averagePips: null, adverseRate: 0, worstAdversePips: null, bestFavorablePips: null });
  });

  it("aggregates average/adverse-rate/worst/best across points", () => {
    const points: SlippagePoint[] = [
      { tradeId: "a", pair: "EUR/USD", slippagePips: 3, attemptedAt: 1 },
      { tradeId: "b", pair: "EUR/USD", slippagePips: -1, attemptedAt: 2 },
      { tradeId: "c", pair: "EUR/USD", slippagePips: 5, attemptedAt: 3 },
      { tradeId: "d", pair: "EUR/USD", slippagePips: -2, attemptedAt: 4 },
    ];
    const stats = getSlippageStats(points);
    expect(stats.count).toBe(4);
    expect(stats.averagePips).toBeCloseTo((3 - 1 + 5 - 2) / 4, 5);
    expect(stats.adverseRate).toBe(50); // 2 of 4 positive
    expect(stats.worstAdversePips).toBe(5);
    expect(stats.bestFavorablePips).toBe(-2);
  });
});

describe("getSlippageBreakdownByPair", () => {
  it("groups points by pair and runs stats per bucket", () => {
    const points: SlippagePoint[] = [
      { tradeId: "a", pair: "EUR/USD", slippagePips: 2, attemptedAt: 1 },
      { tradeId: "b", pair: "GBP/USD", slippagePips: -4, attemptedAt: 2 },
      { tradeId: "c", pair: "EUR/USD", slippagePips: 4, attemptedAt: 3 },
    ];
    const breakdown = getSlippageBreakdownByPair(points);
    expect(Object.keys(breakdown).sort()).toEqual(["EUR/USD", "GBP/USD"]);
    expect(breakdown["EUR/USD"].count).toBe(2);
    expect(breakdown["EUR/USD"].averagePips).toBeCloseTo(3, 5);
    expect(breakdown["GBP/USD"].count).toBe(1);
    expect(breakdown["GBP/USD"].averagePips).toBeCloseTo(-4, 5);
  });
});
