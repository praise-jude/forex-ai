import type { NoTradeReason } from "./types";

export interface NoTradeCloseness {
  /** 0 = closest to firing, higher = farther. Not a percentage or a promise -- an
   * ordinal ranking of how much real progress this reason represents, derived from
   * what it actually tells us already cleared (see the switch below's own comments).
   * Purely for sorting/display -- never read by any gate or execution path. */
  tier: number;
  /** Short, human label for display -- reuses the real numbers already on the reason
   * itself (ADX, score, minutes) rather than inventing a new figure. */
  label: string;
}

/**
 * "Given this candle didn't fire, how much real progress had it already made" -- an
 * ordinal ranking over NoTradeReason (see types.ts's own doc comment on that union),
 * used to sort the dashboard's "closest to firing" panel. Nothing here is a new
 * computation: every number displayed already exists on the reason itself (adx, atr,
 * score totals, minutesUntil) -- this only orders and labels what signalEngine.ts/
 * rangeEngine.ts already computed and attached.
 *
 * Tiers, closest to farthest:
 * 0 -- everything (including independent confirmation) already agreed; only waiting
 *      on the next M5 candle to confirm direction.
 * 1 -- the setup already cleared its own confidence bar on its own engine's merits,
 *      just blocked by a genuinely separate, external gate (news timing, or Signer
 *      B's own independent read).
 * 2 -- a real, scored setup exists, but the score itself hasn't cleared the bar yet.
 * 3 -- a real directional structure exists (a range, or a trend-aligned SMC zone),
 *      but a secondary numeric condition (ADX floor, volatility, a boundary touch)
 *      hasn't been met.
 * 4 -- the higher-timeframe trend itself isn't aligned -- the most fundamental
 *      SMC precondition, structurally further than a numeric threshold miss.
 * 5 -- no real setup/structure exists yet at all; nothing to measure progress
 *      against.
 */
export function rankNoTradeCloseness(reason: NoTradeReason): NoTradeCloseness {
  switch (reason.code) {
    case "m5_not_confirmed":
      return { tier: 0, label: "Everything agrees -- waiting on the next 5-minute candle to confirm" };
    case "signer_b_neutral":
      return { tier: 1, label: "Setup already qualified -- Signer B has no lean yet" };
    case "signer_conflict":
      return { tier: 1, label: `Setup already qualified -- Signer B leans the other way (${reason.signerBConfidence.toFixed(0)}%)` };
    case "news_blackout":
      return { tier: 1, label: `Setup already qualified -- waiting out ${reason.event} (${reason.minutesUntil}m)` };
    case "below_threshold": {
      const score = Math.min(reason.direction.total, reason.entry.total);
      return { tier: 2, label: `Scored ${score.toFixed(0)}/100 so far` };
    }
    case "range_below_threshold":
      return { tier: 2, label: `Scored ${reason.total.toFixed(0)}/100 so far` };
    case "weak_trend_adx":
      return { tier: 3, label: `ADX ${reason.adx.toFixed(1)}, needs 20+` };
    case "low_volatility":
      return { tier: 3, label: `Volatility below its recent average (ATR ${reason.atr.toFixed(5)} vs ${reason.atrAverage.toFixed(5)})` };
    case "no_boundary_touch":
      return { tier: 3, label: "A real range exists -- no boundary touch yet" };
    case "trend_disagreement":
      return { tier: 4, label: "Daily and 4-hour trend don't yet agree" };
    case "no_setup":
      return { tier: 5, label: "No qualifying structure yet" };
    case "outside_killzone":
      return { tier: 5, label: "Outside the killzone window" };
    case "not_ranging":
      return { tier: 5, label: "Market isn't currently ranging" };
    case "no_range_detected":
      return { tier: 5, label: "No tradeable range established yet" };
  }
}
