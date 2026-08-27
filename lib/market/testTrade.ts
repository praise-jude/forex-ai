import { randomUUID } from "node:crypto";
import type { Candle, Pair, Price, Signal, Timeframe } from "./types";
import { calculateAtr } from "./indicators/atr";
import { calculateAdx } from "./indicators/adx";
import { calculateRsi } from "./indicators/rsi";
import { getActiveSession } from "./sessions";
import { checkNews } from "./newsFilter";

// Same ATR-scaled-stop reasoning as signalEngine.ts's ATR_BUFFER_FRACTION and
// rangeEngine.ts's STOP_BUFFER_ATR_FRACTION -- a flat pip distance doesn't scale across
// instruments with very different pip definitions. 1x ATR is a plain, sane stop for a
// synthetic order that has no real structure to place it against; 1.5x reward keeps
// riskReward comfortably above every existing engine's own MIN_RISK_REWARD floor (1.2-1.5)
// so this doesn't get blocked by the operator's own configured execution-policy R:R floor
// for an unrelated reason.
const STOP_ATR_MULTIPLE = 1;
const REWARD_ATR_MULTIPLE = 1.5;
const MIN_CANDLES = 20;

export type ManualTestSignalResult = { ok: true; signal: Signal } | { ok: false; reason: string };

/**
 * Builds a deliberately synthetic Signal for exercising the DEMO execution pipeline end
 * to end (symbol specs, position sizing, the real broker order call, journaling) without
 * needing a genuine SMC/range setup to exist first -- see app/api/signals/test-trade's
 * own doc comment for why that's a real, separate need from "does the strategy find a
 * setup right now". Pure aside from `randomUUID()`/`Date.now()` -- candles/price are
 * passed in so this is unit-testable without a live MetaApi connection, same posture as
 * every other signal-construction function in this codebase.
 *
 * Deliberately NOT run through confidenceScore.ts's tierOf/scoreSignal -- there is no
 * real setup here to score, so fabricating a number would misrepresent this as a scored
 * read rather than what it actually is (see UNSCORED_SOURCE_LABEL in types.ts, which
 * hides confidence entirely for this source in every UI that shows it). Tier is fixed at
 * "buy" -- the minimum non-"watch" tier -- purely so executionEngine.ts's watch-tier
 * guard doesn't reject it; it carries no meaning about setup quality the way a real SMC
 * signal's tier does.
 */
export function buildManualTestSignal(
  pair: Pair,
  direction: "long" | "short",
  timeframe: Timeframe,
  candles: Candle[],
  price: Price | undefined
): ManualTestSignalResult {
  if (!price) return { ok: false, reason: "no live price yet for this pair -- try again shortly" };
  if (candles.length < MIN_CANDLES) return { ok: false, reason: "not enough candle history yet for this pair -- try again shortly" };

  const lastIndex = candles.length - 1;
  const atr = calculateAtr(candles)[lastIndex];
  if (!Number.isFinite(atr) || atr <= 0) return { ok: false, reason: "couldn't compute volatility (ATR) for this pair yet -- try again shortly" };

  // Same bid/ask convention as riskManager.ts's checkPriceDrift -- a long buys at ask, a
  // short sells at bid. Only used to compute the stop/target distance and for display;
  // this is a real market order (see executionEngine.ts), so the broker fills at whatever
  // the live market price actually is when the order reaches it, not this exact number.
  const entry = direction === "long" ? price.ask : price.bid;
  const stopDistance = atr * STOP_ATR_MULTIPLE;
  const rewardDistance = atr * REWARD_ATR_MULTIPLE;
  const stopLoss = direction === "long" ? entry - stopDistance : entry + stopDistance;
  const takeProfit = direction === "long" ? entry + rewardDistance : entry - rewardDistance;
  const takeProfit2 = direction === "long" ? entry + rewardDistance * 1.5 : entry - rewardDistance * 1.5;

  const now = Date.now();
  const signal: Signal = {
    id: randomUUID(),
    source: "manual_test",
    pair,
    direction,
    entry,
    stopLoss,
    takeProfit,
    takeProfit2,
    riskReward: rewardDistance / stopDistance,
    confidence: 0,
    directionScore: 0,
    entryScore: 0,
    adx: calculateAdx(candles)[lastIndex],
    rsi: calculateRsi(candles)[lastIndex],
    tier: "buy",
    confluences: [],
    session: getActiveSession(now),
    timeframe,
    createdAt: now,
    // No real SMC zone exists for a synthetic order -- a degenerate point at entry keeps
    // every consumer that reads zoneTop/zoneBottom (display only) working without a
    // fabricated range.
    zoneTop: entry,
    zoneBottom: entry,
    // Same "unavailable" convention rangeEngine.ts already uses for the exact same
    // reason: Signer B is SMC-specific confirmation, meaningless for a synthetic order.
    signerBDirection: "unavailable",
    signerBConfidence: 0,
    signerBEmaTrend: "unavailable",
    rsiDivergence: "unavailable",
    supertrendTrend: "unavailable",
    usdStrengthStatus: "unavailable",
    newsStatus: checkNews(pair, now).status,
  };

  return { ok: true, signal };
}
