import { randomUUID } from "node:crypto";
import type { Candle, Confluence, NoTradeReason, Pair, Signal, SignalEvaluation, Timeframe } from "./types";
import { detectSwingPoints } from "./detectors/swings";
import { detectStructureBreaks } from "./detectors/structure";
import { detectFairValueGaps } from "./detectors/fairValueGaps";
import { detectOrderBlocks } from "./detectors/orderBlocks";
import { detectLiquiditySweeps } from "./detectors/liquiditySweeps";
import { marketStructureTrend } from "./detectors/marketStructure";
import { detectCandlestickPattern } from "./detectors/candlestickPatterns";
import { getActiveSession, isKillzone } from "./sessions";
import { isCrypto, isStock } from "./symbols";
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
import { scoreSignal } from "./confidenceScore";
import { evaluateSignerB } from "./signerB";
import { combineSigners } from "./decisionMatrix";

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
const ADX_HARD_MIN = 20;
const ATR_AVERAGE_PERIOD = 20;

const BULLISH_PATTERNS = new Set(["bullish_engulfing", "pin_bar_bullish", "morning_star"]);
const BEARISH_PATTERNS = new Set(["bearish_engulfing", "pin_bar_bearish", "evening_star"]);

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
  overrides?: { usdStrength?: UsdStrength; newsStatus?: NewsStatus }
): SignalEvaluation {
  const noTrade = (reason: NoTradeReason): SignalEvaluation => ({ status: "no_trade", reason });

  if (candles.length < 10) return noTrade({ code: "no_setup" });
  const lastIndex = candles.length - 1;
  const lastCandle = candles[lastIndex];

  // Crypto trades 24/7 with no ICT-style institutional session structure the killzone
  // gate was built around, so it's exempted here rather than arbitrarily restricted to
  // forex trading hours. Stocks (NFLX/MSFT/SPCX) get the same exemption for a different
  // reason: their own real trading hours have no relationship to the forex London/NY
  // killzone, and the broker's candle stream already only ever produces bars during
  // their actual open hours (see symbols.ts's isStock() doc comment) -- every other
  // pre-gate below still fully applies to both.
  if (!isCrypto(pair) && !isStock(pair) && !isKillzone(lastCandle.time)) return noTrade({ code: "outside_killzone" });

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
  if (recentSweeps.length === 0) return noTrade({ code: "no_setup" });
  const sweep = recentSweeps[recentSweeps.length - 1];

  // A buyside sweep (stops above a high taken out) implies a bearish reversal is
  // being set up; a sellside sweep implies a bullish one.
  const wantsBullish = sweep.side === "sellside";
  const zoneDirection = wantsBullish ? "bullish" : "bearish";
  const direction: "long" | "short" = wantsBullish ? "long" : "short";

  // --- Hard pre-gates: D1/H4/H1 agreement, ADX floor, ATR health ---
  const d1Trend = emaTrendDirection(higherTimeframes.d1);
  const h4Trend = emaTrendDirection(higherTimeframes.h4);
  const h1Trend = emaTrendDirection(higherTimeframes.h1);
  if (d1Trend === "neutral" || d1Trend !== h4Trend || d1Trend !== h1Trend || d1Trend !== zoneDirection) {
    return noTrade({ code: "trend_disagreement", impliedDirection: direction, d1: d1Trend, h4: h4Trend, h1: h1Trend });
  }

  const adx = calculateAdx(candles)[lastIndex];
  if (Number.isNaN(adx) || adx < ADX_HARD_MIN) return noTrade({ code: "weak_trend_adx", adx: Number.isNaN(adx) ? 0 : adx });

  const atrWindow = atrSeries.slice(lastIndex - ATR_AVERAGE_PERIOD, lastIndex);
  const atrAverage = atrWindow.reduce((sum, v) => sum + v, 0) / atrWindow.length;
  if (Number.isNaN(atr) || !(atr > atrAverage)) {
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
        ? { code: "signer_b_neutral", impliedDirection: direction }
        : {
            code: "signer_conflict",
            impliedDirection: direction,
            signerBDirection: decision.blocked.signerBDirection,
            signerBConfidence: decision.blocked.signerBConfidence,
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
