import { describe, expect, it } from "vitest";
import { describeNoTradeReason } from "../noTradeReason";

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
});
