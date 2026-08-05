import { randomUUID } from "node:crypto";
import type { Candle, Confluence, Pair, Signal, Timeframe } from "./types";
import { detectSwingPoints } from "./detectors/swings";
import { detectStructureBreaks } from "./detectors/structure";
import { detectFairValueGaps } from "./detectors/fairValueGaps";
import { detectOrderBlocks } from "./detectors/orderBlocks";
import { detectLiquiditySweeps } from "./detectors/liquiditySweeps";
import { getActiveSession, isKillzone } from "./sessions";
import { pipSize } from "./symbols";

const SWEEP_LOOKBACK_CANDLES = 30;
const SL_BUFFER_PIPS = 3;
const MIN_RISK_REWARD = 1.5;
const FALLBACK_RISK_REWARD = 2;

interface Zone {
  top: number;
  bottom: number;
  confluence: Confluence;
  /** Index after which a touch counts as a genuine retest (excludes the formation/impulse candles). */
  sinceIndex: number;
}

/**
 * Assembles a trade signal from the current candle close, if (and only if) all of
 * these line up on this bar: a recent liquidity sweep, a structure break in the
 * implied reversal direction, price tagging an unmitigated FVG/order block from
 * that move for the first time, during a London/NY killzone. Call this once per
 * closed candle — never on the still-forming candle, or signals will repaint.
 */
export function assembleSignals(candles: Candle[], pair: Pair, timeframe: Timeframe): Signal[] {
  if (candles.length < 10) return [];
  const lastIndex = candles.length - 1;
  const lastCandle = candles[lastIndex];

  if (!isKillzone(lastCandle.time)) return [];

  const swings = detectSwingPoints(candles);
  const structureEvents = detectStructureBreaks(candles, swings);
  const sweeps = detectLiquiditySweeps(candles, swings, pipSize(pair) * 2);

  const recentSweeps = sweeps.filter((s) => s.sweepIndex >= lastIndex - SWEEP_LOOKBACK_CANDLES);
  if (recentSweeps.length === 0) return [];
  const sweep = recentSweeps[recentSweeps.length - 1];

  // A buyside sweep (stops above a high taken out) implies a bearish reversal is
  // being set up; a sellside sweep implies a bullish one.
  const wantsBullish = sweep.side === "sellside";
  const zoneDirection = wantsBullish ? "bullish" : "bearish";

  const structureEvent = structureEvents
    .filter((e) => e.breakIndex > sweep.sweepIndex && e.breakIndex <= lastIndex)
    .find((e) =>
      wantsBullish
        ? e.type === "BOS_BULLISH" || e.type === "MSS_BULLISH"
        : e.type === "BOS_BEARISH" || e.type === "MSS_BEARISH"
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
  const pip = pipSize(pair);
  const stopLoss = wantsBullish
    ? sweep.sweptSwing.price - pip * SL_BUFFER_PIPS
    : sweep.sweptSwing.price + pip * SL_BUFFER_PIPS;
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

  const signal: Signal = {
    id: randomUUID(),
    pair,
    direction: wantsBullish ? "long" : "short",
    entry,
    stopLoss,
    takeProfit,
    riskReward: Math.abs(takeProfit - entry) / risk,
    confluences: ["liquidity_sweep", "bos", taggedNow.confluence, "killzone"],
    session: getActiveSession(lastCandle.time),
    timeframe,
    createdAt: Date.now(),
  };

  return [signal];
}
