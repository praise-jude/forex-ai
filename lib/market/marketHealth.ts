import type { Price } from "./types";

// Documented starting point, not a claimed-precise figure (same posture as every other
// tuned constant in this codebase, e.g. maxSpreadFractionOfStop) -- comfortably longer
// than any normal gap between ticks while a market is genuinely open, short enough to
// flag a closed/frozen market (confirmed directly against a real weekend closure: a
// forex pair's price sat frozen for many hours past this threshold, while a still-open
// crypto pair kept ticking every few seconds).
export const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * An honest inference, not a broker-provided "market open" flag -- MetaApi doesn't
 * expose one directly. A price that hasn't ticked in longer than the threshold most
 * likely means the market for that symbol is closed right now, not that the connection
 * is broken (a healthy connection with a closed market simply stops receiving new
 * ticks). Never asserted as ground truth in the UI, only ever labelled as inferred.
 */
export function isPriceStale(price: Price | undefined, now: number, thresholdMs = DEFAULT_STALE_THRESHOLD_MS): boolean {
  if (!price) return true;
  return now - price.time > thresholdMs;
}
