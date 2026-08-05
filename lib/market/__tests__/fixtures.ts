import type { Signal, SymbolSpec } from "../types";

export function buildSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "test-signal",
    pair: "EUR/USD",
    direction: "long",
    entry: 1.105,
    stopLoss: 1.103,
    takeProfit: 1.109,
    riskReward: 2,
    confluences: ["liquidity_sweep", "bos", "fvg", "killzone"],
    session: "london",
    timeframe: "15m",
    createdAt: Date.now(),
    ...overrides,
  };
}

export function buildSpec(overrides: Partial<SymbolSpec> = {}): SymbolSpec {
  return {
    contractSize: 100000,
    volumeStep: 0.01,
    volumeMin: 0.01,
    volumeMax: 100,
    ...overrides,
  };
}
