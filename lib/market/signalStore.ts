import type { Pair, Signal } from "./types";

const STALE_AFTER_MS = 4 * 60 * 60 * 1000; // 4 hours

class SignalStore {
  private byPair = new Map<Pair, Signal[]>();

  add(signal: Signal): void {
    const existing = this.byPair.get(signal.pair) ?? [];
    existing.push(signal);
    this.byPair.set(signal.pair, existing);
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
      this.byPair.set(
        pair,
        list.filter((s) => now - s.createdAt <= STALE_AFTER_MS)
      );
    }
  }
}

const globalKey = Symbol.for("forex-ai.signalStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: SignalStore };
const g = globalThis as GlobalWithStore;

export const signalStore: SignalStore = g[globalKey] ?? (g[globalKey] = new SignalStore());
