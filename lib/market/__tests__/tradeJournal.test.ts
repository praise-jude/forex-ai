import { beforeEach, describe, expect, it } from "vitest";
import type { JournalEntry, SignalContext, SignalOutcome } from "../tradeJournal";
import { getConfidenceCalibration, getPerformanceBreakdown, getPerformanceStats, getSignalFunnelStats, getSignerBCalibration } from "../tradeJournal";
import type { TradeJournalModule } from "./tradeJournalTestHelper";
import { loadTradeJournalModule } from "./tradeJournalTestHelper";

function buildContext(overrides: Partial<SignalContext> = {}): SignalContext {
  return {
    signalId: "sig-1",
    pair: "EUR/USD",
    timeframe: "15m",
    direction: "long",
    regime: "strong_uptrend",
    setupQuality: { smc: 27, trend: 20, momentum: 10, liquidity: 10, volatility: 7, newsRisk: 10, session: 5, total: 89 },
    confidence: 90,
    signerBDirection: "long",
    signerBConfidence: 85,
    adx: 27.4,
    rsi: 58,
    newsStatus: "clear",
    session: "london",
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
    profit: 200,
    riskDollars: 100,
    rMultiple: 2,
    reason: "take_profit",
    closedAt: Date.now(),
    context: buildContext(),
    ...overrides,
  };
}

