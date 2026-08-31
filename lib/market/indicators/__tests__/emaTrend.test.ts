import { describe, expect, it } from "vitest";
import { emaTrendDirection, emaTrendGapPct } from "../emaTrend";
import { candle } from "../../detectors/__tests__/fixtures";
import type { Candle } from "../../types";

function trendingCandles(count: number, direction: "up" | "down", start = 1): Candle[] {
  const step = direction === "up" ? 0.001 : -0.001;
  const candles: Candle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    price += step;
    candles.push(candle(i, open, Math.max(open, price) + 0.0001, Math.min(open, price) - 0.0001, price));
  }
  return candles;
}

describe("emaTrendDirection", () => {
  it("is neutral with fewer than 50 candles (the EMA50 warmup floor)", () => {
    expect(emaTrendDirection(trendingCandles(30, "up"))).toBe("neutral");
  });

  it("reads bullish when EMA20 is above EMA50 in a sustained uptrend", () => {
    expect(emaTrendDirection(trendingCandles(250, "up"))).toBe("bullish");
  });

  it("reads bearish when EMA20 is below EMA50 in a sustained downtrend", () => {
    expect(emaTrendDirection(trendingCandles(250, "down", 2))).toBe("bearish");
  });
});

describe("emaTrendGapPct", () => {
  it("is null with fewer than 50 candles (the same EMA50 warmup floor emaTrendDirection uses)", () => {
    expect(emaTrendGapPct(trendingCandles(30, "up"))).toBeNull();
  });

  it("is positive in a sustained uptrend -- same sign as emaTrendDirection reading bullish", () => {
    const gap = emaTrendGapPct(trendingCandles(250, "up"));
    expect(gap).not.toBeNull();
    expect(gap as number).toBeGreaterThan(0);
  });

  it("is negative in a sustained downtrend -- same sign as emaTrendDirection reading bearish", () => {
    const gap = emaTrendGapPct(trendingCandles(250, "down", 2));
    expect(gap).not.toBeNull();
    expect(gap as number).toBeLessThan(0);
  });

  it("shrinks toward zero the closer the fast/slow EMA sit to crossing -- a real distance, not a fixed reading", () => {
    // A short-lived uptrend after a long downtrend: EMA20 has only just started
    // recovering, so it's still much closer to EMA50 than a long, sustained trend would
    // leave it -- the gap must be genuinely smaller here, not some other arbitrary value.
    const establishedDowntrend = trendingCandles(250, "down", 3);
    const justTurning = [...establishedDowntrend, ...trendingCandles(5, "up", establishedDowntrend[establishedDowntrend.length - 1].close)];
    const establishedGap = emaTrendGapPct(establishedDowntrend);
    const turningGap = emaTrendGapPct(justTurning);
    expect(establishedGap).not.toBeNull();
    expect(turningGap).not.toBeNull();
    expect(Math.abs(turningGap as number)).toBeLessThan(Math.abs(establishedGap as number));
  });
});
