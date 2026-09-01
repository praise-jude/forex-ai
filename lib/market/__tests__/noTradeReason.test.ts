import { describe, expect, it } from "vitest";
import { describeNoTradeReason, pipelineStages } from "../noTradeReason";
import type { SignalEvaluation } from "../types";

describe("describeNoTradeReason", () => {
  it("describes outside_killzone", () => {
    expect(describeNoTradeReason({ code: "outside_killzone" })).toMatch(/killzone/i);
  });

  it("describes no_setup", () => {
    expect(describeNoTradeReason({ code: "no_setup" })).toMatch(/no qualifying setup/i);
  });

  it("describes trend_disagreement with the real per-timeframe readings", () => {
    const text = describeNoTradeReason({
      code: "trend_disagreement",
      impliedDirection: "long",
      d1: "bullish",
      h4: "bearish",
      h1: "bullish",
    });
    expect(text).toContain("D1 bullish");
    expect(text).toContain("H4 bearish");
    expect(text).toContain("H1 bullish");
  });

  it("describes weak_trend_adx with the real ADX value", () => {
    expect(describeNoTradeReason({ code: "weak_trend_adx", adx: 14.2 })).toContain("14.2");
  });

  it("describes low_volatility with the real ATR figures", () => {
    const text = describeNoTradeReason({ code: "low_volatility", atr: 0.001, atrAverage: 0.0015 });
    expect(text).toContain("0.00100");
    expect(text).toContain("0.00150");
  });

  it("describes below_threshold, naming which specific factors are missing (not present)", () => {
    const text = describeNoTradeReason({
      code: "below_threshold",
      direction: { total: 85, tier: "watch", reasons: ["trend_ema_stack", "market_structure"] }, // missing adx
      entry: { total: 60, tier: "no_trade", reasons: ["candlestick"] }, // missing macd/rsi/volume
    });
    expect(text).toContain("Direction confidence 85%");
    expect(text).toContain("entry confidence 60%");
    expect(text).toMatch(/missing a strong adx reading/i);
    expect(text).toMatch(/MACD confirmation/);
    expect(text).toMatch(/RSI momentum/);
    expect(text).toMatch(/above-average volume/);
    expect(text).not.toMatch(/EMA stack alignment/); // was present, must not be listed as missing
  });

  it("below_threshold with nothing missing on a dimension omits that clause", () => {
    const text = describeNoTradeReason({
      code: "below_threshold",
      direction: { total: 100, tier: "strong_buy", reasons: ["trend_ema_stack", "market_structure", "adx"] },
      entry: { total: 60, tier: "no_trade", reasons: ["candlestick"] },
    });
    // Only one "missing ..." clause (for entry) -- direction has nothing missing.
    expect(text.match(/missing/gi)).toHaveLength(1);
  });

  it("describes signer_b_neutral, naming SMC's implied direction", () => {
    const text = describeNoTradeReason({ code: "signer_b_neutral", impliedDirection: "long" });
    expect(text).toMatch(/bullish setup/i);
    expect(text).toMatch(/confirmation signer/i);
    expect(text).toMatch(/clear lean/i);
  });

  it("describes signer_conflict with both signers' real directions and Signer B's confidence", () => {
    const text = describeNoTradeReason({
      code: "signer_conflict",
      impliedDirection: "long",
      signerBDirection: "short",
      signerBConfidence: 72,
    });
    expect(text).toMatch(/bullish setup/i);
    expect(text).toMatch(/bearish/i);
    expect(text).toContain("72%");
  });

  it("prefixes the market regime onto the explanation when given", () => {
    const text = describeNoTradeReason({ code: "no_setup" }, "range");
    expect(text).toMatch(/^Market regime: Range\. /);
    expect(text).toMatch(/no qualifying setup/i);
  });

  it("omits the regime prefix entirely when no regime is given", () => {
    const text = describeNoTradeReason({ code: "no_setup" });
    expect(text).not.toMatch(/Market regime/i);
  });

  it("describes news_blackout with the real event, currency, and time until it", () => {
    const text = describeNoTradeReason({
      code: "news_blackout",
      impliedDirection: "long",
      event: "Non-Farm Payrolls",
      currency: "USD",
      minutesUntil: 12,
    });
    expect(text).toMatch(/buy setup/i);
    expect(text).toContain("USD");
    expect(text).toContain("Non-Farm Payrolls");
    expect(text).toContain("12 minutes");
  });
});

describe("pipelineStages", () => {
  it("marks every SMC stage pass for a real signal", () => {
    const evaluation = { status: "signal" } as unknown as SignalEvaluation;
    const stages = pipelineStages(evaluation, "smc");
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.every((s) => s.status === "pass")).toBe(true);
  });

  it("marks the failing SMC stage 'fail', everything before it 'pass', everything after 'not_reached'", () => {
    const evaluation: SignalEvaluation = { status: "no_trade", reason: { code: "weak_trend_adx", adx: 12 } };
    const stages = pipelineStages(evaluation, "smc");
    const killzone = stages.find((s) => s.label === "Killzone window")!;
    const setup = stages.find((s) => s.label === "SMC setup trigger")!;
    const trend = stages.find((s) => s.label === "D1/H4 trend agreement")!;
    const adx = stages.find((s) => s.label === "Trend strength (ADX)")!;
    const volatility = stages.find((s) => s.label === "Volatility (ATR)")!;
    const confidence = stages.find((s) => s.label === "Confidence score")!;
    expect(killzone.status).toBe("pass");
    expect(setup.status).toBe("pass");
    expect(trend.status).toBe("pass");
    expect(adx.status).toBe("fail");
    expect(volatility.status).toBe("not_reached");
    expect(confidence.status).toBe("not_reached");
  });

  it("marks the failing stage first among two codes sharing one stage (signer_conflict)", () => {
    const evaluation: SignalEvaluation = {
      status: "no_trade",
      reason: { code: "signer_conflict", impliedDirection: "long", signerBDirection: "short", signerBConfidence: 70 },
    };
    const stages = pipelineStages(evaluation, "smc");
    expect(stages.find((s) => s.label === "Confidence score")!.status).toBe("pass");
    expect(stages.find((s) => s.label === "Independent confirmation")!.status).toBe("fail");
    expect(stages.find((s) => s.label === "M5 entry confirmation")!.status).toBe("not_reached");
  });

  it("uses the range engine's own stage order for mean_reversion", () => {
    const evaluation: SignalEvaluation = { status: "no_trade", reason: { code: "no_boundary_touch" } };
    const stages = pipelineStages(evaluation, "mean_reversion");
    expect(stages.find((s) => s.label === "Range detected")!.status).toBe("pass");
    expect(stages.find((s) => s.label === "Ranging regime")!.status).toBe("pass");
    expect(stages.find((s) => s.label === "Boundary touch")!.status).toBe("fail");
    expect(stages.find((s) => s.label === "Confidence score")!.status).toBe("not_reached");
  });

  it("marks every range stage pass for a real range signal", () => {
    const evaluation = { status: "signal" } as unknown as SignalEvaluation;
    const stages = pipelineStages(evaluation, "mean_reversion");
    expect(stages.every((s) => s.status === "pass")).toBe(true);
  });
});
