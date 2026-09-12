import { randomUUID } from "node:crypto";
import type {
  Candle,
  Confluence,
  LiquiditySweep,
  NoTradeReason,
  Pair,
  Signal,
  SignalEvaluation,
  StructureEvent,
  SwingPoint,
  Timeframe,
} from "./types";
import { detectSwingPoints } from "./detectors/swings";
import { detectStructureBreaks } from "./detectors/structure";
import { detectFairValueGaps } from "./detectors/fairValueGaps";
import { detectOrderBlocks } from "./detectors/orderBlocks";
import { detectLiquiditySweeps } from "./detectors/liquiditySweeps";
import { marketStructureTrend } from "./detectors/marketStructure";
import { detectCandlestickPattern } from "./detectors/candlestickPatterns";
import { getActiveSession, isKillzone } from "./sessions";
import { isCrypto, isStock, isCommodity } from "./symbols";
import { calculateRsi } from "./indicators/rsi";
import { calculateMacd } from "./indicators/macd";
import { calculateAdx } from "./indicators/adx";
import { calculateAtr } from "./indicators/atr";
import { isAboveAverageVolume } from "./indicators/volume";
import { isEmaStackAligned } from "./indicators/emaStack";
import { calculateSupertrend } from "./indicators/supertrend";
import { emaTrendDirection } from "./indicators/emaTrend";
import { computeUsdStrength, usdStrengthSupports as computeUsdStrengthSupport, type UsdStrength } from "./currencyStrength";
import { checkNews, type NewsStatus } from "./newsFilter";
import { isWithinWeekendCloseWindow, nyWeekdayAndHour } from "./marketHours";
import { scoreSignal } from "./confidenceScore";
import { evaluateSignerB } from "./signerB";
import { combineSigners } from "./decisionMatrix";

/**
 * Only ever passed by the backtester (see lib/market/backtest/) -- undefined at every
 * live call site, so live behavior is unchanged unless a caller explicitly opts in.
 * usdStrength/newsStatus feed live-cache reads with no per-bar timestamp of their own,
 * which the backtester replaces with real historical values computed per bar (see
 * evaluateSignal's own doc comment). atrAverageMultiplier/minAdx exist so the backtester
 * can measure whether LOOSENING the low_volatility/weak_trend_adx hard gates (see
 * evaluateDirectionalCandidate below) is a real edge improvement or just more trades --
 * added 2026-09-11 after an operator asked to lower these thresholds live off the back
 * of one quiet night; this is the actual way to answer that with real historical data
 * instead of a guess, without ever touching the live gates until a backtest confirms it.
 */
export interface SignalEvaluationOverrides {
  usdStrength?: UsdStrength;
  newsStatus?: NewsStatus;
  /** Multiplier applied to the low_volatility gate's ATR-average threshold: requires
   * `atr > atrAverage * atrAverageMultiplier`. Defaults to 1 (today's live behavior --
   * ATR must exceed its own recent average). A value below 1 loosens the gate (allows
   * firing at a below-average-but-not-too-far-below reading); above 1 tightens it. */
  atrAverageMultiplier?: number;
  /** Overrides ADX_HARD_MIN's floor for the weak_trend_adx gate. Defaults to
   * ADX_HARD_MIN (15, lowered from 20 on 2026-09-11 -- see that constant's own doc
   * comment for the backtest evidence) when unset. */
  minAdx?: number;
  /** Overrides TREND_AGREEMENT_MODE_DEFAULT for the D1 hard trend-agreement gate (the
   * "trend_disagreement" no-trade code). "d1_only" requires D1 itself to agree with the
   * implied direction, full stop. "d1_or_h4" passes if EITHER D1 or H4 agrees. Defaults
   * to TREND_AGREEMENT_MODE_DEFAULT (see that constant's own doc comment for the
   * backtest evidence and why it was shipped live despite a mixed signal) when unset. */
  trendAgreementMode?: "d1_only" | "d1_or_h4";
}

const SWEEP_LOOKBACK_CANDLES = 30;
// Fraction of the instrument's own ATR used as the SL buffer beyond the swept swing
// level. Replaces a flat pip count, which doesn't scale across instruments — a
// broker's "pip" is just 10x its smallest quotable tick (a display convention), not
// something proportional to real volatility (see symbols.ts's XAU/USD comment).
const ATR_BUFFER_FRACTION = 0.25;
// Same reasoning as ATR_BUFFER_FRACTION, applied to the liquidity-sweep wick-overshoot
// tolerance (see detectLiquiditySweeps) instead of the SL buffer. Smaller than the SL
// buffer fraction since this is meant for tight equal-highs/lows clustering, not a
// full safety margin.
const SWEEP_TOLERANCE_ATR_FRACTION = 0.1;
const MIN_RISK_REWARD = 1.5;
const FALLBACK_RISK_REWARD = 2;
const MIN_RISK_REWARD_2 = 2.5;
const FALLBACK_RISK_REWARD_2 = 3;

