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

// Lowered from 95/90/80 -- at 95/90/80 this account fired exactly one signal across a
// 60-day, 10-pair, all-timeframe backtest (a real trend-gate bug that permanently
// blocked every setup was ALSO fixed the same night, so 95/90/80's own true rate was
// never actually observed cleanly). 85/70/60 was tried first and rejected: 11 signals
// but a 27% win rate and a 0.53 profit factor -- net-losing. 90/80/70 is a deliberately
// smaller step: on the same backtest window it produced 2 signals at a 100% win rate,
// +0.80 average R -- still a tiny sample, not proof this generalizes, but a real,
// measured result rather than a guess. Revisit once more live data accumulates.
// Exported so any UI displaying tier boundaries (see app/settings/page.tsx's
// SIGNER_A_TIER_LABEL/SIGNER_B_TIER_LABEL) derives its labels from these real numbers
// instead of hardcoding a second copy that can silently drift out of sync -- which is
// exactly what had happened (the settings page showed "Buy (90-94)"/"Strong buy
// (95-100)" while these actual thresholds were 80/90 the whole time).
// BUY_THRESHOLD nudged 80 -> 75 on 2026-08-28, after the H1-relaxation fix (see
// signalEngine.ts) was itself verified on real data: 6 trades/67% win rate/2.79 profit
// factor over a real 180-day, 9-pair, 15m realistic backtest -- a small, bounded step
// off a result that already held up, not a guess. Still bounded well above the 70
// floor that was already tried and rejected once (11 signals, 27% win rate, 0.53
// profit factor -- net-losing, see the note above). Re-verify against a fresh backtest
// before trusting this value; revert to 80 if it doesn't hold up.
export const STRONG_BUY_THRESHOLD = 90;
export const BUY_THRESHOLD = 75;
export const WATCH_THRESHOLD = 70;

const ADX_STRONG = 25;
const ADX_ADEQUATE = 20;

/** Exported for reuse by signerB.ts (Signer B's own confidence bucketing) and
 * decisionMatrix.ts (comparing tiers) -- one shared 90/80/70 bucketing rule for every
 * tiered score in the app, never redefined per-caller. */
export function tierOf(total: number): DimensionTier {
  if (total >= STRONG_BUY_THRESHOLD) return "strong_buy";
  if (total >= BUY_THRESHOLD) return "buy";
  if (total >= WATCH_THRESHOLD) return "watch";
  return "no_trade";
}

/**
 * Direction and entry are still scored independently -- trend/structure evidence
 * (direction) and entry-timing evidence (entry) answer different questions, and both
 * are computed and returned for transparency, confluences, and dashboard display.
 *
 * The final tier/total is driven by ENTRY ALONE (changed 2026-09-01). Direction used to
 * also bottleneck the tier, on the theory that a strong trend doesn't guarantee a good
 * entry and vice versa -- true in principle, but direction's own inputs
 * (emaStackAligned, marketStructureMatches) turned out to be RE-testing a question
 * signalEngine.ts's own hard pre-gates (D1/H4 trend agreement, ADX floor) had already
 * answered, at a stricter bar than those gates use. A production investigation found
 * this was the dominant reason SMC produced zero signals across 9 pairs for 30 straight
 * days: real, well-formed setups that had already cleared every hard trend/structure
 * gate kept failing the SAME question again in scoring, at a rate where emaStackAligned
 * and marketStructureMatches were almost never both true even once. Direction no longer
 * gates the tier -- the hard pre-gates already are the trend/structure requirement; this
 * score's job is entry-timing confirmation on top of a setup already known to be valid.
 */
export function scoreSignal(input: DirectionScoreInput & EntryScoreInput): ScoreBreakdown {
  const direction = scoreDirection(input);
  const entry = scoreEntry(input);
  return { direction, entry, tier: entry.tier, total: entry.total };
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
