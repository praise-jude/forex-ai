import MetaApi from "metaapi.cloud-sdk/node";
import type { MetatraderAccount } from "metaapi.cloud-sdk/node";
import type { Candle, Pair, SymbolSpec, Timeframe } from "../types";
import { brokerSymbol } from "../symbols";

// MetaApi's documented per-call cap on getHistoricalCandles.
const MAX_BARS_PER_CALL = 1000;
// Conservative placeholder -- MetaApi's actual per-account rate limit isn't confirmed
// anywhere in this codebase. Confirm against MetaApi's own dashboard/docs before
// running large/frequent backtests.
const REQUEST_PACING_MS = 1000;
// Defense-in-depth against an infinite loop if the SDK's pagination boundary behaves
// unexpectedly -- 2000 pages is far more than any realistic lookback/timeframe
// combination this app's backtester allows (see backtestRunner.ts's MAX_LOOKBACK_DAYS)
// would ever need.
const MAX_PAGES = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A backtest walks dozens of pages across every requested pair/timeframe over several
// minutes -- long enough that a single transient network blip (DNS hiccup, reset
// connection) on any one page used to fail the ENTIRE job, discarding several minutes
// of otherwise-successful work for every other pair. Retried here instead, so one blip
// doesn't cost the whole run.
const MAX_FETCH_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;

// Only network-level connectivity errors are retried -- a legitimate application-level
// rejection (bad symbol, invalid timeframe, auth failure) should surface immediately,
// never be silently retried into a misleadingly-late failure.
function isRetryableFetchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message);
}

async function getHistoricalCandlesWithRetry(
  account: MetatraderAccount,
  symbol: string,
  timeframe: Timeframe,
  cursor: Date,
  barCount: number
): ReturnType<MetatraderAccount["getHistoricalCandles"]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await account.getHistoricalCandles(symbol, timeframe, cursor, barCount);
    } catch (error) {
      if (!isRetryableFetchError(error) || attempt >= MAX_FETCH_RETRIES - 1) throw error;
      console.error(`[backtest] transient fetch error for ${symbol} ${timeframe} (attempt ${attempt + 1}/${MAX_FETCH_RETRIES}), retrying:`, error);
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
}

/**
 * A fresh, read-only account handle for historical data only -- deliberately NEVER
 * obtained through metaApiConnection.ts's stored streaming connection. This keeps a
 * running backtest fully decoupled from live connection state: it can never interfere
 * with live streaming/execution, and metaApiConnection.ts needs no changes at all to
 * support it. getHistoricalCandles is plain REST regardless of connection/streaming
 * state, so no .connect()/.waitSynchronized() call is needed on this handle.
 */
export async function getBacktestAccount(): Promise<MetatraderAccount> {
  const token = process.env.METAAPI_TOKEN;
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  if (!token || !accountId) {
    throw new Error("METAAPI_TOKEN/METAAPI_ACCOUNT_ID must be set to run a backtest.");
  }
  const api = new MetaApi(token);
  return api.metatraderAccountApi.getAccount(accountId);
}

/**
 * Paginated historical OHLC fetch, walking backwards from `to` in pages of up to
 * MAX_BARS_PER_CALL (matching seedHistory.ts's own single-account, serial-loop
 * precedent -- no Promise.all here either, both to respect MetaApi's rate limits and to
 * keep pagination cursor logic simple). Returns oldest-first, deduped by time --
 * defensive against the SDK's actual return order in either direction, same spirit as
 * candleStore.seed's own defensive handling elsewhere in this codebase.
 */
export async function loadHistoricalRange(
  account: MetatraderAccount,
  pair: Pair,
  timeframe: Timeframe,
  from: Date,
  to: Date
): Promise<Candle[]> {
  const symbol = brokerSymbol(pair);
  const byTime = new Map<number, Candle>();
  let cursor = to;

  for (let page = 0; page < MAX_PAGES && cursor.getTime() > from.getTime(); page++) {
    const raw = await getHistoricalCandlesWithRetry(account, symbol, timeframe, cursor, MAX_BARS_PER_CALL);
    if (raw.length === 0) break;

    let earliestTime = cursor.getTime();
    for (const c of raw) {
      const time = c.time.getTime();
      earliestTime = Math.min(earliestTime, time);
      if (time >= from.getTime()) {
        byTime.set(time, { time, open: c.open, high: c.high, low: c.low, close: c.close, tickVolume: c.tickVolume, spread: c.spread });
      }
    }

    // No forward progress -- the API returned nothing older than the current cursor.
    // Stop rather than loop forever.
    if (earliestTime >= cursor.getTime()) break;
    // Nudge one ms before the earliest bar just seen, regardless of whether the SDK
    // treats `startTime` as inclusive or exclusive of that boundary -- guarantees
    // progress either way rather than assuming one behavior.
    cursor = new Date(earliestTime - 1);
    if (cursor.getTime() > from.getTime()) await sleep(REQUEST_PACING_MS);
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/**
 * Best-effort, fetched via a fresh one-off RPC connection -- deliberately NOT
 * metaApiConnection.ts's own persistent streaming connection (see getBacktestAccount's
 * own comment on why: a backtest must stay fully decoupled from live connection state,
 * so this works even when the live streaming connection happens to be down). Unlike
 * getHistoricalCandles, symbol specs aren't available as a plain REST call on the
 * account handle itself -- only through RpcMetaApiConnectionInstance -- so this opens,
 * synchronizes, and closes its own short-lived connection rather than reusing anything
 * else. A pair whose spec can't be fetched is simply omitted from the returned map
 * (logged, never fabricated) -- callers fall back to non-realistic sizing for that pair.
 */
export async function loadSymbolSpecs(account: MetatraderAccount, pairs: Pair[]): Promise<Map<Pair, SymbolSpec>> {
  const specs = new Map<Pair, SymbolSpec>();
  const connection = account.getRPCConnection();
  try {
    await connection.connect();
    await connection.waitSynchronized();
    for (const pair of pairs) {
      try {
        const spec = await connection.getSymbolSpecification(brokerSymbol(pair));
        specs.set(pair, {
          contractSize: spec.contractSize,
          volumeStep: spec.volumeStep,
          volumeMin: spec.minVolume,
          volumeMax: spec.maxVolume,
          point: spec.point,
        });
      } catch (err) {
        console.error(`[backtest] failed to fetch symbol spec for ${pair} (realistic sizing will fall back to flat stake for it):`, err);
      }
    }
  } finally {
    await connection.close();
  }
  return specs;
}
