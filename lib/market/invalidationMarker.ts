// A tiny leaf store, deliberately dependency-free (same shape as priceStore.ts) -- exists
// so metaApiConnection.ts (which today only ever imports OTHER leaf stores like
// positionStore/priceStore/candleStore, never a higher-level business-logic module) can
// learn "this position's next close was caused by an invalidation exit" without importing
// positionInvalidation.ts directly, which would invert that existing dependency direction.
//
// positionInvalidation.ts calls mark() right after a confirmed-successful closePosition
// call; metaApiConnection.ts's journalCloseReasonFor calls consume() before falling back
// to the broker's own deal.reason mapping. Short TTL: generous for MetaApi's own
// sync/round-trip lag, short enough that a much-later, unrelated close of a since-reused
// broker position id can never be mislabeled.
const MARKS_TTL_MS = 2 * 60 * 1000;

const globalKey = Symbol.for("forex-ai.invalidationMarker");
type GlobalWithMarks = typeof globalThis & { [globalKey]?: Map<string, number> };
const g = globalThis as GlobalWithMarks;
const marks: Map<string, number> = g[globalKey] ?? (g[globalKey] = new Map());

export function mark(brokerPositionId: string): void {
  marks.set(brokerPositionId, Date.now());
}

/** True (and consumes the mark) only if a mark exists for this position and is still
 * fresh -- a stale or missing mark is treated as "not an invalidation exit", never
 * fabricated as one. */
export function consume(brokerPositionId: string, now: number = Date.now()): boolean {
  const markedAt = marks.get(brokerPositionId);
  marks.delete(brokerPositionId);
  return markedAt !== undefined && now - markedAt <= MARKS_TTL_MS;
}
