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

export type DimensionTier = ConfidenceTier | "no_trade";

export interface DimensionScore {
  total: number;
  tier: DimensionTier;
  reasons: Confluence[];
}

export interface ScoreBreakdown {
  direction: DimensionScore;
  entry: DimensionScore;
  /** The weaker of direction.tier / entry.tier -- a strong trend can't compensate for
   * a weak entry trigger, or vice versa. Independent, external confirmation (Signer
   * B -- see signerB.ts/decisionMatrix.ts) is combined separately, downstream of this
   * function: it can gate or upgrade the result, but never bottlenecks this number. */
  tier: DimensionTier;
  /** min(direction.total, entry.total) -- bottlenecked the same way tier is, so the
   * headline number and the tier it produces never visually disagree. */
  total: number;
}

const STRONG_BUY_THRESHOLD = 95;
const BUY_THRESHOLD = 90;
const WATCH_THRESHOLD = 80;

const ADX_STRONG = 25;
const ADX_ADEQUATE = 20;

const TIER_RANK: Record<DimensionTier, number> = { strong_buy: 3, buy: 2, watch: 1, no_trade: 0 };

/** Exported for reuse by signerB.ts (Signer B's own confidence bucketing) and
 * decisionMatrix.ts (comparing tiers) -- one shared 95/90/80 bucketing rule for every
 * tiered score in the app, never redefined per-caller. */
export function tierOf(total: number): DimensionTier {
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
 * result is only as good as whichever of the two is weaker. Pure function -- the
 * caller (signalEngine) is responsible for the hard pre-gates (killzone, D1/H4/H1
 * agreement, ADX floor, ATR health, the SMC trigger itself) before this is ever
 * called, and for combining this result with Signer B's independent read afterward
 * (see decisionMatrix.ts) -- external confirmation never bottlenecks this score.
 */
export function scoreSignal(input: DirectionScoreInput & EntryScoreInput): ScoreBreakdown {
  const direction = scoreDirection(input);
  const entry = scoreEntry(input);
  const tier = TIER_RANK[direction.tier] < TIER_RANK[entry.tier] ? direction.tier : entry.tier;
  const total = Math.min(direction.total, entry.total);

  return { direction, entry, tier, total };
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
