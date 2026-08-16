import { vi } from "vitest";
import type { tradeJournal as TradeJournalInstance, getPerformanceStats as GetPerformanceStatsFn } from "../tradeJournal";

export interface TradeJournalModule {
  tradeJournal: typeof TradeJournalInstance;
  getPerformanceStats: typeof GetPerformanceStatsFn;
}

const globalKey = Symbol.for("forex-ai.tradeJournal");

/**
 * Loads a fresh tradeJournal module instance with an empty in-memory store. Clears the
 * globalThis-keyed singleton between loads so each test gets its own state -- DB
 * persistence (see tradeJournal.ts's hydrate()) is a best-effort backstop that no-ops
 * without DATABASE_URL (never set in tests), same as positionStore.ts/signalStore.ts's
 * own tests, which don't exercise their DB path either.
 */
export async function loadTradeJournalModule(): Promise<TradeJournalModule> {
  delete (globalThis as Record<symbol, unknown>)[globalKey];
  vi.resetModules();
  return import("../tradeJournal");
}
