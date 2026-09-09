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
 * Never a trade signal on its own -- Signer B alone cannot execute anything (see
 * decisionMatrix.ts) -- and never fabricated: "Unavailable" is shown honestly when the
 * same killzone/insufficient-data gates that block the BUY/SELL bar entirely also block
 * this. Mirrors forex-ai-mobile's MarketBiasBar.tsx.
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
        <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Market Bias (Signer B -- context only, not a trade signal)</span>
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
