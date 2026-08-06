import { describe, expect, it } from "vitest";
import { calculateMacd } from "../macd";
import { calculateEma } from "../ema";
import { candle } from "../../detectors/__tests__/fixtures";

describe("calculateMacd", () => {
  it("macdLine equals emaFast - emaSlow, independently recomputed", () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
    const candles = closes.map((c, i) => candle(i, c, c, c, c));
    const fast = 3;
    const slow = 5;

    const { macdLine } = calculateMacd(candles, fast, slow, 2);
    const emaFast = calculateEma(closes, fast);
    const emaSlow = calculateEma(closes, slow);

    for (let i = 0; i < closes.length; i++) {
      if (Number.isNaN(emaSlow[i])) {
        expect(macdLine[i]).toBeNaN();
      } else {
        expect(macdLine[i]).toBeCloseTo(emaFast[i] - emaSlow[i], 10);
      }
    }
  });

  it("signalLine is the EMA of the macd line, offset to the first valid macd index", () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
    const candles = closes.map((c, i) => candle(i, c, c, c, c));
    const slow = 5;
    const signalPeriod = 2;

    const { macdLine, signalLine } = calculateMacd(candles, 3, slow, signalPeriod);
    const expectedSignal = calculateEma(macdLine.slice(slow - 1), signalPeriod);

    expect(signalLine.slice(0, slow - 1).every((v) => Number.isNaN(v))).toBe(true);
    for (let i = 0; i < expectedSignal.length; i++) {
      const actual = signalLine[slow - 1 + i];
      if (Number.isNaN(expectedSignal[i])) expect(actual).toBeNaN();
      else expect(actual).toBeCloseTo(expectedSignal[i], 10);
    }
  });
});
