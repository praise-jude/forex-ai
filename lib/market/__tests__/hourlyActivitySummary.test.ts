import { describe, expect, it } from "vitest";
import { formatHourlySummary, type EvaluationLogRowLike } from "../hourlyActivitySummary";

function row(overrides: Partial<EvaluationLogRowLike> = {}): EvaluationLogRowLike {
  return { status: "no_trade", reasonCode: "trend_disagreement", pair: "EUR/USD", signalTier: null, ...overrides };
}

describe("formatHourlySummary", () => {
  it("reports quiet when there are no evaluations at all", () => {
    const result = formatHourlySummary([]);
    expect(result.body).toMatch(/no evaluations/i);
  });

  it("reports 'no signals' plus the top blocking reasons when nothing fired", () => {
    const rows = [
      row({ reasonCode: "trend_disagreement" }),
      row({ reasonCode: "trend_disagreement" }),
      row({ reasonCode: "outside_killzone" }),
    ];
    const result = formatHourlySummary(rows);
    expect(result.body).toContain("3 evaluations in the last hour");
    expect(result.body).toContain("no signals");
    expect(result.body).toContain("trend disagreement (2)");
    expect(result.body).toContain("outside killzone (1)");
  });

  it("lists each fired signal by pair and tier when something fired", () => {
    const rows = [row(), row({ status: "signal", pair: "GBP/USD", signalTier: "strong_buy", reasonCode: null })];
    const result = formatHourlySummary(rows);
    expect(result.body).toContain("1 signal: GBP/USD strong_buy");
    expect(result.body).not.toContain("no signals");
  });

  it("caps the reported reasons at the top 3, ranked by frequency", () => {
    const rows = [
      ...Array(5).fill(row({ reasonCode: "trend_disagreement" })),
      ...Array(4).fill(row({ reasonCode: "outside_killzone" })),
      ...Array(3).fill(row({ reasonCode: "weak_trend_adx" })),
      ...Array(2).fill(row({ reasonCode: "low_volatility" })),
    ];
    const result = formatHourlySummary(rows);
    expect(result.body).toContain("trend disagreement (5)");
    expect(result.body).toContain("outside killzone (4)");
    expect(result.body).toContain("weak trend (3)");
    expect(result.body).not.toContain("low_volatility");
    expect(result.body).not.toContain("low volatility");
  });

  it("falls back to the raw code for a reason with no known label", () => {
    const result = formatHourlySummary([row({ reasonCode: "some_new_reason" })]);
    expect(result.body).toContain("some_new_reason (1)");
  });
});