describe("tradeJournal store", () => {
  let mod: TradeJournalModule;

  beforeEach(async () => {
    mod = await loadTradeJournalModule();
  });

  it("joins a recorded outcome to its earlier-recorded signal context by signalId", () => {
    mod.tradeJournal.recordSignalContext(buildContext({ signalId: "sig-1" }));

    const entry = mod.tradeJournal.recordOutcome({
      dealId: "deal-1",
      signalId: "sig-1",
      account: "live",
      pair: "EUR/USD",
      direction: "long",
      entryPrice: 1.105,
      stopLoss: 1.103,
      lots: 0.5,
      contractSize: 100000,
      exitPrice: 1.109,
      profit: 200,
      reason: "take_profit",
      closedAt: Date.now(),
    });

    expect(entry.context).toMatchObject({ signalId: "sig-1", regime: "strong_uptrend" });
  });

  it("computes riskDollars and rMultiple with the same pip math positionSizing.ts trusts (20 pip stop, $10 pip value/lot, 0.5 lots -> $100 risk)", () => {
    const entry = mod.tradeJournal.recordOutcome({
      dealId: "deal-1",
      signalId: "sig-1",
      account: "live",
      pair: "EUR/USD",
      direction: "long",
      entryPrice: 1.105,
      stopLoss: 1.103,
      lots: 0.5,
      contractSize: 100000,
      exitPrice: 1.109,
      profit: 200,
      reason: "take_profit",
      closedAt: Date.now(),
    });

    expect(entry.riskDollars).toBeCloseTo(100);
    expect(entry.rMultiple).toBeCloseTo(2);
  });

  it("reports a losing trade as a negative R-multiple", () => {
    const entry = mod.tradeJournal.recordOutcome({
      dealId: "deal-1",
      signalId: "sig-1",
      account: "live",
      pair: "EUR/USD",
      direction: "long",
      entryPrice: 1.105,
      stopLoss: 1.103,
      lots: 0.5,
      contractSize: 100000,
      exitPrice: 1.103,
      profit: -100,
      reason: "stop_loss",
      closedAt: Date.now(),
    });

    expect(entry.rMultiple).toBeCloseTo(-1);
  });

  it("honestly reports context: null rather than fabricating one when no matching signal context was ever recorded", () => {
    const entry = mod.tradeJournal.recordOutcome({
      dealId: "deal-1",
      signalId: "never-recorded",
      account: "live",
      pair: "EUR/USD",
      direction: "long",
      entryPrice: 1.105,
      stopLoss: 1.103,
      lots: 0.5,
      contractSize: 100000,
      exitPrice: 1.109,
      profit: 200,
      reason: "take_profit",
      closedAt: Date.now(),
    });

    expect(entry.context).toBeNull();
  });

  it("honestly reports riskDollars/rMultiple: null when no symbol spec (contract size) was available, never a fabricated guess", () => {
    const entry = mod.tradeJournal.recordOutcome({
      dealId: "deal-1",
      signalId: "sig-1",
      account: "live",
      pair: "EUR/USD",
      direction: "long",
      entryPrice: 1.105,
      stopLoss: 1.103,
      lots: 0.5,
      contractSize: undefined,
      exitPrice: 1.109,
      profit: 200,
      reason: "take_profit",
      closedAt: Date.now(),
    });

    expect(entry.riskDollars).toBeNull();
    expect(entry.rMultiple).toBeNull();
  });

  it("consumes the pending context on join -- a second outcome for the same signalId gets context: null, not the same context twice", () => {
    mod.tradeJournal.recordSignalContext(buildContext({ signalId: "sig-1" }));
    mod.tradeJournal.recordOutcome({
      dealId: "deal-1",
      signalId: "sig-1",
      account: "live",
      pair: "EUR/USD",
      direction: "long",
      entryPrice: 1.105,
      stopLoss: 1.103,
      lots: 0.5,
      contractSize: 100000,
      exitPrice: 1.109,
      profit: 200,
      reason: "take_profit",
      closedAt: Date.now(),
    });

    const second = mod.tradeJournal.recordOutcome({
      dealId: "deal-2",
      signalId: "sig-1",
      account: "live",
      pair: "EUR/USD",
      direction: "long",
      entryPrice: 1.105,
      stopLoss: 1.103,
      lots: 0.5,
      contractSize: 100000,
      exitPrice: 1.109,
      profit: 200,
      reason: "take_profit",
      closedAt: Date.now(),
    });

    expect(second.context).toBeNull();
  });

  it("prunes a signal context older than the 30-day retention window, so a much-later close honestly reports context: null", () => {
    const stale = Date.now() - 31 * 24 * 60 * 60 * 1000;
    mod.tradeJournal.recordSignalContext(buildContext({ signalId: "sig-1", createdAt: stale }));
    // Pruning runs on every recordSignalContext call -- a second, unrelated context
    // recorded now is what actually triggers the sweep that evicts the stale one.
    mod.tradeJournal.recordSignalContext(buildContext({ signalId: "sig-2", createdAt: Date.now() }));

    const entry = mod.tradeJournal.recordOutcome({
      dealId: "deal-1",
      signalId: "sig-1",
      account: "live",
      pair: "EUR/USD",
      direction: "long",
      entryPrice: 1.105,
      stopLoss: 1.103,
      lots: 0.5,
      contractSize: 100000,
      exitPrice: 1.109,
      profit: 200,
      reason: "take_profit",
      closedAt: Date.now(),
    });

    expect(entry.context).toBeNull();
  });

  it("all() returns entries most-recent-first", () => {
    mod.tradeJournal.recordOutcome({
      dealId: "deal-1",
      signalId: "sig-1",
      account: "live",
      pair: "EUR/USD",
      direction: "long",
      entryPrice: 1.105,
      stopLoss: 1.103,
      lots: 0.5,
      contractSize: 100000,
      exitPrice: 1.109,
      profit: 200,
      reason: "take_profit",
      closedAt: 1000,
    });
    mod.tradeJournal.recordOutcome({
      dealId: "deal-2",
      signalId: "sig-2",
      account: "live",
      pair: "EUR/USD",
      direction: "long",
      entryPrice: 1.105,
      stopLoss: 1.103,
      lots: 0.5,
      contractSize: 100000,
      exitPrice: 1.109,
      profit: 200,
      reason: "take_profit",
      closedAt: 2000,
    });

    expect(mod.tradeJournal.all().map((e) => e.id)).toEqual(["deal-2", "deal-1"]);
  });
});

