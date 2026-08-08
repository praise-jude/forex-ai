import fs from "node:fs";

export interface RiskCheckInput {
  killSwitchActive: boolean;
  haltedForToday: boolean;
  openPositionCount: number;
  maxConcurrentPositions: number;
  tradesOpenedToday: number;
  maxTradesPerDay: number;
  startOfDayEquity: number;
  currentEquity: number;
  maxDailyLossPct: number;
}

export type RiskBlockCode = "kill_switch" | "halted" | "max_positions" | "max_trades" | "daily_loss" | "stale_price";

export type RiskCheckResult = { allowed: true } | { allowed: false; code: RiskBlockCode; reason: string };

/**
 * Checked before every execution attempt, cheapest/highest-priority first, so the
 * reported reason always reflects the most severe condition tripped rather than
 * whichever check happened to run last. `code` is for callers to branch on
 * programmatically (e.g. "should this trip the daily halt flag?") — `reason` is
 * for logging, not for matching against.
 */
export function checkRiskLimits(input: RiskCheckInput): RiskCheckResult {
  if (input.killSwitchActive) {
    return { allowed: false, code: "kill_switch", reason: "kill switch is active" };
  }
  if (input.haltedForToday) {
    return { allowed: false, code: "halted", reason: "trading halted for today (daily loss limit already tripped)" };
  }
  if (input.openPositionCount >= input.maxConcurrentPositions) {
    return {
      allowed: false,
      code: "max_positions",
      reason: `max concurrent positions reached (${input.openPositionCount}/${input.maxConcurrentPositions})`,
    };
  }
  if (input.tradesOpenedToday >= input.maxTradesPerDay) {
    return {
      allowed: false,
      code: "max_trades",
      reason: `max trades per day reached (${input.tradesOpenedToday}/${input.maxTradesPerDay})`,
    };
  }
  if (input.startOfDayEquity > 0) {
    const drawdownPct = ((input.startOfDayEquity - input.currentEquity) / input.startOfDayEquity) * 100;
    if (drawdownPct >= input.maxDailyLossPct) {
      return {
        allowed: false,
        code: "daily_loss",
        reason: `daily loss limit reached (${drawdownPct.toFixed(2)}% >= ${input.maxDailyLossPct}%)`,
      };
    }
  }
  return { allowed: true };
}

export interface PriceDriftInput {
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  /** Current bid/ask, if a live price has been seen for this pair yet. */
  currentBid?: number;
  currentAsk?: number;
}

// A fraction of stop-distance, not a flat pip count -- consistent with this codebase's
// existing preference for ATR/stop-relative thresholds over flat pip counts (e.g. the
// sweep tolerance and SL buffer are both stop/ATR-relative). 25% of stop distance is
// deliberately generous: it only catches genuinely stale quotes (a fast news spike, a
// long gap between signal generation and a slow voice confirmation), not normal spread
// noise around the entry.
export const STALE_PRICE_FRACTION_OF_STOP = 0.25;

/**
 * Blocks execution if the market has moved too far from the signal's entry since it was
 * generated -- there was previously no check at all between signal creation and order
 * placement, which matters most for voice-confirmed trades where a slow "would you like
 * me to place this trade?" -> spoken confirmation round trip leaves more time for the
 * price to drift than an immediate button click. Fails open (allows execution) when no
 * live price has been seen yet for the pair -- `no_account`/`no_symbol_spec` already
 * guard against acting with no data at all elsewhere in the execution pipeline.
 */
export function checkPriceDrift(input: PriceDriftInput): RiskCheckResult {
  const referencePrice = input.direction === "long" ? input.currentAsk : input.currentBid;
  if (referencePrice === undefined) return { allowed: true };

  const stopDistance = Math.abs(input.entry - input.stopLoss);
  if (stopDistance <= 0) return { allowed: true };

  const drift = Math.abs(referencePrice - input.entry);
  const tolerance = STALE_PRICE_FRACTION_OF_STOP * stopDistance;
  if (drift > tolerance) {
    return {
      allowed: false,
      code: "stale_price",
      reason: `price has moved ${drift.toFixed(5)} since the signal was generated (tolerance ${tolerance.toFixed(5)})`,
    };
  }
  return { allowed: true };
}

const FALSY_ENV_VALUES = new Set(["", "0", "false"]);

/** The platform-level switch alone — split out so callers (the STOP ROBOT API route)
 * can tell "blocked by the env var" apart from "blocked by the file", since only the
 * file can be toggled at runtime from within the app itself. */
export function isEnvKillSwitchActive(): boolean {
  const envValue = process.env.TRADING_KILL_SWITCH?.toLowerCase() ?? "";
  return !FALSY_ENV_VALUES.has(envValue);
}

/**
 * Two independent switches, either one blocks trading: the file (works anywhere with a
 * persistent filesystem — e.g. a VPS, where it can be toggled live without a restart)
 * and the `TRADING_KILL_SWITCH` env var (works on platforms with an ephemeral
 * filesystem per deploy — e.g. Railway/Render — where a file touched via a one-off
 * shell command wouldn't survive the next redeploy, but an env var set in the
 * platform's dashboard is guaranteed present from the very first boot).
 */
export function isKillSwitchActive(killSwitchFile: string): boolean {
  if (isEnvKillSwitchActive()) return true;

  try {
    return fs.existsSync(killSwitchFile);
  } catch {
    return false;
  }
}
