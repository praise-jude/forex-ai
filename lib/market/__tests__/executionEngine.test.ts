import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSignal } from "./fixtures";
import type { AccountInfo } from "../types";

// A real, confirmed gap (2026-09-12): a live BTC/USD signal was blocked with code
// "daily_loss" (visible in autoExecutionActivity's own trail), but neither the
// persisted halt (riskDailyState.haltedForToday) nor the "Autopilot locked" alert ever
// showed up afterward. attemptExecution had NO test coverage at all before this file --
// this exercises the real function (not a mock of it) against the real riskState
// singleton, only stubbing the outer MetaApi/notification boundary, specifically to
// prove (or disprove) that the daily_loss branch in executionEngine.ts actually does
// what its own code claims.

const mockGetAccountInformation = vi.fn<() => AccountInfo | undefined>();
const mockGetOpenPositionCount = vi.fn<() => number>();
const mockGetOpenPositions = vi.fn<() => []>();

vi.mock("../metaApiConnection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../metaApiConnection")>();
  return {
    ...actual,
    getAccountInformation: () => mockGetAccountInformation(),
    getOpenPositionCount: () => mockGetOpenPositionCount(),
    getOpenPositions: () => mockGetOpenPositions(),
  };
});

const mockSendNotification = vi.fn().mockResolvedValue(undefined);
vi.mock("../pushNotifier", () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}));

function accountInfo(equity: number): AccountInfo {
  return { balance: equity, equity, freeMargin: equity, margin: 0, tradeAllowed: true };
}

describe("attemptExecution -- daily_loss halt (real riskState, real checkRiskLimits)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetAccountInformation.mockReset();
    mockGetOpenPositionCount.mockReset().mockReturnValue(0);
    mockGetOpenPositions.mockReset().mockReturnValue([]);
    mockSendNotification.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets haltedForToday=true the moment daily_loss trips, sends the alert, and blocks every later attempt with 'halted'", async () => {
    // A date no other test file's riskState fixtures use -- irrelevant anyway since
    // vitest isolates module state (and therefore riskState's globalThis singleton) per
    // test FILE by default, but kept distinctive for readability.
    const day1 = Date.UTC(2031, 3, 10, 9, 0, 0);
    vi.setSystemTime(day1);

    const { attemptExecution } = await import("../executionEngine");
    const { riskState } = await import("../riskState");

    // First attempt anchors today's startOfDayEquity at 1000 via a signal that's
    // otherwise unblocked (equity hasn't moved yet) -- mirrors the real first-evaluation-
    // of-the-day path (riskState.current() is called and anchors on whatever equity it
    // sees first).
    mockGetAccountInformation.mockReturnValue(accountInfo(1000));
    const firstSignal = buildSignal({ id: "signal-anchor", pair: "BTC/USD", source: "mean_reversion", tier: "buy" });
    // Kill switch/policy/no_account gates all pass at equity 1000 with no daily-loss
    // breach yet, so this reaches the real broker-order path -- not the point of this
    // test, so accept whatever happens (fails on sizing/order placement is fine; we only
    // care that it anchors startOfDayEquity, which riskState.current() does as a side
    // effect of the risk check regardless of what happens after).
    await attemptExecution(firstSignal, "live").catch(() => undefined);
    expect(riskState.current(day1, 1000, "live").startOfDayEquity).toBe(1000);
    expect(riskState.current(day1, 1000, "live").haltedForToday).toBe(false);

    // Now equity has dropped 2% (breaches MAX_DAILY_LOSS_PCT=1 from .env.local) -- a
    // second, distinct signal fires and should trip the daily_loss gate.
    mockGetAccountInformation.mockReturnValue(accountInfo(980));
    const losingSignal = buildSignal({ id: "signal-daily-loss", pair: "BTC/USD", source: "mean_reversion", tier: "buy", direction: "short" });
    const result = await attemptExecution(losingSignal, "live");

    expect(result).toMatchObject({ status: "blocked", code: "daily_loss" });

    // The actual real-world symptom being tested: did the halt really persist, and did
    // the alert really fire?
    const afterTrip = riskState.current(day1, 980, "live");
    expect(afterTrip.haltedForToday).toBe(true);
    expect(mockSendNotification).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("Autopilot locked") }));

    // A THIRD signal, at the same (or even recovered) equity, must now be blocked by the
    // persisted halt itself ("halted"), not re-evaluate daily_loss from scratch -- this
    // is the concrete, checkable version of "does the account actually stay locked".
    mockGetAccountInformation.mockReturnValue(accountInfo(1000));
    const thirdSignal = buildSignal({ id: "signal-after-halt", pair: "BTC/USD", source: "mean_reversion", tier: "buy" });
    const thirdResult = await attemptExecution(thirdSignal, "live");
    expect(thirdResult).toMatchObject({ status: "blocked", code: "halted" });
  });
});
