import type { Pair, PredictionUpdate } from "./types";

/**
 * Latest evaluation per pair -- overwritten every closed M15 candle, no history and no
 * staleness pruning (unlike signalStore.ts, which keeps a bounded history of actual
 * Signals). This exists purely so the dashboard can show "here's the current read on
 * this pair" -- including a real no_trade reason -- even when no Signal was produced.
 */
class PredictionStore {
  private byPair = new Map<Pair, PredictionUpdate>();

  set(pair: Pair, update: PredictionUpdate): void {
    this.byPair.set(pair, update);
  }

  get(pair: Pair): PredictionUpdate | undefined {
    return this.byPair.get(pair);
  }

  all(): PredictionUpdate[] {
    return [...this.byPair.values()];
  }
}

const globalKey = Symbol.for("forex-ai.predictionStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: PredictionStore };
const g = globalThis as GlobalWithStore;

export const predictionStore: PredictionStore = g[globalKey] ?? (g[globalKey] = new PredictionStore());
