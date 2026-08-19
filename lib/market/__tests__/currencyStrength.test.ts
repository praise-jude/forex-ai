import { beforeEach, describe, expect, it } from "vitest";
import {
  computeUsdStrength,
  computeHistoricalUsdStrength,
  usdStrengthSupports,
  resetCurrencyStrengthForTests,
  setCurrencyStrengthStateForTests,
  type CurrencyStrengthSnapshot,
} from "../currencyStrength";
import type { Candle, Pair } from "../types";

function snapshot(atMs: number, rates: CurrencyStrengthSnapshot["rates"]): CurrencyStrengthSnapshot {
  return { atMs, rates };
}

const BASE_RATES: CurrencyStrengthSnapshot["rates"] = { EUR: 0.91, GBP: 0.77, JPY: 150, AUD: 1.5, CAD: 1.35, CHF: 0.88, NZD: 1.64 };

describe("computeUsdStrength", () => {
  beforeEach(() => {
    resetCurrencyStrengthForTests();
  });

  it("is unavailable when the cache has never been successfully populated", () => {
    expect(computeUsdStrength()).toEqual({ status: "unavailable" });
  });

  it("is unavailable after only a single poll (needs two snapshots to compare)", () => {
    setCurrencyStrengthStateForTests([snapshot(1000, BASE_RATES)], true);
    expect(computeUsdStrength()).toEqual({ status: "unavailable" });
  });

  it("is unavailable when the last poll failed, even with prior snapshots cached", () => {
    setCurrencyStrengthStateForTests([snapshot(1000, BASE_RATES), snapshot(2000, BASE_RATES)], false);
    expect(computeUsdStrength()).toEqual({ status: "unavailable" });
  });

  it("reports a positive (USD-strong) index when every USDxxx rate rises", () => {
    setCurrencyStrengthStateForTests(
      [
        snapshot(1000, BASE_RATES),
        snapshot(2000, { EUR: 0.92, GBP: 0.78, JPY: 151, AUD: 1.52, CAD: 1.36, CHF: 0.89, NZD: 1.66 }),
      ],
      true
    );
    const result = computeUsdStrength();
    expect(result.status).toBe("available");
    if (result.status === "available") expect(result.index).toBeGreaterThan(0);
  });

  it("reports a negative (USD-weak) index when every USDxxx rate falls", () => {
    setCurrencyStrengthStateForTests(
      [
        snapshot(1000, BASE_RATES),
        snapshot(2000, { EUR: 0.9, GBP: 0.76, JPY: 149, AUD: 1.48, CAD: 1.34, CHF: 0.87, NZD: 1.62 }),
      ],
      true
    );
    const result = computeUsdStrength();
    expect(result.status).toBe("available");
    if (result.status === "available") expect(result.index).toBeLessThan(0);
  });

  it("is unavailable if a tracked currency is missing from a snapshot", () => {
    const { JPY, ...missingJpy } = BASE_RATES;
    void JPY;
    setCurrencyStrengthStateForTests([snapshot(1000, missingJpy), snapshot(2000, BASE_RATES)], true);
    expect(computeUsdStrength()).toEqual({ status: "unavailable" });
  });
});

