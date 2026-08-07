import { randomUUID } from "node:crypto";
import type { Candle, Confluence, Pair, Signal, Timeframe } from "./types";
import { detectSwingPoints } from "./detectors/swings";
import { detectStructureBreaks } from "./detectors/structure";
import { detectFairValueGaps } from "./detectors/fairValueGaps";
import { detectOrderBlocks } from "./detectors/orderBlocks";
import { detectLiquiditySweeps } from "./detectors/liquiditySweeps";
import { marketStructureTrend } from "./detectors/marketStructure";
import { detectCandlestickPattern } from "./detectors/candlestickPatterns";
import { getActiveSession, isKillzone } from "./sessions";
import { isCrypto } from "./symbols";
import { calculateEma } from "./indicators/ema";
import { calculateRsi } from "./indicators/rsi";
import { calculateMacd } from "./indicators/macd";
import { calculateAdx } from "./indicators/adx";
import { calculateAtr } from "./indicators/atr";
import { isAboveAverageVolume } from "./indicators/volume";
import { isEmaStackAligned } from "./indicators/emaStack";
import { scoreSignal } from "./confidenceScore";

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

interface HigherTimeframeCandles {
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
}

/** EMA50/EMA200 relationship only — used for the D1/H4 multi-timeframe agreement
 * pre-gate, distinct from the stricter 4-EMA stack scored in the Trend category. */
function trendDirection(candles: Candle[]): "bullish" | "bearish" | "neutral" {
  if (candles.length < 200) return "neutral";
  const closes = candles.map((c) => c.close);
  const index = candles.length - 1;
  const fast = calculateEma(closes, 50)[index];
  const slow = calculateEma(closes, 200)[index];
  if (Number.isNaN(fast) || Number.isNaN(slow)) return "neutral";
  if (fast > slow) return "bullish";
  if (fast < slow) return "bearish";
  return "neutral";
}

/**
 * Assembles a trade signal from the current M15 candle close. A liquidity sweep,
 * structure break in the implied reversal direction, and a first-time retest of the
 * resulting unmitigated FVG/order block during a killzone (crypto pairs exempted —
 * see isCrypto) locate the *candidate* trade (its entry/SL/TP). D1/H4/H1 trend
 * agreement, ADX, and ATR are then hard
 * pre-gates. If those pass, a weighted confidence score (trend, market structure,
 * SMC zone quality, volume, MACD, RSI, candlestick pattern) is computed; a Signal is
 * constructed at 80%+ (watch — informational only, not executable), 90%+ (buy), or
 * 95%+ (strong_buy). Anything lower produces no signal at all. Only buy/strong_buy
 * can ever be manually executed (see executionEngine.ts's watch-tier guard) — watch
 * exists purely so a near-miss setup is visible on the dashboard. Call this once per
 * closed M15 candle — never on the still-forming candle, or signals will repaint.
 */
export function assembleSignals(
  candles: Candle[],
  pair: Pair,
  timeframe: Timeframe,
  higherTimeframes: HigherTimeframeCandles
): Signal[] {
  if (candles.length < 10) return [];
  const lastIndex = candles.length - 1;
  const lastCandle = candles[lastIndex];

  // Crypto trades 24/7 with no ICT-style institutional session structure the killzone
  // gate was built around, so it's exempted here rather than arbitrarily restricted to
  // forex trading hours — every other pre-gate below still fully applies.
  if (!isCrypto(pair) && !isKillzone(lastCandle.time)) return [];

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
  if (recentSweeps.length === 0) return [];
  const sweep = recentSweeps[recentSweeps.length - 1];

  // A buyside sweep (stops above a high taken out) implies a bearish reversal is
  // being set up; a sellside sweep implies a bullish one.
  const wantsBullish = sweep.side === "sellside";
  const zoneDirection = wantsBullish ? "bullish" : "bearish";
  const direction: "long" | "short" = wantsBullish ? "long" : "short";

  // --- Hard pre-gates: D1/H4/H1 agreement, ADX floor, ATR health ---
  const d1Trend = trendDirection(higherTimeframes.d1);
  const h4Trend = trendDirection(higherTimeframes.h4);
  const h1Trend = trendDirection(higherTimeframes.h1);
  if (d1Trend === "neutral" || d1Trend !== h4Trend || d1Trend !== h1Trend || d1Trend !== zoneDirection) return [];

  const adx = calculateAdx(candles)[lastIndex];
  if (Number.isNaN(adx) || adx < ADX_HARD_MIN) return [];

  const atrWindow = atrSeries.slice(lastIndex - ATR_AVERAGE_PERIOD, lastIndex);
  const atrAverage = atrWindow.reduce((sum, v) => sum + v, 0) / atrWindow.length;
  if (Number.isNaN(atr) || !(atr > atrAverage)) return [];

  const structureEvent = structureEvents
    .filter((e) => e.breakIndex > sweep.sweepIndex && e.breakIndex <= lastIndex)
    .find((e) =>
      wantsBullish
        ? e.type === "BOS_BULLISH" || e.type === "CHOCH_BULLISH"
        : e.type === "BOS_BEARISH" || e.type === "CHOCH_BEARISH"
    );
  if (!structureEvent) return [];

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
  if (candidateZones.length === 0) return [];

  const overlaps = (candle: Candle, zone: Zone) => candle.low <= zone.top && candle.high >= zone.bottom;
  const taggedNow = candidateZones.find((zone) => overlaps(lastCandle, zone));
  if (!taggedNow) return [];
  // Only fire the first time price returns to the zone after it formed, so a signal
  // doesn't repeat every candle while price chops around inside it.
  const alreadyTagged = candles.slice(taggedNow.sinceIndex + 1, lastIndex).some((c) => overlaps(c, taggedNow));
  if (alreadyTagged) return [];

  const entry = (taggedNow.top + taggedNow.bottom) / 2;
  const slBuffer = atr * ATR_BUFFER_FRACTION;
  const stopLoss = wantsBullish ? sweep.sweptSwing.price - slBuffer : sweep.sweptSwing.price + slBuffer;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return [];

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

  // --- Weighted confidence score over the remaining categories ---
  const emaStackAligned = isEmaStackAligned(candles, direction);

  const rsi = calculateRsi(candles)[lastIndex];
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

  if (score.tier === "no_trade") return [];

  const structureConfluence: Confluence = structureEvent.type.startsWith("CHOCH") ? "choch" : "bos";

  const confluences: Confluence[] = [
    "liquidity_sweep",
    structureConfluence,
    taggedNow.confluence,
    "killzone",
    "multi_timeframe",
    ...score.reasons,
  ];

  const signal: Signal = {
    id: randomUUID(),
    pair,
    direction,
    entry,
    stopLoss,
    takeProfit,
    takeProfit2,
    riskReward: Math.abs(takeProfit - entry) / risk,
    confidence: score.total,
    tier: score.tier,
    confluences,
    session: getActiveSession(lastCandle.time),
    timeframe,
    createdAt: Date.now(),
  };

  return [signal];
}
