import type { MetatraderAccount } from "metaapi.cloud-sdk/node";
import type { Candle, Timeframe } from "./types";
import { PAIRS } from "./types";
import { candleStore } from "./candleStore";
import { brokerSymbol } from "./symbols";

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d"];
const HISTORY_BARS = 300;

/**
 * Loads recent history for every pair/timeframe into the candle store before the
 * streaming connection subscribes, so API routes and the signal engine never see
 * an empty store once live ticks start arriving.
 */
export async function seedHistoricalCandles(account: MetatraderAccount): Promise<void> {
  for (const pair of PAIRS) {
    for (const timeframe of TIMEFRAMES) {
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
    }
  }
}
