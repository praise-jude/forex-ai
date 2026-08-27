import { getOptionalDb } from "../db/optionalClient";
import { processedDeals as processedDealsTable } from "../db/tradingSchema";
import type { AccountKey } from "./types";

// Bounds memory the same way positionStore.ts's MAX_RECORDS does -- generous relative to
// realistic deal volume, so this only ever prunes ancient history long after the deal it
// guarded is no longer reachable via a fresh sync replay.
const MAX_RECORDS = 2000;

async function persist(dealId: string, account: AccountKey, processedAt: number): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db
    .insert(processedDealsTable)
    .values({ dealId, account, processedAt: new Date(processedAt) })
    .onConflictDoNothing();
}

/**
 * Guards metaApiConnection.ts's onDealAdded against the same closing deal being processed
 * more than once. The MetaApi SDK redelivers recent deal history as fresh onDealAdded
 * events during a reconnect resync (and again after a process restart) -- onDealAdded's
 * own `connection.synchronized` check only filters the very first historical backlog on a
 * brand-new connection, not every later resync, so without this guard the same real loss
 * got re-counted by riskState.recordTradeClosed on every redelivery, tripping phantom
 * "N consecutive losses" cooldowns that don't correspond to any new trade.
 *
 * Same "synchronous in-memory Map is the real source of truth, DB is a durability
 * backstop" shape as positionStore.ts/riskState.ts -- markProcessed() must run
 * synchronously, before any of the actions it guards, so two onDealAdded deliveries for
 * the same deal arriving back-to-back can't both slip through before the DB round trip
 * settles.
 */
class DealDedupStore {
  private seen = new Map<string, number>();

  /** True if this exact broker deal has already been processed. */
  hasProcessed(dealId: string): boolean {
    return this.seen.has(dealId);
  }

  /** Marks the deal processed for every future check, this run and after a restart. */
  markProcessed(dealId: string, account: AccountKey, nowMs: number): void {
    this.seen.set(dealId, nowMs);
    this.prune();
    void persist(dealId, account, nowMs).catch((error: unknown) => {
      console.error(`[dealDedup] failed to persist processed deal ${dealId}:`, error);
    });
  }

  /** Reloads recently processed deal ids from the DB -- called once at boot (see
   * bootstrap.ts) so a restart doesn't reopen the redelivery window for deals that were
   * already correctly counted before the restart. No-ops when DATABASE_URL isn't set. */
  async hydrate(): Promise<void> {
    const db = getOptionalDb();
    if (!db) return;
    const rows = await db.select().from(processedDealsTable);
    for (const row of rows) {
      if (!this.seen.has(row.dealId)) this.seen.set(row.dealId, row.processedAt.getTime());
    }
  }

  private prune(): void {
    if (this.seen.size <= MAX_RECORDS) return;
    const oldestFirst = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
    for (const [dealId] of oldestFirst.slice(0, this.seen.size - MAX_RECORDS)) {
      this.seen.delete(dealId);
    }
  }
}

const globalKey = Symbol.for("forex-ai.dealDedup");
type GlobalWithStore = typeof globalThis & { [globalKey]?: DealDedupStore };
const g = globalThis as GlobalWithStore;
export const dealDedup: DealDedupStore = g[globalKey] ?? (g[globalKey] = new DealDedupStore());
