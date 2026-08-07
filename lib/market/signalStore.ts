import type { Pair, Signal } from "./types";

const STALE_AFTER_MS = 4 * 60 * 60 * 1000; // 4 hours

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
