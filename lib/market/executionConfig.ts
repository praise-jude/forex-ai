import type { AccountKey } from "./types";

export interface ExecutionConfig {
  /** Manual approvals may bypass account-level circuit breakers when explicitly enabled. */
  unrestrictedManualTrading: boolean;
  riskPerTradePct: number;
  maxConcurrentPositions: number;
  /** See riskManager.ts's checkCorrelatedExposure / pairCorrelation.ts -- how many
   * already-open positions may share the same implied directional bet (e.g. EUR/USD
   * long + GBP/USD long, both a short-USD bet) before a new correlated one is blocked.
   * Default 1: a second correlated position is blocked, the first is always allowed. */
  maxCorrelatedPositions: number;
  maxDailyLossPct: number;
  maxTradesPerDay: number;
  killSwitchFile: string;
  /** Consecutive losing deals (any symbol, any origin -- see getOpenPositionCount's same
   * whole-account philosophy) that trip the revenge-trading cooldown below. */
  maxConsecutiveLosses: number;
  /** How long new execution is paused for once maxConsecutiveLosses is hit. */
  cooldownMinutes: number;
  /** See riskManager.ts's checkSpread -- a fraction of the signal's own stop distance,
   * not a flat pip count, so it scales per instrument. */
  maxSpreadFractionOfStop: number;
  /** See positionManager.ts -- the R-multiple (computed off the trade's own original
   * entry/stop, never a since-moved live SL) at which the live stop loss moves to
   * breakeven. */
  breakEvenTriggerR: number;
  /** The R-multiple at which a broker-side trailing stop is armed (once, via MetaApi's
   * own server-side trailing -- see positionManager.ts). */
  trailingArmTriggerR: number;
  /** Trailing distance as a fraction of the trade's own original stop distance, same
   * "fraction of stop, not a flat pip count" reasoning as maxSpreadFractionOfStop. */
  trailingDistanceFractionOfStop: number;
  /** Master on/off switch for the whole position-management subsystem (break-even,
   * trailing, invalidation exit) -- independent of engine mode/kill switch, which only
   * govern opening NEW trades. */
  positionManagementEnabled: boolean;
  /** See positionManager.ts -- closes a fraction of the position once price reaches the
   * signal's TP1 and moves the stop to break-even on the remainder. Defaults OFF
   * (unlike every other position-management feature above): unlike break-even/trailing,
   * this touches live position VOLUME, not just the stop loss, so it ships opt-in --
   * same "off until explicitly configured" convention as the dashboard password gate
   * and the TradingView webhook secret. Exercise on DEMO before enabling on LIVE. */
  partialCloseEnabled: boolean;
  /** Fraction of the position closed at TP1, e.g. 0.5 = half. */
  partialCloseFraction: number;
  /** See m5Confirmation.ts / metaApiConnection.ts's onCandlesUpdated -- requires the
   * most recently closed M5 candle to confirm a would-be signal's direction before it
   * fires. Defaults ON (unlike partialCloseEnabled): this can only make execution MORE
   * conservative -- it holds a trade that would've otherwise fired, never fires one
   * that wouldn't have otherwise qualified -- so a bug here can't create risk the way
   * touching live position volume can. */
  m5ConfirmationEnabled: boolean;
  /** See positionSizing.ts's confidenceAdjustedRiskPct -- scales riskPerTradePct by
   * riskMultiplierBuy/riskMultiplierStrongBuy based on the signal's own final tier
   * before sizing. Defaults OFF, same posture as partialCloseEnabled: this changes
   * actual position size, not just a stop/target, so it ships opt-in. */
  confidenceSizingEnabled: boolean;
  /** Multiplier applied to riskPerTradePct for a buy-tier signal. Default 1.0 (no
   * change) -- buy is the existing baseline; only strong_buy scales up by default. */
  riskMultiplierBuy: number;
  /** Multiplier applied to riskPerTradePct for a strong_buy-tier signal (SMC's own
   * tier, optionally upgraded by Signer B agreement -- see decisionMatrix.ts). Default
   * 1.5: a documented starting point to observe and tune, not a claimed-optimal figure,
   * same posture as every other weighted constant in this codebase (e.g.
   * setupQualityScore.ts's dimension weights). */
  riskMultiplierStrongBuy: number;
  /** See positionSizing.ts's confluenceAdjustedMultiplier -- scales riskPerTradePct by
   * the real measured expectancy of the specific confluence tags present on THIS signal
   * (see tradeJournal.ts's getConfluenceBreakdown), multiplied into confidenceAdjustedRiskPct's
   * result rather than replacing it. Defaults OFF, same posture as confidenceSizingEnabled
   * and partialCloseEnabled: this changes actual position size, so it ships opt-in. */
  confluenceSizingEnabled: boolean;
  /** Master on/off switch for rangeEngine.ts's mean-reversion signals ever reaching
   * autoExecutionListener.ts/positionInvalidation.ts. Defaults OFF, same "off until
   * explicitly configured" posture as partialCloseEnabled -- this engine has zero
   * backtest history yet (unlike SMC, which got hours of validation the night it
   * shipped), so it stays detection-only (visible on the dashboard, journaled, never
   * executed) until deliberately turned on. */
  rangeEngineEnabled: boolean;
}

