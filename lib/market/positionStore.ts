import { desc, eq } from "drizzle-orm";
import { getOptionalDb } from "../db/optionalClient";
import { executedTrades as executedTradesTable } from "../db/tradingSchema";
import type { AccountKey, ExecutedTrade } from "./types";

type AttemptInput = Omit<ExecutedTrade, "status" | "filledEntry" | "brokerPositionId" | "brokerOrderId" | "rejectReason" | "filledAt">;

/** Best-effort inserts/updates, fired without awaiting from recordAttempt/markFilled/
 * markRejected below -- a DB failure must never affect execution, same "log, don't
 * throw" philosophy as pushNotifier.ts's sends. The in-memory Map stays the real,
 * synchronous source of truth (see PositionStore's own class doc on why recordAttempt
 * must run synchronously) -- these are a durability backstop, not a new read path. */
async function persistAttempt(record: ExecutedTrade): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db
    .insert(executedTradesTable)
    .values({
      id: record.id,
      signalId: record.signalId,
      account: record.account,
      pair: record.pair,
      timeframe: record.timeframe,
      direction: record.direction,
      requestedLots: record.requestedLots,
      requestedEntry: record.requestedEntry,
      stopLoss: record.stopLoss,
      takeProfit: record.takeProfit,
      takeProfit2: record.takeProfit2,
      status: record.status,
      riskPct: record.riskPct,
      attemptedAt: new Date(record.attemptedAt),
    })
    .onConflictDoNothing();
}

async function persistFilled(record: ExecutedTrade): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db
    .update(executedTradesTable)
    .set({
      status: "filled",
      filledEntry: record.filledEntry,
      brokerPositionId: record.brokerPositionId,
      brokerOrderId: record.brokerOrderId,
      filledAt: record.filledAt !== undefined ? new Date(record.filledAt) : undefined,
    })
    .where(eq(executedTradesTable.id, record.id));
}

async function persistRejected(record: ExecutedTrade): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db
    .update(executedTradesTable)
    .set({ status: "rejected", rejectReason: record.rejectReason })
    .where(eq(executedTradesTable.id, record.id));
}

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
    void persistAttempt(record).catch((error: unknown) => {
      console.error(`[positionStore] failed to persist attempt ${record.id}:`, error);
    });
    return record;
  }

  /** Reloads the most recent records from the DB into memory -- called once at boot (see
   * bootstrap.ts) so hasExecuted()'s idempotency guard and the dashboard's execution
   * ledger both survive a restart. No-ops when DATABASE_URL isn't set. Bypasses
   * recordAttempt() deliberately -- these rows already exist in the DB, so re-persisting
   * them on load would just be a wasted round trip. */
  async hydrate(): Promise<void> {
    const db = getOptionalDb();
    if (!db) return;
    const rows = await db.select().from(executedTradesTable).orderBy(desc(executedTradesTable.attemptedAt)).limit(MAX_RECORDS);
    for (const row of rows) {
      const record: ExecutedTrade = {
        id: row.id,
        signalId: row.signalId,
        account: row.account as AccountKey,
        pair: row.pair as ExecutedTrade["pair"],
        timeframe: row.timeframe as ExecutedTrade["timeframe"],
        direction: row.direction as ExecutedTrade["direction"],
        requestedLots: row.requestedLots,
        requestedEntry: row.requestedEntry,
        filledEntry: row.filledEntry ?? undefined,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        takeProfit2: row.takeProfit2,
        status: row.status as ExecutedTrade["status"],
        brokerPositionId: row.brokerPositionId ?? undefined,
        brokerOrderId: row.brokerOrderId ?? undefined,
        rejectReason: row.rejectReason ?? undefined,
        riskPct: row.riskPct,
        attemptedAt: row.attemptedAt.getTime(),
        filledAt: row.filledAt?.getTime(),
      };
      const key = this.key(record.signalId, record.account);
      if (!this.byKey.has(key)) this.byKey.set(key, record);
    }
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
    void persistFilled(record).catch((error: unknown) => {
      console.error(`[positionStore] failed to persist fill ${record.id}:`, error);
    });
  }

  markRejected(signalId: string, rejectReason: string, account: AccountKey = "live"): void {
    const record = this.byKey.get(this.key(signalId, account));
    if (!record) return;
    record.status = "rejected";
    record.rejectReason = rejectReason;
    void persistRejected(record).catch((error: unknown) => {
      console.error(`[positionStore] failed to persist rejection ${record.id}:`, error);
    });
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
