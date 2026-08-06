import { beforeEach, describe, expect, it } from "vitest";
import { candleStore } from "../candleStore";
import type { Candle } from "../types";

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close, low: close, close, tickVolume: 1 };
}

function isStrictlyAscending(candles: Candle[]): boolean {
  return candles.every((c, i) => i === 0 || c.time > candles[i - 1].time);
}

const PAIR = "EUR/USD";
const TF = "15m";

describe("candleStore", () => {
  beforeEach(() => {
    // Fresh state per test via seed (overwrites whatever the singleton had).
    candleStore.seed(PAIR, TF, []);
  });

  it("appends a genuinely new bar (time > last)", () => {
    candleStore.upsert(PAIR, TF, candle(1000, 1.1));
    candleStore.upsert(PAIR, TF, candle(2000, 1.2));
    expect(candleStore.get(PAIR, TF)).toEqual([candle(1000, 1.1), candle(2000, 1.2)]);
  });

  it("updates the last bar in place on repeat ticks (time === last)", () => {
    candleStore.upsert(PAIR, TF, candle(1000, 1.1));
    candleStore.upsert(PAIR, TF, candle(1000, 1.15));
    candleStore.upsert(PAIR, TF, candle(1000, 1.12));
    expect(candleStore.get(PAIR, TF)).toEqual([candle(1000, 1.12)]);
  });

  it("corrects an earlier bar in place when a late update arrives after the next bar has already started", () => {
    // This is exactly the bug: bar at 1000 closes, bar at 2000 starts forming, then a
    // late "final" update for bar 1000 arrives after bar 2000 already exists.
    candleStore.upsert(PAIR, TF, candle(1000, 1.1)); // bar 1000 forming
    candleStore.upsert(PAIR, TF, candle(2000, 1.3)); // bar 2000 starts -> 1000 is "closed"
    candleStore.upsert(PAIR, TF, candle(1000, 1.19)); // late final tick for bar 1000

    const result = candleStore.get(PAIR, TF);
    expect(result).toEqual([candle(1000, 1.19), candle(2000, 1.3)]);
    expect(isStrictlyAscending(result)).toBe(true);
  });

  it("drops a late update for a bar that's no longer present rather than inserting it out of order", () => {
    candleStore.upsert(PAIR, TF, candle(1000, 1.1));
    candleStore.upsert(PAIR, TF, candle(2000, 1.2));
    candleStore.upsert(PAIR, TF, candle(500, 0.9)); // older than anything we have, no match

    const result = candleStore.get(PAIR, TF);
    expect(result).toEqual([candle(1000, 1.1), candle(2000, 1.2)]);
    expect(isStrictlyAscending(result)).toBe(true);
  });

  it("seed() sorts and deduplicates by time, keeping the last occurrence", () => {
    candleStore.seed(PAIR, TF, [candle(2000, 1.2), candle(1000, 1.1), candle(1000, 1.15)]);
    const result = candleStore.get(PAIR, TF);
    expect(result).toEqual([candle(1000, 1.15), candle(2000, 1.2)]);
    expect(isStrictlyAscending(result)).toBe(true);
  });
});
