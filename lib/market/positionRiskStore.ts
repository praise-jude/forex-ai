import type { PositionRiskLevel } from "./types";

// Voice/push notifications must only fire on a real level CHANGE, not every candle
// close a position happens to still be at "caution" -- the same "smart alert filter"
// reasoning the rest of this app's notifications already follow (e.g.
// calibrationMilestoneNotifications only fires on crossing a real milestone, never on
// every read). This is that state, keyed by broker position id so it survives across
// candle closes for as long as the position stays open. Purely a notification-dedup
// concern -- PositionsPanel.tsx's own passive display always shows the fresh, current
// assessment regardless of what's recorded here (see /api/positions).
const MAX_RECORDS = 200;

const byPositionId = new Map<string, PositionRiskLevel>();

export function getLastPositionRiskLevel(positionId: string): PositionRiskLevel | undefined {
  return byPositionId.get(positionId);
}

export function setLastPositionRiskLevel(positionId: string, level: PositionRiskLevel): void {
  // Map.set on an existing key does NOT move it in iteration order -- only a fresh
  // insertion does (see positionDurationCautionStore.ts, which had the same bug: a
  // long-open position re-recorded every candle close would stay "oldest" forever and
  // still get evicted once MAX_RECORDS other positions are recorded). Deleting first
  // forces re-insertion at the end.
  byPositionId.delete(positionId);
  byPositionId.set(positionId, level);
  if (byPositionId.size > MAX_RECORDS) {
    const oldest = byPositionId.keys().next().value;
    if (oldest !== undefined) byPositionId.delete(oldest);
  }
}
