import { describe, expect, it } from "vitest";
import { isCorrelated } from "../pairCorrelation";

describe("isCorrelated", () => {
  it("flags two USD-quote majors long together as correlated (both short USD)", () => {
    expect(isCorrelated("EUR/USD", "long", "GBP/USD", "long")).toBe(true);
  });

  it("flags two USD-quote majors short together as correlated (both long USD)", () => {
    expect(isCorrelated("EUR/USD", "short", "AUD/USD", "short")).toBe(true);
  });

  it("does not flag opposite-direction USD-quote majors as correlated", () => {
    expect(isCorrelated("EUR/USD", "long", "GBP/USD", "short")).toBe(false);
  });

  it("flags a USD-quote pair long and a USD-base pair short as correlated (both short USD)", () => {
    // EUR/USD long = short USD. USD/CAD short = short USD too (going short USD/CAD bets USD weakens).
    expect(isCorrelated("EUR/USD", "long", "USD/CAD", "short")).toBe(true);
  });

  it("does not flag a USD-quote pair long and a USD-base pair long as correlated (opposite USD bets)", () => {
    // EUR/USD long = short USD. USD/CAD long = long USD -- opposite bets on USD itself.
    expect(isCorrelated("EUR/USD", "long", "USD/CAD", "long")).toBe(false);
  });

  it("flags two USD-base majors long together as correlated (both long USD)", () => {
    expect(isCorrelated("USD/CAD", "long", "USD/JPY", "long")).toBe(true);
  });

  it("flags precious metals in the same direction as correlated", () => {
    expect(isCorrelated("XAU/USD", "long", "XAG/USD", "long")).toBe(true);
    expect(isCorrelated("XAU/USD", "short", "XAG/USD", "short")).toBe(true);
  });

  it("does not flag precious metals in opposite directions as correlated", () => {
    expect(isCorrelated("XAU/USD", "long", "XAG/USD", "short")).toBe(false);
  });

  it("flags oil pairs in the same direction as correlated", () => {
    expect(isCorrelated("USOIL", "long", "UKOIL", "long")).toBe(true);
  });

  it("does not cross-correlate metals with oil", () => {
    expect(isCorrelated("XAU/USD", "long", "USOIL", "long")).toBe(false);
  });

  it("does not correlate a forex major with a commodity", () => {
    expect(isCorrelated("EUR/USD", "long", "XAU/USD", "long")).toBe(false);
  });

  it("never correlates BTC/USD with anything, including itself in either direction", () => {
    expect(isCorrelated("BTC/USD", "long", "EUR/USD", "long")).toBe(false);
    expect(isCorrelated("BTC/USD", "long", "BTC/USD", "long")).toBe(false);
    expect(isCorrelated("BTC/USD", "short", "XAU/USD", "short")).toBe(false);
  });

  it("is symmetric", () => {
    expect(isCorrelated("EUR/USD", "long", "GBP/USD", "long")).toBe(isCorrelated("GBP/USD", "long", "EUR/USD", "long"));
  });

  it("USD/CHF behaves as a USD-base major, like USD/CAD and USD/JPY", () => {
    expect(isCorrelated("USD/CHF", "long", "USD/JPY", "long")).toBe(true);
    expect(isCorrelated("USD/CHF", "long", "EUR/USD", "short")).toBe(true); // both long USD
    expect(isCorrelated("USD/CHF", "long", "EUR/USD", "long")).toBe(false); // opposite USD bets
  });

  it("NZD/USD behaves as a USD-quote major, like EUR/USD and GBP/USD", () => {
    expect(isCorrelated("NZD/USD", "long", "EUR/USD", "long")).toBe(true);
    expect(isCorrelated("NZD/USD", "long", "USD/CAD", "short")).toBe(true); // both short USD
  });

  it("EUR/JPY has no USD leg, so the static model has nothing to say about it either way -- a documented gap the real rolling correlation matrix (rollingCorrelation.ts) backstops instead", () => {
    expect(isCorrelated("EUR/JPY", "long", "EUR/USD", "long")).toBe(false);
    expect(isCorrelated("EUR/JPY", "long", "USD/JPY", "long")).toBe(false);
  });
});
