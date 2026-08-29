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
  | "BTC/USD"
  | "USD/CHF"
  | "NZD/USD"
  | "EUR/JPY"
  | "AUD/JPY"
  | "ETH/USD"
  | "NFLX"
  | "MSFT"
  | "SPCX";

// Widened from 9 to 13 on 2026-08-28, then REVERTED back to 9 the same night after
// real production evidence: within minutes of deploying 13 pairs, the live account hit
// a sustained, self-perpetuating candle-subscription-downgrade storm (nearly every
// symbol repeatedly downgraded, hundreds of events, not settling over 7+ minutes) --
// the app's own bounded 2-attempt recovery (see MarketSyncListener.onSubscriptionDowngraded)
// couldn't keep up at this pair count, unlike at 9. Going back to 13 (or beyond) needs
// that recovery/subscription-pacing story solved FIRST, verified on demo, before ever
// touching the live account's pair count again -- not just re-adding pairs and hoping.
// See the "widen tracked pairs" and its revert commit for the full incident.
export const PAIRS: Pair[] = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "USD/CHF", "NZD/USD", "XAU/USD", "BTC/USD"];

export interface Candle {
  time: number; // unix ms, candle open time
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  /** Broker-reported spread in points at this candle (see symbols.ts's pointSize for
   * the price-unit conversion) -- only ever populated by the backtester's historical
   * fetch (see backtest/historyLoader.ts); undefined on live-streamed candles, which
   * don't carry it. */
  spread?: number;
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
  | "rsi_divergence"
  // rangeEngine.ts (mean-reversion) confluences below -- SMC never produces these.
  | "range_regime"
  | "boundary_touch"
  | "rsi_extreme"
  | "rejection_candle";

export const CONFLUENCES: Confluence[] = [
  "liquidity_sweep",
  "bos",
  "choch",
  "fvg",
  "order_block",
  "killzone",
  "ema_trend",
  "rsi_momentum",
  "macd_crossover",
  "volume",
  "trend_ema_stack",
  "market_structure",
  "adx",
  "candlestick",
  "multi_timeframe",
  "supertrend",
  "currency_strength",
  "rsi_divergence",
  "range_regime",
  "boundary_touch",
  "rsi_extreme",
  "rejection_candle",
];

export type ConfidenceTier = "strong_buy" | "buy" | "watch";

export type SignalSource = "smc" | "tradingview" | "mean_reversion" | "manual_test";

/** Sources whose `confidence`/`directionScore`/`entryScore` are placeholders rather than
 * a real weighted score -- TradingView hardcodes tier "buy" by design (see
 * executionPolicy.ts), and "manual_test" (see lib/market/testTrade.ts) is a deliberately
 * synthetic order for verifying the DEMO execution pipeline, not a scored setup at all.
 * Shared so every place that would otherwise show a fabricated-looking percentage (
 * SignalToast.tsx, SignalsPanel.tsx) shows this label instead, in one place rather than
 * two separately hand-written ternaries. */
export const UNSCORED_SOURCE_LABEL: Partial<Record<SignalSource, string>> = {
  tradingview: "Source: TradingView",
  manual_test: "Source: Manual test order",
};

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
    }
  // Everything else passed (including Signer B agreement) but the most recently closed
  // 5-minute candle didn't confirm the setup's own direction -- see m5Confirmation.ts.
  // An on-demand REST check at decision time, never a live subscription.
  | { code: "m5_not_confirmed"; impliedDirection: "long" | "short" }
  // --- rangeEngine.ts (mean-reversion) reasons below -- SMC never produces these. ---
  // The market isn't genuinely ranging right now (see marketRegime.ts) -- a trending or
  // breakout regime is exactly the condition a mean-reversion setup needs to avoid, not
  // an arbitrary filter the way SMC's killzone gate is.
  | { code: "not_ranging"; regime: MarketRegime }
  // The regime read itself is "range"/"consolidation", but there isn't yet enough
  // history, a valid ATR reading, detectable swing highs/lows, or a wide-enough gap
  // between them to call this a real, tradeable range at all -- distinct from
  // no_boundary_touch below (a real range DOES exist, it just hasn't been touched yet).
  // Collapsing these into no_boundary_touch was its own bug (see rangeEngine.ts's own
  // comment) -- it made the dashboard claim a specific range existed in cases where none
  // had actually been established.
  | { code: "no_range_detected" }
  // A support/resistance range exists, but the most recently closed candle didn't
  // actually touch either boundary -- there's nothing to react to yet.
  | { code: "no_boundary_touch" }
  // A genuine boundary touch happened, but the weighted score (RSI extremity,
  // rejection-candle quality, range cleanliness, entry proximity) didn't clear the
  // shared tierOf floor -- a single total, not SMC's two-dimension DimensionScore
  // shape, since this engine scores one combined dimension, not direction+entry
  // separately.
  | { code: "range_below_threshold"; total: number; impliedDirection: "long" | "short" };

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

