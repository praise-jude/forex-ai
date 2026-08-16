import type { MetatraderAccount } from "metaapi.cloud-sdk/node";
import type { Candle, Timeframe } from "./types";
import { PAIRS } from "./types";
import { candleStore } from "./candleStore";
import { brokerSymbol } from "./symbols";

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];
const HISTORY_BARS = 300;

/**
 * Loads recent history for every pair/timeframe into the candle store before the
 * streaming connection subscribes, so API routes and the signal engine never see
 * an empty store once live ticks start arriving.
 *
 * Each (pair, timeframe) fetch is caught individually -- a single transient failure
 * (a real production incident: MetaApi returned a 504 for one symbol/timeframe because
 * the account wasn't fully synced to the broker yet at the exact moment of a cold
 * boot) must never take down the other 59 combinations, and must never propagate up
 * to connect() and abort the streaming connection entirely -- which is what happened
 * before this fix: one bad historical-candle request left the ENTIRE live engine
 * disconnected (no prices, no candles, no signals) until the next manual redeploy,
 * since bootstrap.ts's ensureMetaApiConnection("live") is only ever attempted once
 * and never retried. A symbol/timeframe that fails here just starts empty and fills in
 * naturally from live ticks once the streaming connection (established regardless,
 * see connect()) starts flowing.
 */
// Pairs run concurrently (10 at once) -- getHistoricalCandles is a plain REST fetch
// with no documented MetaApi rate-limit history the way subscribeToMarketData has (see
// connect()'s own comment on that), so there's no reason to serialize across pairs.
// Each pair's own 6 timeframes still run sequentially -- 6 concurrent requests per pair
// is already redundant with the 10-way pair concurrency and not worth the added
// complexity of a second parallel dimension. This cuts the sequential chain from 60
// awaits down to 6, the dominant remaining cost being connect()'s own no-longer-blocking
// use of this function (see connect()'s comment on why it's now fire-and-forget there).
export async function seedHistoricalCandles(account: MetatraderAccount): Promise<void> {
  await Promise.all(
    PAIRS.map(async (pair) => {
      for (const timeframe of TIMEFRAMES) {
        try {
          const raw = await account.getHistoricalCandles(brokerSymbol(pair), timeframe, new Date(), HISTORY_BARS);
          const candles: Candle[] = raw.map((c) => ({
            time: c.time.getTime(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            tickVolume: c.tickVolume,
          }));
          candleStore.seed(pair, timeframe, candles);
        } catch (error) {
          console.error(`[market] failed to seed ${pair} ${timeframe} history (continuing):`, error);
        }
      }
    })
  );
}
