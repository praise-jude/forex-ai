import { describe, expect, it } from "vitest";
import { pipValuePerLot } from "../pipValue";
import { priceStore } from "../priceStore";

describe("pipValuePerLot", () => {
  it("computes pip value directly for USD-quote pairs, no live price needed", () => {
    expect(pipValuePerLot("EUR/USD", 100000)).toBeCloseTo(10, 5);
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
