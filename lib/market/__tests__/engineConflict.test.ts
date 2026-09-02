import { describe, expect, it } from "vitest";
import { detectEngineConflicts } from "../engineConflict";
import type { PredictionUpdate, Signal } from "../types";

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "sig-1",
    source: "smc",
    pair: "EUR/USD",
    direction: "long",
    entry: 1.085,
    stopLoss: 1.083,
    takeProfit: 1.089,
    takeProfit2: 1.091,
    riskReward: 2,
    confidence: 90,
    directionScore: 90,
    entryScore: 90,
    adx: 25,
    rsi: 60,
    tier: "strong_buy",
    confluences: [],
    session: "london",
    timeframe: "15m",
    createdAt: 0,
    signerBDirection: "long",
    signerBConfidence: 80,
    signerBEmaTrend: "bullish",
    rsiDivergence: "none",
    supertrendTrend: "up",
    usdStrengthStatus: "supports",
    newsStatus: "clear",
    ...overrides,
  };
}

const NEUTRAL_TRENDS = { d1: "neutral", h4: "neutral", h1: "neutral", d1Gap: null, h4Gap: null, h1Gap: null } as const;

function signalUpdate(overrides: Partial<Signal> = {}): PredictionUpdate {
  const s = signal(overrides);
  return {
    pair: s.pair,
    timeframe: s.timeframe,
    source: s.source,
    evaluation: { status: "signal", signal: s },
    time: 0,
    regime: "range",
    trends: NEUTRAL_TRENDS,
  };
}

function noTradeUpdate(source: PredictionUpdate["source"] = "smc"): PredictionUpdate {
  return {
    pair: "EUR/USD",
    timeframe: "15m",
    source,
    evaluation: { status: "no_trade", reason: { code: "no_setup" } },
    time: 0,
    regime: "range",
    trends: NEUTRAL_TRENDS,
  };
}

describe("detectEngineConflicts", () => {
  it("reports no conflict when only one engine has fired a signal", () => {
    const conflicts = detectEngineConflicts([signalUpdate({ source: "smc" })]);
    expect(conflicts).toEqual([]);
  });

  it("reports no conflict when both engines fired and agree", () => {
    const conflicts = detectEngineConflicts([
      signalUpdate({ source: "smc", direction: "long" }),
      signalUpdate({ source: "mean_reversion", direction: "long" }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("reports a conflict when SMC and the range engine fire opposing directions on the same pair/timeframe", () => {
    const conflicts = detectEngineConflicts([
      signalUpdate({ source: "smc", direction: "long" }),
      signalUpdate({ source: "mean_reversion", direction: "short" }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].pair).toBe("EUR/USD");
    expect(conflicts[0].timeframe).toBe("15m");
    expect(conflicts[0].sides).toEqual(
      expect.arrayContaining([
        { source: "smc", direction: "long" },
        { source: "mean_reversion", direction: "short" },
      ])
    );
  });

  it("never invents a conflict from a no-trade reason's implied direction", () => {
    const conflicts = detectEngineConflicts([signalUpdate({ source: "smc", direction: "long" }), noTradeUpdate("mean_reversion")]);
    expect(conflicts).toEqual([]);
  });

  it("does not conflate different pairs or timeframes", () => {
    const conflicts = detectEngineConflicts([
      signalUpdate({ source: "smc", direction: "long", pair: "EUR/USD", timeframe: "15m" }),
      signalUpdate({ source: "mean_reversion", direction: "short", pair: "GBP/USD", timeframe: "15m" }),
    ]);
    expect(conflicts).toEqual([]);
  });
});
