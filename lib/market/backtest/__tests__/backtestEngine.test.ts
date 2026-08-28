import { describe, expect, it } from "vitest";
import { runBacktest, simulateOutcome, simulateRealisticOutcome, type RealisticSimConfig } from "../backtestEngine";
import { evaluateRangeSignalForBacktest } from "../../rangeEngine";
import { buildSignal, buildSpec } from "../../__tests__/fixtures";
import type { Candle } from "../../types";

// Long fixture signal: entry 1.105, stopLoss 1.103 (risk 0.002), takeProfit 1.109
// (reward 0.004, RR 2), takeProfit2 1.113 -- see fixtures.ts.

function candle(overrides: Partial<Candle>): Candle {
  return { time: 0, open: 1.105, high: 1.105, low: 1.105, close: 1.105, tickVolume: 100, ...overrides };
}

describe("simulateOutcome", () => {
  it("reports take_profit when TP1 is touched before SL (long)", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.109, takeProfit2: 1.113 });
    const future = [candle({ time: 1000, high: 1.106, low: 1.104 }), candle({ time: 2000, high: 1.11, low: 1.108 })];
    const result = simulateOutcome(signal, future);
    expect(result).toEqual({ exitPrice: 1.109, exitTime: 2000, reason: "take_profit", rMultiple: 2, tp2Reached: false });
  });

  it("reports stop_loss when SL is touched before TP1 (long)", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.109 });
    const future = [candle({ time: 1000, high: 1.106, low: 1.104 }), candle({ time: 2000, high: 1.104, low: 1.1025 })];
    const result = simulateOutcome(signal, future);
    expect(result).toEqual({ exitPrice: 1.103, exitTime: 2000, reason: "stop_loss", rMultiple: -1, tp2Reached: false });
  });

  it("assumes SL first when a single candle touches both SL and TP1 (pessimistic tie-break)", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.109 });
    const future = [candle({ time: 1000, high: 1.11, low: 1.102 })];
    const result = simulateOutcome(signal, future);
    expect(result.reason).toBe("stop_loss");
    expect(result.rMultiple).toBe(-1);
  });

  it("flags tp2Reached when TP2 is touched on the same candle as TP1", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.109, takeProfit2: 1.113 });
    const future = [candle({ time: 1000, high: 1.115, low: 1.108 })];
    const result = simulateOutcome(signal, future);
    expect(result).toEqual({ exitPrice: 1.109, exitTime: 1000, reason: "take_profit", rMultiple: 2, tp2Reached: true });
  });

  it("reports still_open_at_end with rMultiple 0 when neither SL nor TP1 is ever touched", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.109 });
    const future = [candle({ time: 1000, high: 1.106, low: 1.104, close: 1.1055 })];
    const result = simulateOutcome(signal, future);
    expect(result).toEqual({ exitPrice: 1.1055, exitTime: 1000, reason: "still_open_at_end", rMultiple: 0, tp2Reached: false });
  });

  it("falls back to entry/createdAt when there are no future candles at all", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, createdAt: 999 });
    const result = simulateOutcome(signal, []);
    expect(result).toEqual({ exitPrice: 1.105, exitTime: 999, reason: "still_open_at_end", rMultiple: 0, tp2Reached: false });
  });

  it("mirrors SL/TP direction logic for a short signal", () => {
    const signal = buildSignal({ direction: "short", entry: 1.105, stopLoss: 1.107, takeProfit: 1.101, takeProfit2: 1.097 });
    const future = [candle({ time: 1000, high: 1.1035, low: 1.1005 })];
    const result = simulateOutcome(signal, future);
    expect(result).toEqual({ exitPrice: 1.101, exitTime: 1000, reason: "take_profit", rMultiple: 2, tp2Reached: false });
  });
});

