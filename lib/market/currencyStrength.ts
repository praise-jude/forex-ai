import type { Candle, Pair } from "./types";

const CURRENCYLAYER_URL = "http://apilayer.net/api/live";
// Free-tier currencylayer accounts are typically capped around 100-250 requests/month.
// Polling every 12h is 2 requests/day (~60/month) -- well inside that budget while still
// refreshing often enough that a currency-strength lean reflects the current day, not a
// stale one (strength trends this app cares about persist over many hours, not minutes).
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const TRACKED_CURRENCIES = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"] as const;
const USD_BASE_PAIRS: ReadonlySet<Pair> = new Set(["USD/JPY", "USD/CAD", "USD/CHF"]);
// Pairs with no USD leg at all -- EUR/JPY is EUR vs JPY, USD isn't in it either way.
// USD strength is genuinely inapplicable here (not merely "weakly correlated" the way
// gold/oil/crypto's own USD-quote fallback is), so usdStrengthSupports reports
// "unavailable" honestly for these rather than silently reusing the USD-quote branch's
// logic on a pair that was never a USD pair to begin with.
const NOT_A_USD_PAIR: ReadonlySet<Pair> = new Set(["EUR/JPY"]);
// A move smaller than this (as a fraction, e.g. 0.0005 = 0.05%) between polls is too
// small to call a meaningful directional lean either way -- avoids treating quote noise
// as a confirmed currency-strength signal.
const NEUTRAL_DEADBAND = 0.0005;

export type UsdStrength = { status: "available"; index: number } | { status: "unavailable" };

export interface CurrencyStrengthSnapshot {
  atMs: number;
  /** currencylayer quotes with source=USD, keyed by currency code -- e.g. rates.EUR is
   * "how many EUR per 1 USD", so a RISING rate always means USD getting stronger against
   * that currency, for every tracked currency uniformly (no per-pair inversion needed
   * here -- that only matters later, in usdStrengthSupports, which maps this index onto
   * a specific pair's own quoting convention). */
  rates: Partial<Record<(typeof TRACKED_CURRENCIES)[number], number>>;
}

interface CacheState {
  /** Oldest-first, capped at 2 entries -- only ever compares the latest poll against the
   * one immediately before it. */
  snapshots: CurrencyStrengthSnapshot[];
  lastFetchOk: boolean | null;
  started: boolean;
}

const globalKey = Symbol.for("forex-ai.currencyStrengthCache");
type GlobalWithCache = typeof globalThis & { [globalKey]?: CacheState };
const g = globalThis as GlobalWithCache;
const state: CacheState = g[globalKey] ?? (g[globalKey] = { snapshots: [], lastFetchOk: null, started: false });