// A non-finite or non-positive multiplier can't reflect a real risk-scaling intent (a
// fat-fingered "0" or a stray non-numeric env value would zero out or invert sizing) --
// falls back to 1.0 (no scaling), same "invalid override ignored, safe default used"
// posture as sessions.ts's envHour/envWindow.
function envPositiveMultiplier(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1.0;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

// Same convention as riskManager.ts's isEnvKillSwitchActive -- "unset" keeps the
// fallback, and only these exact strings read as explicitly false, so a stray env var
// set to e.g. "no" doesn't silently disable position management by accident.
const FALSY_ENV_VALUES = new Set(["", "0", "false"]);

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !FALSY_ENV_VALUES.has(raw.toLowerCase());
}

/** These are risk-tolerance numbers, not engineering defaults — tune via env vars per
 * README. `account` "demo" reads the `DEMO_`-prefixed vars, independent of live's —
 * falling back to the same defaults as live (not live's actual configured values) when
 * unset, so demo risk can be tuned without touching live's tuned settings. */
export function loadExecutionConfig(account: AccountKey = "live"): ExecutionConfig {
  const prefix = account === "demo" ? "DEMO_" : "";
  return {
    unrestrictedManualTrading: envBoolean(`${prefix}UNRESTRICTED_MANUAL_TRADING`, false),
    // Tightened from the original 1% / 5% defaults -- more conservative starting point,
    // still just a starting point (tune via env vars per README), not a claim that
    // 0.25%/1% is somehow "correct" for every account size or risk tolerance.
    riskPerTradePct: envNumber(`${prefix}RISK_PER_TRADE_PCT`, 0.25),
    maxConcurrentPositions: envNumber(`${prefix}MAX_CONCURRENT_POSITIONS`, 3),
    maxCorrelatedPositions: envNumber(`${prefix}MAX_CORRELATED_POSITIONS`, 1),
    maxDailyLossPct: envNumber(`${prefix}MAX_DAILY_LOSS_PCT`, 1),
    maxTradesPerDay: envNumber(`${prefix}MAX_TRADES_PER_DAY`, 25),
    maxConsecutiveLosses: envNumber(`${prefix}MAX_CONSECUTIVE_LOSSES`, 3),
    cooldownMinutes: envNumber(`${prefix}COOLDOWN_MINUTES`, 30),
    // 15% of stop distance is deliberately generous -- catches a genuinely blown-out
    // spread (news spike, market open, weekend-gap-adjacent quote), not normal noise.
    maxSpreadFractionOfStop: envNumber(`${prefix}MAX_SPREAD_FRACTION_OF_STOP`, 0.15),
    breakEvenTriggerR: envNumber(`${prefix}BREAK_EVEN_TRIGGER_R`, 1.0),
    trailingArmTriggerR: envNumber(`${prefix}TRAILING_ARM_TRIGGER_R`, 1.5),
    trailingDistanceFractionOfStop: envNumber(`${prefix}TRAILING_DISTANCE_FRACTION_OF_STOP`, 1.0),
    positionManagementEnabled: envBoolean(`${prefix}POSITION_MANAGEMENT_ENABLED`, true),
    partialCloseEnabled: envBoolean(`${prefix}PARTIAL_CLOSE_ENABLED`, false),
    partialCloseFraction: envNumber(`${prefix}PARTIAL_CLOSE_FRACTION`, 0.5),
    m5ConfirmationEnabled: envBoolean(`${prefix}M5_CONFIRMATION_ENABLED`, true),
    confidenceSizingEnabled: envBoolean(`${prefix}CONFIDENCE_SIZING_ENABLED`, false),
    riskMultiplierBuy: envPositiveMultiplier(`${prefix}RISK_MULTIPLIER_BUY`, 1.0),
    riskMultiplierStrongBuy: envPositiveMultiplier(`${prefix}RISK_MULTIPLIER_STRONG_BUY`, 1.5),
    confluenceSizingEnabled: envBoolean(`${prefix}CONFLUENCE_SIZING_ENABLED`, false),
    rangeEngineEnabled: envBoolean(`${prefix}RANGE_ENGINE_ENABLED`, false),
    killSwitchFile:
      account === "demo" ? (process.env.KILL_SWITCH_FILE_DEMO ?? ".trading-paused-demo") : (process.env.KILL_SWITCH_FILE ?? ".trading-paused"),
  };
}
