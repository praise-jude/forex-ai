import { describe, expect, it } from "vitest";
import { findInvalidatedTrades } from "../positionInvalidation";
import { buildSignal } from "./fixtures";
import type { ExecutedTrade } from "../types";

function buildTrade(overrides: Partial<ExecutedTrade> = {}): ExecutedTrade {
  return {
    id: "trade-1",
    signalId: "signal-1",
    account: "live",
    pair: "EUR/USD",
    timeframe: "15m",
    direction: "long",
    requestedLots: 0.5,
    requestedEntry: 1.1,
    filledEntry: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.13,
    status: "filled",
    brokerPositionId: "pos-1",
    riskPct: 1,
    attemptedAt: Date.now(),
    filledAt: Date.now(),
    ...overrides,
  };
}

describe("findInvalidatedTrades", () => {
  it("matches a same-pair, same-timeframe, opposite-direction open trade", () => {
    const signal = buildSignal({ pair: "EUR/USD", timeframe: "15m", direction: "short" });
    const trade = buildTrade({ pair: "EUR/USD", timeframe: "15m", direction: "long" });
    expect(findInvalidatedTrades(signal, [trade])).toEqual([trade]);
  });

  it("never matches a same-direction trade -- a fresh agreeing signal doesn't invalidate anything", () => {
    const signal = buildSignal({ pair: "EUR/USD", timeframe: "15m", direction: "long" });
    const trade = buildTrade({ pair: "EUR/USD", timeframe: "15m", direction: "long" });
    expect(findInvalidatedTrades(signal, [trade])).toEqual([]);
  });

  it("never matches a different pair", () => {
    const signal = buildSignal({ pair: "GBP/USD", timeframe: "15m", direction: "short" });
    const trade = buildTrade({ pair: "EUR/USD", timeframe: "15m", direction: "long" });
    expect(findInvalidatedTrades(signal, [trade])).toEqual([]);
  });

  it("never matches a different timeframe -- three signal engines run concurrently per pair", () => {
    const signal = buildSignal({ pair: "EUR/USD", timeframe: "1h", direction: "short" });
    const trade = buildTrade({ pair: "EUR/USD", timeframe: "15m", direction: "long" });
    expect(findInvalidatedTrades(signal, [trade])).toEqual([]);
  });

  it("never matches a trade that isn't filled (pending/rejected)", () => {
    const signal = buildSignal({ pair: "EUR/USD", timeframe: "15m", direction: "short" });
    const pending = buildTrade({ pair: "EUR/USD", timeframe: "15m", direction: "long", status: "pending", brokerPositionId: undefined });
    expect(findInvalidatedTrades(signal, [pending])).toEqual([]);
  });

  it("never matches a filled trade with no broker position id (nothing to close)", () => {
    const signal = buildSignal({ pair: "EUR/USD", timeframe: "15m", direction: "short" });
    const trade = buildTrade({ pair: "EUR/USD", timeframe: "15m", direction: "long", brokerPositionId: undefined });
    expect(findInvalidatedTrades(signal, [trade])).toEqual([]);
  });

  it("matches across both accounts independently -- live and demo can both be open on the same pair/timeframe", () => {
    const signal = buildSignal({ pair: "EUR/USD", timeframe: "15m", direction: "short" });
    const liveTrade = buildTrade({ account: "live", brokerPositionId: "pos-live" });
    const demoTrade = buildTrade({ account: "demo", brokerPositionId: "pos-demo" });
    const result = findInvalidatedTrades(signal, [liveTrade, demoTrade]);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.account).sort()).toEqual(["demo", "live"]);
  });

  it("matches only the opposite-direction trade when both directions are open on the same pair/timeframe", () => {
    const signal = buildSignal({ pair: "EUR/USD", timeframe: "15m", direction: "short" });
    const longTrade = buildTrade({ direction: "long", brokerPositionId: "pos-long" });
    const shortTrade = buildTrade({ direction: "short", brokerPositionId: "pos-short" });
    expect(findInvalidatedTrades(signal, [longTrade, shortTrade])).toEqual([longTrade]);
  });
});
