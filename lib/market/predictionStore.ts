import type { Pair, PredictionUpdate, Timeframe } from "./types";

/**
 * Latest evaluation per (pair, timeframe) -- overwritten every closed candle on that
 * timeframe, no history and no staleness pruning (unlike signalStore.ts, which keeps a
 * bounded history of actual Signals). This exists purely so the dashboard can show
 * "here's the current read on this pair/timeframe" -- including a real no_trade reason
 * -- even when no Signal was produced. Nested by timeframe (mirroring candleStore.ts's
 * own two-dimensional-key pattern) since three signal engines (15m/30m/1h, see
 * metaApiConnection.ts) run concurrently per pair.
 */
class PredictionStore {
  private byPair = new Map<Pair, Map<Timeframe, PredictionUpdate>>();

  private bucket(pair: Pair): Map<Timeframe, PredictionUpdate> {
    let byTimeframe = this.byPair.get(pair);
    if (!byTimeframe) {
      byTimeframe = new Map();
      this.byPair.set(pair, byTimeframe);
    }
    return byTimeframe;
  }

  set(pair: Pair, timeframe: Timeframe, update: PredictionUpdate): void {
    this.bucket(pair).set(timeframe, update);
  }

  get(pair: Pair, timeframe: Timeframe): PredictionUpdate | undefined {
    return this.bucket(pair).get(timeframe);
  }

  /** Every timeframe currently on record for one pair -- what the dashboard needs to
   * resolve "the prediction for the selected pair, at whichever timeframe is selected". */
  forPair(pair: Pair): PredictionUpdate[] {
    return [...this.bucket(pair).values()];
  }

  /** Flattened across every pair and timeframe. */
  all(): PredictionUpdate[] {
    return [...this.byPair.values()].flatMap((byTimeframe) => [...byTimeframe.values()]);
  }
}

const globalKey = Symbol.for("forex-ai.predictionStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: PredictionStore };
const g = globalThis as GlobalWithStore;

export const predictionStore: PredictionStore = g[globalKey] ?? (g[globalKey] = new PredictionStore());
