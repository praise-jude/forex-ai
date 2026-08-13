import type { ConfidenceTier, Signal } from "./types";

export interface ExecutionPolicyState {
  /** Floor is "buy" -- watch-tier signals are already hard-blocked in executionEngine.ts
   * before this gate ever runs, so this can only ever tighten selectivity beyond today's
   * shipped behavior, never loosen it. */
  minTier: "buy" | "strong_buy";
  /** Floor is 0 -- same invariant as minTier. */
  minRiskReward: number;
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

const globalKey = Symbol.for("forex-ai.executionPolicy");
type GlobalWithState = typeof globalThis & { [globalKey]?: ExecutionPolicyState };
const g = globalThis as GlobalWithState;
const state: ExecutionPolicyState = g[globalKey] ?? (g[globalKey] = { minTier: envTierDefault(), minRiskReward: envRRDefault() });

export function getExecutionPolicy(): ExecutionPolicyState {
  return state;
}

export function setExecutionPolicy(next: Partial<ExecutionPolicyState>): ExecutionPolicyState {
  if (next.minTier !== undefined) state.minTier = next.minTier;
  if (next.minRiskReward !== undefined && Number.isFinite(next.minRiskReward) && next.minRiskReward >= 0) {
    state.minRiskReward = next.minRiskReward;
  }
  return state;
}

/** Test-only: returns to the env-var-derived boot default, same convention as
 * engineMode.ts's own resetEngineModeForTests. */
export function resetExecutionPolicyForTests(): void {
  state.minTier = envTierDefault();
  state.minRiskReward = envRRDefault();
}

const TIER_RANK: Record<ConfidenceTier, number> = { watch: 0, buy: 1, strong_buy: 2 };

export type ExecutionPolicyBlockCode = "below_min_tier" | "below_min_rr";
export type ExecutionPolicyCheckResult = { allowed: true } | { allowed: false; code: ExecutionPolicyBlockCode; reason: string };

/**
 * Pure. A policy floor sitting on top of an already-computed signal -- it never changes
 * how a signal is scored (confidenceScore.ts's 95/90/80 tier boundaries) or how its
 * take-profit targets were picked (signalEngine.ts's RR constants), both of which stay
 * fixed, tested constants. This only decides whether an otherwise-valid signal clears
 * the operator's own configured selectivity bar before being allowed to execute.
 *
 * Exempts source === "tradingview": that integration hardcodes tier "buy" by design
 * (see tradingViewWebhook.ts) and has its own dedicated, always-live execution path --
 * gating it against an SMC-tuned tier floor would silently disable it whenever the
 * operator raises the floor above "buy". Matches autoExecutionListener.ts's own
 * established source==="tradingview" carve-out for the same reason.
 */
export function checkExecutionPolicy(
  signal: Pick<Signal, "tier" | "riskReward" | "source">,
  policy: ExecutionPolicyState
): ExecutionPolicyCheckResult {
  if (signal.source === "tradingview") return { allowed: true };

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

  return { allowed: true };
}
