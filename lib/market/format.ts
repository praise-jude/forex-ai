import type { Pair } from "./types";
import { decimals } from "./symbols";

export function formatPrice(pair: Pair, value: number): string {
  return value.toFixed(decimals(pair));
}

/** A static "typical duration" figure (e.g. a median time-to-target across past
 * trades) rather than a live-counting elapsed timer -- see PositionsPanel.tsx's own
 * formatDuration for that different use case (elapsed-since-open, seconds precision,
 * deliberately no days tier). This one adds a days tier (a median can genuinely span
 * multiple days on a higher timeframe) and drops seconds entirely -- a static average
 * has no business claiming second-level precision. */
export function formatDurationApprox(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** A "typical window" readout (e.g. computeDurationStats' p25Ms-p75Ms) -- deliberately
 * two numbers, not one: most past trades in a bucket resolved somewhere in this range,
 * which is what "caution, this one's already taking longer than usual" needs to compare
 * an open position's real elapsed time against. Collapses to a single figure when the
 * two round to the same display string (e.g. both land in "0m" for a very tight, very
 * fast bucket), rather than showing a meaningless "12m-12m". */
export function formatDurationRange(loMs: number, hiMs: number): string {
  const lo = formatDurationApprox(loMs);
  const hi = formatDurationApprox(hiMs);
  return lo === hi ? lo : `${lo}–${hi}`;
}
