import type { Pair, PredictionUpdate, Timeframe } from "./types";

export interface EngineConflict {
  pair: Pair;
  timeframe: Timeframe;
  /** One entry per engine that actually fired a signal here -- always exactly 2 today
   * (SMC vs. mean_reversion, the only two engines that ever produce a real Signal), but
   * kept as a list rather than a fixed pair of fields so a third engine later doesn't
   * need a shape change here. */
  sides: { source: PredictionUpdate["source"]; direction: "long" | "short" }[];
}

/**
 * Flags a pair/timeframe where two different engines have BOTH produced a real,
 * currently-live qualifying Signal (not just a no-trade lean) in OPPOSING directions at
 * the same time -- e.g. SMC says BUY while the range engine says SELL on the same
 * EUR/USD M15 read. Deliberately narrow: only actual fired signals count, never a
 * no-trade reason's own impliedDirection field, since inventing a directional opinion
 * out of a reason that didn't qualify would be exactly the kind of fabricated certainty
 * this app avoids everywhere else (see confidenceScore.ts/candlestickPatterns.ts's own
 * doc comments on the same principle). A single engine alone, or two engines that agree,
 * is not a conflict -- this only reports the case where acting on one would contradict
 * the other.
 */
export function detectEngineConflicts(predictions: PredictionUpdate[]): EngineConflict[] {
  const bySlot = new Map<string, { source: PredictionUpdate["source"]; direction: "long" | "short" }[]>();

  for (const update of predictions) {
    if (update.evaluation.status !== "signal") continue;
    const key = `${update.pair}|${update.timeframe}`;
    const sides = bySlot.get(key) ?? [];
    sides.push({ source: update.source, direction: update.evaluation.signal.direction });
    bySlot.set(key, sides);
  }

  const conflicts: EngineConflict[] = [];
  for (const [key, sides] of bySlot) {
    const directions = new Set(sides.map((s) => s.direction));
    if (directions.size <= 1) continue;
    const [pair, timeframe] = key.split("|") as [Pair, Timeframe];
    conflicts.push({ pair, timeframe, sides });
  }
  return conflicts;
}
