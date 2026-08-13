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

/** The current candle's classified market condition -- see marketRegime.ts for how
 * this is derived (existing ADX/ATR/EMA reads only, no new indicator). Explanatory
 * context only; never gates or alters a trade decision. */
export type MarketRegime =
  | "news_driven"
  | "breakout"
  | "strong_uptrend"
  | "strong_downtrend"
  | "high_volatility"
  | "low_volatility"
  | "consolidation"
  | "range";

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
  /** Raw ADX/RSI readings at the signal candle -- already computed in signalEngine.ts
   * for the direction/entry scoring gates, just exposed here directly rather than only
   * as a pass/fail confluence tag, so the UI can show the real number (e.g. "ADX 27.4"),
   * not just a checkmark. NaN for TradingView-sourced signals (no candle history to
   * derive them from -- never fabricated). */
  adx: number;
  rsi: number;
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
  newsStatus: "clear" | "high_impact_soon" | "unavailable";
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
  // have qualified, but a high-impact release for one of the pair's currencies is
  // imminent (see lib/market/newsFilter.ts). Distinct from below_threshold: this never
  // fires from missing/unavailable news data (see checkNews's own "unavailable" vs
  // "clear" distinction) -- only from a genuinely detected upcoming event.
  | { code: "news_blackout"; impliedDirection: "long" | "short"; event: string; currency: string; minutesUntil: number }
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

/** D1/H4/H1 EMA50/200 trend read, independent of whether a signal actually fired --
 * the same three values signalEngine.ts's own hard trend-agreement gate already
 * computes (see emaTrendDirection), surfaced here so the dashboard can show real
 * per-timeframe bias continuously instead of only when a signal is blocked for
 * trend_disagreement specifically. */
export interface HigherTimeframeTrends {
  d1: "bullish" | "bearish" | "neutral";
  h4: "bullish" | "bearish" | "neutral";
  h1: "bullish" | "bearish" | "neutral";
}

export type StreamEvent =
  | { type: "price"; pair: Pair; bid: number; ask: number; time: number }
  | { type: "candle"; pair: Pair; timeframe: Timeframe; candle: Candle }
  | { type: "signal"; signal: Signal }
  | {
      type: "prediction";
      pair: Pair;
      timeframe: Timeframe;
      evaluation: SignalEvaluation;
      time: number;
      regime: MarketRegime;
      trends: HigherTimeframeTrends;
    };

/** Latest per-pair evaluation result -- overwritten every closed M15 candle, no
 * history kept (see predictionStore.ts). Distinct from Signal: exists even when no
 * signal qualified, so the dashboard can show real "why not" reasoning. */
export interface PredictionUpdate {
  pair: Pair;
  timeframe: Timeframe;
  evaluation: SignalEvaluation;
  time: number;
  /** Computed independently of `evaluation` (see marketRegime.ts) -- shown for every
   * update, not just a qualifying signal, so a NO TRADE reads with real context (e.g.
   * "SMC found a setup, but the market is ranging") instead of a bare gate reason. */
  regime: MarketRegime;
  trends: HigherTimeframeTrends;
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
  /** The signal engine's own timeframe (15m/30m/1h) -- needed to match an incoming
   * invalidation signal (see positionInvalidation.ts) to the right open position;
   * three signal engines run concurrently per pair, so pair alone isn't enough. */
  timeframe: Timeframe;
  direction: "long" | "short";
  requestedLots: number;
  requestedEntry: number;
  filledEntry?: number;
  stopLoss: number;
  takeProfit: number;
  /** The signal's TP2 zone -- carried through so positionManager.ts's partial
   * take-profit action can trigger at TP1 (`takeProfit` above) while still knowing
   * where the remaining runner is headed. Not itself sent to the broker as a second
   * order; the broker only ever sees one takeProfit at a time (see partialCloseApplied
   * in positionManager.ts). */
  takeProfit2: number;
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
  weeklyDigest: boolean;
  minConfidence: number;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  buySignals: true,
  sellSignals: true,
  tradeExecution: true,
  tpSl: true,
  riskAlerts: true,
  connectionAlerts: true,
  weeklyDigest: true,
  minConfidence: 80,
};

export type NotificationCategory =
  | "buy_signal"
  | "sell_signal"
  | "trade_opened"
  | "trade_closed"
  | "order_rejected"
  | "risk_alert"
  | "connection_alert"
  | "weekly_digest";

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
