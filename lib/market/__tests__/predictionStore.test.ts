import { describe, expect, it } from "vitest";
import { predictionStore } from "../predictionStore";
import { buildSignal } from "./fixtures";
import type { PredictionUpdate } from "../types";

function buildUpdate(overrides: Partial<PredictionUpdate> = {}): PredictionUpdate {
  return {
    pair: "GBP/USD", // distinct from other test files' default pair to avoid cross-test collisions on this shared globalThis singleton
    timeframe: "15m",
    evaluation: { status: "signal", signal: buildSignal({ pair: "GBP/USD" }) },
    time: Date.now(),
    regime: "strong_uptrend",
    trends: { d1: "bullish", h4: "bullish", h1: "bullish" },
    ...overrides,
  };
}

describe("predictionStore", () => {
  it("set() then get() returns the same update", () => {
    const update = buildUpdate();
    predictionStore.set(update.pair, update.timeframe, update);
    expect(predictionStore.get(update.pair, update.timeframe)).toEqual(update);
  });

  it("get() returns undefined for a pair/timeframe never set", () => {
    expect(predictionStore.get("USOIL", "15m")).toBeUndefined();
  });

  it("set() overwrites the previous value for the same pair+timeframe -- latest only, no history", () => {
    const first = buildUpdate({ time: 1000 });
    const second = buildUpdate({ time: 2000, evaluation: { status: "no_trade", reason: { code: "outside_killzone" } } });
    predictionStore.set("GBP/USD", "15m", first);
    predictionStore.set("GBP/USD", "15m", second);

    expect(predictionStore.get("GBP/USD", "15m")).toEqual(second);
    expect(predictionStore.all().filter((u) => u.pair === "GBP/USD" && u.timeframe === "15m")).toHaveLength(1);
  });

  it("set() keeps separate entries per timeframe for the same pair -- three signal engines run concurrently", () => {
    const fifteenMin = buildUpdate({ timeframe: "15m", time: 1000 });
    const thirtyMin = buildUpdate({ timeframe: "30m", time: 2000 });
    const oneHour = buildUpdate({ timeframe: "1h", time: 3000 });
    predictionStore.set("GBP/USD", "15m", fifteenMin);
    predictionStore.set("GBP/USD", "30m", thirtyMin);
    predictionStore.set("GBP/USD", "1h", oneHour);

    expect(predictionStore.get("GBP/USD", "15m")).toEqual(fifteenMin);
    expect(predictionStore.get("GBP/USD", "30m")).toEqual(thirtyMin);
    expect(predictionStore.get("GBP/USD", "1h")).toEqual(oneHour);
    expect(predictionStore.forPair("GBP/USD")).toHaveLength(3);
  });

  it("forPair() returns an empty array for a pair never set", () => {
    expect(predictionStore.forPair("UKOIL")).toEqual([]);
  });

  it("all() includes updates across different pairs", () => {
    predictionStore.set("AUD/USD", "15m", buildUpdate({ pair: "AUD/USD" }));
    predictionStore.set("USD/CAD", "15m", buildUpdate({ pair: "USD/CAD" }));

    const pairs = predictionStore.all().map((u) => u.pair);
    expect(pairs).toEqual(expect.arrayContaining(["AUD/USD", "USD/CAD"]));
  });
});
