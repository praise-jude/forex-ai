export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";

export type Pair =
  | "EUR/USD"
  | "GBP/USD"
  | "USD/JPY"
  | "AUD/USD"
  | "USD/CAD"
  | "XAU/USD"
  | "XAG/USD"
  | "USOIL"
  | "UKOIL"
  | "BTC/USD";

export const PAIRS: Pair[] = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "XAU/USD",
  "XAG/USD",
  "USOIL",
  "UKOIL",
  "BTC/USD",
];

export interface Candle {
  time: number; // unix ms, candle open time
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
}

export interface Price {
  pair: Pair;
  bid: number;
  ask: number;
  time: number;
}

export type SwingType = "high" | "low";

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: SwingType;
}

export type StructureEventType = "BOS_BULLISH" | "BOS_BEARISH" | "CHOCH_BULLISH" | "CHOCH_BEARISH";

export interface StructureEvent {
  type: StructureEventType;
  brokenSwing: SwingPoint;
  breakIndex: number;
  time: number;
}

export type FvgDirection = "bullish" | "bearish";

export interface FairValueGap {
  direction: FvgDirection;
  startIndex: number;
  top: number;
  bottom: number;
  filled: boolean;
}

export interface OrderBlock {
  direction: FvgDirection;
  index: number;
  top: number;
  bottom: number;
  mitigated: boolean;
}

export type LiquiditySide = "buyside" | "sellside";

export interface LiquiditySweep {
  sweptSwing: SwingPoint;
  sweepIndex: number;
  side: LiquiditySide;
}

export type Session = "asia" | "london" | "newyork" | "off-session";

export type Confluence =
  | "liquidity_sweep"
  | "bos"
  | "choch"
  | "fvg"
  | "order_block"
  | "killzone"
  | "ema_trend"
  | "rsi_momentum"
  | "macd_crossover"
  | "volume"
  | "trend_ema_stack"
  | "market_structure"
  | "adx"
  | "candlestick"
  | "multi_timeframe";

export type ConfidenceTier = "strong_buy" | "buy" | "watch";

export type SignalSource = "smc" | "tradingview";

export interface Signal {
  id: string;
  source: SignalSource;
  pair: Pair;
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  takeProfit2: number;
  riskReward: number;
  confidence: number;
  directionScore: number;
  entryScore: number;
  tier: ConfidenceTier;
  confluences: Confluence[];
  session: Session;
  timeframe: Timeframe;
  createdAt: number;
}

export type StreamEvent =
  | { type: "price"; pair: Pair; bid: number; ask: number; time: number }
  | { type: "candle"; pair: Pair; timeframe: Timeframe; candle: Candle }
  | { type: "signal"; signal: Signal };

// --- Execution ---

/** Which broker account a connection/order/risk-check applies to. "live" is the real
 * Exness account; "demo" is a separate MetaApi demo account used by DEMO engine mode. */
export type AccountKey = "live" | "demo";

export interface SymbolSpec {
  contractSize: number;
  volumeStep: number;
  volumeMin: number;
  volumeMax: number;
}

export interface AccountInfo {
  balance: number;
  equity: number;
}

export interface OpenPosition {
  id: string; // broker position id
  pair: Pair;
  direction: "long" | "short";
  lots: number;
  openPrice: number;
  currentPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  profit: number; // in account currency
  clientId?: string;
}

export type ExecutionStatus = "pending" | "filled" | "rejected";

export interface ExecutedTrade {
  id: string;
  signalId: string;
  account: AccountKey;
  pair: Pair;
  direction: "long" | "short";
  requestedLots: number;
  requestedEntry: number;
  filledEntry?: number;
  stopLoss: number;
  takeProfit: number;
  status: ExecutionStatus;
  brokerPositionId?: string;
  brokerOrderId?: string;
  rejectReason?: string;
  riskPct: number;
  attemptedAt: number;
  filledAt?: number;
}

// --- Push notifications (mobile) ---

/** Independently toggleable per device -- matches the mobile Settings screen's
 * checkbox list. `minConfidence` additionally gates buy_signal/sell_signal only. */
export interface NotificationPrefs {
  buySignals: boolean;
  sellSignals: boolean;
  tradeExecution: boolean;
  tpSl: boolean;
  riskAlerts: boolean;
  connectionAlerts: boolean;
  minConfidence: number;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  buySignals: true,
  sellSignals: true,
  tradeExecution: true,
  tpSl: true,
  riskAlerts: true,
  connectionAlerts: true,
  minConfidence: 80,
};

export type NotificationCategory =
  | "buy_signal"
  | "sell_signal"
  | "trade_opened"
  | "trade_closed"
  | "order_rejected"
  | "risk_alert"
  | "connection_alert";

export type DevicePlatform = "ios" | "android" | "web";

/** One row per installed app instance (not per user -- this app has no login system,
 * see basicAuth.ts). A single operator with two phones gets two rows, each with its own
 * prefs, so muting signals on a tablet doesn't silence a phone. */
export interface PushDevice {
  deviceId: string;
  pushToken: string;
  platform: DevicePlatform;
  appVersion?: string;
  notificationPrefs: NotificationPrefs;
  createdAt: number;
  updatedAt: number;
}