describe("usdStrengthSupports", () => {
  it("propagates unavailable data honestly rather than fabricating an answer", () => {
    expect(usdStrengthSupports({ status: "unavailable" }, "EUR/USD", "long")).toBe("unavailable");
  });

  it("a negligible index inside the deadband supports neither direction", () => {
    expect(usdStrengthSupports({ status: "available", index: 0.00001 }, "EUR/USD", "long")).toBe(false);
    expect(usdStrengthSupports({ status: "available", index: 0.00001 }, "EUR/USD", "short")).toBe(false);
  });

  it("USD-quote pair (EUR/USD): a BUY is supported by a weak-USD index", () => {
    expect(usdStrengthSupports({ status: "available", index: -0.01 }, "EUR/USD", "long")).toBe(true);
    expect(usdStrengthSupports({ status: "available", index: -0.01 }, "EUR/USD", "short")).toBe(false);
  });

  it("USD-quote pair: a SELL is supported by a strong-USD index", () => {
    expect(usdStrengthSupports({ status: "available", index: 0.01 }, "EUR/USD", "short")).toBe(true);
    expect(usdStrengthSupports({ status: "available", index: 0.01 }, "EUR/USD", "long")).toBe(false);
  });

  it("USD-base pair (USD/JPY): a BUY is supported by a strong-USD index", () => {
    expect(usdStrengthSupports({ status: "available", index: 0.01 }, "USD/JPY", "long")).toBe(true);
    expect(usdStrengthSupports({ status: "available", index: 0.01 }, "USD/JPY", "short")).toBe(false);
  });

  it("USD-base pair: a SELL is supported by a weak-USD index", () => {
    expect(usdStrengthSupports({ status: "available", index: -0.01 }, "USD/JPY", "short")).toBe(true);
    expect(usdStrengthSupports({ status: "available", index: -0.01 }, "USD/JPY", "long")).toBe(false);
  });

  it("USD-denominated non-FX instrument (XAU/USD) is treated like a USD-quote pair", () => {
    expect(usdStrengthSupports({ status: "available", index: -0.01 }, "XAU/USD", "long")).toBe(true);
    expect(usdStrengthSupports({ status: "available", index: 0.01 }, "XAU/USD", "long")).toBe(false);
  });

  it("a real USD-base pair added to the trades list (USD/CHF) behaves like USD/JPY, not the USD-quote fallback", () => {
    expect(usdStrengthSupports({ status: "available", index: 0.01 }, "USD/CHF", "long")).toBe(true);
    expect(usdStrengthSupports({ status: "available", index: 0.01 }, "USD/CHF", "short")).toBe(false);
  });

  it("EUR/JPY has no USD leg at all -- always unavailable, never silently reusing the USD-quote branch", () => {
    expect(usdStrengthSupports({ status: "available", index: 0.01 }, "EUR/JPY", "long")).toBe("unavailable");
    expect(usdStrengthSupports({ status: "available", index: -0.01 }, "EUR/JPY", "short")).toBe("unavailable");
    // Even a genuinely unavailable underlying index stays "unavailable" for EUR/JPY --
    // not two different codepaths landing on the same string by coincidence.
    expect(usdStrengthSupports({ status: "unavailable" }, "EUR/JPY", "long")).toBe("unavailable");
  });
});

