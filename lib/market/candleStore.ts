import type { Candle, Pair, Timeframe } from "./types";

const MAX_CANDLES = 300;

class CandleStore {
  private store = new Map<Pair, Map<Timeframe, Candle[]>>();

  private bucket(pair: Pair, timeframe: Timeframe): Candle[] {
    let byTimeframe = this.store.get(pair);
    if (!byTimeframe) {
      byTimeframe = new Map();
      this.store.set(pair, byTimeframe);
    }
    let candles = byTimeframe.get(timeframe);
    if (!candles) {
      candles = [];
      byTimeframe.set(timeframe, candles);
    }
    return candles;
  }

  /** Bulk-load historical candles, oldest first. Replaces any existing data for this pair/timeframe. */
  seed(pair: Pair, timeframe: Timeframe, candles: Candle[]): void {
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    let byTimeframe = this.store.get(pair);
    if (!byTimeframe) {
      byTimeframe = new Map();
      this.store.set(pair, byTimeframe);
    }
    byTimeframe.set(timeframe, sorted.slice(-MAX_CANDLES));
  }

  /** Upserts a candle: updates the last bar if it shares the same open time, otherwise appends a new bar. */
  upsert(pair: Pair, timeframe: Timeframe, candle: Candle): void {
    const candles = this.bucket(pair, timeframe);
    const last = candles[candles.length - 1];
    if (last && last.time === candle.time) {
      candles[candles.length - 1] = candle;
    } else {
      candles.push(candle);
      if (candles.length > MAX_CANDLES) candles.shift();
    }
  }

  get(pair: Pair, timeframe: Timeframe): Candle[] {
    return this.bucket(pair, timeframe).slice();
  }
}

const globalKey = Symbol.for("forex-ai.candleStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: CandleStore };
const g = globalThis as GlobalWithStore;

export const candleStore: CandleStore = g[globalKey] ?? (g[globalKey] = new CandleStore());
