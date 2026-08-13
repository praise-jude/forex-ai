import { describe, expect, it } from "vitest";
import { simulateOutcome } from "../backtestEngine";
import { buildSignal } from "../../__tests__/fixtures";
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
