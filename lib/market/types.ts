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
// couldn't keep up at this pair count, unlike at 9. See the "widen tracked pairs" and its
// revert commit for the full incident.
//
// USOIL added back on 2026-09-02 -- a single-pair step, not a return to 13, and only
// after the actual subscription-pacing story this comment asks for was solved: the
// serialized recovery queue (no more independent per-symbol retry timers re-tripping the
// shared rate limit), the circuit breaker (backs off entirely during a storm instead of
// feeding it), and dropping 5m/4h/1d from live streaming (cut live subscriptions ~40%).
//
// EUR/USD, USD/JPY, and AUD/USD dropped later the same night -- not a subscription-storm
// incident this time, but real, sustained MetaApi credit-limit throttling specifically on
// BTC/USD and USOIL (see https://metaapi.cloud/docs/client/rateLimiting/: a shared,
// account-wide credit budget, 2 credits per candle/quote update -- BTC and oil both tick
// far more often and more erratically than a forex major, so they were burning a
// disproportionate share of it and getting server-side downgraded repeatedly). The
// operator explicitly prioritized keeping BTC/USD, USOIL, and XAU/USD over these three --
// removing them frees up shared credit budget for the pairs that actually matter here,
// same lever MetaApi's own docs suggest ("distribute subscriptions" -- the only version of
// that available on a single account is tracking fewer symbols).
//
// USD/CAD and NZD/USD dropped the same night, a few hours later -- confirmed the 7-pair
// cut above didn't fully clear the throttling, it just moved which symbol absorbed it
// next (NZD/USD hit the same "downgraded -- circuit open" pattern BTC/USD and USOIL
// had). Real evidence the account's overall MetaApi tier is under sustained pressure
// independent of which specific symbols are tracked, not something fixable by picking a
// different 7. Down to 4 now.
//
// USD/CHF swapped back out for USOIL on 2026-09-04 at the operator's explicit request --
// USOIL is a priority instrument for them (see the 2026-09-02 note above), and keeping
// the count at 4 means no net subscription-load increase. USOIL gets FULL live candle
// subscriptions this time, not the quote-only tier it occupied before: a quote-only
// pair can't feed "Check a pair", manual-trade suggestions, or the signal engines, which
// defeated the point of tracking it at all.
export const PAIRS: Pair[] = ["GBP/USD", "XAU/USD", "BTC/USD", "USOIL"];

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

export type SignalSource = "smc" | "tradingview" | "mean_reversion" | "manual_test" | "manual";

/** Sources whose `confidence`/`directionScore`/`entryScore` are placeholders rather than
 * a real weighted score -- TradingView hardcodes tier "buy" by design (see
 * executionPolicy.ts), "manual_test" (see lib/market/testTrade.ts) is a deliberately
 * synthetic order for verifying the DEMO execution pipeline, not a scored setup at all,
 * and "manual" (see manualSignal.ts) is a hand-entered trade -- the operator's own
 * pair/direction/SL/TP judgment standing in for the SMC/range engines' scoring, not a
 * bug or a missing computation. Shared so every place that would otherwise show a
 * fabricated-looking percentage (SignalToast.tsx, SignalsPanel.tsx) shows this label
 * instead, in one place rather than three separately hand-written ternaries. */
export const UNSCORED_SOURCE_LABEL: Partial<Record<SignalSource, string>> = {
  tradingview: "Source: TradingView",
  manual_test: "Source: Manual test order",
  manual: "Source: Manual trade",
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
  // Same "decisive hold" shape as news_blackout above -- a qualifying setup was found,
  // but this pair is within the pre-weekend-close window (see marketHours.ts's
  // isWithinWeekendCloseWindow), so opening it now would sit through the weekend gap.
  // Never fires for crypto (trades straight through the weekend, no gap). Only blocks
  // NEW entries from the SMC/range engines -- already-open positions and the
  // TradingView webhook path are both untouched by this gate.
  | { code: "weekend_close_blackout"; impliedDirection: "long" | "short"; hoursUntilClose: number }
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
  /** Signed EMA20/EMA50 gap (see emaTrend.ts's own emaTrendGapPct), percent of the slow
   * EMA -- null exactly when the matching direction above is "neutral" (same warmup
   * floor). Only consumed by positionRiskNarration.ts's "how close to flipping back"
   * distance so far, but computed alongside the direction fields for every prediction
   * regardless, matching how d1/h4/h1 above are already unconditional. */
  d1Gap: number | null;
  h4Gap: number | null;
  h1Gap: number | null;
}

