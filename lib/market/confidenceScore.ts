import type { Confluence, ConfidenceTier } from "./types";

export interface DirectionScoreInput {
  emaStackAligned: boolean;
  adx: number;
  marketStructureMatches: boolean;
}

export interface EntryScoreInput {
  smcZoneType: "order_block" | "fvg";
  volumeAboveAverage: boolean;
  macdAgrees: boolean;
  rsiAgrees: boolean;
  candlestickMatches: boolean;
}

/**
 * Independent, external confirmation -- distinct from `direction` (does the SMC
 * structure itself look trending) and `entry` (does the entry trigger itself look
 * good). Both inputs can be `"unavailable"` (Supertrend needs a warmed-up ATR window;
 * currency strength needs all 5 tracked FX pairs' history loaded) -- never fabricated
 * as agreeing or disagreeing. See scoreConfirmation()'s own comment for how
 * unavailability is handled without silently zeroing out the score.
 */
export interface ConfirmationScoreInput {
  supertrendAgrees: boolean | "unavailable";
  usdStrengthSupports: boolean | "unavailable";
}

type DimensionTier = ConfidenceTier | "no_trade";

export interface DimensionScore {
  total: number;
  tier: DimensionTier;
  reasons: Confluence[];
}

export interface ScoreBreakdown {
  direction: DimensionScore;
  entry: DimensionScore;
  confirmation: DimensionScore;
  /** The weakest of direction.tier / entry.tier / confirmation.tier -- a strong trend
   * or entry can't compensate for conflicting external confirmation, or vice versa.
   * See confidenceScore's module doc for why. */
  tier: DimensionTier;
  /** min(direction.total, entry.total, confirmation.total) -- bottlenecked the same
   * way tier is, so the headline number and the tier it produces never visually
   * disagree. */
  total: number;
}

const STRONG_BUY_THRESHOLD = 95;
const BUY_THRESHOLD = 90;
const WATCH_THRESHOLD = 80;

const ADX_STRONG = 25;
const ADX_ADEQUATE = 20;

const TIER_RANK: Record<DimensionTier, number> = { strong_buy: 3, buy: 2, watch: 1, no_trade: 0 };

function tierOf(total: number): DimensionTier {
  if (total >= STRONG_BUY_THRESHOLD) return "strong_buy";
  if (total >= BUY_THRESHOLD) return "buy";
  if (total >= WATCH_THRESHOLD) return "watch";
  return "no_trade";
}

/**
 * A strongly-trending market doesn't mean *this moment* is a good entry, and a
 * perfect entry trigger doesn't matter if the higher-timeframe trend isn't really
 * there -- so trend/structure evidence (direction) and entry-timing evidence (entry)
 * are scored independently, each against the same 95/90/80 tier thresholds, and the
 * final signal is only as good as whichever of the two is weaker. Pure function --
 * the caller (signalEngine) is responsible for the hard pre-gates (killzone, D1/H4/H1
 * agreement, ADX floor, ATR health, the SMC trigger itself) that must pass before
 * this is ever called.
 */
export function scoreSignal(input: DirectionScoreInput & EntryScoreInput & ConfirmationScoreInput): ScoreBreakdown {
  const direction = scoreDirection(input);
  const entry = scoreEntry(input);
  const confirmation = scoreConfirmation(input);
  const weakest = [direction, entry, confirmation].reduce((worst, dim) => (TIER_RANK[dim.tier] < TIER_RANK[worst.tier] ? dim : worst));
  const total = Math.min(direction.total, entry.total, confirmation.total);

  return { direction, entry, confirmation, tier: weakest.tier, total };
}

function scoreDirection(input: DirectionScoreInput): DimensionScore {
  let total = 0;
  const reasons: Confluence[] = [];

  if (input.emaStackAligned) {
    total += 45;
    reasons.push("trend_ema_stack");
  }
  if (input.marketStructureMatches) {
    total += 40;
    reasons.push("market_structure");
  }
  if (input.adx >= ADX_STRONG) {
    total += 15;
    reasons.push("adx");
  } else if (input.adx >= ADX_ADEQUATE) {
    total += 7.5;
  }

  return { total, tier: tierOf(total), reasons };
}

function scoreEntry(input: EntryScoreInput): DimensionScore {
  let total = 0;
  const reasons: Confluence[] = [];

  total += input.smcZoneType === "order_block" ? 35 : 25;

  if (input.candlestickMatches) {
    total += 25;
    reasons.push("candlestick");
  }
  if (input.macdAgrees) {
    total += 20;
    reasons.push("macd_crossover");
  }
  if (input.rsiAgrees) {
    total += 10;
    reasons.push("rsi_momentum");
  }
  if (input.volumeAboveAverage) {
    total += 10;
    reasons.push("volume");
  }

  return { total, tier: tierOf(total), reasons };
}

/**
 * Unlike scoreDirection/scoreEntry, this dimension's inputs can each independently be
 * "unavailable" (Supertrend needs a warmed-up ATR window; USD strength needs all 5
 * tracked FX pairs' history loaded). An unavailable input is EXCLUDED from the tally
 * rather than counted as a miss -- the score is rescaled to what's actually knowable,
 * so a data source that simply hasn't warmed up yet can never silently sink every
 * signal to "no_trade" the way a hardcoded fixed-weight split would. Only genuine
 * disagreement pulls the score down; missing data just narrows what's being asked.
 */
function scoreConfirmation(input: ConfirmationScoreInput): DimensionScore {
  const checks: { agrees: boolean; weight: number; reason: Confluence }[] = [];

  if (input.supertrendAgrees !== "unavailable") {
    checks.push({ agrees: input.supertrendAgrees, weight: 60, reason: "supertrend" });
  }
  if (input.usdStrengthSupports !== "unavailable") {
    checks.push({ agrees: input.usdStrengthSupports, weight: 40, reason: "currency_strength" });
  }

  const possible = checks.reduce((sum, c) => sum + c.weight, 0);
  // Both inputs unavailable at once (e.g. right after boot, before candle history has
  // warmed up for either) -- score as fully neutral (max, never the bottleneck) rather
  // than 0. An empty confirmation dimension must never be indistinguishable from an
  // actively-disagreeing one; each Signal also carries the raw supertrendTrend/
  // usdStrengthStatus fields separately so "unavailable" is still visible downstream.
  if (possible === 0) return { total: 100, tier: tierOf(100), reasons: [] };

  const earned = checks.reduce((sum, c) => sum + (c.agrees ? c.weight : 0), 0);
  const total = (earned / possible) * 100;
  const reasons = checks.filter((c) => c.agrees).map((c) => c.reason);

  return { total, tier: tierOf(total), reasons };
}
