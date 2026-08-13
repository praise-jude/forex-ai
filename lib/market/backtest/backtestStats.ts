import type { JournalEntry, SignalContext } from "../tradeJournal";
import { scoreSetupQuality } from "../setupQualityScore";
import type { BacktestBarResult } from "./backtestEngine";

/** Arbitrary but disclosed fixed stake used to convert R-multiples into dollar figures
 * -- no real lot sizing, spread, commission, or compounding is simulated (see
 * positionSizing.ts's own live computeLotSize, which needs a live SymbolSpec that
 * doesn't meaningfully apply to a historical bar). Only affects the dollar-denominated
 * profit/riskDollars fields; every R-multiple/win-rate figure is unaffected by this
 * constant's actual value. */
export const HYPOTHETICAL_RISK_DOLLARS = 100;

export interface BacktestJournalConversion {
  entries: JournalEntry[];
  /** Signals that fired but never hit SL or TP1 before the requested window ran out --
   * excluded from `entries` (and therefore from every win-rate/R stat) rather than
   * counted with a fabricated profit of 0, which would silently understate the real
   * win rate. Surfaced here as an honest, separate count instead. */
  openAtWindowEnd: number;
}

/**
 * Converts fired-and-resolved backtest signals into the exact same JournalEntry shape
 * the live trade journal uses, building each entry's `context` the same way
 * metaApiConnection.ts's live recordSignalContext does -- so getPerformanceStats
 * (tradeJournal.ts, already tested) can be reused completely unmodified for the core
 * backtest stats, and its existing pair/timeframe/session/regime/signerBAgreement
 * filters all work for free here too.
 */
export function toJournalEntries(results: BacktestBarResult[], hypotheticalRiskDollars = HYPOTHETICAL_RISK_DOLLARS): BacktestJournalConversion {
  const entries: JournalEntry[] = [];
  let openAtWindowEnd = 0;

  for (const result of results) {
    if (result.evaluation.status !== "signal" || !result.outcome) continue;
    const { signal } = result.evaluation;
    const { outcome } = result;

    if (outcome.reason === "still_open_at_end") {
      openAtWindowEnd++;
      continue;
    }

    const context: SignalContext = {
      signalId: signal.id,
      pair: signal.pair,
      timeframe: signal.timeframe,
      direction: signal.direction,
      regime: result.regime,
      setupQuality: scoreSetupQuality(signal, result.regime),
      confidence: signal.confidence,
      signerBDirection: signal.signerBDirection,
      signerBConfidence: signal.signerBConfidence,
      adx: signal.adx,
      rsi: signal.rsi,
      newsStatus: signal.newsStatus,
      session: signal.session,
      createdAt: signal.createdAt,
    };

    entries.push({
      id: signal.id,
      signalId: signal.id,
      account: "live", // backtests always read history via the live account's connection (see historyLoader.ts) -- placeholder only, unused by getPerformanceStats
      pair: signal.pair,
      timeframe: signal.timeframe,
      direction: signal.direction,
      entryPrice: signal.entry,
      exitPrice: outcome.exitPrice,
      profit: Number((outcome.rMultiple * hypotheticalRiskDollars).toFixed(2)),
      riskDollars: hypotheticalRiskDollars,
      rMultiple: outcome.rMultiple,
      reason: outcome.reason,
      closedAt: outcome.exitTime,
      context,
    });
  }

  return { entries, openAtWindowEnd };
}

/** Gross winning profit / gross losing profit (as a positive number). Null when there's
 * no losing trade to divide by, matching getPerformanceStats' own "null when it
 * genuinely can't be computed" convention rather than returning Infinity. */
export function computeProfitFactor(entries: JournalEntry[]): number | null {
  const grossWin = entries.filter((e) => e.profit > 0).reduce((sum, e) => sum + e.profit, 0);
  const grossLoss = entries.filter((e) => e.profit < 0).reduce((sum, e) => sum + Math.abs(e.profit), 0);
  if (grossLoss === 0) return null;
  return Number((grossWin / grossLoss).toFixed(2));
}

/** Mean R-multiple / standard deviation of R-multiples across entries with a real
 * rMultiple -- a simple per-trade Sharpe-style ratio, not annualized (this app has no
 * fixed trade cadence to annualize against). Null with fewer than 2 data points or zero
 * variance, both of which make the ratio meaningless rather than just small. */
export function computeSharpeRatio(entries: JournalEntry[]): number | null {
  const rValues = entries.map((e) => e.rMultiple).filter((r): r is number => r !== null);
  if (rValues.length < 2) return null;
  const mean = rValues.reduce((sum, r) => sum + r, 0) / rValues.length;
  const variance = rValues.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (rValues.length - 1);
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return null;
  return Number((mean / stdev).toFixed(3));
}

export interface StreakStats {
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
}

/** Chronological (by closedAt), counting strictly-positive-profit and
 * strictly-negative-profit runs -- a profit of exactly 0 (theoretically possible, never
 * actually produced by simulateOutcome today) breaks a streak without extending either. */
export function computeStreaks(entries: JournalEntry[]): StreakStats {
  const chronological = entries.slice().sort((a, b) => a.closedAt - b.closedAt);
  let maxWins = 0;
  let maxLosses = 0;
  let currentWins = 0;
  let currentLosses = 0;

  for (const entry of chronological) {
    if (entry.profit > 0) {
      currentWins++;
      currentLosses = 0;
    } else if (entry.profit < 0) {
      currentLosses++;
      currentWins = 0;
    } else {
      currentWins = 0;
      currentLosses = 0;
    }
    maxWins = Math.max(maxWins, currentWins);
    maxLosses = Math.max(maxLosses, currentLosses);
  }

  return { maxConsecutiveWins: maxWins, maxConsecutiveLosses: maxLosses };
}

export interface ScoreRangeBucket {
  range: string;
  count: number;
  winRate: number;
  averageR: number | null;
}

const SCORE_RANGES: { range: string; min: number; max: number }[] = [
  { range: "80-89", min: 80, max: 90 },
  { range: "90-94", min: 90, max: 95 },
  { range: "95-100", min: 95, max: 101 },
];

/** Buckets by the signal's own confidence score (see confidenceScore.ts's 95/90/80
 * tier boundaries) -- a one-off summary breakdown for the backtest report, deliberately
 * not folded into PerformanceFilter (tradeJournal.ts), which has no notion of a score
 * range and shouldn't grow one just for this report. */
export function computeScoreRangeBreakdown(entries: JournalEntry[]): ScoreRangeBucket[] {
  return SCORE_RANGES.map(({ range, min, max }) => {
    const bucket = entries.filter((e) => e.context && e.context.confidence >= min && e.context.confidence < max);
    const wins = bucket.filter((e) => e.profit > 0).length;
    const rValues = bucket.map((e) => e.rMultiple).filter((r): r is number => r !== null);
    const averageR = rValues.length === 0 ? null : rValues.reduce((sum, r) => sum + r, 0) / rValues.length;
    return { range, count: bucket.length, winRate: bucket.length === 0 ? 0 : (wins / bucket.length) * 100, averageR };
  });
}
