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
  // Quoted to 2 decimals (e.g. 2350.45); pip is a calibration choice for the SL-buffer
  // and position-sizing math (see signalEngine.ts's SL_BUFFER_PIPS), not display
  // precision — 0.1 (common retail-platform convention for gold) keeps that buffer
  // proportional to gold's volatility instead of the ~$0.03 a naive 0.01 would give.
  "XAU/USD": { symbol: "XAUUSD", pip: 0.1, decimals: 2 },
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
