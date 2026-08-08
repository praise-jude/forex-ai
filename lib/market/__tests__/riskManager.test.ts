import { afterEach, describe, expect, it } from "vitest";
import {
  checkPriceDrift,
  checkRiskLimits,
  isEnvKillSwitchActive,
  isKillSwitchActive,
  STALE_PRICE_FRACTION_OF_STOP,
  type PriceDriftInput,
  type RiskCheckInput,
} from "../riskManager";

function buildInput(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    killSwitchActive: false,
    haltedForToday: false,
    openPositionCount: 0,
    maxConcurrentPositions: 3,
    tradesOpenedToday: 0,
    maxTradesPerDay: 5,
    startOfDayEquity: 10000,
    currentEquity: 10000,
    maxDailyLossPct: 5,
    ...overrides,
  };
}

describe("checkRiskLimits", () => {
  it("allows execution when nothing is tripped", () => {
    expect(checkRiskLimits(buildInput())).toEqual({ allowed: true });
  });

  it("blocks on the kill switch, even if other limits are also over", () => {
    const result = checkRiskLimits(buildInput({ killSwitchActive: true, openPositionCount: 99 }));
    expect(result).toEqual({ allowed: false, code: "kill_switch", reason: "kill switch is active" });
  });

  it("blocks when already halted for today", () => {
    const result = checkRiskLimits(buildInput({ haltedForToday: true }));
    expect(result).toEqual({
      allowed: false,
      code: "halted",
      reason: "trading halted for today (daily loss limit already tripped)",
    });
  });

  it("blocks at the max concurrent positions limit", () => {
    const result = checkRiskLimits(buildInput({ openPositionCount: 3, maxConcurrentPositions: 3 }));
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("max_positions");
  });

  it("blocks at the max trades per day limit", () => {
    const result = checkRiskLimits(buildInput({ tradesOpenedToday: 5, maxTradesPerDay: 5 }));
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("max_trades");
  });

  it("blocks once the daily loss threshold is reached", () => {
    const result = checkRiskLimits(buildInput({ startOfDayEquity: 10000, currentEquity: 9500, maxDailyLossPct: 5 }));
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("daily_loss");
  });

  it("allows when the drawdown is under the daily loss threshold", () => {
    const result = checkRiskLimits(buildInput({ startOfDayEquity: 10000, currentEquity: 9600, maxDailyLossPct: 5 }));
    expect(result).toEqual({ allowed: true });
  });
});

function buildDriftInput(overrides: Partial<PriceDriftInput> = {}): PriceDriftInput {
  return {
    direction: "long",
    entry: 1.1,
    stopLoss: 1.09,
    currentAsk: 1.1,
    currentBid: 1.0998,
    ...overrides,
  };
}

describe("checkPriceDrift", () => {
  it("allows execution when the current price is at (or very near) the entry", () => {
    expect(checkPriceDrift(buildDriftInput())).toEqual({ allowed: true });
  });

  it("allows execution when no live price has been seen yet (fails open)", () => {
    expect(checkPriceDrift(buildDriftInput({ currentAsk: undefined, currentBid: undefined }))).toEqual({ allowed: true });
  });

  it("uses ask for a long entry, blocking once drift exceeds the stop-relative tolerance", () => {
    const stopDistance = 0.01; // entry 1.10, stop 1.09
    const tolerance = STALE_PRICE_FRACTION_OF_STOP * stopDistance;
    const result = checkPriceDrift(buildDriftInput({ currentAsk: 1.1 + tolerance + 0.0001 }));
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("stale_price");
  });

  it("uses bid, not ask, for a short entry", () => {
    const input = buildDriftInput({ direction: "short", entry: 1.1, stopLoss: 1.11, currentBid: 1.15, currentAsk: 1.1 });
    // Ask hasn't moved at all, but bid (the side a short entry actually fills against) has
    // -- must block on bid, proving the direction-based side selection is respected.
    const result = checkPriceDrift(input);
    expect(result.allowed).toBe(false);
  });

  it("allows execution right at the tolerance boundary and blocks just past it", () => {
    const stopDistance = 0.01;
    const tolerance = STALE_PRICE_FRACTION_OF_STOP * stopDistance;
    expect(checkPriceDrift(buildDriftInput({ currentAsk: 1.1 + tolerance })).allowed).toBe(true);
    expect(checkPriceDrift(buildDriftInput({ currentAsk: 1.1 + tolerance + 0.00001 })).allowed).toBe(false);
  });
});

describe("isKillSwitchActive", () => {
  const NONEXISTENT_FILE = "___does-not-exist___.tmp";

  afterEach(() => {
    delete process.env.TRADING_KILL_SWITCH;
  });

  it("is false when neither the file nor the env var is set", () => {
    expect(isKillSwitchActive(NONEXISTENT_FILE)).toBe(false);
  });

  it("is true when TRADING_KILL_SWITCH is set to a truthy value, even without the file", () => {
    process.env.TRADING_KILL_SWITCH = "1";
    expect(isKillSwitchActive(NONEXISTENT_FILE)).toBe(true);
  });

  it("treats \"0\" and \"false\" as not set", () => {
    process.env.TRADING_KILL_SWITCH = "0";
    expect(isKillSwitchActive(NONEXISTENT_FILE)).toBe(false);
    process.env.TRADING_KILL_SWITCH = "false";
    expect(isKillSwitchActive(NONEXISTENT_FILE)).toBe(false);
  });
});

describe("isEnvKillSwitchActive", () => {
  afterEach(() => {
    delete process.env.TRADING_KILL_SWITCH;
  });

  it("is false when unset, true when set truthy -- independent of any file", () => {
    expect(isEnvKillSwitchActive()).toBe(false);
    process.env.TRADING_KILL_SWITCH = "1";
    expect(isEnvKillSwitchActive()).toBe(true);
  });
});
