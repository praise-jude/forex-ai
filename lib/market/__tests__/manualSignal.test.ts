import { describe, expect, it } from "vitest";
import { buildManualSignal, type ManualSignalInput } from "../manualSignal";

const NOW = 1_700_000_000_000;

function buildInput(overrides: Partial<ManualSignalInput> = {}): ManualSignalInput {
  return {
    pair: "EUR/USD",
    direction: "long",
    entry: 1.085,
    stopLoss: 1.083,
    takeProfit: 1.089,
    ...overrides,
  };
}

describe("buildManualSignal", () => {
  it("builds a valid manual-sourced signal for a long trade", () => {
    const result = buildManualSignal(buildInput(), NOW);
    expect("signal" in result).toBe(true);
    if (!("signal" in result)) throw new Error("expected a signal");

    expect(result.signal.source).toBe("manual");
    expect(result.signal.pair).toBe("EUR/USD");
    expect(result.signal.direction).toBe("long");
    expect(result.signal.entry).toBe(1.085);
    expect(result.signal.tier).toBe("buy"); // never "watch" -- would trip the execution guard
    expect(result.signal.confluences).toEqual([]);
    expect(result.signal.takeProfit2).toBe(1.089); // defaults to takeProfit when omitted
    expect(Number.isNaN(result.signal.adx)).toBe(true);
    expect(Number.isNaN(result.signal.rsi)).toBe(true);
    expect(result.signal.signerBDirection).toBe("unavailable");
  });

  it("builds a valid manual-sourced signal for a short trade", () => {
    const result = buildManualSignal(
      buildInput({ direction: "short", entry: 1.085, stopLoss: 1.087, takeProfit: 1.081 }),
      NOW
    );
    expect("signal" in result).toBe(true);
    if ("signal" in result) expect(result.signal.direction).toBe("short");
  });

  it("rejects a stop-loss on the wrong side of entry for a long trade", () => {
    const result = buildManualSignal(buildInput({ stopLoss: 1.087 }), NOW); // above entry -- wrong side for a long
    expect("error" in result).toBe(true);
  });

  it("rejects a take-profit on the wrong side of entry for a short trade", () => {
    const result = buildManualSignal(
      buildInput({ direction: "short", entry: 1.085, stopLoss: 1.087, takeProfit: 1.089 }), // TP above entry -- wrong side for a short
      NOW
    );
    expect("error" in result).toBe(true);
  });

  it("rejects a non-finite entry (no live price available)", () => {
    const result = buildManualSignal(buildInput({ entry: NaN }), NOW);
    expect("error" in result).toBe(true);
  });

  it("computes riskReward from the real entry/stopLoss/takeProfit distances", () => {
    const result = buildManualSignal(buildInput({ entry: 1.085, stopLoss: 1.083, takeProfit: 1.089 }), NOW);
    if ("signal" in result) expect(result.signal.riskReward).toBeCloseTo(2, 5); // (1.089-1.085)/(1.085-1.083) = 2
  });
});
