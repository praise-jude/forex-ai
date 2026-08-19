import { describe, expect, it } from "vitest";
import { pairForPlainSymbol } from "../symbols";

describe("pairForPlainSymbol", () => {
  it("matches a plain symbol", () => {
    expect(pairForPlainSymbol("EURUSD")).toBe("EUR/USD");
  });

  it("matches with an exchange prefix stripped", () => {
    expect(pairForPlainSymbol("OANDA:XAUUSD")).toBe("XAU/USD");
    expect(pairForPlainSymbol("FX:GBPUSD")).toBe("GBP/USD");
  });

  it("matches lowercase input", () => {
    expect(pairForPlainSymbol("btcusd")).toBe("BTC/USD");
  });

  it("matches a slash-containing ticker", () => {
    expect(pairForPlainSymbol("EUR/USD")).toBe("EUR/USD");
  });

  it("matches a single-word symbol like USOIL unchanged", () => {
    expect(pairForPlainSymbol("USOIL")).toBe("USOIL");
  });

  it("returns undefined for an unrecognized symbol", () => {
    expect(pairForPlainSymbol("DOGEUSD")).toBeUndefined();
  });

  it("matches the newly-added pairs", () => {
    expect(pairForPlainSymbol("USDCHF")).toBe("USD/CHF");
    expect(pairForPlainSymbol("NZDUSD")).toBe("NZD/USD");
    expect(pairForPlainSymbol("EURJPY")).toBe("EUR/JPY");
  });
});
