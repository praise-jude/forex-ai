import { pipSize } from "./symbols";
import type { ExecutedTrade, Pair } from "./types";

/** One filled trade's execution quality, in pips -- positive means adverse (filled
 * worse than requested, cost you), negative means favorable (filled better than
 * requested). Direction-aware: for a long, filling higher than requested is adverse;
 * for a short, filling lower than requested is adverse. */
export interface SlippagePoint {
  tradeId: string;
  pair: Pair;
  slippagePips: number;
  attemptedAt: number;
}

export interface SlippageStats {
  count: number;
  /** Null when count is 0 -- an honest "nothing to report" rather than 0, which would
   * misleadingly read as "zero average slippage" instead of "no data". */
  averagePips: number | null;
  /** 0-100. 0 (not NaN) when count is 0, same posture as tradeJournal.ts's winRate. */
  adverseRate: number;
  worstAdversePips: number | null;
  bestFavorablePips: number | null;
}

function slippagePipsFor(trade: ExecutedTrade): number | null {
  if (trade.status !== "filled" || trade.filledEntry === undefined) return null;
  const pip = pipSize(trade.pair);
  const raw = trade.direction === "long" ? trade.filledEntry - trade.requestedEntry : trade.requestedEntry - trade.filledEntry;
  return raw / pip;
}

/** Only filled trades with a recorded fill price carry real slippage -- pending/
 * rejected attempts never reached a broker fill, so there's nothing to measure. */
export function getSlippagePoints(trades: ExecutedTrade[]): SlippagePoint[] {
  return trades
    .map((trade) => {
      const slippagePips = slippagePipsFor(trade);
      return slippagePips === null ? null : { tradeId: trade.id, pair: trade.pair, slippagePips, attemptedAt: trade.attemptedAt };
    })
    .filter((point): point is SlippagePoint => point !== null);
}

/**
 * "Is the broker filling me at a worse price than I asked for, and by how much" --
 * requestedEntry/filledEntry are already recorded on every filled ExecutedTrade
 * (positionStore.ts) but were never aggregated into anything the operator could see.
 * Pure aggregation over already-computed points, same posture as
 * tradeJournal.ts's getPerformanceStats.
 */
export function getSlippageStats(points: SlippagePoint[]): SlippageStats {
  const count = points.length;
  if (count === 0) return { count: 0, averagePips: null, adverseRate: 0, worstAdversePips: null, bestFavorablePips: null };

  const values = points.map((p) => p.slippagePips);
  const averagePips = values.reduce((sum, v) => sum + v, 0) / count;
  const adverseRate = (values.filter((v) => v > 0).length / count) * 100;

  return {
    count,
    averagePips,
    adverseRate,
    worstAdversePips: Math.max(...values),
    bestFavorablePips: Math.min(...values),
  };
}

/** "Which pairs slip the most" -- same per-pair grouping shape as
 * tradeJournal.ts's getPerformanceBreakdown, just over slippage points instead of
 * journal entries. */
export function getSlippageBreakdownByPair(points: SlippagePoint[]): Record<string, SlippageStats> {
  const buckets = new Map<string, SlippagePoint[]>();
  for (const point of points) {
    const bucket = buckets.get(point.pair);
    if (bucket) bucket.push(point);
    else buckets.set(point.pair, [point]);
  }

  const breakdown: Record<string, SlippageStats> = {};
  for (const [pair, bucketPoints] of buckets) breakdown[pair] = getSlippageStats(bucketPoints);
  return breakdown;
}