/** The same real per-timeframe EMA trend read HigherTimeframeTrends already carries for
 * d1/h4/h1 (see emaTrendDirection), extended down to the signal's own two entry
 * timeframes (15m/30m) -- genuinely computed the same way, not fabricated, just applied
 * to two more timeframes where nothing previously read it for display purposes. Additive
 * to HigherTimeframeTrends, not a replacement -- every existing consumer of that type
 * (positionRiskNarration.ts, the SSE "prediction" event, etc.) is unaffected. Only used
 * by the "Check a Pair" analysis job (pairAnalysisJob.ts). */
export interface ExtendedTimeframeTrends extends HigherTimeframeTrends {
  m15: "bullish" | "bearish" | "neutral";
  m30: "bullish" | "bearish" | "neutral";
}

/** The named, real stages of the "Check a Pair" analysis job (pairAnalysisJob.ts) -- the
 * job only ever advances to the next stage once the current one's real computation has
 * actually completed, never on a timer. See pairAnalysisJob.ts's own doc comment for
 * exactly what each stage computes. */
export type AnalysisStage =
  | "market_data"
  | "structure"
  | "smc_engine"
  | "range_engine"
  | "multi_timeframe"
  | "consensus"
  | "risk_validation"
  | "final";

/** One real engine/timeframe's own verdict, for the "AI Consensus" breakdown -- every
 * entry traces to a real, already-computed value (Signer A's candidate evaluation,
 * Signer B's independent vote, the Range Engine's regime read, or a timeframe's EMA
 * trend), never invented. `"unavailable"` means that engine genuinely never ran or
 * never reached a directional read (e.g. Signer B when the SMC candidate that would
 * have reached it was rejected by an earlier gate) -- distinct from `"neutral"`, which
 * means the engine ran and genuinely found no lean either way. */
export interface EngineVerdict {
  engine: "smc" | "signer_b" | "range_engine" | "timeframe_15m" | "timeframe_30m" | "timeframe_1h" | "timeframe_4h" | "timeframe_1d";
  direction: "long" | "short" | "neutral" | "unavailable";
}

/** The real, currently-execute-only risk checks (riskManager.ts/executionPolicy.ts),
 * run early and read-only during analysis for transparency -- never place an order, and
 * are re-checked for real at actual execute time regardless of what's shown here (price/
 * spread/positions can all change in between). Absent entirely when there's no
 * qualifying direction to validate (nothing would be executed anyway). */
export interface RiskValidationSummary {
  spread: { allowed: boolean; reason?: string };
  priceDrift: { allowed: boolean; reason?: string };
  correlatedExposure: { allowed: boolean; reason?: string };
  executionPolicy: { allowed: boolean; reason?: string };
}

/**
 * The final, fully-computed output of a "Check a Pair" analysis job -- see
 * pairAnalysisJob.ts's own doc comment for how each field is derived. `bullish`/
 * `bearish` are each a real, independently-evaluated SignalEvaluation for that specific
 * side's most recent liquidity-sweep candidate, or `null` when no such candidate existed
 * in the lookback window at all (not even attempted) -- distinct from a candidate that
 * was attempted and rejected (still present as a `{status: "no_trade", reason}`).
 */
export interface PairAnalysisResult {
  pair: Pair;
  timeframe: Timeframe;
  time: number;
  regime: MarketRegime;
  timeframeTrends: ExtendedTimeframeTrends;
  bullish: SignalEvaluation | null;
  bearish: SignalEvaluation | null;
  rangeEvaluation: SignalEvaluation;
  /** Real directional confidences (whichever candidate(s) reached Signer A's scoring
   * stage), normalized to sum to 100 alongside noTradePct -- see pairAnalysisJob.ts for
   * the exact normalization. Never independently invented percentages. */
  buyPct: number;
  sellPct: number;
  noTradePct: number;
  /** True when the engines that DID reach a directional read disagree past the job's
   * defined threshold -- drives an honest "CONFLICTED" display instead of forcing a
   * direction. */
  conflicted: boolean;
  /** The winning direction, if any qualifying (non-blocked) candidate exists and the
   * engines aren't conflicted -- "no_trade" otherwise (covers both "nothing qualified"
   * and "conflicted"). */
  direction: "long" | "short" | "no_trade";
  engines: EngineVerdict[];
  riskValidation: RiskValidationSummary | null;
}

