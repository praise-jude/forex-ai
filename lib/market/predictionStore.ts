import type { Pair, PredictionUpdate, SignalSource, Timeframe } from "./types";

/**
 * Latest evaluation per (pair, timeframe, source) -- overwritten every closed candle on
 * that timeframe, no history and no staleness pruning (unlike signalStore.ts, which
 * keeps a bounded history of actual Signals). This exists purely so the dashboard can
 * show "here's the current read on this pair/timeframe" -- including a real no_trade
 * reason -- even when no Signal was produced. Nested by timeframe (mirroring
 * candleStore.ts's own two-dimensional-key pattern) since three signal engines
 * (15m/30m/1h, see metaApiConnection.ts) run concurrently per pair -- and further nested
 * by source (SMC vs. rangeEngine.ts's mean-reversion engine) since two independent
 * engines can evaluate the exact same pair/timeframe without one silently overwriting
 * the other's latest status.
 */
class PredictionStore {
  private byPair = new Map<Pair, Map<Timeframe, Map<SignalSource, PredictionUpdate>>>();

  private bucket(pair: Pair, timeframe: Timeframe): Map<SignalSource, PredictionUpdate> {
    let byTimeframe = this.byPair.get(pair);
    if (!byTimeframe) {
      byTimeframe = new Map();
      this.byPair.set(pair, byTimeframe);
    }
    let bySource = byTimeframe.get(timeframe);
    if (!bySource) {
      bySource = new Map();
      byTimeframe.set(timeframe, bySource);
    }
    return bySource;
  }

  /** Keyed by `update.source` itself -- callers never pass the source separately, so a
   * single object always writes to exactly the bucket it says it belongs to. */
  set(pair: Pair, timeframe: Timeframe, update: PredictionUpdate): void {
    this.bucket(pair, timeframe).set(update.source, update);
  }

  get(pair: Pair, timeframe: Timeframe, source: SignalSource): PredictionUpdate | undefined {
    return this.bucket(pair, timeframe).get(source);
  }

  /** Every timeframe/source currently on record for one pair -- what the dashboard
   * needs to resolve "every engine's read on this pair, across every timeframe". */
  forPair(pair: Pair): PredictionUpdate[] {
    const byTimeframe = this.byPair.get(pair);
    if (!byTimeframe) return [];
    return [...byTimeframe.values()].flatMap((bySource) => [...bySource.values()]);
  }

  /** Flattened across every pair, timeframe, and source. */
  all(): PredictionUpdate[] {
    return [...this.byPair.values()].flatMap((byTimeframe) => [...byTimeframe.values()].flatMap((bySource) => [...bySource.values()]));
  }
}

const globalKey = Symbol.for("forex-ai.predictionStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: PredictionStore };
const g = globalThis as GlobalWithStore;

export const predictionStore: PredictionStore = g[globalKey] ?? (g[globalKey] = new PredictionStore());
