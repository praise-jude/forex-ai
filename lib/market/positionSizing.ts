import type { ConfidenceTier, Signal, SymbolSpec } from "./types";
import type { ExecutionConfig } from "./executionConfig";
import type { ConfidenceCalibrationBucket } from "./tradeJournal";
import { pipSize } from "./symbols";
import { pipValuePerLot } from "./pipValue";

export type LotSizeResult = { lots: number } | { skipped: true; reason: string };

// Exported for reuse by positionManager.ts's partial take-profit action, which needs
// the exact same broker-step rounding when computing a fraction of an already-open
// position's lots (see closePositionPartially's caller).
export function roundDownToStep(value: number, step: number): number {
  if (step <= 0) return value;
  // Binary floating point means e.g. 1.105 - 1.103 isn't exactly 0.002, which can
  // nudge a value that should land exactly on a step boundary a hair below it
  // (0.49999999999999956 instead of 0.5) and floor down one step too many. Rounding
  // to 8dp first — far finer than any real broker's volume step — absorbs that noise
  // without affecting genuine step-boundary decisions.
  const safeValue = Number(value.toFixed(8));
  const steps = Math.floor(safeValue / step);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number((steps * step).toFixed(decimals));
}

// Bounds on a CALIBRATED multiplier (never on the manual riskMultiplierBuy/
// riskMultiplierStrongBuy config values themselves, which are an explicit operator
// choice) -- a documented starting point to tune, not a claimed-optimal range. Caps how
// far real measured performance can swing sizing in either direction even once a tier
// has cleared the sample-size bar, so one unusually hot or cold real stretch can't send
// sizing to an extreme.
const MIN_CALIBRATED_MULTIPLIER = 0.5;
const MAX_CALIBRATED_MULTIPLIER = 2.0;
// How much one full R of measured expectancy shifts the calibrated multiplier away from
// 1.0x -- a tier averaging +0.5R per real closed trade gets 1.5x size, one averaging
// -0.3R gets 0.7x. Documented starting point, not a claimed-optimal value.
const EXPECTANCY_SENSITIVITY = 1.0;

/**
 * The real-performance-derived multiplier for one tier, or null when there isn't yet
 * enough real closed-trade history to trust it (see getConfidenceCalibration in
 * tradeJournal.ts -- "calibrated" only once a tier clears CONFIDENCE_CALIBRATION_MIN_
 * SAMPLES real trades). Null here is what makes confidenceAdjustedRiskPct fall back to
 * the manual riskMultiplierBuy/riskMultiplierStrongBuy config value below -- turning
 * this on has ZERO effect on sizing until a tier has genuinely earned a real number.
 */
export function calibratedMultiplier(bucket: ConfidenceCalibrationBucket | undefined): number | null {
  if (!bucket || bucket.status !== "calibrated" || bucket.expectancy === null) return null;
  const raw = 1 + bucket.expectancy * EXPECTANCY_SENSITIVITY;
  return Math.min(MAX_CALIBRATED_MULTIPLIER, Math.max(MIN_CALIBRATED_MULTIPLIER, raw));
}

/**
 * Scales a base risk % by the signal's own final tier (buy vs strong_buy -- SMC's tier,
 * optionally upgraded by Signer B agreement, see decisionMatrix.ts) when confidence
 * sizing is enabled -- so a fully-confirmed strong_buy setup risks more than a
 * barely-qualifying buy, instead of every executable signal risking the same flat %.
 * Returns `baseRiskPct` unchanged when disabled, or for "watch" (defensive only --
 * watch-tier signals never reach execution, see executionEngine.ts's own guard, but this
 * must never amplify a tier that was never meant to execute).
 *
 * `calibration` (see getConfidenceCalibration in tradeJournal.ts) is optional and, when
 * supplied, takes priority over the manual riskMultiplierBuy/riskMultiplierStrongBuy
 * config value for any tier that has real data behind it -- real measured expectancy
 * replacing a guess, exactly the "later change once this produces real numbers to build
 * on" the calibration panel's own copy has always promised. A tier still short on real
 * trades (or no calibration data supplied at all -- every existing call site that
 * doesn't pass this argument) falls straight back to the manual multiplier, so this is
 * purely additive: it can only ever replace a guess with real data, never introduce a
 * new way to skip sizing checks.
 */
export function confidenceAdjustedRiskPct(
  baseRiskPct: number,
  tier: ConfidenceTier,
  config: Pick<ExecutionConfig, "confidenceSizingEnabled" | "riskMultiplierBuy" | "riskMultiplierStrongBuy">,
  calibration?: ConfidenceCalibrationBucket[]
): number {
  if (!config.confidenceSizingEnabled) return baseRiskPct;
  if (tier !== "strong_buy" && tier !== "buy") return baseRiskPct;

  const manualMultiplier = tier === "strong_buy" ? config.riskMultiplierStrongBuy : config.riskMultiplierBuy;
  const bucket = calibration?.find((b) => b.tier === tier);
  const multiplier = calibratedMultiplier(bucket) ?? manualMultiplier;
  return baseRiskPct * multiplier;
}

/**
 * Sizes a position so that hitting the signal's stop loss risks exactly
 * `riskPct` of `equity` — never more. Rounds down, and skips (rather than
 * rounding up to the broker minimum) when the risk-correct size would fall
 * below what the broker allows, since forcing a minimum-size trade there
 * would silently risk more than the configured percentage.
 */
export function computeLotSize(signal: Signal, equity: number, riskPct: number, spec: SymbolSpec): LotSizeResult {
  const riskAmount = equity * (riskPct / 100);
  const pips = Math.abs(signal.entry - signal.stopLoss) / pipSize(signal.pair);
  if (pips <= 0) return { skipped: true, reason: "entry and stop loss are equal (zero pip distance)" };

  const pipValue = pipValuePerLot(signal.pair, spec.contractSize);
  if (pipValue === undefined || pipValue <= 0) {
    return { skipped: true, reason: "no live price available to compute pip value" };
  }

  const rawLots = riskAmount / (pips * pipValue);
  const lots = roundDownToStep(rawLots, spec.volumeStep);

  if (lots < spec.volumeMin) {
    return {
      skipped: true,
      reason: `computed lot size ${lots} is below the broker minimum ${spec.volumeMin} for this risk %`,
    };
  }

  return { lots: Math.min(lots, spec.volumeMax) };
}
