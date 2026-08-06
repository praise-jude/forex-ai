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

  /**
   * Bulk-load historical candles, oldest first. Replaces any existing data for this
   * pair/timeframe. Sorted and deduplicated by time (keeping the last occurrence of
   * any duplicate) — the chart requires strictly ascending, unique timestamps, and a
   * third-party historical API isn't a source worth trusting blindly on that.
   */
  seed(pair: Pair, timeframe: Timeframe, candles: Candle[]): void {
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const deduped: Candle[] = [];
    for (const candle of sorted) {
      if (deduped.length > 0 && deduped[deduped.length - 1].time === candle.time) {
        deduped[deduped.length - 1] = candle;
      } else {
        deduped.push(candle);
      }
    }

    let byTimeframe = this.store.get(pair);
    if (!byTimeframe) {
      byTimeframe = new Map();
      this.store.set(pair, byTimeframe);
    }
    byTimeframe.set(timeframe, deduped.slice(-MAX_CANDLES));
  }

  /**
   * Upserts a candle, keeping the array in strictly ascending time order (required
   * by the chart, which throws on out-of-order data). Usually the new candle is
   * either a fresh tick on the current bar (time === last) or the start of the next
   * bar (time > last). But MetaApi can also deliver a late "final" update for a bar
   * that's just closed *after* the next bar has already started forming — that
   * arrives with time < last, and must correct the earlier entry in place rather
   * than being appended, or it corrupts the ordering.
   */
  upsert(pair: Pair, timeframe: Timeframe, candle: Candle): void {
    const candles = this.bucket(pair, timeframe);
    const last = candles[candles.length - 1];

    if (!last || candle.time > last.time) {
      candles.push(candle);
      if (candles.length > MAX_CANDLES) candles.shift();
      return;
    }

    if (candle.time === last.time) {
      candles[candles.length - 1] = candle;
      return;
    }

    for (let i = candles.length - 2; i >= 0; i--) {
      if (candles[i].time === candle.time) {
        candles[i] = candle;
        return;
      }
      if (candles[i].time < candle.time) break; // array is ascending; no match further back
    }
    // No matching bar found (likely evicted by the MAX_CANDLES cap) — drop it rather
    // than inserting out of order.
  }

  get(pair: Pair, timeframe: Timeframe): Candle[] {
    return this.bucket(pair, timeframe).slice();
  }
}

const globalKey = Symbol.for("forex-ai.candleStore");
type GlobalWithStore = typeof globalThis & { [globalKey]?: CandleStore };
const g = globalThis as GlobalWithStore;

export const candleStore: CandleStore = g[globalKey] ?? (g[globalKey] = new CandleStore());
