import { afterEach, describe, expect, it } from "vitest";
import {
  checkCorrelatedExposure,
  checkPriceDrift,
  checkRiskLimits,
  checkSpread,
  isDailyLossBreached,
  isEnvKillSwitchActive,
  isKillSwitchActive,
  STALE_PRICE_FRACTION_OF_STOP,
  type CorrelatedExposureInput,
  type PriceDriftInput,
  type RiskCheckInput,
  type SpreadInput,
} from "../riskManager";

function buildInput(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    killSwitchActive: false,
    haltedForToday: false,
    now: 1_000_000,
    cooldownUntil: null,
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

  it("blocks while a revenge-trading cooldown is still active", () => {
    const result = checkRiskLimits(buildInput({ now: 1_000_000, cooldownUntil: 1_000_000 + 5 * 60_000 }));
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("cooldown");
    expect((result as { reason: string }).reason).toContain("5 minute");
  });

  it("allows execution once the cooldown has lifted", () => {
    const result = checkRiskLimits(buildInput({ now: 1_000_000, cooldownUntil: 999_000 }));
    expect(result).toEqual({ allowed: true });
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

function buildSpreadInput(overrides: Partial<SpreadInput> = {}): SpreadInput {
  return {
    entry: 1.1,
    stopLoss: 1.09, // 0.01 stop distance
    currentBid: 1.0999,
    currentAsk: 1.1001, // 0.0002 spread
    maxSpreadFractionOfStop: 0.15,
    ...overrides,
  };
}

describe("checkSpread", () => {
  it("allows execution when the spread is well within tolerance", () => {
    expect(checkSpread(buildSpreadInput())).toEqual({ allowed: true });
  });

  it("allows execution when no live price has been seen yet (fails open)", () => {
    expect(checkSpread(buildSpreadInput({ currentBid: undefined, currentAsk: undefined }))).toEqual({ allowed: true });
  });

  it("allows a spread comfortably inside tolerance and blocks one comfortably past it", () => {
    const bid = 1.1;
    // stop distance 0.01, 15% tolerance = 0.0015 -- well inside vs well past that.
    expect(checkSpread(buildSpreadInput({ currentBid: bid, currentAsk: bid + 0.001 })).allowed).toBe(true);
    const result = checkSpread(buildSpreadInput({ currentBid: bid, currentAsk: bid + 0.002 }));
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("wide_spread");
  });

  it("scales the tolerance with the signal's own stop distance, not a flat pip count", () => {
    // Same absolute spread (0.005), tight stop blocks it, wide stop allows it.
    const tightStop = buildSpreadInput({ entry: 1.1, stopLoss: 1.099, currentBid: 1.1, currentAsk: 1.105 }); // 0.001 stop
    const wideStop = buildSpreadInput({ entry: 1.1, stopLoss: 1.05, currentBid: 1.1, currentAsk: 1.105 }); // 0.05 stop
    expect(checkSpread(tightStop).allowed).toBe(false);
    expect(checkSpread(wideStop).allowed).toBe(true);
  });

  it("allows when entry and stop loss are equal (degenerate case handled elsewhere, not here)", () => {
    expect(checkSpread(buildSpreadInput({ entry: 1.1, stopLoss: 1.1 })).allowed).toBe(true);
  });
});

function buildCorrelationInput(overrides: Partial<CorrelatedExposureInput> = {}): CorrelatedExposureInput {
  return {
    pair: "EUR/USD",
    direction: "long",
    openPositions: [],
    maxCorrelatedPositions: 1,
    ...overrides,
  };
}

describe("checkCorrelatedExposure", () => {
  it("allows when there are no open positions, at full size", () => {
    expect(checkCorrelatedExposure(buildCorrelationInput())).toEqual({ allowed: true, sizeMultiplier: 1, tier: "none", reason: null });
  });

  it("allows an uncorrelated open position, at full size", () => {
    // EUR/USD long is a short-USD bet; BTC/USD has no correlation partner in this model.
    const input = buildCorrelationInput({ openPositions: [{ pair: "BTC/USD", direction: "long" }] });
    expect(checkCorrelatedExposure(input)).toEqual({ allowed: true, sizeMultiplier: 1, tier: "none", reason: null });
  });

  it("blocks a second EXTREME-tier (static-model match) correlated position once the cap (default 1) is reached", () => {
    // GBP/USD is a static-model match for EUR/USD (both a short-USD bet) -- no real
    // correlation data seeded here, so this exercises the static-match-is-always-extreme
    // path, same as before this feature's graduated sizing existed.
    const input = buildCorrelationInput({ openPositions: [{ pair: "GBP/USD", direction: "long" }] });
    const result = checkCorrelatedExposure(input);
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("correlated_exposure");
    expect((result as { tier: string }).tier).toBe("extreme");
  });

  it("respects a higher configured cap -- allowed, but still sized down hard (extreme tier isn't gated by the cap for sizing)", () => {
    const input = buildCorrelationInput({ openPositions: [{ pair: "GBP/USD", direction: "long" }], maxCorrelatedPositions: 2 });
    const result = checkCorrelatedExposure(input);
    expect(result.allowed).toBe(true);
    expect((result as { sizeMultiplier: number }).sizeMultiplier).toBe(0.1);
    expect((result as { tier: string }).tier).toBe("extreme");
  });

  it("counts multiple EXTREME-tier positions against the cap", () => {
    const input = buildCorrelationInput({
      openPositions: [
        { pair: "GBP/USD", direction: "long" },
        { pair: "AUD/USD", direction: "long" },
      ],
      maxCorrelatedPositions: 2,
    });
    expect(checkCorrelatedExposure(input).allowed).toBe(false);
  });

  it("uses the worst (most-correlated) tier across multiple open positions, not an average", () => {
    // BTC/USD is genuinely uncorrelated in the static model; GBP/USD is a static match.
    // The worst tier (extreme, from GBP/USD) must drive the result even with a
    // comfortably-diversified position also open.
    const input = buildCorrelationInput({
      openPositions: [
        { pair: "BTC/USD", direction: "long" },
        { pair: "GBP/USD", direction: "long" },
      ],
      maxCorrelatedPositions: 2,
    });
    const result = checkCorrelatedExposure(input);
    expect(result.allowed).toBe(true);
    expect((result as { tier: string }).tier).toBe("extreme");
    expect((result as { sizeMultiplier: number }).sizeMultiplier).toBe(0.1);
  });
});

describe("isDailyLossBreached", () => {
  it("mirrors checkRiskLimits's daily_loss threshold, usable outside an execution attempt", () => {
    expect(isDailyLossBreached(10000, 9500, 5)).toBe(true);
    expect(isDailyLossBreached(10000, 9600, 5)).toBe(false);
    expect(isDailyLossBreached(0, 9600, 5)).toBe(false); // no anchor yet -- never reports a breach
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