// Operator-requested override (2026-09-07): a flat $1.50 take-profit target for these
// specific pairs, replacing the structure/risk-reward-based target entirely -- NOT a
// pip/percentage distance, a literal price-unit distance, which only makes sense for a
// pair actually priced in whole dollars (confirmed with the operator: GBP/USD trades
// around 1.2-1.4, where a $1.50 move is larger than the pair's entire realistic range,
// so it's deliberately excluded here; BTC/USD trades in the tens of thousands, where
// $1.50 is a near-instant, near-zero-profit target -- the operator was shown this
// tradeoff directly and chose to include it anyway). Stop-loss is untouched by this --
// still the existing ATR-buffered structural stop computed above.
const FIXED_TAKE_PROFIT_DISTANCE: Partial<Record<Pair, number>> = {
  "XAU/USD": 1.5,
  "BTC/USD": 1.5,
  USOIL: 1.5,
};
// Exported so pairAnalysisJob.ts's smcSetupProgress can report a real "ADX X of Y needed"
// ratio without duplicating this number by hand and risking it drifting out of sync.
//
// Lowered from 20 to 15 on 2026-09-11, backed by real historical data, not a hunch --
// _backtest-gate-comparison.ts replayed the SAME candle series through evaluateSignal at
// both floors, isolating this one variable. Over 90 days (5 pairs, 15m): baseline 48
// trades / 72.9% win rate / 3.42 profit factor vs. ADX>=15's 78 trades / 71.8% / 4.88.
// Over 180 days: 102 trades / 78.4% / 4.26 vs. 159 trades / 76.1% / 4.72. Both windows
// agree: more trades, a slightly lower win rate, but a HIGHER profit factor and higher
// average R -- not just "more trades", genuinely better quality ones too. A companion
// loosening of the low_volatility ATR gate was tested at the same time and made every
// metric worse (confirmed that gate is doing real work) -- ATR was left untouched.
// Caveat this change accepts: only tested on 15m with idealized (non-realistic) fills,
// since this deployment has no DEMO MetaApi account to safely run realistic-mode
// (spread/position-management) simulation against without contending with the live
// connection's own rate limit. If live results (Journal -> Performance by engine, "smc")
// don't track this after a couple of weeks, revert this single constant back to 20.
export const ADX_HARD_MIN = 15;
// Live default for the D1 hard trend-agreement gate, changed from "d1_only" to
// "d1_or_h4" on 2026-09-12. Backed by real historical replay, not a hunch, but the
// evidence is genuinely mixed -- shipped anyway on an explicit operator decision to
// accept that tradeoff for more trade frequency, after the risk was laid out plainly.
// _backtest-gate-comparison.ts replayed the SAME candle series through evaluateSignal
// with only this one gate changed (5 pairs, 15m). Over 180 days: baseline 164 trades /
// 76.8% win rate / 0.89 avgR / 4.83 profit factor / 3.99R max drawdown vs. d1_or_h4's
// 241 trades / 77.6% / 2.25 / 11.18 / 5.28R -- looks like a clear win. But over the more
// recent 90 days: baseline 82 trades / 74.4% / 1.10 / 5.31 / 3.99R vs. d1_or_h4's 133 /
// 76.7% / 0.94 / 5.13 / 5.28R -- MORE trades and a slightly higher win rate, but a
// slightly WORSE average R and profit factor than baseline. The two windows agree on
// "more trades, modestly higher win rate" but disagree on whether per-trade quality
// actually improves; the strong 180-day avgR/profit-factor numbers are likely carried
// by the older (91-180 day) half of history, not by how the market's behaving lately.
// The 3.99R -> 5.28R max-drawdown increase is a real, sane ~32% rise proportionate to
// the extra trade volume -- NOT the same number as an earlier, since-fixed 22.95R
// backtest reading, which was a zombie-invalidation bookkeeping bug in
// backtestInvalidation.ts (see that file's own doc comment), not a real result. Same
// caveat as ADX_HARD_MIN: only tested on 15m with idealized (non-realistic) fills, no
// DEMO MetaApi account to forward-test against first. If live results (Journal ->
// Performance by engine, "smc") don't track the win-rate gain within a couple of weeks,
// revert this constant back to "d1_only".
export const TREND_AGREEMENT_MODE_DEFAULT: "d1_only" | "d1_or_h4" = "d1_or_h4";
const ATR_AVERAGE_PERIOD = 20;
// How many hours before the Friday 5pm New York weekly close a NEW entry is refused --
// see marketHours.ts's isWithinWeekendCloseWindow for the reasoning. Env-configurable
// (not per-account like executionConfig.ts's knobs -- this gates signal GENERATION,
// before any account/execution decision even exists, the same account-agnostic
// placement checkNews's own blackout already uses). Exported so rangeEngine.ts's own
// identical gate reads the exact same value rather than an independently-configured copy.
export const WEEKEND_CLOSE_GATE_HOURS = Number(process.env.WEEKEND_CLOSE_GATE_HOURS) || 2;