describe("getPerformanceStats", () => {
  it("counts wins/losses and computes a real win rate", () => {
    const entries = [
      buildEntry({ id: "1", profit: 100, rMultiple: 1 }),
      buildEntry({ id: "2", profit: -50, rMultiple: -1 }),
      buildEntry({ id: "3", profit: 200, rMultiple: 2 }),
    ];
    const stats = getPerformanceStats(entries);
    expect(stats).toMatchObject({ count: 3, wins: 2, losses: 1 });
    expect(stats.winRate).toBeCloseTo((2 / 3) * 100);
  });

  it("reports an honest zero win rate for an empty set, not NaN", () => {
    expect(getPerformanceStats([]).winRate).toBe(0);
    expect(getPerformanceStats([]).averageR).toBeNull();
    expect(getPerformanceStats([]).maxDrawdownR).toBeNull();
  });

  it("averages only the entries with a real, computed rMultiple -- never fabricating one for null entries", () => {
    const entries = [
      buildEntry({ id: "1", profit: 100, rMultiple: 1 }),
      buildEntry({ id: "2", profit: 100, rMultiple: null, riskDollars: null }),
      buildEntry({ id: "3", profit: 200, rMultiple: 3 }),
    ];
    const stats = getPerformanceStats(entries);
    expect(stats.count).toBe(3); // still counted toward count/wins -- profit itself is always real
    expect(stats.averageR).toBe(2); // (1 + 3) / 2, the null entry excluded
  });

  it("computes peak-to-trough max drawdown on the chronological R sequence", () => {
    const entries = [
      buildEntry({ id: "1", closedAt: 1, rMultiple: 2 }),
      buildEntry({ id: "2", closedAt: 2, rMultiple: -1 }),
      buildEntry({ id: "3", closedAt: 3, rMultiple: -1 }),
      buildEntry({ id: "4", closedAt: 4, rMultiple: 3 }),
    ];
    // Cumulative: 2, 1, 0, 3. Peak reached before the trough: 2. Drop to trough: 2 - 0 = 2.
    const stats = getPerformanceStats(entries);
    expect(stats.maxDrawdownR).toBe(2);
    expect(stats.averageR).toBeCloseTo(0.75);
  });

  it("filters by pair, timeframe, session, and regime", () => {
    const entries = [
      buildEntry({ id: "1", pair: "EUR/USD", context: buildContext({ session: "london", regime: "strong_uptrend" }) }),
      buildEntry({ id: "2", pair: "GBP/USD", context: buildContext({ session: "newyork", regime: "range" }) }),
    ];
    expect(getPerformanceStats(entries, { pair: "EUR/USD" }).count).toBe(1);
    expect(getPerformanceStats(entries, { session: "newyork" }).count).toBe(1);
    expect(getPerformanceStats(entries, { regime: "range" }).count).toBe(1);
    expect(getPerformanceStats(entries, { pair: "USD/JPY" }).count).toBe(0);
  });

  it("filters by whether Signer B agreed with the trade's own direction at signal time", () => {
    const entries = [
      buildEntry({ id: "1", direction: "long", context: buildContext({ signerBDirection: "long" }) }),
      buildEntry({ id: "2", direction: "long", context: buildContext({ signerBDirection: "short" }) }),
      buildEntry({ id: "3", direction: "long", context: null }),
    ];
    expect(getPerformanceStats(entries, { signerBAgreement: true }).count).toBe(1);
    expect(getPerformanceStats(entries, { signerBAgreement: false }).count).toBe(2);
  });
});

