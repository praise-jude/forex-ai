import type { MetatraderAccount } from "metaapi.cloud-sdk/node";
import type { Candle, Timeframe } from "./types";
import { PAIRS } from "./types";
import { candleStore } from "./candleStore";
import { brokerSymbol } from "./symbols";

const TIMEFRAMES: Timeframe[] = ["4h", "1d"];
const HISTORY_BARS = 300;
// 30 minutes is generous headroom under a 4-hour bar's own natural refresh cadence
// (worst case, this data is up to ~30min stale relative to a bar that just closed --
// irrelevant for a trend-agreement read that only cares "bullish/bearish/neutral right
// now", never a specific candle's exact OHLC), and vastly so for daily.
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
// Same real, documented MetaApi limit (5 concurrent getHistoricalCandles requests per
// account) seedHistory.ts's own SEED_BATCH_SIZE already respects -- mirrored here
// rather than imported since the two batch sizes are allowed to diverge if one file's
// tuning ever needs to change without affecting the other.
const BATCH_SIZE = 4;

/**
 * Keeps candleStore's 4h/1d data fresh via periodic REST polling instead of a
 * permanent live subscription -- see metaApiConnection.ts's own doc comment on
 * LIVE_MARKET_DATA_SUBSCRIPTIONS for why these two timeframes were dropped from it.
 * They're only ever read for the D1/H4 trend-agreement gate (an EMA20/50 read that only
 * meaningfully changes once every few hours, or once a day), so a live tick-by-tick
 * stream was pure unused subscription cost -- confirmed as a real production incident
 * (2026-09-01): the same class of MetaApi rate-limit "downgrade storm" that 5m's own
 * live subscription caused before it was dropped for the identical reason was recurring
 * repeatedly across a live evening, well past what the earlier serialized-recovery-queue
 * fix alone could contain -- that fix makes recovery from a downgrade clean, it can't
 * stop the account's total subscription load from tripping the limit in the first place.
 * Cutting live candle subscriptions from 5 timeframes/pair to 3 (15m/30m/1h) is the
 * actual load reduction.
 *
 * Writes into the SAME candleStore every other consumer already reads from
 * (signalEngine.ts's hard trend-agreement gate, the dashboard's D1/H4/H1 display,
 * position-risk narration) via candleStore.seed() -- a pure data replacement with no
 * side effects (no event-bus publish, no re-triggering an evaluation) -- so none of
 * those consumers needed to change at all, only how this data gets fed.
 */
async function refreshOnce(account: MetatraderAccount): Promise<void> {
  for (let start = 0; start < PAIRS.length; start += BATCH_SIZE) {
    const batch = PAIRS.slice(start, start + BATCH_SIZE);
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
            // Keeps whatever candleStore already has (the last successful refresh, or
            // seedHistoricalCandles' own boot-time seed) rather than clearing it --
            // same "a transient failure must never blank out otherwise-good data"
            // posture as seedHistoricalCandles' own per-symbol catch.
            console.error(`[market] failed to refresh ${pair} ${timeframe} history (continuing, keeping last known data):`, error);
          }
        }
      })
    );
  }
}

const globalKey = Symbol.for("forex-ai.higherTimeframeRefresh");
type GlobalWithState = typeof globalThis & { [globalKey]?: { account: MetatraderAccount | null; intervalStarted: boolean } };
const g = globalThis as GlobalWithState;
const state = g[globalKey] ?? (g[globalKey] = { account: null, intervalStarted: false });

/** Called from connect() every time it runs -- including a forced reconnect, which
 * constructs a brand new MetatraderAccount entity. Always updates the account reference
 * this refresh uses, even after the interval is already running, so a reconnect can
 * never leave it retrying REST calls against a stale, torn-down account indefinitely.
 * The interval itself is only ever started once (mirrors newsFilter.ts's own
 * startNewsFilter fetch-then-interval pattern), reading whichever account is current at
 * each tick rather than closing over the one passed in at start time. */
export function startHigherTimeframeRefresh(account: MetatraderAccount): void {
  state.account = account;
  if (state.intervalStarted) return;
  state.intervalStarted = true;
  setInterval(() => {
    if (state.account) void refreshOnce(state.account);
  }, REFRESH_INTERVAL_MS);
}
