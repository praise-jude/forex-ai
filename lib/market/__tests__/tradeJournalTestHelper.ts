import { vi } from "vitest";
import type { tradeJournal as TradeJournalInstance, getPerformanceStats as GetPerformanceStatsFn } from "../tradeJournal";

export interface TradeJournalModule {
  tradeJournal: typeof TradeJournalInstance;
  getPerformanceStats: typeof GetPerformanceStatsFn;
}

const globalKey = Symbol.for("forex-ai.tradeJournal");

/**
 * Loads a fresh tradeJournal module instance pointed at `storeFile`. Same reasoning as
 * deviceStoreTestHelper.ts: clears the globalThis-keyed singleton between loads so a
 * "reload" in the same test process genuinely re-reads from disk instead of handing
 * back the first load's in-memory instance.
 */
export async function loadTradeJournalModule(storeFile: string): Promise<TradeJournalModule> {
  process.env.TRADE_JOURNAL_FILE = storeFile;
  delete (globalThis as Record<symbol, unknown>)[globalKey];
  vi.resetModules();
  return import("../tradeJournal");
}
