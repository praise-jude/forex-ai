import type { Session, SignalSource } from "./types";
import { getPerformanceBreakdown, type JournalEntry, type PerformanceStats } from "./tradeJournal";

/**
 * Adaptive engine weighting: auto-reduce position size for whichever engine (SMC vs
 * mean-reversion) is underperforming over its recent closed trades, restore it when it
 * recovers. Session edge scoring does the same per killzone (asia/london/newyork).
 *
 * Both are SIZE-ONLY levers -- they shrink the risk on a statistically weaker bucket,
 * never block a trade outright and never grow size past 1.0. A bug here can only make
 * execution more conservative, never more aggressive. Both require a real sample of
 * closed trades before they engage at all (insufficient data => multiplier 1, no
 * effect), same "never act on too few trades" posture as tradeJournal's own
 * calibration buckets.
 */

export const DEFAULT_EDGE_MIN_SAMPLES = 10;

export interface EdgeBucket {
  sampleSize: number;
  /** Win rate as 0-100 (matches PerformanceStats.winRate). */
  winRate: number;
  /** Average R multiple; null when no entry in the bucket has a computed rMultiple. */
  expectancyR: number | null;
  /** Size multiplier derived from this bucket's measured edge. */
  sizeMultiplier: number;
  /** Human-readable explanation for the dashboard/settings UI. */
  reason: string;
}

export interface EdgeComputationOptions {
  minSamples?: number;
  /** Multiplier for a genuinely negative-expectancy bucket (e.g. 0.5 = half size). */
  negativeExpectancyMultiplier?: number;
  /** Multiplier for a non-negative-expectancy bucket. Default 1 (no boost -- this module
   * only ever de-risks, never presses). */
  positiveExpectancyMultiplier?: number;
}

function bucketFromStats(
  stats: PerformanceStats,
  minSamples: number,
  negativeMultiplier: number,
  positiveMultiplier: number
): EdgeBucket {
  const { count, winRate, averageR } = stats;
  if (count < minSamples) {
    return {
      sampleSize: count,
      winRate,
      expectancyR: averageR,
      sizeMultiplier: 1,
      reason: `insufficient data (${count}/${minSamples} trades) -- no adjustment`,
    };
  }
  // Null averageR means no rMultiple could be computed for any trade in the bucket --
  // treat as "no usable edge signal", no adjustment, rather than guessing.
  if (averageR === null) {
    return { sampleSize: count, winRate, expectancyR: null, sizeMultiplier: 1, reason: "no R data yet -- no adjustment" };
  }
  if (averageR < 0) {
    return {
      sampleSize: count,
      winRate,
      expectancyR: averageR,
      sizeMultiplier: negativeMultiplier,
      reason: `negative expectancy (${averageR.toFixed(2)}R over ${count} trades) -- size reduced to ${Math.round(negativeMultiplier * 100)}%`,
    };
  }
  return {
    sampleSize: count,
    winRate,
    expectancyR: averageR,
    sizeMultiplier: positiveMultiplier,
    reason: `positive expectancy (${averageR.toFixed(2)}R over ${count} trades) -- full size`,
  };
}

function resolveOptions(options: EdgeComputationOptions): Required<EdgeComputationOptions> {
  const minSamples = options.minSamples && options.minSamples > 0 ? Math.floor(options.minSamples) : DEFAULT_EDGE_MIN_SAMPLES;
  const negativeExpectancyMultiplier =
    options.negativeExpectancyMultiplier !== undefined && options.negativeExpectancyMultiplier > 0 && options.negativeExpectancyMultiplier < 1
      ? options.negativeExpectancyMultiplier
      : 0.5;
  const positiveExpectancyMultiplier =
    options.positiveExpectancyMultiplier !== undefined && options.positiveExpectancyMultiplier > 0 && options.positiveExpectancyMultiplier <= 1
      ? options.positiveExpectancyMultiplier
      : 1;
  return { minSamples, negativeExpectancyMultiplier, positiveExpectancyMultiplier };
}

/** Per-engine (SMC / mean-reversion) sizing multiplier from measured expectancy. */
export function engineSizeMultiplier(
  entries: JournalEntry[],
  source: SignalSource,
  options: EdgeComputationOptions = {}
): EdgeBucket {
  const { minSamples, negativeExpectancyMultiplier, positiveExpectancyMultiplier } = resolveOptions(options);
  const breakdown = getPerformanceBreakdown(entries, "source");
  const stats = breakdown[source];
  if (!stats) {
    return { sampleSize: 0, winRate: 0, expectancyR: null, sizeMultiplier: 1, reason: `no closed ${source} trades yet -- no adjustment` };
  }
  return bucketFromStats(stats, minSamples, negativeExpectancyMultiplier, positiveExpectancyMultiplier);
}

/** Per-session killzone sizing multiplier from measured expectancy. */
export function sessionSizeMultiplier(
  entries: JournalEntry[],
  session: Session,
  options: EdgeComputationOptions = {}
): EdgeBucket {
  const { minSamples, negativeExpectancyMultiplier, positiveExpectancyMultiplier } = resolveOptions(options);
  const breakdown = getPerformanceBreakdown(entries, "session");
  const stats = breakdown[session];
  if (!stats) {
    return { sampleSize: 0, winRate: 0, expectancyR: null, sizeMultiplier: 1, reason: `no closed ${session} trades yet -- no adjustment` };
  }
  return bucketFromStats(stats, minSamples, negativeExpectancyMultiplier, positiveExpectancyMultiplier);
}

/** Full session breakdown for the settings/analytics UI -- every session that has any
 * closed trades, with its multiplier and a plain-English reason. */
export function sessionEdgeBreakdown(entries: JournalEntry[], options: EdgeComputationOptions = {}): Record<string, EdgeBucket> {
  const { minSamples, negativeExpectancyMultiplier, positiveExpectancyMultiplier } = resolveOptions(options);
  const breakdown = getPerformanceBreakdown(entries, "session");
  const result: Record<string, EdgeBucket> = {};
  for (const [session, stats] of Object.entries(breakdown)) {
    result[session] = bucketFromStats(stats, minSamples, negativeExpectancyMultiplier, positiveExpectancyMultiplier);
  }
  return result;
}

/** Full engine breakdown for the settings/analytics UI. */
export function engineEdgeBreakdown(entries: JournalEntry[], options: EdgeComputationOptions = {}): Record<string, EdgeBucket> {
  const { minSamples, negativeExpectancyMultiplier, positiveExpectancyMultiplier } = resolveOptions(options);
  const breakdown = getPerformanceBreakdown(entries, "source");
  const result: Record<string, EdgeBucket> = {};
  for (const [source, stats] of Object.entries(breakdown)) {
    result[source] = bucketFromStats(stats, minSamples, negativeExpectancyMultiplier, positiveExpectancyMultiplier);
  }
  return result;
}
