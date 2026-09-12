import { describe, expect, it } from "vitest";
import { applyEarlyInvalidation } from "../backtestInvalidation";
import type { BacktestBarResult, OutcomeSim } from "../backtestEngine";
import { buildSignal } from "../../__tests__/fixtures";
import type { Signal } from "../../types";

function barResult(signal: Signal, outcome: OutcomeSim): BacktestBarResult {
  return { barTime: signal.createdAt, evaluation: { status: "signal", signal }, outcome, regime: "range" };
}

describe("applyEarlyInvalidation", () => {
  it("truncates an earlier signal's outcome when a later opposite-direction signal fires before its natural exit", () => {
    const long = buildSignal({ id: "long-1", direction: "long", entry: 1.105, stopLoss: 1.103, createdAt: 1000, pair: "EUR/USD", timeframe: "15m" });
    const longOutcome: OutcomeSim = { exitPrice: 1.109, exitTime: 9000, reason: "take_profit", rMultiple: 2, tp2Reached: false };
    const short = buildSignal({ id: "short-1", direction: "short", entry: 1.106, stopLoss: 1.108, createdAt: 5000, pair: "EUR/USD", timeframe: "15m" });
    const shortOutcome: OutcomeSim = { exitPrice: 1.102, exitTime: 8000, reason: "take_profit", rMultiple: 2, tp2Reached: false };

    const output = applyEarlyInvalidation([barResult(long, longOutcome), barResult(short, shortOutcome)]);

    // Truncated to the invalidating short's own entry/fire time -- rMultiple = (1.106 -
    // 1.105) / (1.105 - 1.103) = 0.5, a small realized gain, not the long's untouched
    // natural take_profit outcome.
    expect(output[0].outcome).toMatchObject({ exitPrice: 1.106, exitTime: 5000, reason: "invalidation", tp2Reached: false });
    expect(output[0].outcome!.rMultiple).toBeCloseTo(0.5);
    // The invalidating signal's own outcome is never itself touched.
    expect(output[1].outcome).toEqual(shortOutcome);
  });

  it("does not truncate a signal that already naturally closed before the later opposite signal fired", () => {
    const long = buildSignal({ id: "long-1", direction: "long", createdAt: 1000, pair: "EUR/USD", timeframe: "15m" });
    const longOutcome: OutcomeSim = { exitPrice: 1.109, exitTime: 3000, reason: "take_profit", rMultiple: 2, tp2Reached: false };
    const short = buildSignal({ id: "short-1", direction: "short", createdAt: 5000, pair: "EUR/USD", timeframe: "15m" });
    const shortOutcome: OutcomeSim = { exitPrice: 1.102, exitTime: 8000, reason: "take_profit", rMultiple: 2, tp2Reached: false };

    const output = applyEarlyInvalidation([barResult(long, longOutcome), barResult(short, shortOutcome)]);

    expect(output[0].outcome).toEqual(longOutcome);
  });

  it("does not truncate when the later fired signal is the same direction", () => {
    const long1 = buildSignal({ id: "long-1", direction: "long", createdAt: 1000, pair: "EUR/USD", timeframe: "15m" });
    const outcome1: OutcomeSim = { exitPrice: 1.109, exitTime: 9000, reason: "take_profit", rMultiple: 2, tp2Reached: false };
    const long2 = buildSignal({ id: "long-2", direction: "long", createdAt: 5000, pair: "EUR/USD", timeframe: "15m" });
    const outcome2: OutcomeSim = { exitPrice: 1.109, exitTime: 9500, reason: "take_profit", rMultiple: 2, tp2Reached: false };

    const output = applyEarlyInvalidation([barResult(long1, outcome1), barResult(long2, outcome2)]);

    expect(output[0].outcome).toEqual(outcome1);
  });

  it("stamps exitTime from the bar's own real historical time, not signal.createdAt", () => {
    // Real, confirmed bug (2026-09-12): signal.createdAt is ALWAYS Date.now() (see
    // signalEngine.ts), including during a backtest replay of historical data -- using
    // it here stamped a truncated trade's exitTime with real wall-clock time instead of
    // any historical date. This test deliberately makes barTime and createdAt DIFFERENT
    // (the earlier tests' own barResult helper sets them equal, which is exactly what
    // let this bug hide) to actually exercise the distinction.
    const long = buildSignal({ id: "long-1", direction: "long", entry: 1.105, stopLoss: 1.103, createdAt: 1000, pair: "EUR/USD", timeframe: "15m" });
    const longOutcome: OutcomeSim = { exitPrice: 1.109, exitTime: 9000, reason: "take_profit", rMultiple: 2, tp2Reached: false };
    const short = buildSignal({ id: "short-1", direction: "short", entry: 1.106, stopLoss: 1.108, createdAt: 99_999_999_999, pair: "EUR/USD", timeframe: "15m" });
    const shortOutcome: OutcomeSim = { exitPrice: 1.102, exitTime: 8000, reason: "take_profit", rMultiple: 2, tp2Reached: false };
    const historicalBarTime = 5000;

    const output = applyEarlyInvalidation([
      barResult(long, longOutcome),
      { barTime: historicalBarTime, evaluation: { status: "signal", signal: short }, outcome: shortOutcome, regime: "range" },
    ]);

    expect(output[0].outcome!.exitTime).toBe(historicalBarTime);
  });

  it("a truncated position is correctly seen as closed and never invalidated a second time by a later signal", () => {
    // The actual mechanism behind a real, confirmed incident (2026-09-12): with the
    // exitTime bug, a truncated position's exitTime (real wall-clock time, always huge
    // relative to any historical barTime) could never be <= a later bar's real
    // historical barTime, so the "drop this position, it's already closed" check could
    // never fire -- the position stayed a zombie in `open`, eligible to be invalidated
    // AGAIN by a THIRD signal, computing a fresh R-multiple off its ORIGINAL entry
    // against whatever price that much-later signal fired at (a real -22.95R "loss" was
    // produced this way, impossible for a real stop-loss, which can never lose more
    // than 1R). long1 (bar 1000) is invalidated once by short1 (bar 5000, createdAt
    // deliberately wall-clock-like to reproduce the exact bug shape) -- short2 (bar
    // 20000, also opposite long1's direction) must NOT be able to touch long1 again.
    const long1 = buildSignal({ id: "long-1", direction: "long", entry: 1.105, stopLoss: 1.103, createdAt: 1000, pair: "EUR/USD", timeframe: "15m" });
    const long1Outcome: OutcomeSim = { exitPrice: 1.109, exitTime: 9000, reason: "take_profit", rMultiple: 2, tp2Reached: false };
    const short1 = buildSignal({
      id: "short-1",
      direction: "short",
      entry: 1.106,
      stopLoss: 1.108,
      createdAt: 99_999_999_999, // wall-clock-like, deliberately far from its own bar's real historical time (5000)
      pair: "EUR/USD",
      timeframe: "15m",
    });
    const short1Outcome: OutcomeSim = { exitPrice: 1.102, exitTime: 50_000, reason: "take_profit", rMultiple: 2, tp2Reached: false };
    const short2 = buildSignal({ id: "short-2", direction: "short", entry: 1.5, stopLoss: 1.6, createdAt: 20_000, pair: "EUR/USD", timeframe: "15m" });
    const short2Outcome: OutcomeSim = { exitPrice: 1.4, exitTime: 30_000, reason: "take_profit", rMultiple: 2, tp2Reached: false };

    const output = applyEarlyInvalidation([
      { barTime: 1000, evaluation: { status: "signal", signal: long1 }, outcome: long1Outcome, regime: "range" },
      { barTime: 5000, evaluation: { status: "signal", signal: short1 }, outcome: short1Outcome, regime: "range" },
      { barTime: 20_000, evaluation: { status: "signal", signal: short2 }, outcome: short2Outcome, regime: "range" },
    ]);

    // long1 was correctly truncated once by short1 (rMultiple 0.5, off real nearby
    // prices) -- it must NOT be re-touched by short2 firing later, which would otherwise
    // recompute rMultiple off long1's original 1.105 entry against short2's far-away 1.5
    // fire price (≈197R) -- exactly the impossible-magnitude bug this guards against.
    expect(output[0].outcome!.exitTime).toBe(5000);
    expect(output[0].outcome!.rMultiple).toBeCloseTo(0.5);
  });

  it("does not mutate the input array's own objects", () => {
    const long = buildSignal({ id: "long-1", direction: "long", entry: 1.105, stopLoss: 1.103, createdAt: 1000, pair: "EUR/USD", timeframe: "15m" });
    const longOutcome: OutcomeSim = { exitPrice: 1.109, exitTime: 9000, reason: "take_profit", rMultiple: 2, tp2Reached: false };
    const short = buildSignal({ id: "short-1", direction: "short", entry: 1.106, createdAt: 5000, pair: "EUR/USD", timeframe: "15m" });
    const shortOutcome: OutcomeSim = { exitPrice: 1.102, exitTime: 8000, reason: "take_profit", rMultiple: 2, tp2Reached: false };
    const input = [barResult(long, longOutcome), barResult(short, shortOutcome)];

    applyEarlyInvalidation(input);

    expect(input[0].outcome).toEqual(longOutcome);
  });
});
