import fs from "node:fs";
import type { Pair } from "./types";
import { correlationTier, type CorrelationTier } from "./rollingCorrelation";

export interface RiskCheckInput {
  killSwitchActive: boolean;
  haltedForToday: boolean;
  now: number;
  /** Epoch ms the revenge-trading cooldown lifts, or null when none is active. */
  cooldownUntil: number | null;
  openPositionCount: number;
  maxConcurrentPositions: number;
  tradesOpenedToday: number;
  maxTradesPerDay: number;
  startOfDayEquity: number;
  currentEquity: number;
  maxDailyLossPct: number;
}

export type RiskBlockCode =
  | "kill_switch"
  | "halted"
  | "cooldown"
  | "max_positions"
  | "max_trades"
  | "daily_loss"
  | "stale_price"
  | "wide_spread"
  | "correlated_exposure";

function computeDrawdownPct(startOfDayEquity: number, currentEquity: number): number {
  if (startOfDayEquity <= 0) return 0;
  return ((startOfDayEquity - currentEquity) / startOfDayEquity) * 100;
}

/** Same daily-loss math checkRiskLimits uses, exposed standalone so metaApiConnection.ts's
 * deal-close listener can detect a breach the moment equity changes -- not just the next
 * time a trade happens to be attempted. */
export function isDailyLossBreached(startOfDayEquity: number, currentEquity: number, maxDailyLossPct: number): boolean {
  return startOfDayEquity > 0 && computeDrawdownPct(startOfDayEquity, currentEquity) >= maxDailyLossPct;
}

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
  if (input.cooldownUntil !== null && input.now < input.cooldownUntil) {
    const remainingMin = Math.ceil((input.cooldownUntil - input.now) / 60_000);
    return {
      allowed: false,
      code: "cooldown",
      reason: `trading paused after too many consecutive losses -- ${remainingMin} minute(s) remaining`,
    };
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
  if (isDailyLossBreached(input.startOfDayEquity, input.currentEquity, input.maxDailyLossPct)) {
    const drawdownPct = computeDrawdownPct(input.startOfDayEquity, input.currentEquity);
    return {
      allowed: false,
      code: "daily_loss",
      reason: `daily loss limit reached (${drawdownPct.toFixed(2)}% >= ${input.maxDailyLossPct}%)`,
    };
  }
  return { allowed: true };
}

export interface CorrelatedExposureInput {
  pair: Pair;
  direction: "long" | "short";
  /** Every other currently-open position on the account (from getOpenPositions) --
   * never includes the position this check is deciding whether to allow, since that
   * one doesn't exist yet. */
  openPositions: { pair: Pair; direction: "long" | "short" }[];
  maxCorrelatedPositions: number;
}

export type CorrelatedExposureResult =
  | { allowed: true; sizeMultiplier: number; tier: CorrelationTier; reason: string | null }
  | { allowed: false; code: "correlated_exposure"; reason: string; tier: "extreme" };

const TIER_RANK: Record<CorrelationTier, number> = { none: 0, moderate: 1, strong: 2, extreme: 3 };
// Position-size multiplier applied when allowed at each tier -- documented starting
// points to tune, same posture as CORRELATION_STRONG_THRESHOLD/CORRELATION_EXTREME_
// THRESHOLD in rollingCorrelation.ts. "extreme" only ever reaches this table when it's
// under the maxCorrelatedPositions count cap below (otherwise it's blocked outright) --
// still sized down hard even though it wasn't blocked, since 0.90+ correlation is a
// near-duplicate bet regardless of how many correlated positions are already open.
const SIZE_MULTIPLIER_BY_TIER: Record<CorrelationTier, number> = { none: 1, moderate: 0.5, strong: 0.25, extreme: 0.1 };

/**
 * Graduated correlation-aware sizing, not a flat allow/block: a new position that
 * shares the same directional bet as an already-open one (e.g. EUR/USD long opened,
 * then a GBP/USD long signal fires -- both a bet that USD weakens, not two diversified
 * trades) gets its position size reduced in proportion to how strongly correlated it
 * is, and is only blocked outright once enough EXTREME-tier (0.90+ real correlation, or
 * a static-model match with no real magnitude behind it -- see rollingCorrelation.ts's
 * correlationTier) positions are already open to hit maxCorrelatedPositions. Sizing for
 * the moderate/strong tiers is never gated by that count at all -- a correlated
 * position is still allowed, just smaller, however many others are already open.
 *
 * Uses the WORST (most-correlated) tier across every open position, not an average --
 * one 0.92-correlated position should size the new trade down hard even if three other
 * open positions are entirely uncorrelated. A bug here can only make execution MORE
 * conservative (smaller size or an outright block), never less.
 */
export function checkCorrelatedExposure(input: CorrelatedExposureInput): CorrelatedExposureResult {
  const tiers = input.openPositions.map((p) => correlationTier(input.pair, input.direction, p.pair, p.direction));

  const extremeCount = tiers.filter((t) => t === "extreme").length;
  if (extremeCount >= input.maxCorrelatedPositions) {
    return {
      allowed: false,
      code: "correlated_exposure",
      tier: "extreme",
      reason: `${extremeCount} tightly correlated position(s) already open (max ${input.maxCorrelatedPositions}) -- ${input.pair} ${input.direction} would stack the same directional bet`,
    };
  }

  const worstTier = tiers.reduce((worst, t) => (TIER_RANK[t] > TIER_RANK[worst] ? t : worst), "none" as CorrelationTier);
  const sizeMultiplier = SIZE_MULTIPLIER_BY_TIER[worstTier];
  return {
    allowed: true,
    sizeMultiplier,
    tier: worstTier,
    reason:
      sizeMultiplier < 1
        ? `position size reduced to ${(sizeMultiplier * 100).toFixed(0)}% -- ${worstTier} correlated exposure with an open position`
        : null,
  };
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

export interface SpreadInput {
  entry: number;
  stopLoss: number;
  /** Current bid/ask, if a live price has been seen for this pair yet. */
  currentBid?: number;
  currentAsk?: number;
  maxSpreadFractionOfStop: number;
}

/**
 * Blocks execution when the current spread is wide relative to the signal's own stop
 * distance -- e.g. a news spike, market open, or weekend-gap-adjacent quote. A fraction
 * of stop-distance, not a flat pip count, for the same reason checkPriceDrift is: a flat
 * pip threshold doesn't work across pairs with very different pip definitions (0.0001
 * for EUR/USD vs 1 for USOIL vs 0.01 for a several-thousand-dollar BTC/USD), but "spread
 * relative to this specific signal's own stop distance" scales naturally per instrument.
 * Fails open (allows execution) when no live price has been seen yet, matching
 * checkPriceDrift's own posture -- other checks already guard against acting on no data.
 */
export function checkSpread(input: SpreadInput): RiskCheckResult {
  if (input.currentBid === undefined || input.currentAsk === undefined) return { allowed: true };

  const stopDistance = Math.abs(input.entry - input.stopLoss);
  if (stopDistance <= 0) return { allowed: true };

  const spread = input.currentAsk - input.currentBid;
  const tolerance = input.maxSpreadFractionOfStop * stopDistance;
  if (spread > tolerance) {
    return {
      allowed: false,
      code: "wide_spread",
      reason: `spread (${spread.toFixed(5)}) exceeds ${(input.maxSpreadFractionOfStop * 100).toFixed(0)}% of the stop distance (${stopDistance.toFixed(5)})`,
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
