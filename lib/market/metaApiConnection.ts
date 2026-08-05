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
import type { AccountInfo, Candle, OpenPosition, Pair, SymbolSpec, Timeframe } from "./types";
import { PAIRS } from "./types";
import { candleStore } from "./candleStore";
import { priceStore } from "./priceStore";
import { signalStore } from "./signalStore";
import { eventBus } from "./eventBus";
import { assembleSignals } from "./signalEngine";
import { brokerSymbol, pairForBrokerSymbol } from "./symbols";
import { seedHistoricalCandles } from "./seedHistory";

const SIGNAL_TIMEFRAME: Timeframe = "15m";

class MarketSyncListener extends SynchronizationListener {
  async onSymbolPricesUpdated(_instanceIndex: string, prices: MetatraderSymbolPrice[]): Promise<void> {
    for (const raw of prices) {
      const pair = pairForBrokerSymbol(raw.symbol);
      if (!pair) continue;

      const time = raw.time.getTime();
      priceStore.set({ pair, bid: raw.bid, ask: raw.ask, time });
      eventBus.publish({ type: "price", pair, bid: raw.bid, ask: raw.ask, time });
    }
  }

  async onCandlesUpdated(_instanceIndex: string, candles: MetatraderCandle[]): Promise<void> {
    for (const raw of candles) {
      const pair = pairForBrokerSymbol(raw.symbol);
      if (!pair) continue;
      if (raw.timeframe !== "5m" && raw.timeframe !== "15m") continue;
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
        for (const signal of assembleSignals(priorSeries, pair, SIGNAL_TIMEFRAME)) {
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

// Set once the streaming connection is up, read by the broker accessors below. This is
// the only module allowed to hold a reference to the SDK connection — everything else
// (execution engine, risk manager, API routes) goes through the narrow functions here.
let activeConnection: StreamingMetaApiConnectionInstance | null = null;

async function connect(): Promise<void> {
  const token = requireEnv("METAAPI_TOKEN");
  const accountId = requireEnv("METAAPI_ACCOUNT_ID");

  const api = new MetaApi(token);
  const account = await api.metatraderAccountApi.getAccount(accountId);

  await seedHistoricalCandles(account);

  const connection = account.getStreamingConnection();
  connection.addSynchronizationListener(new MarketSyncListener());

  await connection.connect();
  await connection.waitSynchronized();

  for (const pair of PAIRS) {
    await connection.subscribeToMarketData(brokerSymbol(pair), [
      { type: "quotes" },
      { type: "candles", timeframe: "5m" },
      { type: "candles", timeframe: "15m" },
    ]);
  }

  activeConnection = connection;
  console.log(`[market] connected and streaming ${PAIRS.join(", ")}`);
}

// --- Broker accessors (execution engine + API routes read through these, never the SDK directly) ---

export function getAccountInformation(): AccountInfo | undefined {
  const info = activeConnection?.terminalState.accountInformation;
  if (!info) return undefined;
  return { balance: info.balance, equity: info.equity };
}

/** Total open positions on the account, including any not opened by this app — used for risk limits. */
export function getOpenPositionCount(): number {
  return activeConnection?.terminalState.positions.length ?? 0;
}

/** Open positions mapped to our tracked pairs only (skips symbols outside the 5 majors, e.g. opened manually). */
export function getOpenPositions(): OpenPosition[] {
  const positions = activeConnection?.terminalState.positions ?? [];
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

export function getSymbolSpecification(pair: Pair): SymbolSpec | undefined {
  const spec = activeConnection?.terminalState.specification(brokerSymbol(pair));
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
  clientId: string
): Promise<PlaceOrderResult> {
  if (!activeConnection) return { success: false, message: "no active MetaApi connection" };
  const symbol = brokerSymbol(pair);

  let response: MetatraderTradeResponse;
  try {
    response =
      direction === "long"
        ? await activeConnection.createMarketBuyOrder(symbol, lots, stopLoss, takeProfit, { clientId })
        : await activeConnection.createMarketSellOrder(symbol, lots, stopLoss, takeProfit, { clientId });
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (!TRADE_SUCCESS_CODES.has(response.numericCode)) {
    return { success: false, numericCode: response.numericCode, stringCode: response.stringCode, message: response.message };
  }

  // The trade response doesn't carry the actual fill price — read it back from the
  // now-open position if the local terminal state has already synced it, falling back
  // to the requested price (which was the current ask/bid at signal time) otherwise.
  const openedPosition = activeConnection.terminalState.positions.find((p) => p.id === Number(response.positionId));
  return {
    success: true,
    filledEntry: openedPosition?.openPrice ?? requestedEntry,
    brokerPositionId: response.positionId,
    brokerOrderId: response.orderId,
  };
}

const globalKey = Symbol.for("forex-ai.metaApiConnection");
type GlobalWithConnection = typeof globalThis & { [globalKey]?: Promise<void> };
const g = globalThis as GlobalWithConnection;

/** Idempotent: the first caller starts the connection, later callers get the same promise. */
export function ensureMetaApiConnection(): Promise<void> {
  if (!g[globalKey]) {
    g[globalKey] = connect();
  }
  return g[globalKey];
}
