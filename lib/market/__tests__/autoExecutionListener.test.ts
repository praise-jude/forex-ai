import { describe, expect, it } from "vitest";
import { hasAdverseOpenPosition } from "../autoExecutionListener";
import type { ExecutedTrade, OpenPosition } from "../types";

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
    takeProfit2: 1.15,
    status: "filled",
    brokerPositionId: "pos-1",
    riskPct: 1,
    attemptedAt: Date.now(),
    filledAt: Date.now(),
    ...overrides,
  };
}

function buildPosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    id: "pos-1",
    pair: "EUR/USD",
    direction: "long",
    lots: 0.5,
    openPrice: 1.1,
    currentPrice: 1.1,
    profit: 0,
    ...overrides,
  };
}

describe("hasAdverseOpenPosition", () => {
  it("is false when there are no open trades at all", () => {
    expect(hasAdverseOpenPosition("EUR/USD", "15m", "long", [], [])).toBe(false);
  });

  it("is false when the matching trade's live position is currently profitable", () => {
    const trade = buildTrade();
    const position = buildPosition({ profit: 12.5 });
    expect(hasAdverseOpenPosition("EUR/USD", "15m", "long", [trade], [position])).toBe(false);
  });

  it("is true when the matching same-direction trade's live position is currently losing money", () => {
    const trade = buildTrade();
    const position = buildPosition({ profit: -8.2 });
    expect(hasAdverseOpenPosition("EUR/USD", "15m", "long", [trade], [position])).toBe(true);
  });

  it("is false for the opposite direction even while the existing position is losing -- reversal must pass through", () => {
    const trade = buildTrade({ direction: "long" });
    const position = buildPosition({ direction: "long", profit: -8.2 });
    expect(hasAdverseOpenPosition("EUR/USD", "15m", "short", [trade], [position])).toBe(false);
  });

  it("ignores a losing position on a different pair", () => {
    const trade = buildTrade({ pair: "GBP/USD", brokerPositionId: "pos-gbp" });
    const position = buildPosition({ id: "pos-gbp", pair: "GBP/USD", profit: -8.2 });
    expect(hasAdverseOpenPosition("EUR/USD", "15m", "long", [trade], [position])).toBe(false);
  });

  it("ignores a losing position on a different timeframe -- three signal engines run concurrently per pair", () => {
    const trade = buildTrade({ timeframe: "1h", brokerPositionId: "pos-1h" });
    const position = buildPosition({ id: "pos-1h", profit: -8.2 });
    expect(hasAdverseOpenPosition("EUR/USD", "15m", "long", [trade], [position])).toBe(false);
  });

  it("ignores a trade that isn't filled (pending/rejected)", () => {
    const trade = buildTrade({ status: "pending", brokerPositionId: undefined });
    const position = buildPosition({ profit: -8.2 });
    expect(hasAdverseOpenPosition("EUR/USD", "15m", "long", [trade], [position])).toBe(false);
  });

  it("ignores a filled trade with no broker position id", () => {
    const trade = buildTrade({ brokerPositionId: undefined });
    const position = buildPosition({ profit: -8.2 });
    expect(hasAdverseOpenPosition("EUR/USD", "15m", "long", [trade], [position])).toBe(false);
  });

  it("ignores a trade whose broker position already closed naturally (no longer in the live list)", () => {
    const trade = buildTrade();
    expect(hasAdverseOpenPosition("EUR/USD", "15m", "long", [trade], [])).toBe(false);
  });
});
