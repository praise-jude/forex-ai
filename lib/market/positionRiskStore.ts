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
  byPositionId.set(positionId, level);
  if (byPositionId.size > MAX_RECORDS) {
    const oldest = byPositionId.keys().next().value;
    if (oldest !== undefined) byPositionId.delete(oldest);
  }
}
