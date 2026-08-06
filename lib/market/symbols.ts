import type { Pair } from "./types";

interface PairConfig {
  brokerSymbol: string;
  pip: number;
  decimals: number;
}

// A broker suffix (e.g. "EURUSD.a", "EURUSDm") is common on live MT5 servers.
// Configurable via env so this doesn't need a code change per broker.
const BROKER_SUFFIX = process.env.MT5_SYMBOL_SUFFIX ?? "";

const BASE_CONFIG: Record<Pair, { symbol: string; pip: number; decimals: number }> = {
  "EUR/USD": { symbol: "EURUSD", pip: 0.0001, decimals: 5 },
  "GBP/USD": { symbol: "GBPUSD", pip: 0.0001, decimals: 5 },
  "USD/JPY": { symbol: "USDJPY", pip: 0.01, decimals: 3 },
  "AUD/USD": { symbol: "AUDUSD", pip: 0.0001, decimals: 5 },
  "USD/CAD": { symbol: "USDCAD", pip: 0.0001, decimals: 5 },
  // pip/decimals both confirmed directly from the broker's own symbol spec (not
  // guessed) — Exness quotes both metals to 3 digits with pipSize 0.01. The SL buffer
  // no longer scales off pip (see signalEngine.ts's ATR-relative buffer), so pip here
  // only feeds the sweep-tolerance and position-sizing math, where the broker's own
  // value is the right one to use rather than an artificial calibration.
  "XAU/USD": { symbol: "XAUUSD", pip: 0.01, decimals: 3 },
  "XAG/USD": { symbol: "XAGUSD", pip: 0.01, decimals: 3 },
};

const CONFIG: Record<Pair, PairConfig> = Object.fromEntries(
  Object.entries(BASE_CONFIG).map(([pair, cfg]) => [
    pair,
    { brokerSymbol: cfg.symbol + BROKER_SUFFIX, pip: cfg.pip, decimals: cfg.decimals },
  ])
) as Record<Pair, PairConfig>;

const BY_BROKER_SYMBOL: Map<string, Pair> = new Map(
  Object.entries(CONFIG).map(([pair, cfg]) => [cfg.brokerSymbol, pair as Pair])
);

export function brokerSymbol(pair: Pair): string {
  return CONFIG[pair].brokerSymbol;
}

export function pairForBrokerSymbol(symbol: string): Pair | undefined {
  return BY_BROKER_SYMBOL.get(symbol);
}

export function pipSize(pair: Pair): number {
  return CONFIG[pair].pip;
}

export function decimals(pair: Pair): number {
  return CONFIG[pair].decimals;
}
