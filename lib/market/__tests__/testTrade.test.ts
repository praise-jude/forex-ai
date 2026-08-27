import { describe, expect, it } from "vitest";
import { buildManualTestSignal } from "../testTrade";
import type { Candle, Price } from "../types";

const STEP = 15 * 60 * 1000;

function buildCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const price = 1.1 + (i % 2 === 0 ? 0.0006 : -0.0006);
    candles.push({ time: t, open: price, high: price + 0.0008, low: price - 0.0008, close: price, tickVolume: 100 });
    t += STEP;
  }
  return candles;
}

const PRICE: Price = { pair: "EUR/USD", bid: 1.1001, ask: 1.1003, time: Date.now() };

describe("buildManualTestSignal", () => {
  it("builds a long signal priced off the live ask, with SL below and TP above entry", () => {
    const result = buildManualTestSignal("EUR/USD", "long", "15m", buildCandles(30), PRICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { signal } = result;
    expect(signal.source).toBe("manual_test");
    expect(signal.entry).toBe(PRICE.ask);
    expect(signal.stopLoss).toBeLessThan(signal.entry);
    expect(signal.takeProfit).toBeGreaterThan(signal.entry);
    expect(signal.tier).toBe("buy");
    expect(signal.riskReward).toBeGreaterThan(1.2);
  });

  it("builds a short signal priced off the live bid, with SL above and TP below entry", () => {
    const result = buildManualTestSignal("EUR/USD", "short", "15m", buildCandles(30), PRICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { signal } = result;
    expect(signal.entry).toBe(PRICE.bid);
    expect(signal.stopLoss).toBeGreaterThan(signal.entry);
    expect(signal.takeProfit).toBeLessThan(signal.entry);
  });

  it("fails cleanly with no live price yet", () => {
    const result = buildManualTestSignal("EUR/USD", "long", "15m", buildCandles(30), undefined);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("no live price") });
  });

  it("fails cleanly with not enough candle history yet", () => {
    const result = buildManualTestSignal("EUR/USD", "long", "15m", buildCandles(5), PRICE);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("not enough candle history") });
  });

  it("never fabricates a confidence score -- it's honestly 0, not a real setup", () => {
    const result = buildManualTestSignal("EUR/USD", "long", "15m", buildCandles(30), PRICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signal.confidence).toBe(0);
    expect(result.signal.confluences).toEqual([]);
  });
});
