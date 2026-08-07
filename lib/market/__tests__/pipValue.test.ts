import { describe, expect, it } from "vitest";
import { pipValuePerLot } from "../pipValue";
import { priceStore } from "../priceStore";

describe("pipValuePerLot", () => {
  it("computes pip value directly for USD-quote pairs, no live price needed", () => {
    expect(pipValuePerLot("EUR/USD", 100000)).toBeCloseTo(10, 5);
  });

  it("computes pip value directly for gold, same USD-quote shape as forex majors", () => {
    // XAU/USD quotes directly in USD (same structural shape as EUR/USD) -- pip 0.01 *
    // a 100oz contract = $1 per pip per lot, no currency conversion needed.
    expect(pipValuePerLot("XAU/USD", 100)).toBeCloseTo(1, 5);
  });

  it("computes pip value directly for silver, same USD-quote shape as forex majors", () => {
    // XAG/USD quotes directly in USD -- pip 0.01 * a 5000oz contract = $50 per pip per lot.
    expect(pipValuePerLot("XAG/USD", 5000)).toBeCloseTo(50, 5);
  });

  it("computes pip value directly for oil, same USD-quote shape as forex majors", () => {
    // USOIL quotes directly in USD -- pip 1 * a 1000-barrel contract = $1000 per pip per lot.
    expect(pipValuePerLot("USOIL", 1000)).toBeCloseTo(1000, 5);
  });

  it("computes pip value directly for crypto, same USD-quote shape as forex majors", () => {
    // BTC/USD quotes directly in USD -- pip 0.01 * a 1-BTC contract = $0.01 per pip per lot.
    expect(pipValuePerLot("BTC/USD", 1)).toBeCloseTo(0.01, 5);
  });

  it("converts through the live price for USD-base pairs", () => {
    priceStore.set({ pair: "USD/JPY", bid: 149.0, ask: 149.02, time: Date.now() });
    // pip size 0.01 * contractSize 100000 = 1000 JPY per pip per lot; mid price 149.01
    expect(pipValuePerLot("USD/JPY", 100000)).toBeCloseTo(1000 / 149.01, 5);
  });

  it("returns undefined for a USD-base pair with no live price yet", () => {
    expect(pipValuePerLot("USD/CAD", 100000)).toBeUndefined();
  });
});
