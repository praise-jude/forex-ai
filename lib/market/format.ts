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