describe("getPerformanceBreakdown", () => {
  it("groups by pair and each bucket's stats sum back to the same totals as the aggregate", () => {
    const entries = [
      buildEntry({ id: "1", pair: "EUR/USD", profit: 100, rMultiple: 1 }),
      buildEntry({ id: "2", pair: "EUR/USD", profit: -50, rMultiple: -1 }),
      buildEntry({ id: "3", pair: "GBP/USD", profit: 200, rMultiple: 2 }),
    ];
    const breakdown = getPerformanceBreakdown(entries, "pair");
    expect(Object.keys(breakdown).sort()).toEqual(["EUR/USD", "GBP/USD"]);
    expect(breakdown["EUR/USD"].count).toBe(2);
    expect(breakdown["GBP/USD"].count).toBe(1);
    const totalCount = Object.values(breakdown).reduce((sum, s) => sum + s.count, 0);
    expect(totalCount).toBe(getPerformanceStats(entries).count);
  });

  it("groups by session, skipping entries with no context", () => {
    const entries = [
      buildEntry({ id: "1", context: buildContext({ session: "london" }) }),
      buildEntry({ id: "2", context: buildContext({ session: "newyork" }) }),
      buildEntry({ id: "3", context: null }),
    ];
    const breakdown = getPerformanceBreakdown(entries, "session");
    expect(Object.keys(breakdown).sort()).toEqual(["london", "newyork"]);
    expect(breakdown.london.count).toBe(1);
    expect(breakdown.newyork.count).toBe(1);
  });

  it("returns an empty object for an empty entry list", () => {
    expect(getPerformanceBreakdown([], "pair")).toEqual({});
  });
});

function buildOutcome(overrides: Partial<SignalOutcome> = {}): SignalOutcome {
  return { signalId: "sig-1", pair: "EUR/USD", outcome: "approved", reason: null, timestamp: 1, ...overrides };
}

describe("getSignalFunnelStats", () => {
  it("counts each outcome type independently", () => {
    const outcomes = [
      buildOutcome({ signalId: "1", outcome: "approved" }),
      buildOutcome({ signalId: "2", outcome: "approved" }),
      buildOutcome({ signalId: "3", outcome: "rejected" }),
      buildOutcome({ signalId: "4", outcome: "expired" }),
      buildOutcome({ signalId: "5", outcome: "blocked", reason: "signal_only_mode" }),
      buildOutcome({ signalId: "6", outcome: "blocked", reason: "watch_tier" }),
    ];
    expect(getSignalFunnelStats(outcomes)).toEqual({ approved: 2, rejected: 1, expired: 1, blocked: 2 });
  });

  it("returns all zeros for an empty list", () => {
    expect(getSignalFunnelStats([])).toEqual({ approved: 0, rejected: 0, expired: 0, blocked: 0 });
  });
});

describe("getConfidenceCalibration", () => {
  it("reports insufficient_data below the minimum sample size, with null stats", () => {
    const entries = [
      buildEntry({ id: "1", profit: 100, rMultiple: 2, context: buildContext({ confidence: 92 }) }),
      buildEntry({ id: "2", profit: -50, rMultiple: -1, context: buildContext({ confidence: 91 }) }),
    ];

    const [buy] = getConfidenceCalibration(entries, 30);
    expect(buy).toEqual({ tier: "buy", sampleSize: 2, status: "insufficient_data", winRate: null, averageR: null, expectancy: null });
  });

  it("reports real calibrated stats once the minimum sample size is reached", () => {
    const entries = [
      buildEntry({ id: "1", profit: 100, rMultiple: 2, context: buildContext({ confidence: 92 }) }),
      buildEntry({ id: "2", profit: -50, rMultiple: -1, context: buildContext({ confidence: 91 }) }),
    ];

    const [buy] = getConfidenceCalibration(entries, 2);
    expect(buy.status).toBe("calibrated");
    expect(buy.sampleSize).toBe(2);
    expect(buy.winRate).toBe(50);
    expect(buy.averageR).toBeCloseTo(0.5); // (2 + -1) / 2
    expect(buy.expectancy).toBe(buy.averageR); // same number, not a second computation
  });

  it("buckets by the signal's tier at fire time -- confidence >= 95 is strong_buy, below is buy", () => {
    const entries = [
      buildEntry({ id: "1", context: buildContext({ confidence: 94 }) }), // buy
      buildEntry({ id: "2", context: buildContext({ confidence: 95 }) }), // strong_buy
      buildEntry({ id: "3", context: buildContext({ confidence: 100 }) }), // strong_buy
    ];

    const [buy, strongBuy] = getConfidenceCalibration(entries, 1);
    expect(buy.sampleSize).toBe(1);
    expect(strongBuy.sampleSize).toBe(2);
  });

  it("excludes entries with no captured context -- there's no confidence to bucket them by", () => {
    const entries = [buildEntry({ id: "1", context: buildContext({ confidence: 92 }) }), buildEntry({ id: "2", context: null })];

    const [buy] = getConfidenceCalibration(entries, 1);
    expect(buy.sampleSize).toBe(1);
  });

  it("returns insufficient_data for both tiers on an empty list", () => {
    const result = getConfidenceCalibration([], 30);
    expect(result).toEqual([
      { tier: "buy", sampleSize: 0, status: "insufficient_data", winRate: null, averageR: null, expectancy: null },
      { tier: "strong_buy", sampleSize: 0, status: "insufficient_data", winRate: null, averageR: null, expectancy: null },
    ]);
  });
});

