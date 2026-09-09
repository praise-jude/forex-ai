"use client";

/**
 * SMC's own genuine progress toward a real setup (see PairAnalysisResult.smcSetupProgress's
 * doc comment in types.ts) -- operator request, 2026-09-09, after Market Bias (Signer B's
 * reading) shipped with a real percentage while SMC's own "how close" info stayed buried
 * in prose text ("ADX 19.9, needs 20+"). `pct` is null (never fabricated) for a reason
 * with no natural continuous ratio -- rendered as label-only, no bar, in that case.
 */
export function SmcSetupProgressBar({ pct, label }: { pct: number | null; label: string }) {
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">SMC Setup Progress</span>
        <span className="text-[11px] font-bold text-sky-400">{pct === null ? label : `${label} (${Math.round(pct)}%)`}</span>
      </div>
      {pct !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.round(pct)}%` }} />
        </div>
      )}
    </div>
  );
}
