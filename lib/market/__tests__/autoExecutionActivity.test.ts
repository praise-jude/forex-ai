import { beforeEach, describe, expect, it } from "vitest";
import { getAutoExecutionActivity, recordAttempt, recordSignalSeen, resetAutoExecutionActivityForTests } from "../autoExecutionActivity";

describe("autoExecutionActivity", () => {
  beforeEach(() => {
    resetAutoExecutionActivityForTests();
  });

  it("starts empty", () => {
    const activity = getAutoExecutionActivity();
    expect(activity).toEqual({
      signalsSeen: 0,
      lastSignalSeenAt: null,
      lastSignalSeen: null,
      attemptsTotal: 0,
      filledTotal: 0,
      resultCounts: {},
      recentAttempts: [],
    });
  });

  it("recordSignalSeen increments the count and tracks the most recent signal", () => {
    recordSignalSeen("GBP/USD", "buy", "smc");
    recordSignalSeen("XAU/USD", "strong_buy", "mean_reversion");
    const activity = getAutoExecutionActivity();
    expect(activity.signalsSeen).toBe(2);
    expect(activity.lastSignalSeen).toEqual({ pair: "XAU/USD", tier: "strong_buy", source: "mean_reversion" });
    expect(activity.lastSignalSeenAt).not.toBeNull();
  });

  it("recordAttempt tracks totals and only counts 'filled' toward filledTotal", () => {
    recordAttempt({ signalId: "1", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: "blocked: kill_switch" });
    recordAttempt({ signalId: "2", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: "filled" });
    const activity = getAutoExecutionActivity();
    expect(activity.attemptsTotal).toBe(2);
    expect(activity.filledTotal).toBe(1);
  });

  it("recentAttempts is most-recent-first and capped", () => {
    for (let i = 0; i < 25; i++) {
      recordAttempt({ signalId: String(i), pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: `attempt-${i}` });
    }
    const activity = getAutoExecutionActivity();
    expect(activity.recentAttempts.length).toBe(20);
    expect(activity.recentAttempts[0].result).toBe("attempt-24");
    expect(activity.recentAttempts[19].result).toBe("attempt-5");
  });

  it("allows a null account for the two gates that stop a signal before one is resolved", () => {
    recordAttempt({ signalId: "1", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: null, result: "blocked: analysis_mode" });
    const activity = getAutoExecutionActivity();
    expect(activity.recentAttempts[0].account).toBeNull();
  });

  it("getAutoExecutionActivity returns a snapshot, not a live reference -- later mutation doesn't retroactively change it", () => {
    recordSignalSeen("GBP/USD", "buy", "smc");
    const snapshot = getAutoExecutionActivity();
    recordSignalSeen("XAU/USD", "buy", "smc");
    expect(snapshot.signalsSeen).toBe(1);
  });

  describe("resultCounts", () => {
    it("groups a fixed reason code (blocked: <code>) verbatim, so a specific code like stale_price is countable on its own", () => {
      recordAttempt({ signalId: "1", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: "blocked: stale_price" });
      recordAttempt({ signalId: "2", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: "blocked: stale_price" });
      recordAttempt({ signalId: "3", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: "blocked: kill_switch" });
      const activity = getAutoExecutionActivity();
      expect(activity.resultCounts).toEqual({ "blocked: stale_price": 2, "blocked: kill_switch": 1 });
    });

    it("collapses free-text rejected/error results into one bucket each, not one per unique message", () => {
      recordAttempt({ signalId: "1", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: "rejected: broker says no" });
      recordAttempt({ signalId: "2", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: "rejected: a completely different reason" });
      recordAttempt({ signalId: "3", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: "error: network blip" });
      const activity = getAutoExecutionActivity();
      expect(activity.resultCounts).toEqual({ rejected: 2, error: 1 });
    });

    it("does not mutate the caller's snapshot object on a later recordAttempt", () => {
      recordAttempt({ signalId: "1", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: "filled" });
      const snapshot = getAutoExecutionActivity();
      recordAttempt({ signalId: "2", pair: "GBP/USD", tier: "buy", source: "smc", direction: "long", account: "live", result: "filled" });
      expect(snapshot.resultCounts.filled).toBe(1);
    });
  });
});
