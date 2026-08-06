import type { Confluence, ConfidenceTier } from "./types";

export interface ScoreInput {
  emaStackAligned: boolean;
  adx: number;
  marketStructureMatches: boolean;
  smcZoneType: "order_block" | "fvg";
  volumeAboveAverage: boolean;
  macdAgrees: boolean;
  rsiAgrees: boolean;
  candlestickMatches: boolean;
}

export interface ScoreBreakdown {
  total: number;
  tier: ConfidenceTier | "watch" | "no_trade";
  /** New-category confluences that scored credit — merged into the signal's full
   * confluences list by the caller alongside the existing SMC ones. */
  reasons: Confluence[];
}

const STRONG_BUY_THRESHOLD = 95;
const BUY_THRESHOLD = 90;
const WATCH_THRESHOLD = 80;

const ADX_STRONG = 25;
const ADX_ADEQUATE = 20;

/**
 * Weighted confidence score (0-95 — News is excluded this pass, so 95 is the
 * practical ceiling, not 100). Trend and SMC-zone-quality are the only categories
 * with partial credit; everything else is full-credit-or-nothing, matching the
 * binary nature of the underlying checks. Pure function — the caller (signalEngine)
 * is responsible for the hard pre-gates (killzone, D1/H4 agreement, ADX floor, ATR
 * health, the SMC trigger itself) that must pass before this is ever called.
 */
export function scoreSignal(input: ScoreInput): ScoreBreakdown {
  let total = 0;
  const reasons: Confluence[] = [];

  if (input.emaStackAligned) {
    total += 20;
    reasons.push("trend_ema_stack");
  }
  if (input.adx >= ADX_STRONG) {
    total += 5;
    reasons.push("adx");
  } else if (input.adx >= ADX_ADEQUATE) {
    total += 2.5;
  }

  if (input.marketStructureMatches) {
    total += 20;
    reasons.push("market_structure");
  }

  total += input.smcZoneType === "order_block" ? 20 : 15;

  if (input.volumeAboveAverage) {
    total += 10;
    reasons.push("volume");
  }
  if (input.macdAgrees) {
    total += 10;
    reasons.push("macd_crossover");
  }
  if (input.rsiAgrees) {
    total += 5;
    reasons.push("rsi_momentum");
  }
  if (input.candlestickMatches) {
    total += 5;
    reasons.push("candlestick");
  }

  let tier: ScoreBreakdown["tier"];
  if (total >= STRONG_BUY_THRESHOLD) tier = "strong_buy";
  else if (total >= BUY_THRESHOLD) tier = "buy";
  else if (total >= WATCH_THRESHOLD) tier = "watch";
  else tier = "no_trade";

  return { total, tier, reasons };
}