describe("getSignerBCalibration", () => {
  it("buckets by Signer B's own confidence, independently of the fired signal's own confidence", () => {
    const entries = [
      buildEntry({ id: "1", context: buildContext({ confidence: 92, signerBConfidence: 45 }) }), // no_trade
      buildEntry({ id: "2", context: buildContext({ confidence: 92, signerBConfidence: 85 }) }), // watch
      buildEntry({ id: "3", context: buildContext({ confidence: 92, signerBConfidence: 92 }) }), // buy
      buildEntry({ id: "4", context: buildContext({ confidence: 92, signerBConfidence: 97 }) }), // strong_buy
    ];

    const [noTrade, watch, buy, strongBuy] = getSignerBCalibration(entries, 1);
    expect(noTrade.sampleSize).toBe(1);
    expect(watch.sampleSize).toBe(1);
    expect(buy.sampleSize).toBe(1);
    expect(strongBuy.sampleSize).toBe(1);
  });

  it("can bucket a fired signal's Signer B confidence as low as no_trade -- agreement alone gates a signal, not any Signer B confidence floor", () => {
    const entries = [buildEntry({ id: "1", context: buildContext({ signerBConfidence: 45 }) })];

    const [noTrade] = getSignerBCalibration(entries, 1);
    expect(noTrade.sampleSize).toBe(1);
    expect(noTrade.status).toBe("calibrated");
  });

  it("reports real calibrated stats once the minimum sample size is reached", () => {
    const entries = [
      buildEntry({ id: "1", profit: 100, rMultiple: 2, context: buildContext({ signerBConfidence: 92 }) }),
      buildEntry({ id: "2", profit: -50, rMultiple: -1, context: buildContext({ signerBConfidence: 91 }) }),
    ];

    const [, , buy] = getSignerBCalibration(entries, 2);
    expect(buy.status).toBe("calibrated");
    expect(buy.sampleSize).toBe(2);
    expect(buy.winRate).toBe(50);
    expect(buy.averageR).toBeCloseTo(0.5);
    expect(buy.expectancy).toBe(buy.averageR);
  });

  it("excludes entries with no captured context", () => {
    const entries = [buildEntry({ id: "1", context: buildContext({ signerBConfidence: 92 }) }), buildEntry({ id: "2", context: null })];

    const [, , buy] = getSignerBCalibration(entries, 1);
    expect(buy.sampleSize).toBe(1);
  });

  it("returns insufficient_data for all four tiers on an empty list", () => {
    const result = getSignerBCalibration([], 30);
    expect(result).toEqual([
      { tier: "no_trade", sampleSize: 0, status: "insufficient_data", winRate: null, averageR: null, expectancy: null },
      { tier: "watch", sampleSize: 0, status: "insufficient_data", winRate: null, averageR: null, expectancy: null },
      { tier: "buy", sampleSize: 0, status: "insufficient_data", winRate: null, averageR: null, expectancy: null },
      { tier: "strong_buy", sampleSize: 0, status: "insufficient_data", winRate: null, averageR: null, expectancy: null },
    ]);
  });
});
