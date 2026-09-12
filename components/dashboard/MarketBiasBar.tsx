"use client";

/**
 * Signer B's own independent directional confidence (see PairAnalysisResult.marketBias's
 * doc comment in types.ts) -- a deliberately SEPARATE reading from ProbabilityBar's
 * BUY/SELL/NO TRADE bar above it on the same card. That bar answers "did a genuine trade
 * setup qualify" and correctly shows 0%/0%/100% the moment SMC/Range Engine hit a hard
 * gate -- which is most real checks, even during a clearly-trending, clearly-moving
 * market, since neither engine is built to trade a quiet trend continuation (SMC hunts
 * liquidity-sweep reversals; Range Engine only acts in a ranging regime). This bar answers
 * a different, always-attempted question instead: what does the broader trend/momentum/
 * currency-strength/session read lean toward right now, regardless of whether SMC's own
 * additional structural gates ever found anything to act on.
 *
 * Corrected label (2026-09-12): this used to read "context only, not a trade signal",
 * which overclaimed how inert Signer B actually is and contradicted AiConsensusPanel.tsx
 * right next to it on the same dashboard, which has always correctly said Signer B "can
 * block SMC". The real mechanism (see decisionMatrix.ts's combineSigners): Signer B
 * cannot ORIGINATE a trade on its own -- it's only ever evaluated after SMC already found
 * a candidate direction/tier -- but it absolutely CAN veto one, turning a would-be SMC
 * trade into a hard NO_TRADE the moment its independent read is neutral or points the
 * opposite direction. That is a real, decision-altering role, not mere context. Never
 * fabricated either way: "Unavailable" is shown honestly when the same killzone/
 * insufficient-data gates that block the BUY/SELL bar entirely also block this. Mirrors
 * forex-ai-mobile's MarketBiasBar.tsx.
 */
export function MarketBiasBar({
  direction,
  confidence,
}: {
  direction: "long" | "short" | "neutral" | "unavailable";
  confidence: number;
}) {
  if (direction === "unavailable") {
    return (
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="font-bold uppercase tracking-wide text-zinc-500">Market Bias</span>
        <span className="text-zinc-600">Unavailable -- outside the killzone or not enough data yet</span>
      </div>
    );
  }

  const label = direction === "long" ? "BUY" : direction === "short" ? "SELL" : "NEUTRAL";
  const colors =
    direction === "long"
      ? { text: "text-emerald-400", bar: "bg-emerald-500" }
      : direction === "short"
        ? { text: "text-rose-400", bar: "bg-rose-500" }
        : { text: "text-zinc-400", bar: "bg-zinc-500" };
  const pct = direction === "neutral" ? 0 : confidence;

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Market Bias (Signer B -- can block SMC, never fires alone)</span>
        <span className={`text-[11px] font-bold ${colors.text}`}>
          {label} {Math.round(pct)}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${colors.bar}`} style={{ width: `${Math.round(pct)}%` }} />
      </div>
    </div>
  );
}
