import type { Signal, SymbolSpec } from "../types";

export function buildSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "test-signal",
    source: "smc",
    pair: "EUR/USD",
    direction: "long",
    entry: 1.105,
    stopLoss: 1.103,
    takeProfit: 1.109,
    takeProfit2: 1.113,
    riskReward: 2,
    confidence: 90,
    directionScore: 90,
    entryScore: 90,
    adx: 27.4,
    rsi: 58,
    tier: "buy",
    confluences: ["liquidity_sweep", "bos", "fvg", "killzone"],
    session: "london",
    timeframe: "15m",
    createdAt: Date.now(),
    signerBDirection: "long",
    signerBConfidence: 90,
    signerBEmaTrend: "bullish",
    rsiDivergence: "none",
    supertrendTrend: "up",
    usdStrengthStatus: "supports",
    newsStatus: "clear",
    ...overrides,
  };
}

export function buildSpec(overrides: Partial<SymbolSpec> = {}): SymbolSpec {
  return {
    contractSize: 100000,
    volumeStep: 0.01,
    volumeMin: 0.01,
    volumeMax: 100,
    point: 0.00001,
    ...overrides,
  };
}
