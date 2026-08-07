import { describe, expect, it } from "vitest";
import { parseTradingViewAlert } from "../tradingViewWebhook";

const NOW = 1_700_000_000_000; // fixed reference instant so age-based tests are deterministic

function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pair: "EURUSD",
    direction: "buy",
    entry: 1.085,
    stopLoss: 1.083,
    takeProfit: 1.089,
    id: "alert-123",
    timestamp: NOW / 1000, // seconds, matching TradingView's {{timenow}}
    ...overrides,
  };
}

describe("parseTradingViewAlert", () => {
  it("builds a valid tradingview-sourced signal from a well-formed payload", () => {
    const result = parseTradingViewAlert(buildPayload(), { now: NOW });
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
    const result = parseTradingViewAlert(buildPayload({ id: undefined }), { now: NOW });
    expect("error" in result).toBe(true);
  });

  it("rejects an unrecognized pair rather than guessing", () => {
    const result = parseTradingViewAlert(buildPayload({ pair: "DOGEUSD" }), { now: NOW });
    expect("error" in result).toBe(true);
  });

  it("maps an exchange-prefixed ticker correctly", () => {
    const result = parseTradingViewAlert(buildPayload({ pair: "OANDA:XAUUSD" }), { now: NOW });
    expect("signal" in result).toBe(true);
    if ("signal" in result) expect(result.signal.pair).toBe("XAU/USD");
  });

  it("rejects an invalid direction", () => {
    const result = parseTradingViewAlert(buildPayload({ direction: "hold" }), { now: NOW });
    expect("error" in result).toBe(true);
  });

  it("accepts long/short as direction aliases", () => {
    const result = parseTradingViewAlert(buildPayload({ direction: "short", stopLoss: 1.087, takeProfit: 1.081 }), {
      now: NOW,
    });
    expect("signal" in result).toBe(true);
    if ("signal" in result) expect(result.signal.direction).toBe("short");
  });

  it("rejects a long trade with stopLoss/takeProfit on the wrong side of entry", () => {
    const result = parseTradingViewAlert(buildPayload({ stopLoss: 1.087, takeProfit: 1.081 }), { now: NOW });
    expect("error" in result).toBe(true);
  });

  it("rejects a short trade with stopLoss/takeProfit on the wrong side of entry", () => {
    const result = parseTradingViewAlert(buildPayload({ direction: "sell", stopLoss: 1.083, takeProfit: 1.089 }), {
      now: NOW,
    });
    expect("error" in result).toBe(true);
  });

  it("respects an explicit takeProfit2", () => {
    const result = parseTradingViewAlert(buildPayload({ takeProfit2: 1.091 }), { now: NOW });
    expect("signal" in result).toBe(true);
    if ("signal" in result) expect(result.signal.takeProfit2).toBe(1.091);
  });

  it("rejects a payload missing timestamp", () => {
    const result = parseTradingViewAlert(buildPayload({ timestamp: undefined }), { now: NOW });
    expect("error" in result).toBe(true);
  });

  it("accepts an alert well within the default 60s max age", () => {
    const result = parseTradingViewAlert(buildPayload({ timestamp: (NOW - 30_000) / 1000 }), { now: NOW });
    expect("signal" in result).toBe(true);
  });

  it("rejects a stale alert older than the default 60s max age", () => {
    const result = parseTradingViewAlert(buildPayload({ timestamp: (NOW - 120_000) / 1000 }), { now: NOW });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/stale|clock-skewed/);
  });

  it("rejects a clock-skewed alert timestamped in the future", () => {
    const result = parseTradingViewAlert(buildPayload({ timestamp: (NOW + 120_000) / 1000 }), { now: NOW });
    expect("error" in result).toBe(true);
  });

  it("respects a custom maxAgeMs option", () => {
    const tooOld = parseTradingViewAlert(buildPayload({ timestamp: (NOW - 10_000) / 1000 }), {
      now: NOW,
      maxAgeMs: 5_000,
    });
    expect("error" in tooOld).toBe(true);

    const stillFresh = parseTradingViewAlert(buildPayload({ timestamp: (NOW - 3_000) / 1000 }), {
      now: NOW,
      maxAgeMs: 5_000,
    });
    expect("signal" in stillFresh).toBe(true);
  });

  it("auto-detects a millisecond-scale timestamp instead of treating it as seconds", () => {
    // NOW is already milliseconds; passed through as-is (not divided by 1000) it must
    // still be recognized as "now", not misread as a far-future/overflowing seconds value.
    const result = parseTradingViewAlert(buildPayload({ timestamp: NOW }), { now: NOW });
    expect("signal" in result).toBe(true);
  });
});