// "doji" is direction-agnostic by design (see candlestickPatterns.ts's own doc comment
// on isDoji) -- its own open/close is too weak a signal to call a side, so it counts
// toward whichever direction the zone/structure already want, same as any other match.
const BULLISH_PATTERNS = new Set(["bullish_engulfing", "pin_bar_bullish", "morning_star", "doji"]);
const BEARISH_PATTERNS = new Set(["bearish_engulfing", "pin_bar_bearish", "evening_star", "doji"]);

interface Zone {
  top: number;
  bottom: number;
  confluence: "order_block" | "fvg";
  /** Index after which a touch counts as a genuine retest (excludes the formation/impulse candles). */
  sinceIndex: number;
}

export interface HigherTimeframeCandles {
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
}

/**
 * Every input `evaluateDirectionalCandidate` needs that does NOT depend on which
 * direction (bullish/bearish sweep) is being evaluated -- computed once and shared
 * across both a bullish and a bearish candidate check (see `findSweepCandidates` +
 * `evaluateDirectionalCandidate` below), instead of recomputed per direction. Everything
 * here is a pure function of `candles`/`higherTimeframes` alone.
 */
export interface SharedGateContext {
  candles: Candle[];
  pair: Pair;
  timeframe: Timeframe;
  higherTimeframes: HigherTimeframeCandles;
  lastIndex: number;
  lastCandle: Candle;
  atrSeries: number[];
  atr: number;
  atrAverage: number;
  adx: number;
  swings: SwingPoint[];
  structureEvents: StructureEvent[];
  recentSweeps: LiquiditySweep[];
  d1Trend: "bullish" | "bearish" | "neutral";
  h4Trend: "bullish" | "bearish" | "neutral";
  h1Trend: "bullish" | "bearish" | "neutral";
  overrides?: SignalEvaluationOverrides;
}

/**
 * Computes every direction-independent input `evaluateDirectionalCandidate` needs, plus
 * the two hard gates that must fail before any direction is even known (too few candles,
 * outside the killzone). Returns `null` for those two cases -- callers should treat that
 * exactly like a `no_setup`/`outside_killzone` no_trade result, same as `evaluateSignal`
 * always has.
 */
export function computeSharedGateContext(
  candles: Candle[],
  pair: Pair,
  timeframe: Timeframe,
  higherTimeframes: HigherTimeframeCandles,
  overrides?: SignalEvaluationOverrides
): { context: SharedGateContext } | { blocked: NoTradeReason } {
  if (candles.length < 10) return { blocked: { code: "no_setup" } };
  const lastIndex = candles.length - 1;
  const lastCandle = candles[lastIndex];

  // Crypto trades 24/7 with no ICT-style institutional session structure the killzone
  // gate was built around, so it's exempted here rather than arbitrarily restricted to
  // forex trading hours. Stocks (NFLX/MSFT/SPCX) get the same exemption for a different
  // reason: their own real trading hours have no relationship to the forex London/NY
  // killzone, and the broker's candle stream already only ever produces bars during
  // their actual open hours (see symbols.ts's isStock() doc comment) -- every other
  // pre-gate below still fully applies to both. Oil (USOIL/UKOIL, see isCommodity) is
  // exempted for the same structural reason: it's a USD-quoted commodity that trends
  // through Asia and the full US session, not a forex pair whose move concentrates in
  // the London/NY overlap -- boxing it into the killzone would suppress the majority of
  // its real setups, which defeats the point of tracking it as a priority instrument.
  if (!isCrypto(pair) && !isStock(pair) && !isCommodity(pair) && !isKillzone(lastCandle.time)) {
    return { blocked: { code: "outside_killzone" } };
  }

  // Hoisted ahead of sweep detection: the sweep tolerance below needs it, and it's a
  // pure function of `candles` with no dependency on anything computed in between, so
  // this doesn't change gate ordering or outcomes — just makes it available earlier.
  const atrSeries = calculateAtr(candles);
  const atr = atrSeries[lastIndex];

  const swings = detectSwingPoints(candles);
  const structureEvents = detectStructureBreaks(candles, swings);
  // A candle's wick must clear the swept swing by more than this to count as a genuine
  // sweep rather than noise — scaled to the instrument's own ATR instead of a flat pip
  // multiple, since a broker's pip isn't proportional to real volatility (see
  // ATR_BUFFER_FRACTION below, and symbols.ts's XAU/USD comment).
  const sweepTolerance = atr * SWEEP_TOLERANCE_ATR_FRACTION;
  const sweeps = detectLiquiditySweeps(candles, swings, sweepTolerance);
  const recentSweeps = sweeps.filter((s) => s.sweepIndex >= lastIndex - SWEEP_LOOKBACK_CANDLES);

  const adx = calculateAdx(candles)[lastIndex];
  const atrWindow = atrSeries.slice(lastIndex - ATR_AVERAGE_PERIOD, lastIndex);
  const atrAverage = atrWindow.reduce((sum, v) => sum + v, 0) / atrWindow.length;

  // H1 is intentionally NOT part of the D1 gate below -- a live check of the
  // lone-disagreement pattern across all 9 pairs found H1 was the sole holdout in 5 of 7
  // blocked setups (D1: 2, H4: 0), consistent with it being the fastest/noisiest of the
  // three and most prone to a short-term pullback against the real D1/H4 trend. h1Trend
  // is still computed and carried in the no-trade reason payload purely as informational
  // context, never as a blocker.
  //
  // H4 was demoted the same way on 2026-09-02, after a production data pull of every
  // trend_disagreement rejection ever logged (1538 of them) found: 744 were a genuine
  // D1-vs-H4 split, and of those, 511 (69%) had the zone's own direction matching D1,
  // not H4 -- the textbook "trade with the daily trend, enter on an H4 pullback"
  // pattern, which requiring all-three-agree was blocking outright. Only D1 -- the
  // slower, more reliable read -- still gates; h4Trend is carried the same way h1Trend
  // already was, informational only.
  const d1Trend = emaTrendDirection(higherTimeframes.d1);
  const h4Trend = emaTrendDirection(higherTimeframes.h4);
  const h1Trend = emaTrendDirection(higherTimeframes.h1);

  return {
    context: {
      candles,
      pair,
      timeframe,
      higherTimeframes,
      lastIndex,
      lastCandle,
      atrSeries,
      atr,
      atrAverage,
      adx,
      swings,
      structureEvents,
      recentSweeps,
      d1Trend,
      h4Trend,
      h1Trend,
      overrides,
    },
  };
}

