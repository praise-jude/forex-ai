"use client";

/**
 * The real 3-way BUY/SELL/NO-TRADE distribution from a PairAnalysisResult (see
 * pairAnalysisJob.ts's normalizeDirectionalPercentages -- always sums to 100, every
 * input a real Signer A score, never independently invented). BUY=emerald,
 * SELL=rose, NO TRADE=zinc, matching this app's existing tone convention
 * (DirectionBadge.tsx). `compact` drops the row labels for the in-progress mini
 * readout (AnalysisProgressScreen); the full result card uses the non-compact form.
 * Mirrors forex-ai-mobile's ProbabilityBar.tsx.
 */
export function ProbabilityBar({
  buyPct,
  sellPct,
  noTradePct,
  compact = false,
}: {
  buyPct: number;
  sellPct: number;
  noTradePct: number;
  compact?: boolean;
}) {
  const rows = [
    { key: "buy", label: "BUY", pct: buyPct, text: "text-emerald-400", bar: "bg-emerald-500" },
    { key: "sell", label: "SELL", pct: sellPct, text: "text-rose-400", bar: "bg-rose-500" },
    { key: "no_trade", label: "NO TRADE", pct: noTradePct, text: "text-zinc-500", bar: "bg-zinc-500" },
  ];

  return (
    <div className="flex w-full flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          {!compact && <span className={`w-16 text-[11px] font-bold ${row.text}`}>{row.label}</span>}
          <div className={`flex-1 overflow-hidden rounded-full bg-zinc-800 ${compact ? "h-1.5" : "h-2.5"}`}>
            <div className={`h-full rounded-full ${row.bar}`} style={{ width: `${Math.round(row.pct)}%` }} />
          </div>
          <span className={`w-9 text-right text-[11px] font-bold ${row.text}`}>{Math.round(row.pct)}%</span>
        </div>
      ))}
    </div>
  );
}
