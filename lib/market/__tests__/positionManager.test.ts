import { describe, expect, it } from "vitest";
import { evaluatePositionForManagement, type PositionManagementConfig, type PositionManagementState } from "../positionManager";
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
    stopLoss: 1.09, // 0.01 stop distance
    takeProfit: 1.13,
    takeProfit2: 1.15,
    status: "filled",
    riskPct: 1,
    attemptedAt: Date.now(),
    filledAt: Date.now(),
    ...overrides,
  };
}

const CONFIG: PositionManagementConfig = {
  breakEvenTriggerR: 1.0,
  trailingArmTriggerR: 1.5,
  trailingDistanceFractionOfStop: 1.0,
  partialCloseEnabled: false,
};

const FRESH_STATE: PositionManagementState = { breakEvenApplied: false, trailingArmed: false, partialCloseApplied: false };

// Boundary comparisons here are inherently floating-point-sensitive (e.g. 1.11 - 1.1
// isn't exactly 0.01 in IEEE754) -- every case below uses a price comfortably inside or
// outside the relevant threshold rather than an exact boundary value, same reasoning as
// riskManager.test.ts's own checkSpread/checkPriceDrift boundary tests.
describe("evaluatePositionForManagement", () => {
  it("does nothing below every threshold", () => {
    const trade = buildTrade(); // entry 1.10, stop 1.09
    expect(evaluatePositionForManagement(trade, 1.105, CONFIG, FRESH_STATE)).toEqual({ type: "none" }); // 0.5R
  });

  describe("break-even trigger", () => {
    it("moves stop to entry once R comfortably clears the trigger, for a long trade", () => {
      const trade = buildTrade({ direction: "long", requestedEntry: 1.1, stopLoss: 1.09 });
      const action = evaluatePositionForManagement(trade, 1.111, CONFIG, FRESH_STATE); // 1.1R
      expect(action).toEqual({ type: "break_even", newStopLoss: 1.1 });
    });

    it("moves stop to entry once R comfortably clears the trigger, for a short trade", () => {
      const trade = buildTrade({ direction: "short", requestedEntry: 1.1, stopLoss: 1.11 }); // 0.01 stop distance
      const action = evaluatePositionForManagement(trade, 1.089, CONFIG, FRESH_STATE); // 1.1R favorable
      expect(action).toEqual({ type: "break_even", newStopLoss: 1.1 });
    });

    it("does nothing comfortably below the break-even trigger", () => {
      const trade = buildTrade({ requestedEntry: 1.1, stopLoss: 1.09 });
      expect(evaluatePositionForManagement(trade, 1.109, CONFIG, FRESH_STATE)).toEqual({ type: "none" }); // 0.9R
    });

    it("is idempotent -- never re-fires once already applied", () => {
      const trade = buildTrade({ requestedEntry: 1.1, stopLoss: 1.09 });
      const state: PositionManagementState = { breakEvenApplied: true, trailingArmed: false, partialCloseApplied: false };
      expect(evaluatePositionForManagement(trade, 1.111, CONFIG, state)).toEqual({ type: "none" });
    });
  });

  describe("trailing-arm trigger", () => {
    it("arms trailing at the configured distance once R comfortably clears the trigger, for a long trade", () => {
      const trade = buildTrade({ direction: "long", requestedEntry: 1.1, stopLoss: 1.09 }); // 0.01 stop distance
      const action = evaluatePositionForManagement(trade, 1.116, CONFIG, FRESH_STATE); // 1.6R
      expect(action).toEqual({ type: "arm_trailing", distance: 0.01 }); // 1.0 fraction * 0.01 stop distance
    });

    it("arms trailing at the configured distance once R comfortably clears the trigger, for a short trade", () => {
      const trade = buildTrade({ direction: "short", requestedEntry: 1.1, stopLoss: 1.11 });
      const action = evaluatePositionForManagement(trade, 1.084, CONFIG, FRESH_STATE); // 1.6R favorable
      expect(action).toEqual({ type: "arm_trailing", distance: 0.01 });
    });

    it("does nothing comfortably below the trailing-arm trigger (but above break-even)", () => {
      const trade = buildTrade({ requestedEntry: 1.1, stopLoss: 1.09 });
      const action = evaluatePositionForManagement(trade, 1.113, CONFIG, FRESH_STATE); // 1.3R -- above break-even, below trailing-arm
      expect(action).toEqual({ type: "break_even", newStopLoss: 1.1 });
    });

    it("scales the trailing distance with trailingDistanceFractionOfStop", () => {
      const trade = buildTrade({ requestedEntry: 1.1, stopLoss: 1.09 });
      const halfDistanceConfig: PositionManagementConfig = { ...CONFIG, trailingDistanceFractionOfStop: 0.5 };
      const action = evaluatePositionForManagement(trade, 1.116, halfDistanceConfig, FRESH_STATE);
      expect(action).toEqual({ type: "arm_trailing", distance: 0.005 });
    });

    it("never re-arms once already armed, even as price keeps climbing", () => {
      const trade = buildTrade({ requestedEntry: 1.1, stopLoss: 1.09 });
      const state: PositionManagementState = { breakEvenApplied: true, trailingArmed: true, partialCloseApplied: false };
      expect(evaluatePositionForManagement(trade, 1.2, CONFIG, state)).toEqual({ type: "none" });
    });

    it("prefers arming trailing over a break-even move when a single poll cycle jumps past both thresholds", () => {
      const trade = buildTrade({ requestedEntry: 1.1, stopLoss: 1.09 });
      const action = evaluatePositionForManagement(trade, 1.2, CONFIG, FRESH_STATE); // 10R in one jump
      expect(action.type).toBe("arm_trailing");
    });
  });

  describe("partial-close (TP1) trigger", () => {
    const PARTIAL_CONFIG: PositionManagementConfig = { ...CONFIG, partialCloseEnabled: true };

    it("does nothing while disabled, even once price reaches TP1", () => {
      const trade = buildTrade({ direction: "long", requestedEntry: 1.1, stopLoss: 1.09, takeProfit: 1.113 }); // TP1 at 1.3R
      const action = evaluatePositionForManagement(trade, 1.113, CONFIG, FRESH_STATE); // partialCloseEnabled: false
      expect(action).toEqual({ type: "break_even", newStopLoss: 1.1 });
    });

    it("fires once price reaches TP1 for a long trade", () => {
      const trade = buildTrade({ direction: "long", requestedEntry: 1.1, stopLoss: 1.09, takeProfit: 1.113 });
      expect(evaluatePositionForManagement(trade, 1.113, PARTIAL_CONFIG, FRESH_STATE)).toEqual({ type: "partial_close" });
      expect(evaluatePositionForManagement(trade, 1.12, PARTIAL_CONFIG, FRESH_STATE)).toEqual({ type: "partial_close" }); // past TP1 too
    });

    it("fires once price reaches TP1 for a short trade", () => {
      const trade = buildTrade({ direction: "short", requestedEntry: 1.1, stopLoss: 1.11, takeProfit: 1.087 });
      expect(evaluatePositionForManagement(trade, 1.087, PARTIAL_CONFIG, FRESH_STATE)).toEqual({ type: "partial_close" });
    });

    it("does nothing before TP1 is reached", () => {
      const trade = buildTrade({ direction: "long", requestedEntry: 1.1, stopLoss: 1.09, takeProfit: 1.113 });
      const action = evaluatePositionForManagement(trade, 1.112, PARTIAL_CONFIG, FRESH_STATE);
      expect(action).not.toEqual({ type: "partial_close" });
    });

    it("is idempotent -- never re-fires once already applied", () => {
      const trade = buildTrade({ direction: "long", requestedEntry: 1.1, stopLoss: 1.09, takeProfit: 1.113 });
      const state: PositionManagementState = { breakEvenApplied: false, trailingArmed: false, partialCloseApplied: true };
      const action = evaluatePositionForManagement(trade, 1.12, PARTIAL_CONFIG, state);
      expect(action).not.toEqual({ type: "partial_close" });
    });

    it("takes priority over break-even and trailing-arm even when both thresholds are also cleared", () => {
      const trade = buildTrade({ direction: "long", requestedEntry: 1.1, stopLoss: 1.09, takeProfit: 1.111 }); // TP1 at 1.1R, past break-even trigger
      const action = evaluatePositionForManagement(trade, 1.2, PARTIAL_CONFIG, FRESH_STATE); // 10R -- also past trailing-arm trigger
      expect(action).toEqual({ type: "partial_close" });
    });

    it("still fires even once trailing is already armed -- the two are independent", () => {
      const trade = buildTrade({ direction: "long", requestedEntry: 1.1, stopLoss: 1.09, takeProfit: 1.113 });
      const state: PositionManagementState = { breakEvenApplied: true, trailingArmed: true, partialCloseApplied: false };
      const action = evaluatePositionForManagement(trade, 1.12, PARTIAL_CONFIG, state);
      expect(action).toEqual({ type: "partial_close" });
    });
  });

  describe("R-multiple baseline stability", () => {
    it("keeps measuring R off the ORIGINAL entry/stop even after breakEvenApplied is true, never a live/moved stop", () => {
      const trade = buildTrade({ requestedEntry: 1.1, stopLoss: 1.09 }); // original 0.01 stop distance
      const state: PositionManagementState = { breakEvenApplied: true, trailingArmed: false, partialCloseApplied: false };
      // 1.6R off the ORIGINAL stop should arm trailing -- if R were wrongly computed off
      // a moved stop (e.g. breakeven at 1.10, which would make the "stop distance"
      // collapse toward zero), this would misfire or divide oddly instead.
      const action = evaluatePositionForManagement(trade, 1.116, CONFIG, state);
      expect(action).toEqual({ type: "arm_trailing", distance: 0.01 });
    });
  });

  describe("degenerate input", () => {
    it("never divides by zero when entry equals stop loss", () => {
      const trade = buildTrade({ requestedEntry: 1.1, stopLoss: 1.1 });
      expect(evaluatePositionForManagement(trade, 1.5, CONFIG, FRESH_STATE)).toEqual({ type: "none" });
    });
  });
});
