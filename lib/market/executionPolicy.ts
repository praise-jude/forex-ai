import type { ConfidenceTier, Signal } from "./types";
import type { ConfidenceCalibrationBucket } from "./tradeJournal";

export interface ExecutionPolicyState {
  /** Floor is "buy" -- watch-tier signals are already hard-blocked in executionEngine.ts
   * before this gate ever runs, so this can only ever tighten selectivity beyond today's
   * shipped behavior, never loosen it. */
  minTier: "buy" | "strong_buy";
  /** Floor is 0 -- same invariant as minTier. */
  minRiskReward: number;
  /** Opt-in, defaults OFF -- same posture as executionConfig.ts's confidenceSizingEnabled/
   * confluenceSizingEnabled, which this reuses the exact same calibration data source as
   * (getConfidenceCalibration). Those two only ever SIZE differently based on real
   * performance (clamped [0.5x, 2x], never to zero); this is the stronger, binary sibling
   * -- once a tier has enough real closed trades to measure (see
   * defaultCalibrationMinSamples) AND its measured expectancy has gone negative (it's
   * been a net loser in practice, not just below some arbitrary win-rate guess), new
   * signals at that tier are held entirely until performance recovers, the same "policy
   * floor on top of an already-computed signal" shape minTier/minRiskReward already are. */
  calibratedGateEnabled: boolean;
}

// Unlike engineMode.ts (which always boots to "analysis" -- reverting to the safe
// default on every restart IS the safety mechanism there), the "loose" end of this
// setting (minTier:"buy", minRiskReward:0) is today's EXACT existing behavior. Always
// booting to that hardcoded default would silently undo an operator's deliberate
// tightening on every redeploy, with no signal that it happened. So the boot default
// reads from env vars (persists across restarts via the platform's own env dashboard,
// same reasoning executionConfig.ts documents for ephemeral-filesystem deploys) and is
// then live-adjustable on top, exactly like engineMode.ts.
function envTierDefault(): "buy" | "strong_buy" {
  return process.env.EXEC_MIN_TIER?.trim().toLowerCase() === "strong_buy" ? "strong_buy" : "buy";
}

function envRRDefault(): number {
  const raw = Number(process.env.EXEC_MIN_RISK_REWARD);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function envCalibratedGateDefault(): boolean {
  return process.env.EXEC_CALIBRATED_GATE_ENABLED === "true";
}

const globalKey = Symbol.for("forex-ai.executionPolicy");
type GlobalWithState = typeof globalThis & { [globalKey]?: ExecutionPolicyState };
const g = globalThis as GlobalWithState;
const state: ExecutionPolicyState = g[globalKey] ??
  (g[globalKey] = { minTier: envTierDefault(), minRiskReward: envRRDefault(), calibratedGateEnabled: envCalibratedGateDefault() });

export function getExecutionPolicy(): ExecutionPolicyState {
  return state;
}

export function setExecutionPolicy(next: Partial<ExecutionPolicyState>): ExecutionPolicyState {
  if (next.minTier !== undefined) state.minTier = next.minTier;
  if (next.minRiskReward !== undefined && Number.isFinite(next.minRiskReward) && next.minRiskReward >= 0) {
    state.minRiskReward = next.minRiskReward;
  }
  if (next.calibratedGateEnabled !== undefined) state.calibratedGateEnabled = next.calibratedGateEnabled;
  return state;
}

/** Test-only: returns to the env-var-derived boot default, same convention as
 * engineMode.ts's own resetEngineModeForTests. */
export function resetExecutionPolicyForTests(): void {
  state.minTier = envTierDefault();
  state.minRiskReward = envRRDefault();
  state.calibratedGateEnabled = envCalibratedGateDefault();
}

const TIER_RANK: Record<ConfidenceTier, number> = { watch: 0, buy: 1, strong_buy: 2 };

export type ExecutionPolicyBlockCode = "below_min_tier" | "below_min_rr" | "below_calibrated_expectancy";
export type ExecutionPolicyCheckResult = { allowed: true } | { allowed: false; code: ExecutionPolicyBlockCode; reason: string };

/**
 * Pure. A policy floor sitting on top of an already-computed signal -- it never changes
 * how a signal is scored (confidenceScore.ts's 90/80/70 tier boundaries) or how its
 * take-profit targets were picked (signalEngine.ts's RR constants), both of which stay
 * fixed, tested constants. This only decides whether an otherwise-valid signal clears
 * the operator's own configured selectivity bar before being allowed to execute.
 *
 * Exempts source === "tradingview" and source === "manual": both hardcode tier "buy" by
 * design (see tradingViewWebhook.ts and manualSignal.ts) since neither goes through the
 * SMC scoring this floor is tuned against -- gating either against it would silently
 * disable it whenever the operator raises the floor above "buy". A hand-entered manual
 * trade is the operator's own explicit, one-off judgment call; a tier floor meant to
 * filter the AUTOPILOT's own signal stream was never meant to second-guess that.
 *

 * `calibration` is only consulted when policy.calibratedGateEnabled is on -- the caller
 * (executionEngine.ts) only bothers computing it in that case, same "cheap but no reason
 * to do it for accounts that never opted in" posture as the sizing feature's own
 * confidenceSizingEnabled check. Never blocks on a tier that hasn't cleared its own real
 * sample-size bar yet (bucket.status !== "calibrated") -- an early, thin sample is not
 * evidence, the same fail-open posture calibratedMultiplier's null fallback in
 * positionSizing.ts already uses.
 */
export function checkExecutionPolicy(
  signal: Pick<Signal, "tier" | "riskReward" | "source">,
  policy: ExecutionPolicyState,
  calibration?: ConfidenceCalibrationBucket[]
): ExecutionPolicyCheckResult {
  if (signal.source === "tradingview" || signal.source === "manual") return { allowed: true };

  if (TIER_RANK[signal.tier] < TIER_RANK[policy.minTier]) {
    return {
      allowed: false,
      code: "below_min_tier",
      reason: `signal tier "${signal.tier}" is below the configured minimum "${policy.minTier}"`,
    };
  }

  if (signal.riskReward < policy.minRiskReward) {
    return {
      allowed: false,
      code: "below_min_rr",
      reason: `risk/reward ${signal.riskReward.toFixed(2)} is below the configured minimum ${policy.minRiskReward.toFixed(2)}`,
    };
  }

  if (policy.calibratedGateEnabled && (signal.tier === "buy" || signal.tier === "strong_buy")) {
    const bucket = calibration?.find((b) => b.tier === signal.tier);
    if (bucket?.status === "calibrated" && bucket.expectancy !== null && bucket.expectancy < 0) {
      return {
        allowed: false,
        code: "below_calibrated_expectancy",
        reason: `real trade history for tier "${signal.tier}" (${bucket.sampleSize} closed trades) shows negative expectancy (${bucket.expectancy.toFixed(2)}R average) -- held until performance recovers`,
      };
    }
  }

  return { allowed: true };
}
