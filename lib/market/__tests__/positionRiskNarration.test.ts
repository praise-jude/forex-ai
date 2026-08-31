import { describe, expect, it } from "vitest";
import { assessPositionRisk } from "../positionRiskNarration";
import type { HigherTimeframeTrends } from "../types";

function trends(overrides: Partial<HigherTimeframeTrends> = {}): HigherTimeframeTrends {
  return { d1: "neutral", h4: "neutral", h1: "neutral", d1Gap: null, h4Gap: null, h1Gap: null, ...overrides };
}

describe("assessPositionRisk", () => {
  it("is aligned for a long position when nothing opposes it (range regime, neutral trends)", () => {
    const result = assessPositionRisk("long", "range", trends());
    expect(result.level).toBe("aligned");
  });

  it("is aligned for a long position when the regime itself is a strong uptrend", () => {
    const result = assessPositionRisk("long", "strong_uptrend", trends());
    expect(result.level).toBe("aligned");
  });

  it("warns a long position when the regime flips to a strong downtrend", () => {
    const result = assessPositionRisk("long", "strong_downtrend", trends());
    expect(result.level).toBe("warning");
    expect(result.reason).toContain("downtrend");
    expect(result.reason).toContain("BUY");
  });

  it("warns a short position when the regime flips to a strong uptrend", () => {
    const result = assessPositionRisk("short", "strong_uptrend", trends());
    expect(result.level).toBe("warning");
    expect(result.reason).toContain("uptrend");
    expect(result.reason).toContain("SELL");
  });

  it("warns a long position when BOTH D1 and H4 turn bearish, even without an opposing regime", () => {
    const result = assessPositionRisk("long", "range", trends({ d1: "bearish", h4: "bearish" }));
    expect(result.level).toBe("warning");
    expect(result.reason).toContain("daily and 4-hour");
  });

  it("cautions a long position when only D1 turns bearish, with a real distance from its own gap", () => {
    const result = assessPositionRisk("long", "range", trends({ d1: "bearish", d1Gap: -0.42 }));
    expect(result.level).toBe("caution");
    expect(result.reason).toContain("daily");
    expect(result.distancePct).toBe(0.42);
  });

  it("cautions a long position when only H4 turns bearish, with a real distance from its own gap", () => {
    const result = assessPositionRisk("long", "range", trends({ h4: "bearish", h4Gap: -1.1 }));
    expect(result.level).toBe("caution");
    expect(result.reason).toContain("4-hour");
    expect(result.distancePct).toBe(1.1);
  });

  it("reports no distance when the opposing timeframe's own gap wasn't available (still under warmup)", () => {
    const result = assessPositionRisk("long", "range", trends({ d1: "bearish", d1Gap: null }));
    expect(result.level).toBe("caution");
    expect(result.distancePct).toBeNull();
  });

  it("cautions on high volatility even when trends are neutral, with no distance to report", () => {
    const result = assessPositionRisk("long", "high_volatility", trends());
    expect(result.level).toBe("caution");
    expect(result.reason.toLowerCase()).toContain("volatility");
    expect(result.distancePct).toBeNull();
  });

  it("reports no distance for warning-level results -- two confirming reads, not one to measure", () => {
    const result = assessPositionRisk("long", "range", trends({ d1: "bearish", d1Gap: -0.3, h4: "bearish", h4Gap: -0.9 }));
    expect(result.level).toBe("warning");
    expect(result.distancePct).toBeNull();
  });

  it("a bullish D1/H4 read never counts against a long position (only the opposing direction does)", () => {
    const result = assessPositionRisk("long", "range", trends({ d1: "bullish", h4: "bullish" }));
    expect(result.level).toBe("aligned");
  });

  it("short and long are mirror images of each other for the same inputs", () => {
    const long = assessPositionRisk("long", "range", trends({ d1: "bearish", h4: "bearish" }));
    const short = assessPositionRisk("short", "range", trends({ d1: "bullish", h4: "bullish" }));
    expect(long.level).toBe("warning");
    expect(short.level).toBe("warning");
  });
});
