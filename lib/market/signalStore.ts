import { gte } from "drizzle-orm";
import { getOptionalDb } from "../db/optionalClient";
import { signals as signalsTable } from "../db/tradingSchema";
import type { Pair, Signal } from "./types";

const STALE_AFTER_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Best-effort insert, fired without awaiting (see add() below) -- a DB failure must
 * never affect signal detection, same "log, don't throw" philosophy as pushNotifier.ts's
 * sends. onConflictDoNothing matches add()'s own in-memory idempotency (a redelivered
 * TradingView alert reuses the same signal id on purpose, see signalStore's class doc). */
async function persistSignal(signal: Signal): Promise<void> {
  const db = getOptionalDb();
  if (!db) return;
  await db
    .insert(signalsTable)
    .values({
      id: signal.id,
      source: signal.source,
      pair: signal.pair,
      direction: signal.direction,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      takeProfit2: signal.takeProfit2,
      riskReward: signal.riskReward,
      confidence: signal.confidence,
      directionScore: signal.directionScore,
      entryScore: signal.entryScore,
      adx: signal.adx,
      rsi: signal.rsi,
      tier: signal.tier,
      confluences: signal.confluences,
      session: signal.session,
      timeframe: signal.timeframe,
      createdAt: new Date(signal.createdAt),
      zoneTop: signal.zoneTop,
      zoneBottom: signal.zoneBottom,
      signerBDirection: signal.signerBDirection,
      signerBConfidence: signal.signerBConfidence,
      signerBEmaTrend: signal.signerBEmaTrend,
      rsiDivergence: signal.rsiDivergence,
      supertrendTrend: signal.supertrendTrend,
      usdStrengthStatus: signal.usdStrengthStatus,
      newsStatus: signal.newsStatus,
    })
    .onConflictDoNothing();
}

class SignalStore {
  private byPair = new Map<Pair, Signal[]>();
  private byId = new Map<string, Signal>();

  /**
   * No-ops for an id already present. The SMC engine always generates a fresh
   * randomUUID so this never triggers there, but a redelivered/retried TradingView
   * webhook alert reuses the same id deliberately (see tradingViewWebhook.ts) --
   * without this guard it'd show as a visual duplicate on the dashboard even though
   * positionStore already treats it as a single execution attempt.
   */
  add(signal: Signal): void {
    if (this.byId.has(signal.id)) return;
    const existing = this.byPair.get(signal.pair) ?? [];
    existing.push(signal);
    this.byPair.set(signal.pair, existing);
    this.byId.set(signal.id, signal);
    // Opportunistic, not scheduled -- add() is the only place new entries come in, so
    // pruning here is what actually keeps byPair/byId bounded over a long-running
    // process. Previously defined but never called, so the store grew unbounded forever.
    this.prune();
    // Fire-and-forget: the in-memory write above is what every existing caller depends
    // on and is already complete by the time this runs. A DB outage must never affect
    // signal detection, so this is never awaited and its failure only ever logs.
    void persistSignal(signal).catch((error: unknown) => {
      console.error(`[signalStore] failed to persist signal ${signal.id}:`, error);
    });
  }

  /** Reloads non-stale signals from the DB into memory -- called once at boot (see
   * bootstrap.ts) so a restart doesn't blank the dashboard's recent-signal history.
   * No-ops when DATABASE_URL isn't set (getOptionalDb() returns null). Bypasses add()
   * deliberately -- these rows already exist in the DB, so re-persisting them on load
   * would just be a wasted round trip. */
  async hydrate(): Promise<void> {
    const db = getOptionalDb();
    if (!db) return;
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);
    const rows = await db.select().from(signalsTable).where(gte(signalsTable.createdAt, cutoff));
    for (const row of rows) {
      if (this.byId.has(row.id)) continue;
      const signal: Signal = {
        id: row.id,
        source: row.source as Signal["source"],
        pair: row.pair as Signal["pair"],
        direction: row.direction as Signal["direction"],
        entry: row.entry,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        takeProfit2: row.takeProfit2,
        riskReward: row.riskReward,
        confidence: row.confidence,
        directionScore: row.directionScore,
        entryScore: row.entryScore,
        adx: row.adx,
        rsi: row.rsi,
        tier: row.tier as Signal["tier"],
        confluences: row.confluences as Signal["confluences"],
        session: row.session as Signal["session"],
        timeframe: row.timeframe as Signal["timeframe"],
        createdAt: row.createdAt.getTime(),
        zoneTop: row.zoneTop ?? undefined,
        zoneBottom: row.zoneBottom ?? undefined,
        signerBDirection: row.signerBDirection as Signal["signerBDirection"],
        signerBConfidence: row.signerBConfidence,
        signerBEmaTrend: row.signerBEmaTrend as Signal["signerBEmaTrend"],
        rsiDivergence: row.rsiDivergence as Signal["rsiDivergence"],
        supertrendTrend: row.supertrendTrend as Signal["supertrendTrend"],
        usdStrengthStatus: row.usdStrengthStatus as Signal["usdStrengthStatus"],
        newsStatus: row.newsStatus as Signal["newsStatus"],
      };
      const existing = this.byPair.get(signal.pair) ?? [];
      existing.push(signal);
      this.byPair.set(signal.pair, existing);
      this.byId.set(signal.id, signal);
    }
  }

  get(id: string): Signal | undefined {
    return this.byId.get(id);
  }

  /** All non-stale signals across every pair, most recent first. */
  all(): Signal[] {
    const now = Date.now();
    const signals: Signal[] = [];
    for (const list of this.byPair.values()) {
      for (const signal of list) {
        if (now - signal.createdAt <= STALE_AFTER_MS) signals.push(signal);
      }
    }
    return signals.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Drops stale entries so the store doesn't grow unbounded. */
  prune(): void {
    const now = Date.now();
    for (const [pair, list] of this.byPair) {
      const [fresh, stale] = [
        list.filter((s) => now - s.createdAt <= STALE_AFTER_MS),
        list.filter((s) => now - s.createdAt > STALE_AFTER_MS),
      ];
      this.byPair.set(pair, fresh);
      for (const s of stale) this.byId.delete(s.id);
    }
  }
}

const globalKey = Symbol.for("forex-ai.signalStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: SignalStore };
const g = globalThis as GlobalWithStore;

export const signalStore: SignalStore = g[globalKey] ?? (g[globalKey] = new SignalStore());
