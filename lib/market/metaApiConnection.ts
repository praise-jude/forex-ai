// The package's default ESM entry point ("metaapi.cloud-sdk") resolves to a browser
// build that references `window` at module scope and crashes under Node. Use the
// explicit Node build instead — see https://github.com/metaapi/metaapi-javascript-sdk.
import MetaApi, { SynchronizationListener } from "metaapi.cloud-sdk/node";
import type {
  MetatraderCandle,
  MetatraderSymbolPrice,
  MetatraderTradeResponse,
  StreamingMetaApiConnectionInstance,
} from "metaapi.cloud-sdk/node";
import type { AccountInfo, AccountKey, Candle, OpenPosition, Pair, SymbolSpec, Timeframe } from "./types";
import { PAIRS } from "./types";
import { candleStore } from "./candleStore";
import { priceStore } from "./priceStore";
import { signalStore } from "./signalStore";
import { eventBus } from "./eventBus";
import { assembleSignals } from "./signalEngine";
import { brokerSymbol, pairForBrokerSymbol } from "./symbols";
import { seedHistoricalCandles } from "./seedHistory";

const SIGNAL_TIMEFRAME: Timeframe = "15m";
const TRACKED_TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d"];

// The demo account exists purely as a second AUTO-EXECUTION target for DEMO engine mode
// -- never a second price feed or a second signal engine. Only "live" writes into the
// shared candleStore/priceStore/signalStore or calls assembleSignals(); if both accounts
// published market data, two connections streaming the same broker prices would race to
// write duplicate/conflicting candle and signal events. The demo connection still needs
// its own terminalState (for getAccountInformation/getSymbolSpecification/position count
// when executing against it), which the SDK maintains internally regardless of what this
// listener does with the events.
class MarketSyncListener extends SynchronizationListener {
  constructor(private accountKey: AccountKey) {
    super();
  }

  async onSymbolPricesUpdated(_instanceIndex: string, prices: MetatraderSymbolPrice[]): Promise<void> {
    if (prices.length > 0) stateFor(this.accountKey).lastUpdateAt = Date.now();
    if (this.accountKey !== "live") return;

    for (const raw of prices) {
      const pair = pairForBrokerSymbol(raw.symbol);
      if (!pair) continue;

      const time = raw.time.getTime();
      priceStore.set({ pair, bid: raw.bid, ask: raw.ask, time });
      eventBus.publish({ type: "price", pair, bid: raw.bid, ask: raw.ask, time });
    }
  }

