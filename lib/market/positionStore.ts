import type { AccountKey, ExecutedTrade } from "./types";

type AttemptInput = Omit<ExecutedTrade, "status" | "filledEntry" | "brokerPositionId" | "brokerOrderId" | "rejectReason" | "filledAt">;

// Bounds the audit ledger so a long-running process doesn't grow this (and the
// /api/signals payload that serializes all of it) unbounded -- generous relative to
// realistic trade volume (a handful of trades/day), so this only ever prunes ancient
// history. See PositionStore.prune()'s own comment for why this is safe with respect to
// hasExecuted()'s idempotency guard.
const MAX_RECORDS = 1000;

/**
 * The execution audit ledger — "why did we take this trade" (which signal, intended
 * risk %, requested vs filled). NOT a live-position mirror: what's actually open right
 * now with live P/L comes from the broker's own terminal state, not this store.
 *
 * Keyed by `account:signalId`, not just `signalId` — the same signal can legitimately be
 * attempted once per account (e.g. auto-fired on demo, and separately, manually, on live)
 * without those two attempts shadowing each other's idempotency guard.
 */
class PositionStore {
  private byKey = new Map<string, ExecutedTrade>();

  private key(signalId: string, account: AccountKey): string {
    return `${account}:${signalId}`;
  }

  /** True once a signal has been attempted for this account, regardless of outcome. */
  hasExecuted(signalId: string, account: AccountKey = "live"): boolean {
    return this.byKey.has(this.key(signalId, account));
  }

  /**
   * Reserves the signal id (for its account) in "pending" status. Must be called
   * synchronously — before the first `await` of the broker call — so it's race-free
   * against Node's single-threaded execution and can't double-fire on a duplicate event
   * delivery.
   */
  recordAttempt(input: AttemptInput): ExecutedTrade {
    const record: ExecutedTrade = { ...input, status: "pending" };
    this.byKey.set(this.key(input.signalId, input.account), record);
    this.prune();
    return record;
  }

  /**
   * Drops the oldest-attempted entries once the ledger exceeds MAX_RECORDS. Safe with
   * respect to hasExecuted()'s idempotency guard: a signal can only ever reach
   * attemptExecution() while it still exists in signalStore, which itself prunes after
   * 4 hours (see signalStore.ts's STALE_AFTER_MS) -- by the time an entry here is old
   * enough to be evicted, the signal it was guarding is already unreachable via the
   * normal execute route (signalStore.get() returns undefined first), so eviction can
   * never actually reopen a duplicate-execution window in practice.
   */
  private prune(): void {
    if (this.byKey.size <= MAX_RECORDS) return;
    const entries = Array.from(this.byKey.entries()).sort((a, b) => a[1].attemptedAt - b[1].attemptedAt);
    const excess = entries.length - MAX_RECORDS;
    for (let i = 0; i < excess; i++) this.byKey.delete(entries[i][0]);
  }

  markFilled(
    signalId: string,
    update: { filledEntry: number; brokerPositionId?: string; brokerOrderId?: string; filledAt: number },
    account: AccountKey = "live"
  ): void {
    const record = this.byKey.get(this.key(signalId, account));
    if (!record) return;
    record.status = "filled";
    record.filledEntry = update.filledEntry;
    record.brokerPositionId = update.brokerPositionId;
    record.brokerOrderId = update.brokerOrderId;
    record.filledAt = update.filledAt;
  }

  markRejected(signalId: string, rejectReason: string, account: AccountKey = "live"): void {
    const record = this.byKey.get(this.key(signalId, account));
    if (!record) return;
    record.status = "rejected";
    record.rejectReason = rejectReason;
  }

  all(): ExecutedTrade[] {
    return Array.from(this.byKey.values()).sort((a, b) => b.attemptedAt - a.attemptedAt);
  }

  /** Filled trades for the given account whose attempt falls on the given UTC day. */
  tradesOnDay(dayKey: string, account: AccountKey = "live"): ExecutedTrade[] {
    return this.all().filter(
      (trade) =>
        trade.account === account &&
        trade.status === "filled" &&
        new Date(trade.attemptedAt).toISOString().slice(0, 10) === dayKey
    );
  }
}

const globalKey = Symbol.for("forex-ai.positionStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: PositionStore };
const g = globalThis as GlobalWithStore;

export const positionStore: PositionStore = g[globalKey] ?? (g[globalKey] = new PositionStore());
