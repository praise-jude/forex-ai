import type { MarketRegime, Signal } from "@/lib/market/types";
import { scoreSetupQuality } from "@/lib/market/setupQualityScore";
import { ConfirmationRow } from "./SignerBBreakdown";

/**
 * Transparent 7-category breakdown of a fired signal's own real data (see
 * setupQualityScore.ts) -- explicitly not a claimed "% chance of winning", just how
 * well-confirmed the setup is by data the engine already computed. Shared by the
 * informational prediction card and the executable "Active Signals" panel so both
 * ever show the same number for the same signal.
 */
export function SetupQualityBreakdown({ signal, regime }: { signal: Signal; regime: MarketRegime }) {
  const score = scoreSetupQuality(signal, regime);

  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>Setup quality</span>
        <span className="text-zinc-300">{score.total}/100</span>
      </div>
      <div className="mt-1 space-y-1 text-[11px]">
        <ConfirmationRow label="SMC (zone/entry)" value={`${score.smc}/30`} tone="neutral" />
        <ConfirmationRow label="Trend" value={`${score.trend}/20`} tone="neutral" />
        <ConfirmationRow label="Momentum" value={`${score.momentum}/15`} tone="neutral" />
        <ConfirmationRow label="Liquidity" value={`${score.liquidity}/10`} tone="neutral" />
        <ConfirmationRow label="Volatility" value={`${score.volatility}/10`} tone="neutral" />
        <ConfirmationRow label="News risk" value={`${score.newsRisk}/10`} tone="neutral" />
        <ConfirmationRow label="Session" value={`${score.session}/5`} tone="neutral" />
      </div>
    </div>
  );
}