/**
 * The most recent sweep implying a bullish reversal (a sellside sweep -- stops above a
 * high taken out) and the most recent implying a bearish one (a buyside sweep),
 * independently -- either or both may be absent. A sweep implying direction X is
 * unrelated to whether a sweep implying the opposite direction also exists; both can be
 * real, independently-evaluable candidates at once (e.g. a recent sweep of both the
 * range high and low). Used by the dual-direction analysis job (pairAnalysisJob.ts) to
 * genuinely score both sides rather than only whichever sweep happens to be most recent
 * overall -- see evaluateSignal below for the single-candidate behavior every existing
 * caller still gets unchanged.
 */
export function findSweepCandidates(recentSweeps: LiquiditySweep[]): { bullish?: LiquiditySweep; bearish?: LiquiditySweep } {
  const bullish = recentSweeps.filter((s) => s.side === "sellside").at(-1);
  const bearish = recentSweeps.filter((s) => s.side === "buyside").at(-1);
  return { bullish, bearish };
}

/**
 * Evaluates ONE specific liquidity-sweep candidate (bullish or bearish) all the way
 * through to a Signal or a NoTradeReason -- this is the entire direction-dependent half
 * of the pipeline described on evaluateSignal's own doc comment (D1/ADX/ATR pre-gates,
 * structure/zone match, news/weekend blackouts, Signer A scoring, Signer B, decision
 * matrix). Factored out so the dual-direction analysis job can call it once per real
 * candidate side (see findSweepCandidates) instead of only ever seeing whichever sweep
 * happened to be most recent overall.
 */
