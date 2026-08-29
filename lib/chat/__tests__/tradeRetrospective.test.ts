import { describe, expect, it } from "vitest";
import { formatEntryForPrompt } from "../tradeRetrospective";
import type { JournalEntry, SignalContext } from "../../market/tradeJournal";

function buildContext(overrides: Partial<SignalContext> = {}): SignalContext {
  return {
    signalId: "sig-1",
    pair: "EUR/USD",
    timeframe: "15m",
    direction: "long",
    regime: "strong_uptrend",
    confidence: 82,
    signerBDirection: "long",
    signerBConfidence: 75,
    adx: 27.4,
    rsi: 58.2,
    newsStatus: "clear",
    session: "newyork",
    createdAt: Date.now(),
    ...overrides,
  };
}

function buildEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "deal-1",
    signalId: "sig-1",
    account: "live",
    pair: "EUR/USD",
    timeframe: "15m",
    direction: "long",
    entryPrice: 1.105,
    exitPrice: 1.109,
    profit: 120.5,
    riskDollars: 60.25,
    rMultiple: 2.0,
    reason: "take_profit",
    closedAt: Date.now(),
    context: buildContext(),
    ...overrides,
  };
}

describe("formatEntryForPrompt", () => {
  it("includes only real fields from the entry -- pair, direction, entry/exit, profit, R-multiple, close reason", () => {
    const prompt = formatEntryForPrompt(buildEntry());
    expect(prompt).toContain("EUR/USD");
    expect(prompt).toContain("long");
    expect(prompt).toContain("1.105");
    expect(prompt).toContain("1.109");
    expect(prompt).toContain("120.50");
    expect(prompt).toContain("2.00");
    expect(prompt).toContain("take_profit");
  });

  it("reports rMultiple as unavailable, not a fabricated number, when it's genuinely null", () => {
    const prompt = formatEntryForPrompt(buildEntry({ rMultiple: null }));
    expect(prompt).toContain("unavailable");
    expect(prompt).not.toContain("null");
  });

  it("includes the real setup-quality breakdown when present, using the entry's own numbers", () => {
    const context = buildContext({
      setupQuality: { smc: 24, trend: 18, momentum: 10, liquidity: 10, volatility: 7, newsRisk: 10, session: 5, total: 84 },
    });
    const prompt = formatEntryForPrompt(buildEntry({ context }));
    expect(prompt).toContain("SMC 24/30");
    expect(prompt).toContain("total 84/100");
  });

  it("omits the setup-quality line entirely when it's genuinely absent (a range-engine or older entry), rather than inventing one", () => {
    const context = buildContext({ setupQuality: undefined });
    const prompt = formatEntryForPrompt(buildEntry({ context }));
    expect(prompt).not.toContain("Setup quality breakdown");
  });

  it("lists real confluences when present", () => {
    const context = buildContext({ confluences: ["liquidity_sweep", "bos", "fvg"] });
    const prompt = formatEntryForPrompt(buildEntry({ context }));
    expect(prompt).toContain("liquidity_sweep");
    expect(prompt).toContain("bos");
    expect(prompt).toContain("fvg");
  });

  it("says plainly when no setup context exists at all, instead of guessing at one", () => {
    const prompt = formatEntryForPrompt(buildEntry({ context: null }));
    expect(prompt).toContain("No setup context available");
  });

  it("reports the real engine source (smc vs mean_reversion) when present", () => {
    const smc = formatEntryForPrompt(buildEntry({ context: buildContext({ source: "smc" }) }));
    const range = formatEntryForPrompt(buildEntry({ context: buildContext({ source: "mean_reversion" }) }));
    expect(smc).toContain("Engine: smc");
    expect(range).toContain("Engine: mean_reversion");
  });
});
