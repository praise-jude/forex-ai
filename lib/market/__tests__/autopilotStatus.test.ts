import { describe, expect, it } from "vitest";
import { computeAutopilotStatus } from "../autopilotStatus";
import { buildSignal } from "./fixtures";
import type { PredictionUpdate } from "../types";

function buildUpdate(overrides: Partial<PredictionUpdate> = {}): PredictionUpdate {
  return {
    pair: "EUR/USD",
    timeframe: "15m",
    evaluation: { status: "no_trade", reason: { code: "no_setup" } },
    time: Date.now(),
    regime: "range",
    ...overrides,
  };
}

describe("computeAutopilotStatus", () => {
  it("passes marketsMonitored through unchanged", () => {
    expect(computeAutopilotStatus([], [], 10).marketsMonitored).toBe(10);
  });

  it("reports lastAnalysisAt as the max time across every pair AND timeframe, not just the primary one", () => {
    const predictions = [
      buildUpdate({ pair: "EUR/USD", timeframe: "15m", time: 1000 }),
      buildUpdate({ pair: "GBP/USD", timeframe: "1h", time: 5000 }),
      buildUpdate({ pair: "USD/JPY", timeframe: "30m", time: 3000 }),
    ];
    expect(computeAutopilotStatus(predictions, [], 10).lastAnalysisAt).toBe(5000);
  });

  it("reports pipelineHealth unknown before any analysis has ever run", () => {
    expect(computeAutopilotStatus([], [], 10).pipelineHealth).toBe("unknown");
  });

  it("reports pipelineHealth fresh when the most recent analysis is within the stale threshold", () => {
    const now = 1_000_000_000;
    const predictions = [buildUpdate({ time: now - 5 * 60 * 1000 })]; // 5 minutes old
    expect(computeAutopilotStatus(predictions, [], 10, now).pipelineHealth).toBe("fresh");
  });

  it("reports pipelineHealth stale when the most recent analysis is older than the fastest tracked timeframe should allow", () => {
    const now = 1_000_000_000;
    const predictions = [buildUpdate({ time: now - 25 * 60 * 1000 })]; // 25 minutes old
    expect(computeAutopilotStatus(predictions, [], 10, now).pipelineHealth).toBe("stale");
  });

  it("counts active signals as non-watch-tier only", () => {
    const signals = [
      buildSignal({ id: "1", tier: "buy" }),
      buildSignal({ id: "2", tier: "strong_buy" }),
      buildSignal({ id: "3", tier: "watch" }),
    ];
    expect(computeAutopilotStatus([], signals, 10).activeSignals).toBe(2);
  });

  it("counts waiting setups from the primary timeframe only, so a pair blocked on all three concurrent timeframes counts once, not three times", () => {
    const predictions = [
      buildUpdate({ pair: "EUR/USD", timeframe: "15m" }),
      buildUpdate({ pair: "EUR/USD", timeframe: "30m" }),
      buildUpdate({ pair: "EUR/USD", timeframe: "1h" }),
      buildUpdate({ pair: "GBP/USD", timeframe: "15m" }),
    ];
    expect(computeAutopilotStatus(predictions, [], 10).waitingSetups).toBe(2);
  });

  it("never counts a fired signal (status: signal) as a waiting setup", () => {
    const predictions = [
      buildUpdate({ pair: "EUR/USD", timeframe: "15m", evaluation: { status: "signal", signal: buildSignal({ pair: "EUR/USD" }) } }),
    ];
    expect(computeAutopilotStatus(predictions, [], 10).waitingSetups).toBe(0);
  });

  it("counts blockedByNews only for genuine news_blackout reasons on the primary timeframe", () => {
    const predictions = [
      buildUpdate({
        pair: "EUR/USD",
        timeframe: "15m",
        evaluation: { status: "no_trade", reason: { code: "news_blackout", impliedDirection: "long", event: "NFP", currency: "USD", minutesUntil: 5 } },
      }),
      buildUpdate({ pair: "GBP/USD", timeframe: "15m", evaluation: { status: "no_trade", reason: { code: "weak_trend_adx", adx: 14 } } }),
      // Same pair, blocked by news on a non-primary timeframe -- must not be double-counted.
      buildUpdate({
        pair: "USD/JPY",
        timeframe: "1h",
        evaluation: { status: "no_trade", reason: { code: "news_blackout", impliedDirection: "long", event: "NFP", currency: "USD", minutesUntil: 5 } },
      }),
    ];
    expect(computeAutopilotStatus(predictions, [], 10).blockedByNews).toBe(1);
  });
});
