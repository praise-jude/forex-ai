// A tiny leaf store, same dependency-free shape as invalidationMarker.ts -- tracks
// broker position IDs whose close was JUST initiated by positionInvalidation.ts, for
// the brief window between "close request sent to the broker" and "MetaApi's
// real-time terminalState reflects it" (getOpenPositionCount reads that live broker
// state directly, not our own positionStore). Without this, a reversal's own new
// position could be blocked by checkRiskLimits' maxConcurrentPositions cap counting
// the exact slot the invalidation close is in the middle of vacating.
//
// Short TTL: generous for the close round-trip (MetaApi sync lag), short enough that a
// stuck or failed close doesn't permanently under-count real open positions and quietly
// let the account exceed its configured concurrent-position cap.
const PENDING_TTL_MS = 30 * 1000;

const globalKey = Symbol.for("forex-ai.pendingInvalidationClose");
type GlobalWithPending = typeof globalThis & { [globalKey]?: Map<string, number> };
const g = globalThis as GlobalWithPending;
const pending: Map<string, number> = g[globalKey] ?? (g[globalKey] = new Map());

/** Called the moment positionInvalidation.ts decides to close a position -- synchronously,
 * before the async closePosition() call, so the window is covered from the earliest
 * possible instant. */
export function markPending(brokerPositionId: string): void {
  pending.set(brokerPositionId, Date.now());
}

/** Called once the close attempt resolves either way (success or failure) -- a failed
 * close must stop excluding the position too, since it's still genuinely open. */
export function clearPending(brokerPositionId: string): void {
  pending.delete(brokerPositionId);
}

/** True only if a mark exists and is still fresh -- a stale mark self-heals here rather
 * than requiring a separate cleanup timer. */
export function isPending(brokerPositionId: string, now: number = Date.now()): boolean {
  const markedAt = pending.get(brokerPositionId);
  if (markedAt === undefined) return false;
  if (now - markedAt > PENDING_TTL_MS) {
    pending.delete(brokerPositionId);
    return false;
  }
  return true;
}
