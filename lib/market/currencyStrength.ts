import type { Pair } from "./types";

const CURRENCYLAYER_URL = "http://apilayer.net/api/live";
// Free-tier currencylayer accounts are typically capped around 100-250 requests/month.
// Polling every 12h is 2 requests/day (~60/month) -- well inside that budget while still
// refreshing often enough that a currency-strength lean reflects the current day, not a
// stale one (strength trends this app cares about persist over many hours, not minutes).
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const TRACKED_CURRENCIES = ["EUR", "GBP", "JPY", "AUD", "CAD"] as const;
const USD_BASE_PAIRS: ReadonlySet<Pair> = new Set(["USD/JPY", "USD/CAD"]);
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
 * 5 tracked majors -- not a true 8-currency cross-pair meter (this app doesn't track
 * CHF/NZD pairs at all), just USD's aggregate lean against the 5 majors it does trade.
 * Computed as the average % change in each currency's USDxxx rate between the two most
 * recent polls -- never fabricated: "unavailable" until at least two successful polls
 * have landed (immediately after boot, or if the API key/plan stops working).
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
