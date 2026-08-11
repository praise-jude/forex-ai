import type { Timeframe } from "./types";

/** Milliseconds per bar for each tracked timeframe -- shared so the chart's forecast-
 * curve spacing and the prediction card's staleness check can't silently drift apart. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};
