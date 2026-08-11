import type { DimensionTier } from "./confidenceScore";
import type { SignerBResult } from "./signerB";

export type DecisionBlock =
  | { code: "signer_conflict"; smcDirection: "long" | "short"; signerBDirection: "long" | "short"; signerBConfidence: number }
  | { code: "signer_b_neutral"; smcDirection: "long" | "short" };

export interface DecisionResult {
  /** Only meaningful when `blocked` is null -- SMC's own tier, optionally upgraded.
   * Never downgraded by Signer B: a genuinely weak-but-agreeing Signer B no longer
   * sinks a strong SMC setup (the actual over-blocking fix). */
  tier: DimensionTier;
  blocked: DecisionBlock | null;
}

/**
 * The hard/soft filter split lives here. SMC (Signer A) is the primary entry engine;
 * Signer B is independent confirmation. Only two things ever produce a WAIT from this
 * function: Signer B has no real opinion (`"neutral"` -- a genuine tie or nothing
 * available), or Signer B's independent read is the OPPOSITE direction from SMC's.
 * Any other disagreement -- one weak factor, a merely-lower Signer B confidence while
 * still agreeing on direction -- is a soft signal, already reflected in Signer B's own
 * confidence number (shown separately, never blended in here), and never blocks.
 */
export function combineSigners(smc: { tier: DimensionTier; direction: "long" | "short" }, signerB: SignerBResult): DecisionResult {
  if (smc.tier === "no_trade") return { tier: smc.tier, blocked: null };

  if (signerB.direction === "neutral") {
    return { tier: smc.tier, blocked: { code: "signer_b_neutral", smcDirection: smc.direction } };
  }
  if (signerB.direction !== smc.direction) {
    return {
      tier: smc.tier,
      blocked: { code: "signer_conflict", smcDirection: smc.direction, signerBDirection: signerB.direction, signerBConfidence: signerB.confidence },
    };
  }

  // Agree: never downgraded. Upgraded to strong_buy/strong_sell only when SMC already
  // cleared "buy" on its own AND Signer B's independent confidence is itself strong --
  // watch-tier (informational-only) is never upgraded, and an already-strong SMC tier
  // has nowhere higher to go.
  const tier: DimensionTier = smc.tier === "buy" && signerB.tier === "strong_buy" ? "strong_buy" : smc.tier;
  return { tier, blocked: null };
}
