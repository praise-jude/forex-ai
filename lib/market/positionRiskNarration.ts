import type { HigherTimeframeTrends, MarketRegime, PositionRiskAssessment } from "./types";

/**
 * "Is the market still backing this open position, or has it turned against it" --
 * reuses the exact same regime/trend reads signalEngine.ts's own hard gates and the
 * dashboard's "Recent Analysis" cards already compute (detectMarketRegime,
 * emaTrendDirection), nothing new invented here. Pure and narration-only: this never
 * touches sizing, stop loss, or execution -- see positionRiskStore.ts's own doc comment
 * on how this feeds voice/push notifications, and PositionsPanel.tsx for the passive
 * dashboard display.
 *
 * "warning" -- the regime has flipped to a strong trend in the OPPOSITE direction, or
 * both D1 and H4 have turned against the position: the two strongest, most agreed-upon
 * reads this app has both say the same thing, against the position.
 * "caution" -- exactly one of D1/H4 has turned against the position, or volatility has
 * picked up -- an early, single-source read, not (yet) a second confirming one.
 * "aligned" -- everything else, including sitting in a range/consolidation with no
 * opposing trend read at all.
 *
 * "caution" also carries a real distancePct -- the single opposing timeframe's
 * EMA20/50 gap, so a real user-facing question ("how close is this to clearing up?")
 * gets an honest current-distance answer instead of silence. Never a time estimate --
 * see emaTrendGapPct's own doc comment for why this app doesn't fabricate one.
 */
export function assessPositionRisk(direction: "long" | "short", regime: MarketRegime, trends: HigherTimeframeTrends): PositionRiskAssessment {
  const opposingRegime: MarketRegime = direction === "long" ? "strong_downtrend" : "strong_uptrend";
  const opposingTrend = direction === "long" ? "bearish" : "bullish";
  const sideLabel = direction === "long" ? "BUY" : "SELL";

  if (regime === opposingRegime) {
    return {
      level: "warning",
      reason: `Market regime has turned to a strong ${direction === "long" ? "downtrend" : "uptrend"}, working directly against your ${sideLabel} position.`,
      distancePct: null,
    };
  }

  const opposingTimeframes = (["d1", "h4"] as const).filter((tf) => trends[tf] === opposingTrend);
  if (opposingTimeframes.length === 2) {
    return {
      level: "warning",
      reason: `Both the daily and 4-hour trend have turned ${opposingTrend}, against your ${sideLabel} position.`,
      distancePct: null,
    };
  }
  if (opposingTimeframes.length === 1) {
    const tf = opposingTimeframes[0];
    const label = tf === "d1" ? "daily" : "4-hour";
    const gap = tf === "d1" ? trends.d1Gap : trends.h4Gap;
    return {
      level: "caution",
      reason: `The ${label} trend has turned ${opposingTrend} while this ${sideLabel} position is still open.`,
      distancePct: gap === null ? null : Math.abs(gap),
    };
  }
  if (regime === "high_volatility") {
    return {
      level: "caution",
      reason: "Volatility has increased -- price swings may be larger than usual while this position is open.",
      distancePct: null,
    };
  }

  return {
    level: "aligned",
    reason: `Market conditions remain aligned with your ${sideLabel} position.`,
    distancePct: null,
  };
}