export function evaluateDirectionalCandidate(ctx: SharedGateContext, sweep: LiquiditySweep): SignalEvaluation {
  const noTrade = (reason: NoTradeReason): SignalEvaluation => ({ status: "no_trade", reason });
  const { candles, pair, timeframe, lastIndex, lastCandle, atr, atrAverage, adx, swings, structureEvents, overrides } = ctx;

  // A buyside sweep (stops above a high taken out) implies a bearish reversal is
  // being set up; a sellside sweep implies a bullish one.
  const wantsBullish = sweep.side === "sellside";
  const zoneDirection = wantsBullish ? "bullish" : "bearish";
  const direction: "long" | "short" = wantsBullish ? "long" : "short";

  // --- Hard pre-gates: D1/H4 agreement, ADX floor, ATR health ---
  // trendAgreementMode defaults to TREND_AGREEMENT_MODE_DEFAULT ("d1_or_h4" as of
  // 2026-09-12 -- see that constant's own doc comment for the backtest evidence and the
  // mixed-signal tradeoff it was shipped on). The backtester overrides this to measure
  // either mode directly against real historical data.
  const d1Agrees = ctx.d1Trend === zoneDirection;
  const h4Agrees = ctx.h4Trend === zoneDirection;
  const trendAgreementMode = overrides?.trendAgreementMode ?? TREND_AGREEMENT_MODE_DEFAULT;
  const trendAgrees = trendAgreementMode === "d1_or_h4" ? d1Agrees || h4Agrees : d1Agrees;
  if (!trendAgrees) {
    return noTrade({ code: "trend_disagreement", impliedDirection: direction, d1: ctx.d1Trend, h4: ctx.h4Trend, h1: ctx.h1Trend });
  }

  // Both floors below default to today's live values when overrides is unset (every
  // live call site) -- only the backtester ever supplies these, to measure whether
  // loosening either gate is a real edge improvement. See SignalEvaluationOverrides's
  // own doc comment.
  const minAdx = overrides?.minAdx ?? ADX_HARD_MIN;
  if (Number.isNaN(adx) || adx < minAdx) return noTrade({ code: "weak_trend_adx", adx: Number.isNaN(adx) ? 0 : adx });

  const atrThreshold = atrAverage * (overrides?.atrAverageMultiplier ?? 1);
  if (Number.isNaN(atr) || !(atr > atrThreshold)) {
    return noTrade({ code: "low_volatility", atr: Number.isNaN(atr) ? 0 : atr, atrAverage });
  }

  const structureEvent = structureEvents
    .filter((e) => e.breakIndex > sweep.sweepIndex && e.breakIndex <= lastIndex)
    .find((e) =>
      wantsBullish
        ? e.type === "BOS_BULLISH" || e.type === "CHOCH_BULLISH"
        : e.type === "BOS_BEARISH" || e.type === "CHOCH_BEARISH"
    );
  if (!structureEvent) return noTrade({ code: "no_setup" });

  const [orderBlock] = detectOrderBlocks(candles, [structureEvent]);
  const fvgs = detectFairValueGaps(candles).filter(
    (g) => g.direction === zoneDirection && g.startIndex <= structureEvent.breakIndex && g.startIndex >= structureEvent.breakIndex - 3
  );

  const candidateZones: Zone[] = [];
  if (orderBlock) {
    candidateZones.push({
      top: orderBlock.top,
      bottom: orderBlock.bottom,
      confluence: "order_block",
      sinceIndex: structureEvent.breakIndex,
    });
  }
  for (const gap of fvgs) {
    candidateZones.push({
      top: gap.top,
      bottom: gap.bottom,
      confluence: "fvg",
      sinceIndex: Math.max(gap.startIndex + 2, structureEvent.breakIndex),
    });
  }
  if (candidateZones.length === 0) return noTrade({ code: "no_setup" });

  const overlaps = (candle: Candle, zone: Zone) => candle.low <= zone.top && candle.high >= zone.bottom;
  const taggedNow = candidateZones.find((zone) => overlaps(lastCandle, zone));
  if (!taggedNow) return noTrade({ code: "no_setup" });
  // Only fire the first time price returns to the zone after it formed, so a signal
  // doesn't repeat every candle while price chops around inside it.
  const alreadyTagged = candles.slice(taggedNow.sinceIndex + 1, lastIndex).some((c) => overlaps(c, taggedNow));
  if (alreadyTagged) return noTrade({ code: "no_setup" });

  const entry = (taggedNow.top + taggedNow.bottom) / 2;
  const slBuffer = atr * ATR_BUFFER_FRACTION;
  const stopLoss = wantsBullish ? sweep.sweptSwing.price - slBuffer : sweep.sweptSwing.price + slBuffer;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return noTrade({ code: "no_setup" });

  const opposingPrices = swings
    .filter((s) => s.index > structureEvent.breakIndex && s.type === (wantsBullish ? "high" : "low"))
    .map((s) => s.price)
    .filter((price) => (wantsBullish ? price > entry : price < entry));

  let takeProfit = wantsBullish ? entry + risk * FALLBACK_RISK_REWARD : entry - risk * FALLBACK_RISK_REWARD;
  if (opposingPrices.length > 0) {
    const target = wantsBullish ? Math.min(...opposingPrices) : Math.max(...opposingPrices);
    const reward = Math.abs(target - entry);
    if (reward / risk >= MIN_RISK_REWARD) takeProfit = target;
  }

  // TP2: a further opposing swing beyond TP1, if one clears the higher R-multiple bar.
  let takeProfit2 = wantsBullish ? entry + risk * FALLBACK_RISK_REWARD_2 : entry - risk * FALLBACK_RISK_REWARD_2;
  const furtherPrices = opposingPrices.filter((price) => (wantsBullish ? price > takeProfit : price < takeProfit));
  if (furtherPrices.length > 0) {
    const target2 = wantsBullish ? Math.min(...furtherPrices) : Math.max(...furtherPrices);
    const reward2 = Math.abs(target2 - entry);
    if (reward2 / risk >= MIN_RISK_REWARD_2) takeProfit2 = target2;
  }

  // See FIXED_TAKE_PROFIT_DISTANCE's own doc comment -- overrides TP1 only (an explicit,
  // scoped operator request), applied after every structure/risk-reward-based target
  // above so it always wins for these pairs regardless of what structure found. TP2
  // deliberately keeps its existing risk-reward-based value; the operator asked to
  // change take-profit, not the separate partial-close target.
  const fixedTakeProfit = FIXED_TAKE_PROFIT_DISTANCE[pair];
  if (fixedTakeProfit !== undefined) {
    takeProfit = wantsBullish ? entry + fixedTakeProfit : entry - fixedTakeProfit;
  }

  // A decisive hold, not part of the weighted score below -- an SMC setup was just
  // fully located (entry/SL/TP all computed above) and would otherwise be evaluated,
  // but a high-impact release for one of this pair's currencies is imminent. Never
  // fires from missing/unreachable news data (see checkNews's own "unavailable" vs
  // "clear" distinction) -- only from a genuinely detected upcoming event.
  const newsCheck = overrides?.newsStatus ?? checkNews(pair, lastCandle.time);
  if (newsCheck.status === "high_impact_soon") {
    return noTrade({
      code: "news_blackout",
      impliedDirection: direction,
      event: newsCheck.event,
      currency: newsCheck.currency,
      minutesUntil: newsCheck.minutesUntil,
    });
  }

  // Same "decisive hold" shape as the news blackout just above -- a qualifying setup was
  // found, but opening it now would sit through the weekend gap (see marketHours.ts's
  // isWithinWeekendCloseWindow). Driven by the CANDLE's own time, not wall-clock Date.now()
  // -- deterministic in backtests against real historical Fridays, same reasoning as
  // checkNews(pair, lastCandle.time) just above, and needs no backtest override the way
  // newsStatus does (no external data source involved, purely a function of the time).
  if (isWithinWeekendCloseWindow(pair, lastCandle.time, WEEKEND_CLOSE_GATE_HOURS)) {
    return noTrade({
      code: "weekend_close_blackout",
      impliedDirection: direction,
      hoursUntilClose: Math.max(0, 17 - nyWeekdayAndHour(lastCandle.time).hour),
    });
  }

  // --- Weighted confidence score over the remaining categories ---
  const emaStackAligned = isEmaStackAligned(candles, direction);

  const rsiSeries = calculateRsi(candles);
  const rsi = rsiSeries[lastIndex];
  const rsiAgrees = !Number.isNaN(rsi) && (wantsBullish ? rsi > 50 : rsi < 50);

  const { macdLine, signalLine } = calculateMacd(candles);
  const macd = macdLine[lastIndex];
  const macdSignal = signalLine[lastIndex];
  const macdAgrees = !Number.isNaN(macd) && !Number.isNaN(macdSignal) && (wantsBullish ? macd > macdSignal : macd < macdSignal);

  const volumeAboveAverage = isAboveAverageVolume(candles, lastIndex, 20);
  const marketStructureMatches = marketStructureTrend(swings) === zoneDirection;

  const pattern = detectCandlestickPattern(candles, lastIndex);
  const candlestickMatches = pattern !== null && (wantsBullish ? BULLISH_PATTERNS : BEARISH_PATTERNS).has(pattern);

  const score = scoreSignal({
    emaStackAligned,
    adx,
    marketStructureMatches,
    smcZoneType: taggedNow.confluence,
    volumeAboveAverage,
    macdAgrees,
    rsiAgrees,
    candlestickMatches,
  });

  if (score.tier === "no_trade") {
    return noTrade({ code: "below_threshold", direction: score.direction, entry: score.entry });
  }

  // --- Signer B: independent confirmation, computed without reference to `direction`
  // above -- see signerB.ts. Combined via decisionMatrix.ts's hard/soft filter split:
  // only a genuine tie or opposite-direction read from Signer B ever blocks.
  const supertrendPoint = calculateSupertrend(candles)[lastIndex];
  const usdStrength = overrides?.usdStrength ?? computeUsdStrength();
  const session = getActiveSession(lastCandle.time);

  const signerB = evaluateSignerB({ candles, pair, swings, rsiSeries, supertrendPoint, usdStrength, session });
  const decision = combineSigners({ tier: score.tier, direction }, signerB);

  if (decision.blocked) {
    return noTrade(
      decision.blocked.code === "signer_b_neutral"
        ? { code: "signer_b_neutral", impliedDirection: direction, confidence: score.total }
        : {
            code: "signer_conflict",
            impliedDirection: direction,
            signerBDirection: decision.blocked.signerBDirection,
            signerBConfidence: decision.blocked.signerBConfidence,
            confidence: score.total,
          }
    );
  }

  // usdStrengthStatus is still computed relative to THIS signal's own direction (not
  // Signer B's independent vote above) -- "does currency strength support this trade"
  // stays a meaningful, honest, backward-compatible display field either way.
  const usdSupport = computeUsdStrengthSupport(usdStrength, pair, direction);

  const structureConfluence: Confluence = structureEvent.type.startsWith("CHOCH") ? "choch" : "bos";

  const confluences: Confluence[] = [
    "liquidity_sweep",
    structureConfluence,
    taggedNow.confluence,
    "killzone",
    "multi_timeframe",
    ...score.direction.reasons,
    ...score.entry.reasons,
  ];
  if (signerB.factors.emaTrend === (wantsBullish ? "bullish" : "bearish")) confluences.push("ema_trend");
  if (supertrendPoint.trend === (wantsBullish ? "up" : "down")) confluences.push("supertrend");
  if (usdSupport === true) confluences.push("currency_strength");
  if (signerB.factors.rsiDivergence === (wantsBullish ? "bullish" : "bearish")) confluences.push("rsi_divergence");

  const signal: Signal = {
    id: randomUUID(),
    source: "smc",
    pair,
    direction,
    entry,
    stopLoss,
    takeProfit,
    takeProfit2,
    riskReward: Math.abs(takeProfit - entry) / risk,
    confidence: score.total,
    directionScore: score.direction.total,
    entryScore: score.entry.total,
    adx,
    rsi,
    tier: decision.tier === "no_trade" ? score.tier : decision.tier,
    confluences,
    session,
    timeframe,
    createdAt: Date.now(),
    zoneTop: taggedNow.top,
    zoneBottom: taggedNow.bottom,
    signerBDirection: signerB.direction,
    signerBConfidence: signerB.confidence,
    signerBEmaTrend: signerB.factors.emaTrend,
    rsiDivergence: signerB.factors.rsiDivergence ?? "none",
    supertrendTrend: supertrendPoint.trend ?? "unavailable",
    usdStrengthStatus: usdSupport === "unavailable" ? "unavailable" : usdSupport ? "supports" : "conflicts",
    newsStatus: newsCheck.status,
  };

  return { status: "signal", signal };
}

