import { describe, expect, it } from "vitest";
import { parseTradingViewAlert } from "../tradingViewWebhook";

function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pair: "EURUSD",
    direction: "buy",
    entry: 1.085,
    stopLoss: 1.083,
    takeProfit: 1.089,
    id: "alert-123",
    ...overrides,
  };
}

describe("parseTradingViewAlert", () => {
  it("builds a valid tradingview-sourced signal from a well-formed payload", () => {
    const result = parseTradingViewAlert(buildPayload());
    expect("signal" in result).toBe(true);
    if (!("signal" in result)) throw new Error("expected a signal");

    expect(result.signal.id).toBe("tv-alert-123");
    expect(result.signal.source).toBe("tradingview");
    expect(result.signal.pair).toBe("EUR/USD");
    expect(result.signal.direction).toBe("long");
    expect(result.signal.tier).toBe("buy"); // never "watch" -- would trip the execution guard
    expect(result.signal.confluences).toEqual([]);
    expect(result.signal.takeProfit2).toBe(1.089); // defaults to takeProfit when omitted
  });

  it("rejects a payload missing id (idempotency would be lost)", () => {
    const result = parseTradingViewAlert(buildPayload({ id: undefined }));
    expect("error" in result).toBe(true);
  });

  it("rejects an unrecognized pair rather than guessing", () => {
    const result = parseTradingViewAlert(buildPayload({ pair: "DOGEUSD" }));
    expect("error" in result).toBe(true);
  });

  it("maps an exchange-prefixed ticker correctly", () => {
    const result = parseTradingViewAlert(buildPayload({ pair: "OANDA:XAUUSD" }));
    expect("signal" in result).toBe(true);
    if ("signal" in result) expect(result.signal.pair).toBe("XAU/USD");
  });

  it("rejects an invalid direction", () => {
    const result = parseTradingViewAlert(buildPayload({ direction: "hold" }));
    expect("error" in result).toBe(true);
  });

  it("accepts long/short as direction aliases", () => {
    const result = parseTradingViewAlert(buildPayload({ direction: "short", stopLoss: 1.087, takeProfit: 1.081 }));
    expect("signal" in result).toBe(true);
    if ("signal" in result) expect(result.signal.direction).toBe("short");
  });

  it("rejects a long trade with stopLoss/takeProfit on the wrong side of entry", () => {
    const result = parseTradingViewAlert(buildPayload({ stopLoss: 1.087, takeProfit: 1.081 }));
    expect("error" in result).toBe(true);
  });

  it("rejects a short trade with stopLoss/takeProfit on the wrong side of entry", () => {
    const result = parseTradingViewAlert(buildPayload({ direction: "sell", stopLoss: 1.083, takeProfit: 1.089 }));
    expect("error" in result).toBe(true);
  });

  it("respects an explicit takeProfit2", () => {
    const result = parseTradingViewAlert(buildPayload({ takeProfit2: 1.091 }));
    expect("signal" in result).toBe(true);
    if ("signal" in result) expect(result.signal.takeProfit2).toBe(1.091);
  });
});