// "Is the market still backing this open position, or has it turned against it" --
// see positionRiskNarration.ts's own doc comment for the full classification logic.
// Defined here (not in that file) so this and the StreamEvent variant below can share
// it without positionRiskNarration.ts importing back into this module.
export type PositionRiskLevel = "aligned" | "caution" | "warning";

export interface PositionRiskAssessment {
  level: PositionRiskLevel;
  reason: string;
}

export type StreamEvent =
  | { type: "price"; pair: Pair; bid: number; ask: number; time: number }
  | { type: "candle"; pair: Pair; timeframe: Timeframe; candle: Candle }
  | { type: "signal"; signal: Signal }
  | {
      type: "prediction";
      pair: Pair;
      timeframe: Timeframe;
      source: SignalSource;
      evaluation: SignalEvaluation;
      time: number;
      regime: MarketRegime;
      trends: HigherTimeframeTrends;
    }
  | {
      type: "position_risk";
      positionId: string;
      pair: Pair;
      direction: "long" | "short";
      level: PositionRiskLevel;
      reason: string;
      time: number;
    };

/** Latest per-pair evaluation result -- overwritten every closed M15 candle, no
 * history kept (see predictionStore.ts). Distinct from Signal: exists even when no
 * signal qualified, so the dashboard can show real "why not" reasoning. */
export interface PredictionUpdate {
  pair: Pair;
  timeframe: Timeframe;
  /** Which engine produced this evaluation -- predictionStore keys on this too (see
   * predictionStore.ts), so two engines evaluating the same pair/timeframe never
   * silently overwrite each other's latest status. */
  source: SignalSource;
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
  /** The broker's own real MT5 "point" size for this symbol (see MetaApi's
   * MetatraderSymbolSpecification.point) -- the actual price delta one point of a
   * broker-reported spread reading represents. Read directly from the account's real
   * spec rather than derived/guessed from decimals(pair), since a broker's quoted
   * precision doesn't reliably predict its own point convention (see
   * backtest/historyLoader.ts's loadSymbolSpecs, backtest/backtestEngine.ts's
   * simulateRealisticOutcome). */
  point: number;
}

export interface AccountInfo {
  balance: number;
  equity: number;
  /** Same object as balance/equity (terminalState.accountInformation) -- never
   * independently absent when the other two are present. */
  freeMargin: number;
  margin: number;
  /** Account-level trading permission -- false for e.g. an unfunded/zero-balance
   * account, independent of market hours or per-symbol trade mode (see
   * getSymbolTradingInfo for the per-symbol equivalent). */
  tradeAllowed: boolean;
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
  dailyDigest: boolean;
  /** Fires when a restart (deploy, crash, host restart) silently drops engine mode back
   * to its safe ANALYSIS default from LIVE/DEMO -- see engineMode.ts's own doc comment
   * on why that reset is unconditional and deliberate, not a bug. Defaults ON: missing
   * this one means believing you're still live-trading when you're not. */
  engineModeAlerts: boolean;
  /** Fires when a signal that otherwise qualified (buy/strong_buy tier) was held back
   * from auto-execution -- correlated exposure, a stale/wide-spread price, a risk limit,
   * an existing losing position on the same pair+timeframe, or a lot size too small for
   * the account balance to clear the broker's minimum. Purely informational -- narrates
   * WHY the autopilot didn't fire, never changes whether it does. Defaults ON: without
   * it, a held-back signal is silent, and "why didn't that fire" has no answer short of
   * reading server logs. Deliberately excludes the autopilot-lock/kill-switch/engine-mode
   * skips -- those are the operator's own standing choice, not new information, and would
   * just repeat on every signal while active. */
  autopilotBlocked: boolean;
  /** Fires when the London/NY killzone window opens or closes -- the SMC engine's own
   * FX/gold trading window (see sessions.ts). Purely informational, same posture as
   * autopilotBlocked above. Defaults ON. */
  sessionAlerts: boolean;
  /** Fires when a confidence tier (buy/strong_buy) crosses a real closed-trade milestone
   * (10/20/30) toward getConfidenceCalibration's own sample-size bar -- purely
   * informational progress toward data that isn't wired into sizing until it clears that
   * bar (see positionSizing.ts's confidenceAdjustedRiskPct). Defaults ON. */
  calibrationUpdates: boolean;
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
  // Defaults OFF, unlike weeklyDigest -- a nightly push is a much higher-frequency ask
  // than a weekly one, and this is a brand-new category existing devices won't have
  // opted into; better to have an operator explicitly turn it on than surprise anyone
  // testing on demo with a notification every evening.
  dailyDigest: false,
  engineModeAlerts: true,
  autopilotBlocked: true,
  sessionAlerts: true,
  calibrationUpdates: true,
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
  | "weekly_digest"
  | "daily_digest"
  | "engine_mode_reset"
  | "signal_blocked"
  | "session_alert"
  | "calibration_update";

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
