// Same dedup purpose as positionRiskStore.ts, for a different signal: whether an open,
// currently-losing position has already run longer than 75% of past losses on this pair
// took to hit their own stop (see tradeJournal.ts's computeDurationStats). Notifications
// must only fire on the real OFF -> ON transition, not every 15m candle close a position
// happens to still be past that window -- otherwise a position sitting in caution for
// hours would re-notify every single candle close. Keyed by broker position id, same as
// positionRiskStore.ts, so a brand-new position (even on the same pair) always starts
// fresh rather than inheriting a stale flag.
const MAX_RECORDS = 200;

const byPositionId = new Map<string, boolean>();

export function getLastDurationCaution(positionId: string): boolean | undefined {
  return byPositionId.get(positionId);
}

export function setLastDurationCaution(positionId: string, value: boolean): void {
  // Map.set on an existing key does NOT move it in iteration order -- only a fresh
  // insertion does. A long-open position re-recorded every candle close would otherwise
  // stay "oldest" forever and still get evicted below once MAX_RECORDS other positions
  // are recorded, silently dropping its caution flag and re-firing a duplicate
  // notification on the next candle. Deleting first forces re-insertion at the end.
  byPositionId.delete(positionId);
  byPositionId.set(positionId, value);
  if (byPositionId.size > MAX_RECORDS) {
    const oldest = byPositionId.keys().next().value;
    if (oldest !== undefined) byPositionId.delete(oldest);
  }
}