/**
 * Evaluates the current closed candle and returns either a Signal or a NoTradeReason --
 * every exit point is accounted for, never silently dropped, so the dashboard can show
 * real "why not" reasoning instead of nothing.
 *
 * Two independent signers. SIGNER A is SMC, the PRIMARY entry engine, completely
 * unchanged: a liquidity sweep, structure break in the implied reversal direction, and
 * a first-time retest of the resulting unmitigated FVG/order block during a killzone
 * (crypto pairs exempted — see isCrypto) locate the *candidate* trade (its entry/SL/TP).
 * D1/H4/H1 trend agreement, ADX, and ATR are hard pre-gates, followed by a news-blackout
 * check (see newsFilter.ts — a hard hold, only when a high-impact release is genuinely
 * detected as imminent, never from missing data). If all of that passes, Signer A's own
 * confidence is scored across two dimensions — direction (trend/structure) and entry
 * (SMC zone quality/volume/MACD/RSI/candlestick) — bottlenecked at the weaker of the two
 * (see confidenceScore.ts). Below 80% on either is `below_threshold`, no signal.
 *
 * SIGNER B (see signerB.ts) is independent confirmation — Trend + Momentum (RSI, incl.
 * divergence) + Volatility + Currency Strength + Session — computed WITHOUT reference to
 * Signer A's own direction. decisionMatrix.ts then combines the two: they must agree in
 * direction (a Signer B tie/"neutral" or outright conflict holds the trade — see
 * `signer_b_neutral`/`signer_conflict` below), but a merely-weaker (still-agreeing)
 * Signer B only shows up in its own separately-displayed confidence number, never
 * downgrades Signer A's. This is the hard/soft filter split: only a genuine tie or
 * opposite-direction read from Signer B ever blocks a trade.
 *
 * A Signal is constructed at 70%+ (watch — informational only, not executable), 80%+
 * (buy), or 90%+ (strong_buy) on Signer A's own tier, optionally upgraded to strong_buy
 * when Signer B also strongly agrees. Only buy/strong_buy can ever be manually executed
 * (see executionEngine.ts's watch-tier guard) — watch exists purely so a near-miss setup
 * is visible on the dashboard. Call this once per closed candle — never on the still-
 * forming one, or signals will repaint. See `assembleSignals` below for the Signal[]-only
 * view.
 *
 * Implementation note: this is now a thin wrapper over `computeSharedGateContext` +
 * `evaluateDirectionalCandidate`, picking the single most-recent sweep exactly as this
 * function always has -- the backtester and the on-demand /api/signals/evaluate route
 * are unaffected by the refactor and still get this single-direction behavior. The live
 * per-candle pipeline (metaApiConnection.ts's ingestCandle) instead calls
 * `evaluateSignalDualDirection` below, which checks both sides when both exist -- see
 * that function's own doc comment for why (a real, confirmed gap where a rejected
 * counter-trend candidate meant a real same-data opposite-direction setup was never
 * even checked). The "Check a Pair" analysis job (pairAnalysisJob.ts) calls
 * `computeSharedGateContext`/`evaluateDirectionalCandidate`/`findSweepCandidates`
 * directly instead, for its own richer dual-direction display.
 */