describe("computeHistoricalUsdStrength", () => {
  // Matches the module's own REFRESH_INTERVAL_MS (12h) -- the lookback the historical
  // replay compares against, same cadence as the live snapshot-diff it mirrors.
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

  function series(points: { time: number; close: number }[]): Candle[] {
    return points.map(({ time, close }) => ({ time, open: close, high: close, low: close, close, tickVolume: 100 }));
  }

  // Every pair's own USDxxx rate moves exactly +1% between the two snapshots -- EUR/GBP/
  // AUD/NZD are USD-quote pairs (rate = 1/close, so close must FALL ~1% for the rate to
  // rise 1%), USD/JPY, USD/CAD, USD/CHF are USD-base pairs (rate = close directly, so
  // close itself rises 1%) -- mirrors USD_BASE_PAIRS' exact live distinction.
  const USD_UP_1PCT: Partial<Record<Pair, Candle[]>> = {
    "EUR/USD": series([{ time: 0, close: 1 }, { time: TWELVE_HOURS_MS, close: 1 / 1.01 }]),
    "GBP/USD": series([{ time: 0, close: 1 }, { time: TWELVE_HOURS_MS, close: 1 / 1.01 }]),
    "USD/JPY": series([{ time: 0, close: 100 }, { time: TWELVE_HOURS_MS, close: 101 }]),
    "AUD/USD": series([{ time: 0, close: 1 }, { time: TWELVE_HOURS_MS, close: 1 / 1.01 }]),
    "USD/CAD": series([{ time: 0, close: 100 }, { time: TWELVE_HOURS_MS, close: 101 }]),
    "USD/CHF": series([{ time: 0, close: 100 }, { time: TWELVE_HOURS_MS, close: 101 }]),
    "NZD/USD": series([{ time: 0, close: 1 }, { time: TWELVE_HOURS_MS, close: 1 / 1.01 }]),
  };

  it("computes a precise +1% USD-strong index from real historical closes (reciprocal and direct pairs both correct)", () => {
    const result = computeHistoricalUsdStrength(USD_UP_1PCT, TWELVE_HOURS_MS);
    expect(result.status).toBe("available");
    if (result.status === "available") expect(result.index).toBeCloseTo(0.01, 5);
  });

  it("reports a negative (USD-weak) index when the closes move the other way", () => {
    const usdDown: Partial<Record<Pair, Candle[]>> = {
      "EUR/USD": series([{ time: 0, close: 1 }, { time: TWELVE_HOURS_MS, close: 1 / 0.99 }]),
      "GBP/USD": series([{ time: 0, close: 1 }, { time: TWELVE_HOURS_MS, close: 1 / 0.99 }]),
      "USD/JPY": series([{ time: 0, close: 100 }, { time: TWELVE_HOURS_MS, close: 99 }]),
      "AUD/USD": series([{ time: 0, close: 1 }, { time: TWELVE_HOURS_MS, close: 1 / 0.99 }]),
      "USD/CAD": series([{ time: 0, close: 100 }, { time: TWELVE_HOURS_MS, close: 99 }]),
      "USD/CHF": series([{ time: 0, close: 100 }, { time: TWELVE_HOURS_MS, close: 99 }]),
      "NZD/USD": series([{ time: 0, close: 1 }, { time: TWELVE_HOURS_MS, close: 1 / 0.99 }]),
    };
    const result = computeHistoricalUsdStrength(usdDown, TWELVE_HOURS_MS);
    expect(result.status).toBe("available");
    if (result.status === "available") expect(result.index).toBeLessThan(0);
  });

  it("is unavailable when a tracked pair's series is entirely missing", () => {
    const { "USD/JPY": _jpy, ...missingJpy } = USD_UP_1PCT;
    void _jpy;
    expect(computeHistoricalUsdStrength(missingJpy, TWELVE_HOURS_MS)).toEqual({ status: "unavailable" });
  });

  it("is unavailable when there's no candle far enough back to compare against (early in a backtest window)", () => {
    // Only the single, most-recent snapshot exists -- nothing at atMs - 12h yet.
    const onlyLatest: Partial<Record<Pair, Candle[]>> = Object.fromEntries(
      Object.entries(USD_UP_1PCT).map(([pair, candles]) => [pair, [candles![1]]])
    );
    expect(computeHistoricalUsdStrength(onlyLatest, TWELVE_HOURS_MS)).toEqual({ status: "unavailable" });
  });

  it("picks the nearest at-or-before candle rather than requiring an exact 12h-boundary match", () => {
    // Extra bars scattered in between the two real comparison points -- the nearest
    // at-or-before search must still land on the same two real data points.
    const irregular: Partial<Record<Pair, Candle[]>> = {
      "EUR/USD": series([
        { time: -1000, close: 1.5 }, // decoy, before the window entirely
        { time: 0, close: 1 },
        { time: 4 * 60 * 60 * 1000, close: 1.02 }, // decoy, between the two reference points
        { time: TWELVE_HOURS_MS, close: 1 / 1.01 },
        { time: TWELVE_HOURS_MS + 1000, close: 1.3 }, // decoy, after atMs
      ]),
      "GBP/USD": USD_UP_1PCT["GBP/USD"]!,
      "USD/JPY": USD_UP_1PCT["USD/JPY"]!,
      "AUD/USD": USD_UP_1PCT["AUD/USD"]!,
      "USD/CAD": USD_UP_1PCT["USD/CAD"]!,
      "USD/CHF": USD_UP_1PCT["USD/CHF"]!,
      "NZD/USD": USD_UP_1PCT["NZD/USD"]!,
    };
    const result = computeHistoricalUsdStrength(irregular, TWELVE_HOURS_MS);
    expect(result.status).toBe("available");
    if (result.status === "available") expect(result.index).toBeCloseTo(0.01, 5);
  });
});
