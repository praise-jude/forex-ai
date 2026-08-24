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
// getHistoricalCandles is capped by MetaApi at 5 concurrent requests per account (real,
// documented limit -- confirmed live via a production TooManyRequestsError: "maximum of
// 5 concurrent... concurrentRequestCount: 6", same rate-limiting docs page that gave us
// SUBSCRIBE_STAGGER_MS in metaApiConnection.ts's connect()). Each pair's own 6 timeframes
// already run sequentially (one in-flight request per pair at a time), so pair-level
// concurrency IS request concurrency -- PAIRS is run in batches of 4 (a one-request margin
// under the real limit of 5) rather than all-at-once, to stay under it even if one batch's
// last request is still finishing when the next batch starts.
const SEED_BATCH_SIZE = 4;

export async function seedHistoricalCandles(account: MetatraderAccount): Promise<void> {
  for (let start = 0; start < PAIRS.length; start += SEED_BATCH_SIZE) {
    const batch = PAIRS.slice(start, start + SEED_BATCH_SIZE);
    await Promise.all(
      batch.map(async (pair) => {
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
}