/** An in-memory, short-lived record of one "Check a Pair" analysis run -- see
 * pairAnalysisJob.ts. Bounded/pruned the same way positionStore.ts's own MAX_RECORDS is;
 * never persisted to disk, unlike backtestRunner.ts's BacktestJob, since a real run
 * completes in well under a second even with the stage-pacing floor applied. */
export interface AnalysisJob {
  id: string;
  pair: Pair;
  timeframe: Timeframe;
  createdAt: number;
  stage: AnalysisStage;
  stageStartedAt: number;
  status: "running" | "complete" | "failed";
  failReason?: "insufficient_data" | "stale_data";
  failMessage?: string;
  /** Built up incrementally, field by field, as each real stage completes -- e.g.
   * `buyPct`/`sellPct`/`noTradePct` become real and readable the moment the `consensus`
   * stage finishes, well before the job as a whole reaches `status: "complete"`. This is
   * what lets the client show a genuinely live-updating probability DURING analysis
   * (never a client-side guess) rather than only at the very end. Guaranteed to be a
   * complete `PairAnalysisResult` once `status === "complete"`. */
  result: Partial<PairAnalysisResult> | null;
}

/** Response shape of GET /api/signals/analyze/recheck -- see that route and
 * evaluateSpecificDirection's own doc comments. Powers the "Check a Pair"
 * signal-weakening monitor (spec section 11): re-evaluates one specific,
 * already-shown direction right now, plus whether the opposite direction has
 * independently become real in the meantime (a genuine reversal). */
export interface SignalRecheckResponse {
  pair: Pair;
  timeframe: Timeframe;
  direction: "long" | "short";
  evaluation: SignalEvaluation;
  opposingSignal: boolean;
  time: number;
}

// "Is the market still backing this open position, or has it turned against it" --
// see positionRiskNarration.ts's own doc comment for the full classification logic.
// Defined here (not in that file) so this and the StreamEvent variant below can share
// it without positionRiskNarration.ts importing back into this module.
export type PositionRiskLevel = "aligned" | "caution" | "warning";

export interface PositionRiskAssessment {
  level: PositionRiskLevel;
  reason: string;
  /** How far the SINGLE opposing timeframe (d1 or h4) is from crossing back to align
   * with the position, as an absolute EMA20/50 gap percentage -- smaller means closer.
   * Only ever set for "caution" (exactly one opposing read to measure a distance for);
   * null for "warning" (already two confirming reads, a distance to just one of them
   * would be misleading) and "aligned" (nothing opposing). A real, honest CURRENT
   * distance, never a time estimate -- see emaTrendGapPct's own doc comment. */
  distancePct: number | null;
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
  /** When THIS app placed the trade (positionStore's own ExecutedTrade.filledAt) --
   * undefined for a position opened directly on the broker outside the app (see
   * /api/positions's own doc comment), since there's no matching record to derive it
   * from. Populated by the API route, never by getOpenPositions itself (that's a raw
   * broker read with no notion of "when," only "what's open now"). */
  openedAt?: number;
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
  /** Fires when the signal engine itself has gone quiet -- no evaluation (SMC or range)
   * has completed in far longer than any real candle-close cadence would ever explain.
   * Distinct from connectionAlerts: the MT5 connection can read perfectly healthy while
   * the analysis pipeline itself has silently stalled (an uncaught exception, a stuck
   * async chain) -- see evaluationLog.ts's startEvaluationHealthMonitor. Defaults ON:
   * this is the one alert that catches "autopilot looks fine but has quietly stopped
   * thinking", which nothing else on the dashboard would otherwise surface. */
  engineHealthAlerts: boolean;
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
  engineHealthAlerts: true,
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
  | "calibration_update"
  | "engine_health";

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
