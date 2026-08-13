import type { Signal, SymbolSpec } from "./types";
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
