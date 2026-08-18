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
