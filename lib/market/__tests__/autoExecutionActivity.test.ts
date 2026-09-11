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
});
