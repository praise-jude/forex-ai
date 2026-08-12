import type { PredictionUpdate, Signal, Timeframe } from "./types";

// The dashboard's own default/primary timeframe (see Dashboard.tsx's useState<Timeframe>
// default) -- used here so a pair blocked simultaneously on 15m/30m/1h counts once in
// waitingSetups/blockedByNews, not three times (one per concurrently-running engine).
const PRIMARY_TIMEFRAME: Timeframe = "15m";

// Longer than the fastest tracked signal timeframe (15m, see metaApiConnection.ts's
// SIGNAL_TIMEFRAMES) so ordinary candle-close timing never false-positives as "stuck" --
// only a genuine stall (the pipeline actually not running) trips this.
const STALE_THRESHOLD_MS = 20 * 60 * 1000;

export type PipelineHealth = "fresh" | "stale" | "unknown";

export interface AutopilotStatus {
  marketsMonitored: number;
  /** Most recent evaluation timestamp across every pair/timeframe -- null only when no
   * analysis has ever run yet (fresh boot). */
  lastAnalysisAt: number | null;
  /** "unknown" before the first analysis ever runs, "stale" when the most recent
   * analysis is older than a fastest-timeframe candle interval should allow (a genuine
   * "the engine appears stuck" signal, not decoration), "fresh" otherwise. */
  pipelineHealth: PipelineHealth;
  activeSignals: number;
  waitingSetups: number;
  blockedByNews: number;
}

/**
 * A real, derived "is the engine alive" summary for the dashboard -- every field
 * traces to actual predictionStore/signalStore data, nothing hardcoded or decorative
 * (see the "no fake diagnostic indicators" reasoning behind this file). `now` is
 * injectable for testability, mirroring riskState.current()'s own pattern.
 */
export function computeAutopilotStatus(
  predictions: PredictionUpdate[],
  signals: Signal[],
  marketsMonitored: number,
  now: number = Date.now()
): AutopilotStatus {
  const primary = predictions.filter((p) => p.timeframe === PRIMARY_TIMEFRAME);

  const lastAnalysisAt = predictions.reduce<number | null>((max, p) => (max === null || p.time > max ? p.time : max), null);
  const pipelineHealth: PipelineHealth =
    lastAnalysisAt === null ? "unknown" : now - lastAnalysisAt > STALE_THRESHOLD_MS ? "stale" : "fresh";

  const activeSignals = signals.filter((s) => s.tier !== "watch").length;
  const waitingSetups = primary.filter((p) => p.evaluation.status === "no_trade").length;
  const blockedByNews = primary.filter(
    (p) => p.evaluation.status === "no_trade" && p.evaluation.reason.code === "news_blackout"
  ).length;

  return { marketsMonitored, lastAnalysisAt, pipelineHealth, activeSignals, waitingSetups, blockedByNews };
}