describe("simulateRealisticOutcome", () => {
  const noSpreadConfig: RealisticSimConfig = {
    positionManagement: { breakEvenTriggerR: 1.0, trailingArmTriggerR: 1.5, trailingDistanceFractionOfStop: 1.0, partialCloseEnabled: false },
    spreadFractionOfStop: 0,
  };

  it("break-even protects a later pullback that would otherwise be a full loss (0R, not -1R)", () => {
    // entry 1.105, stopLoss 1.103 (risk 0.002), takeProfit 1.109 (see fixtures.ts).
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.109 });
    const future = [
      // r = (1.107 - 1.105) / 0.002 = 1.0 -> triggers break-even, stop moves to 1.105.
      candle({ time: 1000, high: 1.1075, low: 1.1045, close: 1.107 }),
      // Pulls back to 1.104 -- below the new break-even stop (1.105), not the original
      // stop (1.103), which this candle never even reaches.
      candle({ time: 2000, high: 1.1065, low: 1.104, close: 1.1045 }),
    ];
    const result = simulateRealisticOutcome(signal, future, noSpreadConfig);
    expect(result.reason).toBe("stop_loss");
    expect(result.exitPrice).toBe(1.105);
    expect(result.rMultiple).toBe(0);
  });

  it("trailing stop locks in profit on a reversal that never reaches the original take-profit", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.115, takeProfit2: 1.12 });
    const future = [
      // r = (1.108 - 1.105) / 0.002 = 1.5 -> arms trailing, distance = 1.0 * 0.002 = 0.002.
      // Initial trailed stop: 1.108 - 0.002 = 1.106.
      candle({ time: 1000, high: 1.1085, low: 1.1055, close: 1.108 }),
      // New high of 1.112 ratchets the stop to 1.112 - 0.002 = 1.110 (never touches TP 1.115).
      candle({ time: 2000, high: 1.112, low: 1.1085, close: 1.1095 }),
      // Reverses -- low of 1.1085 crosses the now-1.110 trailed stop.
      candle({ time: 3000, high: 1.1105, low: 1.1085, close: 1.109 }),
    ];
    const result = simulateRealisticOutcome(signal, future, noSpreadConfig);
    expect(result.reason).toBe("stop_loss"); // exits via the (ratcheted) stop, not TP1
    expect(result.exitPrice).toBe(1.11);
    expect(result.rMultiple).toBeCloseTo(2.5);
  });

  it("a trailing stop never loosens on a lower high", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.115, takeProfit2: 1.12 });
    const future = [
      // Arms trailing at r=1.5 (price 1.108), stop -> 1.106.
      candle({ time: 1000, high: 1.108, low: 1.1055, close: 1.108 }),
      // New high 1.111 ratchets the stop to 1.109.
      candle({ time: 2000, high: 1.111, low: 1.1085, close: 1.1095 }),
      // Lower high (1.1095) than the previous candle -- must NOT loosen the stop back down.
      candle({ time: 3000, high: 1.1095, low: 1.1092, close: 1.1093 }),
      // Touches 1.1085 -- below the still-1.109 stop, so this must still exit here.
      candle({ time: 4000, high: 1.109, low: 1.1085, close: 1.1088 }),
    ];
    const result = simulateRealisticOutcome(signal, future, noSpreadConfig);
    expect(result.exitPrice).toBe(1.109);
  });

  it("spread worsens the effective entry, reducing the realized R on a take-profit hit", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.109, takeProfit2: 1.113 });
    const config: RealisticSimConfig = { ...noSpreadConfig, spreadFractionOfStop: 0.1 }; // 10% of 0.002 = 0.0002
    const future = [candle({ time: 1000, high: 1.11, low: 1.104 })];
    const result = simulateRealisticOutcome(signal, future, config);
    expect(result.reason).toBe("take_profit");
    // effectiveEntry = 1.105 + 0.0002 = 1.1052; R = (1.109 - 1.1052) / 0.002 = 1.9
    expect(result.rMultiple).toBeCloseTo(1.9);
  });

  it("mirrors idealized behavior (no management, no spread) when triggers are never reached", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.109 });
    const future = [candle({ time: 1000, high: 1.106, low: 1.104 }), candle({ time: 2000, high: 1.104, low: 1.1025 })];
    const idealized = simulateOutcome(signal, future);
    const realistic = simulateRealisticOutcome(signal, future, noSpreadConfig);
    expect(realistic).toEqual(idealized);
  });

  it("uses the firing candle's real spread (points -> price via the account's own real symbol spec) over the fixed fraction-of-stop estimate when present", () => {
    // A real EUR/USD-like point size (0.00001) -- 20 points = 0.0002, the exact same
    // spread cost the "spread worsens..." test above reaches via a 10% config fraction
    // instead, so this should land on the identical realized R.
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.109, takeProfit2: 1.113 });
    const future = [candle({ time: 1000, high: 1.11, low: 1.104 })];
    const config: RealisticSimConfig = { ...noSpreadConfig, specs: new Map([["EUR/USD", buildSpec({ point: 0.00001 })]]) };
    const result = simulateRealisticOutcome(signal, future, config, 20);
    expect(result.reason).toBe("take_profit");
    // effectiveEntry = 1.105 + 0.0002 = 1.1052; R = (1.109 - 1.1052) / 0.002 = 1.9
    expect(result.rMultiple).toBeCloseTo(1.9);
  });

  it("falls back to the fixed fraction-of-stop estimate when the real spread reading or the pair's own spec is missing", () => {
    const signal = buildSignal({ direction: "long", entry: 1.105, stopLoss: 1.103, takeProfit: 1.109, takeProfit2: 1.113 });
    const withSpec: RealisticSimConfig = {
      ...noSpreadConfig,
      spreadFractionOfStop: 0.1,
      specs: new Map([["EUR/USD", buildSpec({ point: 0.00001 })]]),
    };
    const withoutSpec: RealisticSimConfig = { ...noSpreadConfig, spreadFractionOfStop: 0.1 };
    const future = [candle({ time: 1000, high: 1.11, low: 1.104 })];

    const withoutReading = simulateRealisticOutcome(signal, future, withSpec, undefined);
    const withZeroReading = simulateRealisticOutcome(signal, future, withSpec, 0);
    const withoutSpecAtAll = simulateRealisticOutcome(signal, future, withoutSpec, 20);
    // Same 0.0002 spread cost the fraction-based test above asserts -- R = 1.9.
    expect(withoutReading.rMultiple).toBeCloseTo(1.9);
    expect(withZeroReading.rMultiple).toBeCloseTo(1.9);
    expect(withoutSpecAtAll.rMultiple).toBeCloseTo(1.9);
  });
});

