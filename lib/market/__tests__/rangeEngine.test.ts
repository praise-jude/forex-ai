import { describe, expect, it } from "vitest";
import { evaluateRangeSignal } from "../rangeEngine";
import type { Candle } from "../types";

const STEP = 15 * 60 * 1000;
const SUPPORT = 1.0;
const RESISTANCE = 1.02;
const MID = (SUPPORT + RESISTANCE) / 2;
const CLEAR_NEWS = { newsStatus: { status: "clear" } } as const;

function candle(time: number, open: number, high: number, low: number, close: number, tickVolume = 100): Candle {
  return { time, open, high, low, close, tickVolume };
}

/**
 * Built and verified empirically (debug-script-and-iterate), same approach
 * signalEngine.test.ts's own fixtures document -- a real synthetic range: tiny-amplitude
 * warmup (indicator history, doesn't register as a swing at the range's own scale), one
 * up/down cycle establishing the resistance/support swing points, a sustained decline
 * back down to support, and a final candle wicking below support that closes back up
 * near the top of its own range (a genuine rejection) -- confirmed to land ADX just
 * under the 20 "clean range" ceiling and RSI in the low 30s (not quite oversold, kept
 * deliberately short of the RSI extreme threshold so this fixture exercises exactly
 * three of the four scoring factors, landing right at the watch-tier floor).
 */
function buildRangeCandles(): Candle[] {
  const candles: Candle[] = [];
  let t = 0;

  const WARMUP = 32;
  for (let i = 0; i < WARMUP; i++) {
    const price = MID + (i % 2 === 0 ? 0.0001 : -0.0001);
    candles.push(candle(t, price, price + 0.00015, price - 0.00015, price));
    t += STEP;
  }

  const CANDLES_PER_LEG = 5;
  for (let i = 0; i < CANDLES_PER_LEG; i++) {
    const frac = i / (CANDLES_PER_LEG - 1);
    const price = SUPPORT + frac * (RESISTANCE - SUPPORT);
    candles.push(candle(t, price - 0.0005, price + 0.0008, price - 0.0008, price));
    t += STEP;
  }
  for (let i = 0; i < CANDLES_PER_LEG; i++) {
    const frac = i / (CANDLES_PER_LEG - 1);
    const price = RESISTANCE - frac * (RESISTANCE - SUPPORT);
    candles.push(candle(t, price + 0.0005, price + 0.0008, price - 0.0008, price));
    t += STEP;
  }

  const DESCENT_STEPS = 20;
  for (let i = 0; i <= DESCENT_STEPS; i++) {
    const frac = i / DESCENT_STEPS;
    const price = RESISTANCE - frac * (RESISTANCE - SUPPORT);
    const open = price + 0.002;
    const close = price - 0.0007;
    candles.push(candle(t, open, open + 0.0002, close - 0.0002, close));
    t += STEP;
  }

  return candles;
}

/** The proven watch-tier fixture, with the final touch candle appended separately so
 * tests can swap it out (e.g. a weak-rejection close) without rebuilding the whole
 * warmup/range history each time. */
function buildTouchCandle(time: number, weakRejection = false): Candle {
  return weakRejection
    ? // Wicks below support but closes near the BOTTOM of its own range -- a touch with
      // no real rejection.
      candle(time, SUPPORT - 0.0002, SUPPORT + 0.0001, SUPPORT - 0.0015, SUPPORT - 0.0013)
    : // Long lower wick, closes near the top of its own range (a real rejection) but
      // only barely above the prior candle's close, so RSI doesn't absorb a big
      // same-candle gain that would undo the preceding decline.
      candle(time, SUPPORT - 0.0008, SUPPORT - 0.0003, SUPPORT - 0.0015, SUPPORT - 0.0004);
}

describe("evaluateRangeSignal", () => {
  it("fires a watch-tier signal on a genuine support touch with rejection, a clean range, and entry proximity", () => {
    const base = buildRangeCandles();
    const candles = [...base, buildTouchCandle(base.length * STEP)];

    const evaluation = evaluateRangeSignal(candles, "EUR/USD", "15m", CLEAR_NEWS);
    expect(evaluation.status).toBe("signal");
    if (evaluation.status !== "signal") return;

    expect(evaluation.signal.source).toBe("mean_reversion");
    expect(evaluation.signal.direction).toBe("long");
    expect(evaluation.signal.tier).toBe("watch");
    expect(evaluation.signal.confidence).toBeGreaterThanOrEqual(70);
    expect(evaluation.signal.confluences).toEqual(expect.arrayContaining(["range_regime", "boundary_touch", "rejection_candle"]));
    // Entry/SL/TP anchored to the real range boundaries, not fabricated.
    expect(evaluation.signal.zoneBottom).toBeCloseTo(0.9992, 3);
    expect(evaluation.signal.zoneTop).toBeCloseTo(1.0222, 3);
    expect(evaluation.signal.stopLoss).toBeLessThan(evaluation.signal.entry);
    expect(evaluation.signal.takeProfit).toBeGreaterThan(evaluation.signal.entry);
    // Never touches Signer B -- this engine skips it entirely, same as TradingView.
    expect(evaluation.signal.signerBDirection).toBe("unavailable");
  });

  it("reports not_ranging when the market is genuinely trending, not ranging", () => {
    // A clean, sustained uptrend -- ADX comfortably above the strong-trend threshold,
    // no oscillation at all.
    const candles: Candle[] = [];
    let price = 1.0;
    for (let i = 0; i < 80; i++) {
      const open = price;
      price += 0.003;
      const close = price;
      candles.push(candle(i * STEP, open, close + 0.0005, open - 0.0005, close));
    }

    const evaluation = evaluateRangeSignal(candles, "EUR/USD", "15m", CLEAR_NEWS);
    expect(evaluation.status).toBe("no_trade");
    if (evaluation.status !== "no_trade") return;
    expect(evaluation.reason.code).toBe("not_ranging");
  });

  it("reports no_boundary_touch when the range is real but price hasn't reached either boundary", () => {
    const base = buildRangeCandles();
    // Stop right after the warmup/cycle, before the descent -- last candle sits mid-range.
    const candles = base.slice(0, 42);

    const evaluation = evaluateRangeSignal(candles, "EUR/USD", "15m", CLEAR_NEWS);
    expect(evaluation.status).toBe("no_trade");
    if (evaluation.status !== "no_trade") return;
    expect(evaluation.reason.code).toBe("no_boundary_touch");
  });

  it("reports range_below_threshold when a boundary touch happens but the rejection is weak", () => {
    const base = buildRangeCandles();
    const candles = [...base, buildTouchCandle(base.length * STEP, true)];

    const evaluation = evaluateRangeSignal(candles, "EUR/USD", "15m", CLEAR_NEWS);
    expect(evaluation.status).toBe("no_trade");
    if (evaluation.status !== "no_trade") return;
    expect(evaluation.reason.code).toBe("range_below_threshold");
    if (evaluation.reason.code !== "range_below_threshold") return;
    expect(evaluation.reason.impliedDirection).toBe("long");
    expect(evaluation.reason.total).toBeLessThan(70);
  });

  it("returns no_boundary_touch on too little history to evaluate at all", () => {
    const candles = buildRangeCandles().slice(0, 10);
    const evaluation = evaluateRangeSignal(candles, "EUR/USD", "15m", CLEAR_NEWS);
    expect(evaluation).toEqual({ status: "no_trade", reason: { code: "no_boundary_touch" } });
  });
});
