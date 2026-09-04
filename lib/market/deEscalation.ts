/**
 * Graduated de-escalation: instead of a binary "all clear" / "halted for today" daily
 * loss gate, add an intermediate HALF-SIZE band. Between the de-escalation threshold
 * (e.g. 50% of maxDailyLossPct) and the hard limit, new trades are still allowed but at
 * a reduced size. Only a bug that made this return a LARGER multiplier could increase
 * risk -- it can only ever shrink size or leave it unchanged, never grow it.
 */

export interface DeEscalationInput {
  /** Equity at the start of the current trading day. */
  startOfDayEquity: number;
  /** Current account equity. */
  currentEquity: number;
  /** Configured hard daily-loss limit (%). Above this the existing gate halts entirely. */
  maxDailyLossPct: number;
  /** Fraction of maxDailyLossPct at which half-size mode kicks in (e.g. 0.5 = half of
   * the limit). Must be in (0, 1). */
  deEscalationFraction: number;
  /** Size multiplier applied while in the de-escalation band (e.g. 0.5 = half size). */
  deEscalationSizeMultiplier: number;
}

export type DeEscalationResult =
  | { active: false; sizeMultiplier: 1 }
  | { active: true; sizeMultiplier: number; drawdownPct: number; thresholdPct: number };

function drawdownPct(startOfDayEquity: number, currentEquity: number): number {
  if (startOfDayEquity <= 0) return 0;
  return ((startOfDayEquity - currentEquity) / startOfDayEquity) * 100;
}

/**
 * Returns a size multiplier of 1 when drawdown is below the de-escalation threshold, or
 * the configured reduced multiplier once inside the band. The hard daily-loss halt (at
 * maxDailyLossPct itself) is unchanged and still handled by checkRiskLimits -- this only
 * ever runs on trades that already passed that gate, so it can't resurrect a halted day.
 */
export function deEscalationSizeMultiplier(input: DeEscalationInput): DeEscalationResult {
  const { startOfDayEquity, currentEquity, maxDailyLossPct, deEscalationFraction, deEscalationSizeMultiplier } = input;
  if (startOfDayEquity <= 0) return { active: false, sizeMultiplier: 1 };
  if (!(deEscalationFraction > 0 && deEscalationFraction < 1)) return { active: false, sizeMultiplier: 1 };
  // Guard: a misconfigured multiplier >= 1 would defeat the purpose; clamp into (0, 1).
  const safeMultiplier = deEscalationSizeMultiplier > 0 && deEscalationSizeMultiplier < 1 ? deEscalationSizeMultiplier : 0.5;

  const dd = drawdownPct(startOfDayEquity, currentEquity);
  const thresholdPct = maxDailyLossPct * deEscalationFraction;
  if (dd >= thresholdPct) {
    return { active: true, sizeMultiplier: safeMultiplier, drawdownPct: dd, thresholdPct };
  }
  return { active: false, sizeMultiplier: 1 };
}
