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
    ...overrides,
  };
}

describe("predictionStore", () => {
  it("set() then get() returns the same update", () => {
    const update = buildUpdate();
    predictionStore.set(update.pair, update);
    expect(predictionStore.get(update.pair)).toEqual(update);
  });

  it("get() returns undefined for a pair never set", () => {
    expect(predictionStore.get("USOIL")).toBeUndefined();
  });

  it("set() overwrites the previous value for the same pair -- latest only, no history", () => {
    const first = buildUpdate({ time: 1000 });
    const second = buildUpdate({ time: 2000, evaluation: { status: "no_trade", reason: { code: "outside_killzone" } } });
    predictionStore.set("GBP/USD", first);
    predictionStore.set("GBP/USD", second);

    expect(predictionStore.get("GBP/USD")).toEqual(second);
    expect(predictionStore.all().filter((u) => u.pair === "GBP/USD")).toHaveLength(1);
  });

  it("all() includes updates across different pairs", () => {
    predictionStore.set("AUD/USD", buildUpdate({ pair: "AUD/USD" }));
    predictionStore.set("USD/CAD", buildUpdate({ pair: "USD/CAD" }));

    const pairs = predictionStore.all().map((u) => u.pair);
    expect(pairs).toEqual(expect.arrayContaining(["AUD/USD", "USD/CAD"]));
  });
});
