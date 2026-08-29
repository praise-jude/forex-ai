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
 */
export function assessPositionRisk(direction: "long" | "short", regime: MarketRegime, trends: HigherTimeframeTrends): PositionRiskAssessment {
  const opposingRegime: MarketRegime = direction === "long" ? "strong_downtrend" : "strong_uptrend";
  const opposingTrend = direction === "long" ? "bearish" : "bullish";
  const sideLabel = direction === "long" ? "BUY" : "SELL";

  if (regime === opposingRegime) {
    return {
      level: "warning",
      reason: `Market regime has turned to a strong ${direction === "long" ? "downtrend" : "uptrend"}, working directly against your ${sideLabel} position.`,
    };
  }

  const opposingTimeframes = (["d1", "h4"] as const).filter((tf) => trends[tf] === opposingTrend);
  if (opposingTimeframes.length === 2) {
    return {
      level: "warning",
      reason: `Both the daily and 4-hour trend have turned ${opposingTrend}, against your ${sideLabel} position.`,
    };
  }
  if (opposingTimeframes.length === 1) {
    const label = opposingTimeframes[0] === "d1" ? "daily" : "4-hour";
    return {
      level: "caution",
      reason: `The ${label} trend has turned ${opposingTrend} while this ${sideLabel} position is still open.`,
    };
  }
  if (regime === "high_volatility") {
    return {
      level: "caution",
      reason: "Volatility has increased -- price swings may be larger than usual while this position is open.",
    };
  }

  return {
    level: "aligned",
    reason: `Market conditions remain aligned with your ${sideLabel} position.`,
  };
}
