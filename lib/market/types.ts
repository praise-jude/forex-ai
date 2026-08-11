import type { DimensionScore } from "./confidenceScore";

export type Timeframe = "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

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
  | "multi_timeframe"
  | "supertrend"
  | "currency_strength"
  | "rsi_divergence";

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
  /** The real SMC order-block/FVG zone bounds behind `entry` (their midpoint), for
   * drawing an actual zone on the chart instead of approximating one from `entry`
   * alone. Optional -- TradingView-sourced signals have no zone concept and must not
   * fabricate one (see tradingViewWebhook.ts). */
  zoneTop?: number;
  zoneBottom?: number;
  /** Signer B's own independent directional read (Trend + Momentum + Volatility +
   * Currency Strength + Session, see signerB.ts) -- computed WITHOUT reference to this
   * signal's own `direction`, then combined via decisionMatrix.ts. "unavailable" only
   * for TradingView-sourced signals, which have no candle history to derive it from. */
  signerBDirection: "long" | "short" | "neutral" | "unavailable";
  signerBConfidence: number;
  signerBEmaTrend: "bullish" | "bearish" | "neutral" | "unavailable";
  rsiDivergence: "bullish" | "bearish" | "none" | "unavailable";
  /** Transparent confirmation-layer status, always present and honest about missing
   * data ("unavailable" is a real, distinct value -- never silently omitted or
   * fabricated as agreeing). TradingView-sourced signals don't compute these (no
   * candle history to derive Supertrend/currency strength from here), so they default
   * to "unavailable" for that source. */
  supertrendTrend: "up" | "down" | "unavailable";
  usdStrengthStatus: "supports" | "conflicts" | "unavailable";
  /** Sourced from FRED (St. Louis Fed) -- US-only and day-level granularity, not a
   * countdown. "high_impact_today" means a curated major USD release is scheduled
   * for the same UTC calendar day, never a specific time. Never fires for a pair's
   * non-USD leg (EUR/GBP/JPY/AUD/CAD releases aren't covered by this data source). */
  newsStatus: "clear" | "high_impact_today" | "unavailable";
}

/** Why a given M15 candle close did *not* produce a Signal -- computed by
 * signalEngine.ts's evaluateSignal from the same real data the gates already checked,
 * never guessed after the fact. `below_threshold` reuses confidenceScore.ts's own
 * DimensionScore so the reason and the (never-created) signal's score can't disagree. */
export type NoTradeReason =
  | { code: "outside_killzone" }
  | { code: "no_setup" } // no recent sweep, no matching structure break, no candidate zone, zone not freshly tagged, or degenerate risk<=0
  | { code: "trend_disagreement"; impliedDirection: "long" | "short"; d1: string; h4: string; h1: string }
  | { code: "weak_trend_adx"; adx: number }
  | { code: "low_volatility"; atr: number; atrAverage: number }
  | { code: "below_threshold"; direction: DimensionScore; entry: DimensionScore }
  // A decisive hold, not a weighted score -- an SMC setup was found and would otherwise
  // have qualified, but a curated major USD release is scheduled for the same UTC
  // calendar day (see lib/market/newsFilter.ts -- FRED-sourced, day-level only, no
  // specific time knowable). Distinct from below_threshold: this never fires from
  // missing/unavailable news data (see checkNews's own "unavailable" vs "clear"
  // distinction) -- only from a genuinely detected same-day event.
  | { code: "news_blackout"; impliedDirection: "long" | "short"; event: string; currency: string }
  // SMC found a qualifying setup, but Signer B's independent read (see signerB.ts) had
  // no real lean either way -- a genuine tie/insufficient-data read, not a fabricated
  // agreement. See decisionMatrix.ts.
  | { code: "signer_b_neutral"; impliedDirection: "long" | "short" }
  // SMC found a qualifying setup, but Signer B's independent read points the opposite
  // direction -- a genuine conflict between the two independent signers, held rather
  // than forced. See decisionMatrix.ts.
  | {
      code: "signer_conflict";
      impliedDirection: "long" | "short";
      signerBDirection: "long" | "short";
      signerBConfidence: number;
    };

export type SignalEvaluation = { status: "signal"; signal: Signal } | { status: "no_trade"; reason: NoTradeReason };

export type StreamEvent =
  | { type: "price"; pair: Pair; bid: number; ask: number; time: number }
  | { type: "candle"; pair: Pair; timeframe: Timeframe; candle: Candle }
  | { type: "signal"; signal: Signal }
  | { type: "prediction"; pair: Pair; timeframe: Timeframe; evaluation: SignalEvaluation; time: number };

/** Latest per-pair evaluation result -- overwritten every closed M15 candle, no
 * history kept (see predictionStore.ts). Distinct from Signal: exists even when no
 * signal qualified, so the dashboard can show real "why not" reasoning. */
export interface PredictionUpdate {
  pair: Pair;
  timeframe: Timeframe;
  evaluation: SignalEvaluation;
  time: number;
}

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