export function evaluateSignal(
  candles: Candle[],
  pair: Pair,
  timeframe: Timeframe,
  higherTimeframes: HigherTimeframeCandles,
  // Only ever passed by the backtester (see lib/market/backtest/) -- undefined at every
  // live call site, so live behavior is unchanged. checkNews/computeUsdStrength are both
  // live-cache reads with no per-bar timestamp of their own (computeUsdStrength in
  // particular takes no timestamp at all, so left alone it would feed today's real
  // currency-strength reading into every single historical bar's Signer B vote) -- the
  // backtester supplies an explicit value per bar instead, computed for real from
  // historical data (currencyStrength.ts's computeHistoricalUsdStrength,
  // newsFilter.ts's checkHistoricalNews) when a historical source is configured, or a
  // deterministic "unavailable"/"clear" default otherwise.
  overrides?: SignalEvaluationOverrides
): SignalEvaluation {
  const shared = computeSharedGateContext(candles, pair, timeframe, higherTimeframes, overrides);
  if ("blocked" in shared) return { status: "no_trade", reason: shared.blocked };

  const { recentSweeps } = shared.context;
  if (recentSweeps.length === 0) return { status: "no_trade", reason: { code: "no_setup" } };
  const sweep = recentSweeps[recentSweeps.length - 1];

  return evaluateDirectionalCandidate(shared.context, sweep);
}

