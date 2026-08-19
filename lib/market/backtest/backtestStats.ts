import type { JournalEntry, SignalContext } from "../tradeJournal";
import { scoreSetupQuality } from "../setupQualityScore";
import { computeLotSize } from "../positionSizing";
import { pipSize } from "../symbols";
import type { Pair, Signal, SymbolSpec } from "../types";
import type { BacktestBarResult } from "./backtestEngine";

const USD_BASE_PAIRS: ReadonlySet<Pair> = new Set(["USD/JPY", "USD/CAD", "USD/CHF"]);

/**
 * Mirrors pipValue.ts's own pipValuePerLot, but takes an explicit historical reference
 * price instead of reading priceStore -- pipValuePerLot's live price lookup would
 * either return undefined (no live data during a pure backtest run) or, worse, silently
 * apply TODAY's real price to a historical bar from weeks ago, exactly the look-ahead
 * anti-pattern this app's own currency-strength handling already deliberately avoids
 * (see README's backtesting disclosure). For a USD-base pair, the pair's OWN historical
 * price at signal time already IS the needed conversion rate, so referencePrice is
 * always the signal's own entry -- a real, contemporaneous quote, never fabricated.
 */
function historicalPipValuePerLot(pair: Pair, contractSize: number, referencePrice: number): number {
  const quotePipValue = pipSize(pair) * contractSize;
  return USD_BASE_PAIRS.has(pair) ? quotePipValue / referencePrice : quotePipValue;
}

/** Default hypothetical starting equity for realistic-sizing backtests -- a documented,
 * configurable-by-caller starting point (not compounding across trades, see this
 * feature's own scope notes), not a claim about what any real account should hold. */
export const DEFAULT_HYPOTHETICAL_EQUITY = 10_000;

export interface RealisticSizingConfig {
  specs: Map<Pair, SymbolSpec>;
  equity: number;
  riskPct: number;
}

/**
 * Real lot-size math (computeLotSize, the same function live execution uses) in place
 * of a flat hypothetical stake -- falls back to hypotheticalRiskDollars per-entry,
 * never for the whole run, when a pair has no fetched spec or computeLotSize itself
 * skips (e.g. the risk-correct size would round to zero lots), same "log and degrade
 * gracefully, never fabricate" posture the rest of this app already follows.
 *
 * For USD-base pairs (USD/JPY, USD/CAD, USD/CHF), computeLotSize is given this same
 * historical pip value as an explicit override instead of letting it fall back to
 * pipValue.ts's live priceStore read -- lots are now sized off the real exchange rate
 * at the historical signal's own time, not today's. Previously these two used different
 * rates (lots sized off today's live rate, but the resulting dollar figure below
 * recomputed with the historical one), which meant the reported risk didn't actually
 * equal the requested risk % for these three pairs specifically -- fixed by sizing and
 * pricing off the same historical rate throughout.
 */
function realisticRiskDollars(signal: Signal, sizing: RealisticSizingConfig): number | null {
  const spec = sizing.specs.get(signal.pair);
  if (!spec) return null;
  const pipValue = historicalPipValuePerLot(signal.pair, spec.contractSize, signal.entry);
  const sizeResult = computeLotSize(signal, sizing.equity, sizing.riskPct, spec, pipValue);
  if ("skipped" in sizeResult) return null;

  const pips = Math.abs(signal.entry - signal.stopLoss) / pipSize(signal.pair);
  return Number((pips * pipValue * sizeResult.lots).toFixed(2));
}

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
export function toJournalEntries(
  results: BacktestBarResult[],
  hypotheticalRiskDollars = HYPOTHETICAL_RISK_DOLLARS,
  realisticSizing?: RealisticSizingConfig
): BacktestJournalConversion {
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

    // Falls back to the flat hypothetical stake per-entry (never for the whole run) when
    // realistic sizing was requested but couldn't be computed for this specific signal
    // (no fetched spec, or computeLotSize itself skipped) -- see realisticRiskDollars.
    const riskDollars = (realisticSizing && realisticRiskDollars(signal, realisticSizing)) ?? hypotheticalRiskDollars;

    entries.push({
      id: signal.id,
      signalId: signal.id,
      account: "live", // backtests always read history via the live account's connection (see historyLoader.ts) -- placeholder only, unused by getPerformanceStats
      pair: signal.pair,
      timeframe: signal.timeframe,
      direction: signal.direction,
      entryPrice: signal.entry,
      exitPrice: outcome.exitPrice,
      profit: Number((outcome.rMultiple * riskDollars).toFixed(2)),
      riskDollars,
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
