import { beforeEach, describe, expect, it } from "vitest";
import {
  computeUsdStrength,
  usdStrengthSupports,
  resetCurrencyStrengthForTests,
  setCurrencyStrengthStateForTests,
  type CurrencyStrengthSnapshot,
} from "../currencyStrength";

function snapshot(atMs: number, rates: CurrencyStrengthSnapshot["rates"]): CurrencyStrengthSnapshot {
  return { atMs, rates };
}

const BASE_RATES: CurrencyStrengthSnapshot["rates"] = { EUR: 0.91, GBP: 0.77, JPY: 150, AUD: 1.5, CAD: 1.35 };

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
        snapshot(2000, { EUR: 0.92, GBP: 0.78, JPY: 151, AUD: 1.52, CAD: 1.36 }),
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
        snapshot(2000, { EUR: 0.9, GBP: 0.76, JPY: 149, AUD: 1.48, CAD: 1.34 }),
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
});