async function refreshOnce(): Promise<void> {
  const apiKey = process.env.CURRENCYLAYER_API_KEY;
  if (!apiKey) {
    state.lastFetchOk = false;
    return;
  }

  try {
    const url = `${CURRENCYLAYER_URL}?access_key=${apiKey}&currencies=${TRACKED_CURRENCIES.join(",")}&source=USD&format=1`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[currencyStrength] currencylayer request failed (${response.status}): ${await response.text().catch(() => "")}`);
      state.lastFetchOk = false;
      return;
    }
    const json = (await response.json()) as { success?: boolean; quotes?: Record<string, number> };
    if (json.success !== true || typeof json.quotes !== "object" || json.quotes === null) {
      console.error("[currencyStrength] currencylayer response missing quotes:", JSON.stringify(json));
      state.lastFetchOk = false;
      return;
    }

    const rates: CurrencyStrengthSnapshot["rates"] = {};
    for (const currency of TRACKED_CURRENCIES) {
      const value = json.quotes[`USD${currency}`];
      if (typeof value === "number" && Number.isFinite(value)) rates[currency] = value;
    }
    if (Object.keys(rates).length !== TRACKED_CURRENCIES.length) {
      state.lastFetchOk = false;
      return;
    }

    state.snapshots.push({ atMs: Date.now(), rates });
    if (state.snapshots.length > 2) state.snapshots.shift();
    state.lastFetchOk = true;
  } catch (error) {
    console.error("[currencyStrength] currencylayer request failed:", error);
    state.lastFetchOk = false;
  }
}

/** Called once from bootstrap.ts, mirroring newsFilter.ts's own fetch-then-interval
 * pattern. Never awaited by evaluateSignal -- computeUsdStrength() below always reads
 * the already-populated cache synchronously. */
export function startCurrencyStrength(): void {
  if (state.started) return;
  state.started = true;
  void refreshOnce();
  setInterval(() => void refreshOnce(), REFRESH_INTERVAL_MS);
}

/**
 * A USD strength index derived from real currencylayer.com FX rates (source=USD) across
 * the 7 tracked majors -- USD's aggregate lean against every currency this app trades a
 * direct USD pair for (EUR/JPY is the one traded pair with no USD leg at all, and is
 * excluded from usdStrengthSupports entirely rather than folded into this basket -- see
 * NOT_A_USD_PAIR). Computed as the average % change in each currency's USDxxx rate
 * between the two most recent polls -- never fabricated: "unavailable" until at least
 * two successful polls have landed (immediately after boot, or if the API key/plan
 * stops working).
 */
export function computeUsdStrength(): UsdStrength {
  if (state.lastFetchOk !== true || state.snapshots.length < 2) return { status: "unavailable" };

  const [previous, latest] = state.snapshots;
  const moves: number[] = [];
  for (const currency of TRACKED_CURRENCIES) {
    const prevRate = previous.rates[currency];
    const latestRate = latest.rates[currency];
    if (!prevRate || !latestRate) return { status: "unavailable" };
    moves.push((latestRate - prevRate) / prevRate);
  }

  const index = moves.reduce((sum, m) => sum + m, 0) / moves.length;
  return { status: "available", index };
}

/**
 * Whether the USD strength index supports a BUY/SELL on `pair`. "unavailable" only
 * propagates from the underlying data itself being unavailable (never fabricated) -- a
 * computed-but-negligible index inside the deadband is a real answer, `false` (does not
 * support either direction), not "unavailable". Unchanged by the currencylayer swap --
 * only consumes the UsdStrength result type, not its data source.
 */
export function usdStrengthSupports(strength: UsdStrength, pair: Pair, direction: "long" | "short"): boolean | "unavailable" {
  if (strength.status === "unavailable") return "unavailable";
  if (NOT_A_USD_PAIR.has(pair)) return "unavailable";
  if (Math.abs(strength.index) < NEUTRAL_DEADBAND) return false;

  const usdIsBase = USD_BASE_PAIRS.has(pair);
  const usdStrong = strength.index > 0;
  // USD-base pair (e.g. USD/JPY): BUY wants USD strong. USD-quote pair (e.g. EUR/USD)
  // or a USD-denominated non-FX instrument (XAU/USD, USOIL, BTC/USD, ...): BUY wants
  // USD weak, mirroring the standard inverse dollar correlation these assets tend to
  // show -- an approximation for gold/oil/crypto, not a guarantee; their own supply and
  // demand dynamics matter too.
  const buySupportedByUsd = usdIsBase ? usdStrong : !usdStrong;
  return direction === "long" ? buySupportedByUsd : !buySupportedByUsd;
}

/** Debug snapshot for /api/health -- reports presence/health, never a secret value
 * itself (same convention as getConnectionStatus in metaApiConnection.ts). */
export function currencyStrengthStatus(): {
  configured: boolean;
  lastFetchOk: boolean | null;
  snapshotCount: number;
} {
  return {
    configured: Boolean(process.env.CURRENCYLAYER_API_KEY),
    lastFetchOk: state.lastFetchOk,
    snapshotCount: state.snapshots.length,
  };
}

const STRENGTH_TRACKING_PAIRS: Record<(typeof TRACKED_CURRENCIES)[number], Pair> = {
  EUR: "EUR/USD",
  GBP: "GBP/USD",
  JPY: "USD/JPY",
  AUD: "AUD/USD",
  CAD: "USD/CAD",
  CHF: "USD/CHF",
  NZD: "NZD/USD",
};

/** Index of the last candle at or before `atMs`, or -1 if none qualify -- `series` must
 * be time-ascending (see loadHistoricalRange's own contract). Binary search since this
 * runs once per tracked currency for every replayed bar across a backtest's full candle
 * count. */
function lastAtOrBefore(series: Candle[], atMs: number): number {
  let lo = 0;
  let hi = series.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].time <= atMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/** A currency's real USDxxx rate from its own tracked pair's close -- mirrors
 * USD_BASE_PAIRS' existing live distinction: USD/JPY and USD/CAD quote USD as the base,
 * so their own close IS the USDxxx rate directly; the rest quote USD as the counter, so
 * the rate is the close's reciprocal. */
function usdRateFromClose(pair: Pair, close: number): number {
  return USD_BASE_PAIRS.has(pair) ? close : 1 / close;
}

/**
 * Historical-replay counterpart to computeUsdStrength -- identical %-change-of-a-5-
 * currency-basket math, but reading two real historical closes (REFRESH_INTERVAL_MS
 * apart, matching the live cache's own poll cadence) from supplied candle series
 * instead of the live currencylayer cache. Used only by the backtester (see
 * backtestEngine.ts's currencyStrengthCloses) -- computeUsdStrength itself, and every
 * live call site, is untouched.
 */
export function computeHistoricalUsdStrength(closesByPair: Partial<Record<Pair, Candle[]>>, atTimeMs: number): UsdStrength {
  const moves: number[] = [];
  for (const currency of TRACKED_CURRENCIES) {
    const pair = STRENGTH_TRACKING_PAIRS[currency];
    const series = closesByPair[pair];
    if (!series || series.length === 0) return { status: "unavailable" };

    const latestIndex = lastAtOrBefore(series, atTimeMs);
    const previousIndex = lastAtOrBefore(series, atTimeMs - REFRESH_INTERVAL_MS);
    if (latestIndex === -1 || previousIndex === -1 || previousIndex === latestIndex) return { status: "unavailable" };

    const prevRate = usdRateFromClose(pair, series[previousIndex].close);
    const latestRate = usdRateFromClose(pair, series[latestIndex].close);
    moves.push((latestRate - prevRate) / prevRate);
  }

  const index = moves.reduce((sum, m) => sum + m, 0) / moves.length;
  return { status: "available", index };
}

/** Used by tests to reset cache state between cases. */
export function resetCurrencyStrengthForTests(): void {
  state.snapshots = [];
  state.lastFetchOk = null;
  state.started = false;
}

/** Used by tests to seed the cache directly, bypassing the network fetch --
 * computeUsdStrength()'s snapshot-comparison logic is what's under test, not
 * currencylayer connectivity itself. */
export function setCurrencyStrengthStateForTests(snapshots: CurrencyStrengthSnapshot[], lastFetchOk: boolean): void {
  state.snapshots = snapshots;
  state.lastFetchOk = lastFetchOk;
}