  async onCandlesUpdated(_instanceIndex: string, candles: MetatraderCandle[]): Promise<void> {
    if (this.accountKey !== "live") return; // demo never subscribes to candles; guard is defense-in-depth

    for (const raw of candles) {
      const pair = pairForBrokerSymbol(raw.symbol);
      if (!pair) continue;
      if (!TRACKED_TIMEFRAMES.includes(raw.timeframe as Timeframe)) continue;
      const timeframe = raw.timeframe as Timeframe;

      const candle: Candle = {
        time: raw.time.getTime(),
        open: raw.open,
        high: raw.high,
        low: raw.low,
        close: raw.close,
        tickVolume: raw.tickVolume,
      };

      // Snapshot the series as it stood before this update: if a new bar just
      // started, this snapshot's last element is the bar that just closed, which
      // is exactly what the signal engine should evaluate (never the forming bar).
      const priorSeries = candleStore.get(pair, timeframe);
      const priorLast = priorSeries[priorSeries.length - 1];
      const barJustClosed = Boolean(priorLast) && candle.time > (priorLast?.time ?? -Infinity);

      candleStore.upsert(pair, timeframe, candle);
      eventBus.publish({ type: "candle", pair, timeframe, candle });

      if (barJustClosed && timeframe === SIGNAL_TIMEFRAME) {
        const higherTimeframes = {
          h1: candleStore.get(pair, "1h"),
          h4: candleStore.get(pair, "4h"),
          d1: candleStore.get(pair, "1d"),
        };
        for (const signal of assembleSignals(priorSeries, pair, SIGNAL_TIMEFRAME, higherTimeframes)) {
          signalStore.add(signal);
          eventBus.publish({ type: "signal", signal });
        }
      }
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const ACCOUNT_ENV_VARS: Record<AccountKey, { token: string; accountId: string }> = {
  live: { token: "METAAPI_TOKEN", accountId: "METAAPI_ACCOUNT_ID" },
  demo: { token: "METAAPI_DEMO_TOKEN", accountId: "METAAPI_DEMO_ACCOUNT_ID" },
};

/** Env-var presence only — no SDK call. Used to fail closed (reject a DEMO-mode switch,
 * or a demo auto-execution attempt) before ever assuming a demo connection exists. */
export function isAccountConfigured(accountKey: AccountKey): boolean {
  const vars = ACCOUNT_ENV_VARS[accountKey];
  return Boolean(process.env[vars.token] && process.env[vars.accountId]);
}

// One connection per account, read by the broker accessors below. This is the only
// module allowed to hold a reference to the SDK connection — everything else (execution
// engine, risk manager, API routes) goes through the narrow functions here. globalThis-
// keyed for the same reason every store in this app is (see priceStore.ts) — a plain
// module-level variable here isn't reliably shared across Next.js's route-handler and
// instrumentation module instances, which previously (before this was globalThis-keyed)
// silently made every accessor below think there was no connection even while data was
// streaming fine through the (correctly globalThis-keyed) priceStore/candleStore.
interface ConnectionState {
  connection: StreamingMetaApiConnectionInstance | null;
  lastUpdateAt: number | null;
}
const connectionStatesKey = Symbol.for("forex-ai.metaApiConnection.states");
type GlobalWithConnectionStates = typeof globalThis & { [connectionStatesKey]?: Map<AccountKey, ConnectionState> };
const connectionStatesGlobal = globalThis as GlobalWithConnectionStates;
const connectionStates: Map<AccountKey, ConnectionState> =
  connectionStatesGlobal[connectionStatesKey] ?? (connectionStatesGlobal[connectionStatesKey] = new Map());

// Never falls back to another account's state — a demo connection that was never
// started (not configured, or still starting up) must read as "no connection", not
// silently pick up live's connection. This is the mechanism that makes an unconfigured
// or not-yet-ready DEMO fail closed.
function stateFor(accountKey: AccountKey): ConnectionState {
  let state = connectionStates.get(accountKey);
  if (!state) {
    state = { connection: null, lastUpdateAt: null };
    connectionStates.set(accountKey, state);
  }
  return state;
}

async function connect(accountKey: AccountKey): Promise<void> {
  const vars = ACCOUNT_ENV_VARS[accountKey];
  const token = requireEnv(vars.token);
  const accountId = requireEnv(vars.accountId);

  const api = new MetaApi(token);
  const account = await api.metatraderAccountApi.getAccount(accountId);

  // Only "live" needs candle history -- "demo" is purely an execution target (see
  // MarketSyncListener above), not a second signal engine.
  if (accountKey === "live") await seedHistoricalCandles(account);

  const connection = account.getStreamingConnection();
  connection.addSynchronizationListener(new MarketSyncListener(accountKey));

  await connection.connect();
  await connection.waitSynchronized();

  for (const pair of PAIRS) {
    await connection.subscribeToMarketData(
      brokerSymbol(pair),
      accountKey === "live"
        ? [
            { type: "quotes" },
            { type: "candles", timeframe: "5m" },
            { type: "candles", timeframe: "15m" },
            { type: "candles", timeframe: "1h" },
            { type: "candles", timeframe: "4h" },
            { type: "candles", timeframe: "1d" },
          ]
        : [{ type: "quotes" }] // enough for terminalState.accountInformation/specification/positions
    );
  }

  stateFor(accountKey).connection = connection;
  console.log(`[market] ${accountKey} account connected and streaming ${PAIRS.join(", ")}`);
}

// --- Broker accessors (execution engine + API routes read through these, never the SDK directly) ---

export type ConnectionStatus = "live" | "reconnecting" | "disconnected";

/**
 * "live" requires the full chain to be healthy: MetaApi's own sync finished, MetaApi is
 * connected to the MT5 terminal, and that terminal is itself connected to the broker.
 * Any one of those being false means data could be stale even though the process is
 * technically still running -- "reconnecting" covers all of those cases without trying
 * to distinguish which specific link dropped.
 */
export function getConnectionStatus(accountKey: AccountKey = "live"): { status: ConnectionStatus; lastUpdateAt: number | null } {
  const state = stateFor(accountKey);
  const connection = state.connection;
  if (!connection) return { status: "disconnected", lastUpdateAt: state.lastUpdateAt };

  const healthy = connection.synchronized && connection.terminalState.connected && connection.terminalState.connectedToBroker;
  return { status: healthy ? "live" : "reconnecting", lastUpdateAt: state.lastUpdateAt };
}

export function getAccountInformation(accountKey: AccountKey = "live"): AccountInfo | undefined {
  const info = stateFor(accountKey).connection?.terminalState.accountInformation;
  if (!info) return undefined;
  return { balance: info.balance, equity: info.equity };
}

/** Total open positions on the account, including any not opened by this app — used for risk limits. */
export function getOpenPositionCount(accountKey: AccountKey = "live"): number {
  return stateFor(accountKey).connection?.terminalState.positions.length ?? 0;
}

/** Open positions mapped to our tracked pairs only (skips symbols outside PAIRS, e.g. opened manually). */
export function getOpenPositions(accountKey: AccountKey = "live"): OpenPosition[] {
  const positions = stateFor(accountKey).connection?.terminalState.positions ?? [];
  const result: OpenPosition[] = [];
  for (const raw of positions) {
    const pair = pairForBrokerSymbol(raw.symbol);
    if (!pair) continue;
    result.push({
      id: String(raw.id),
      pair,
      direction: raw.type === "POSITION_TYPE_BUY" ? "long" : "short",
      lots: raw.volume,
      openPrice: raw.openPrice,
      currentPrice: raw.currentPrice,
      stopLoss: raw.stopLoss,
      takeProfit: raw.takeProfit,
      profit: raw.profit,
      clientId: raw.clientId,
    });
  }
  return result;
}

export function getSymbolSpecification(pair: Pair, accountKey: AccountKey = "live"): SymbolSpec | undefined {
  const spec = stateFor(accountKey).connection?.terminalState.specification(brokerSymbol(pair));
  if (!spec) return undefined;
  return { contractSize: spec.contractSize, volumeStep: spec.volumeStep, volumeMin: spec.minVolume, volumeMax: spec.maxVolume };
}

export type PlaceOrderResult =
  | { success: true; filledEntry: number; brokerPositionId?: string; brokerOrderId?: string }
  | { success: false; numericCode?: number; stringCode?: string; message: string };

// Response codes that indicate success, per MetatraderTradeResponse.numericCode's docs.
const TRADE_SUCCESS_CODES = new Set([0, 10008, 10009, 10010, 10025]);

export async function placeMarketOrder(
  pair: Pair,
  direction: "long" | "short",
  lots: number,
  stopLoss: number,
  takeProfit: number,
  requestedEntry: number,
  clientId: string,
  accountKey: AccountKey = "live"
): Promise<PlaceOrderResult> {
  const connection = stateFor(accountKey).connection;
  if (!connection) return { success: false, message: `no active MetaApi connection (${accountKey})` };
  const symbol = brokerSymbol(pair);
  // Shows up as the position's comment in MT5 itself, so a trade is identifiable
  // in the broker terminal, not just on the dashboard.
  const comment = direction === "long" ? "JUDE" : "OMINI";

  let response: MetatraderTradeResponse;
  try {
    response =
      direction === "long"
        ? await connection.createMarketBuyOrder(symbol, lots, stopLoss, takeProfit, { clientId, comment })
        : await connection.createMarketSellOrder(symbol, lots, stopLoss, takeProfit, { clientId, comment });
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (!TRADE_SUCCESS_CODES.has(response.numericCode)) {
    return { success: false, numericCode: response.numericCode, stringCode: response.stringCode, message: response.message };
  }

  // The trade response doesn't carry the actual fill price — read it back from the
  // now-open position if the local terminal state has already synced it, falling back
  // to the requested price (which was the current ask/bid at signal time) otherwise.
  const openedPosition = connection.terminalState.positions.find((p) => p.id === Number(response.positionId));
  return {
    success: true,
    filledEntry: openedPosition?.openPrice ?? requestedEntry,
    brokerPositionId: response.positionId,
    brokerOrderId: response.orderId,
  };
}

const connectPromisesKey = Symbol.for("forex-ai.metaApiConnection.connectPromises");
type GlobalWithConnectPromises = typeof globalThis & { [connectPromisesKey]?: Map<AccountKey, Promise<void>> };
const g = globalThis as GlobalWithConnectPromises;
const connectPromises: Map<AccountKey, Promise<void>> = g[connectPromisesKey] ?? (g[connectPromisesKey] = new Map());

/** Idempotent per account: the first caller for a given account starts that account's
 * connection, later callers (for the same account) get the same promise. */
export function ensureMetaApiConnection(accountKey: AccountKey = "live"): Promise<void> {
  let promise = connectPromises.get(accountKey);
  if (!promise) {
    promise = connect(accountKey);
    connectPromises.set(accountKey, promise);
  }
  return promise;
}
