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
  // pip/decimals all confirmed directly from each broker symbol's own spec (not
  // guessed). Neither the SL buffer nor the sweep tolerance scale off pip anymore
  // (see signalEngine.ts's ATR-relative versions of both) — pip here only feeds
  // position sizing, where it's dimensionally self-cancelling, so the broker's own
  // value is the right one to use rather than an artificial calibration.
  "XAU/USD": { symbol: "XAUUSD", pip: 0.01, decimals: 3 },
  "XAG/USD": { symbol: "XAGUSD", pip: 0.01, decimals: 3 },
  "USOIL": { symbol: "USOIL", pip: 1, decimals: 3 },
  "UKOIL": { symbol: "UKOIL", pip: 1, decimals: 3 },
  "BTC/USD": { symbol: "BTCUSD", pip: 0.01, decimals: 2 },
  // Confirmed against a real getSymbolSpecification call on this account's own
  // USDCHFm/NZDUSDm/EURJPYm symbols, same discipline as every other row above.
  "USD/CHF": { symbol: "USDCHF", pip: 0.0001, decimals: 5 },
  "NZD/USD": { symbol: "NZDUSD", pip: 0.0001, decimals: 5 },
  "EUR/JPY": { symbol: "EURJPY", pip: 0.01, decimals: 3 },
  // Confirmed against a real getSymbolSpecification call on this account's own
  // AUDJPYm symbol (digits: 3, pipSize: 0.01), same discipline as every other row above.
  "AUD/JPY": { symbol: "AUDJPY", pip: 0.01, decimals: 3 },
  // Confirmed against a real getSymbolSpecification call on this account's own
  // ETHUSDm symbol (digits: 2, pipSize: 0.01) -- identical shape to BTC/USD above.
  "ETH/USD": { symbol: "ETHUSD", pip: 0.01, decimals: 2 },
  // Confirmed against a real getSymbolSpecification call on this account's own
  // NFLXm/MSFTm/SPCXm symbols: pipSize 1, digits 2, point 0.01 for all three.
  NFLX: { symbol: "NFLX", pip: 1, decimals: 2 },
  MSFT: { symbol: "MSFT", pip: 1, decimals: 2 },
  SPCX: { symbol: "SPCX", pip: 1, decimals: 2 },
};

// Crypto trades 24/7 with no ICT-style institutional session structure the killzone
// concept (see sessions.ts) was built around — signalEngine.ts exempts these pairs
// from that gate rather than arbitrarily restricting them to forex trading hours.
const CRYPTO_PAIRS: ReadonlySet<Pair> = new Set(["BTC/USD", "ETH/USD"]);

export function isCrypto(pair: Pair): boolean {
  return CRYPTO_PAIRS.has(pair);
}

// Individual stocks trade on their own daily window (confirmed via real
// quoteSessions/tradeSessions data: NFLX/MSFT ~10:00-19:44, SPCX ~08:01-23:58, both
// Mon-Fri only) -- neither the forex killzone window nor crypto's 24/7 pattern. Rather
// than hardcoding a converted UTC window here (broker "server time" commonly drifts on
// its own DST schedule through the year, so a conversion verified today isn't
// guaranteed to stay correct), signalEngine.ts exempts these from the killzone gate the
// same way crypto is exempted: the real candle stream itself only ever produces bars
// during actual trading hours (brokers don't backfill closed-market candles), so both
// live (candle-close events) and backtest (iterating the real fetched array) already
// naturally enforce real hours with zero special-casing -- see
// backtestEngine.ts's own comment on this.
const STOCK_PAIRS: ReadonlySet<Pair> = new Set(["NFLX", "MSFT", "SPCX"]);

export function isStock(pair: Pair): boolean {
  return STOCK_PAIRS.has(pair);
}

// Oil (USOIL/UKOIL) is a USD-quoted commodity that trends through Asia and the full US
// session, not a forex pair -- unlike the FX majors, its move isn't concentrated in the
// London/NY overlap. signalEngine.ts exempts it from the killzone gate for the same
// structural reason it exempts crypto and stocks (see its own comment): restricting a
// 23-hour commodity to a 5-hour forex window would suppress the majority of its real
// setups. This is what "USOIL as a priority instrument" concretely means in the engine.
const COMMODITY_PAIRS: ReadonlySet<Pair> = new Set(["USOIL", "UKOIL"]);

export function isCommodity(pair: Pair): boolean {
  return COMMODITY_PAIRS.has(pair);
}

const BY_PLAIN_SYMBOL: Map<string, Pair> = new Map(
  Object.entries(BASE_CONFIG).map(([pair, cfg]) => [cfg.symbol, pair as Pair])
);

/**
 * Maps an external, unsuffixed ticker (e.g. a TradingView alert's "OANDA:XAUUSD" or
 * "EURUSD") to a Pair, reusing BASE_CONFIG as the single source of truth rather than a
 * second hand-maintained table. Strips a leading "EXCHANGE:" prefix and any "/", then
 * matches case-insensitively. Returns undefined for anything unrecognized -- callers
 * must reject rather than guess a pair for money-moving input.
 */
export function pairForPlainSymbol(symbol: string): Pair | undefined {
  const normalized = symbol
    .trim()
    .toUpperCase()
    .replace(/^[A-Z_]+:/, "")
    .replace(/\//g, "");
  return BY_PLAIN_SYMBOL.get(normalized);
}

// Every Pair the type union has ever named, not just today's watched PAIRS -- see
// metaApiConnection.ts's stale-subscription cleanup, which needs the FULL historical
// set (including pairs that were once widened-to and later reverted, e.g. XAG/USD,
// ETH/USD) to explicitly unsubscribe them, regardless of whether this session's own
// client-side subscription cache happens to know about them.
export const ALL_PAIRS: Pair[] = Object.keys(BASE_CONFIG) as Pair[];

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
