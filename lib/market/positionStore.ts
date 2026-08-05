import type { ExecutedTrade } from "./types";

type AttemptInput = Omit<ExecutedTrade, "status" | "filledEntry" | "brokerPositionId" | "brokerOrderId" | "rejectReason" | "filledAt">;

/**
 * The execution audit ledger — "why did we take this trade" (which signal, intended
 * risk %, requested vs filled). NOT a live-position mirror: what's actually open right
 * now with live P/L comes from the broker's own terminal state, not this store.
 */
class PositionStore {
  private bySignalId = new Map<string, ExecutedTrade>();

  /** True once a signal has been attempted, regardless of outcome. */
  hasExecuted(signalId: string): boolean {
    return this.bySignalId.has(signalId);
  }

  /**
   * Reserves the signal id in "pending" status. Must be called synchronously — before
   * the first `await` of the broker call — so it's race-free against Node's
   * single-threaded execution and can't double-fire on a duplicate event delivery.
   */
  recordAttempt(input: AttemptInput): ExecutedTrade {
    const record: ExecutedTrade = { ...input, status: "pending" };
    this.bySignalId.set(input.signalId, record);
    return record;
  }

  markFilled(
    signalId: string,
    update: { filledEntry: number; brokerPositionId?: string; brokerOrderId?: string; filledAt: number }
  ): void {
    const record = this.bySignalId.get(signalId);
    if (!record) return;
    record.status = "filled";
    record.filledEntry = update.filledEntry;
    record.brokerPositionId = update.brokerPositionId;
    record.brokerOrderId = update.brokerOrderId;
    record.filledAt = update.filledAt;
  }

  markRejected(signalId: string, rejectReason: string): void {
    const record = this.bySignalId.get(signalId);
    if (!record) return;
    record.status = "rejected";
    record.rejectReason = rejectReason;
  }

  all(): ExecutedTrade[] {
    return Array.from(this.bySignalId.values()).sort((a, b) => b.attemptedAt - a.attemptedAt);
  }

  /** Filled trades whose attempt falls on the given UTC day. */
  tradesOnDay(dayKey: string): ExecutedTrade[] {
    return this.all().filter(
      (trade) => trade.status === "filled" && new Date(trade.attemptedAt).toISOString().slice(0, 10) === dayKey
    );
  }
}

const globalKey = Symbol.for("forex-ai.positionStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: PositionStore };
const g = globalThis as GlobalWithStore;

export const positionStore: PositionStore = g[globalKey] ?? (g[globalKey] = new PositionStore());