// Proves runBacktest's `evaluate` override actually plugs the range engine into the
// same window-walking scaffolding SMC uses -- the range engine had never been
// backtestable at all before rangeEngine.ts's evaluateRangeSignalForBacktest adapter
// was wired into backtestRunner.ts (see that file's own doc comment). Not a test of
// the range engine's own scoring (rangeEngine.test.ts already covers that in depth) --
// just that a real range setup fed through runBacktest with this evaluate override
// actually produces a mean_reversion-sourced signal, not silently nothing.
describe("runBacktest with the range engine's evaluate override", () => {
  const STEP = 15 * 60 * 1000;
  const SUPPORT = 1.0;
  const RESISTANCE = 1.02;
  const MID = (SUPPORT + RESISTANCE) / 2;

  function rangeCandle(time: number, open: number, high: number, low: number, close: number): Candle {
    return { time, open, high, low, close, tickVolume: 100 };
  }

  // Exact same proven fixture as rangeEngine.test.ts's own buildRangeCandles/
  // buildTouchCandle (see that file's doc comment for how it was built/verified) --
  // duplicated rather than imported, matching this codebase's existing convention of
  // self-contained test files.
  function buildRangeSeries(): Candle[] {
    const candles: Candle[] = [];
    let t = 0;

    const WARMUP = 32;
    for (let i = 0; i < WARMUP; i++) {
      const price = MID + (i % 2 === 0 ? 0.0001 : -0.0001);
      candles.push(rangeCandle(t, price, price + 0.00015, price - 0.00015, price));
      t += STEP;
    }

    const CANDLES_PER_LEG = 5;
    for (let i = 0; i < CANDLES_PER_LEG; i++) {
      const frac = i / (CANDLES_PER_LEG - 1);
      const price = SUPPORT + frac * (RESISTANCE - SUPPORT);
      candles.push(rangeCandle(t, price - 0.0005, price + 0.0008, price - 0.0008, price));
      t += STEP;
    }
    for (let i = 0; i < CANDLES_PER_LEG; i++) {
      const frac = i / (CANDLES_PER_LEG - 1);
      const price = RESISTANCE - frac * (RESISTANCE - SUPPORT);
      candles.push(rangeCandle(t, price + 0.0005, price + 0.0008, price - 0.0008, price));
      t += STEP;
    }

    const DESCENT_STEPS = 20;
    for (let i = 0; i <= DESCENT_STEPS; i++) {
      const frac = i / DESCENT_STEPS;
      const price = RESISTANCE - frac * (RESISTANCE - SUPPORT);
      const open = price + 0.002;
      const close = price - 0.0007;
      candles.push(rangeCandle(t, open, open + 0.0002, close - 0.0002, close));
      t += STEP;
    }

    // Final touch candle: long lower wick below support, closes near the top of its
    // own range (a real rejection).
    candles.push(rangeCandle(t, SUPPORT - 0.0008, SUPPORT - 0.0003, SUPPORT - 0.0015, SUPPORT - 0.0004));
    return candles;
  }

  it("produces a mean_reversion-sourced signal from a real range touch/rejection setup", () => {
    const primary = buildRangeSeries();
    const results = runBacktest({
      pair: "EUR/USD",
      timeframe: "15m",
      primary,
      h1: [],
      h4: [],
      d1: [],
      windowStart: primary[0].time,
      windowEnd: primary[primary.length - 1].time,
      evaluate: evaluateRangeSignalForBacktest,
    });

    const fired = results.filter((r) => r.evaluation.status === "signal");
    expect(fired.length).toBeGreaterThan(0);
    for (const result of fired) {
      if (result.evaluation.status !== "signal") continue;
      expect(result.evaluation.signal.source).toBe("mean_reversion");
    }
  });
});