/**
 * Same real pipeline as evaluateSignal, but checks BOTH a bullish and a bearish
 * candidate when both exist, instead of only whichever sweep happens to be most recent
 * overall. Fixes a real, confirmed gap: the live per-candle pipeline could find a
 * counter-trend candidate (e.g. a SELL forming while D1/H4/H1 are all bullish),
 * correctly reject it for trend_disagreement, and never even check whether a real BUY
 * candidate existed on the same data -- reporting NO TRADE while the market was
 * actively trending, not because no real setup existed, but because only the wrong side
 * was ever looked at.
 *
 * If exactly one side independently qualifies, that's the result. In the rare case BOTH
 * sides independently qualify (a genuine, contradictory conflict), the higher-confidence
 * one wins -- deliberately simple over inventing a new "conflicted" NoTradeReason variant
 * that every existing consumer (dashboard text, chat tool descriptions, tests) would need
 * to learn; this is not the "Check a Pair" analysis job, which has its own dedicated
 * conflicted-state display (see pairAnalysisJob.ts). If NEITHER side qualifies, returns
 * the same no-trade reason evaluateSignal itself would have (the most-recent-overall
 * sweep's own rejection), so existing "why not" messaging is unchanged for the common
 * case of no real setup on either side.
 */
export function evaluateSignalDualDirection(
  candles: Candle[],
  pair: Pair,
  timeframe: Timeframe,
  higherTimeframes: HigherTimeframeCandles,
  overrides?: SignalEvaluationOverrides
): SignalEvaluation {
  const shared = computeSharedGateContext(candles, pair, timeframe, higherTimeframes, overrides);
  if ("blocked" in shared) return { status: "no_trade", reason: shared.blocked };

  const { recentSweeps } = shared.context;
  if (recentSweeps.length === 0) return { status: "no_trade", reason: { code: "no_setup" } };
  const primarySweep = recentSweeps[recentSweeps.length - 1];
  const primaryEvaluation = evaluateDirectionalCandidate(shared.context, primarySweep);

  const candidates = findSweepCandidates(recentSweeps);
  const otherSweep = primarySweep.side === "sellside" ? candidates.bearish : candidates.bullish;
  // Same sweep already evaluated above as `primaryEvaluation` -- nothing new to check.
  if (!otherSweep || otherSweep === primarySweep) {
    return primaryEvaluation;
  }
  const otherEvaluation = evaluateDirectionalCandidate(shared.context, otherSweep);

  if (primaryEvaluation.status === "signal" && otherEvaluation.status === "signal") {
    return otherEvaluation.signal.confidence > primaryEvaluation.signal.confidence ? otherEvaluation : primaryEvaluation;
  }
  if (otherEvaluation.status === "signal") return otherEvaluation;
  return primaryEvaluation;
}

/**
 * Re-evaluates ONE specific, caller-chosen direction right now, regardless of whether it
 * is currently the most-recent sweep overall -- unlike evaluateSignal, which always
 * follows whichever side is freshest. Used by the "Check a Pair" signal-weakening
 * monitor (see app/api/signals/analyze/recheck/route.ts): once an operator is watching a
 * specific BUY or SELL read, a genuinely honest "is it still holding up" answer has to
 * keep checking THAT side, not silently swap to reporting on whichever side the market
 * happens to have swept most recently since then. Returns `{status: "no_trade", reason:
 * {code: "no_setup"}}` when that side no longer has any real sweep candidate at all --
 * the honest "this setup has fully dissolved" case, indistinguishable from any other
 * no_setup for display purposes.
 */
export function evaluateSpecificDirection(
  candles: Candle[],
  pair: Pair,
  timeframe: Timeframe,
  higherTimeframes: HigherTimeframeCandles,
  direction: "long" | "short"
): SignalEvaluation {
  const shared = computeSharedGateContext(candles, pair, timeframe, higherTimeframes);
  if ("blocked" in shared) return { status: "no_trade", reason: shared.blocked };

  const candidates = findSweepCandidates(shared.context.recentSweeps);
  const sweep = direction === "long" ? candidates.bullish : candidates.bearish;
  if (!sweep) return { status: "no_trade", reason: { code: "no_setup" } };

  return evaluateDirectionalCandidate(shared.context, sweep);
}

/**
 * Backward-compatible wrapper over evaluateSignal for existing callers that only care
 * about "was a signal produced" (e.g. the test suite's existing assertions) -- not a
 * second code path, just a projection of evaluateSignal's result.
 */
export function assembleSignals(
  candles: Candle[],
  pair: Pair,
  timeframe: Timeframe,
  higherTimeframes: HigherTimeframeCandles
): Signal[] {
  const result = evaluateSignal(candles, pair, timeframe, higherTimeframes);
  return result.status === "signal" ? [result.signal] : [];
}
