"use client";

import { usePolledResource } from "@/lib/hooks/usePolledResource";
import type { CorrelationEntry } from "@/lib/market/rollingCorrelation";

interface CorrelationResponse {
  entries: CorrelationEntry[];
  computedAtAgeMs: number | null;
  threshold: number;
}

const POLL_INTERVAL_MS = 30000;

async function fetchCorrelation(): Promise<CorrelationResponse> {
  const res = await fetch("/api/correlation");
  return res.json();
}

function formatAge(ms: number | null): string {
  if (ms === null) return "not yet computed";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  return `${(minutes / 60).toFixed(1)}h ago`;
}

/**
 * "What's actually correlated right now" -- the real rolling Pearson correlation
 * matrix checkCorrelatedExposure (riskManager.ts) gates trades against, via
 * rollingCorrelation.ts. This is a diagnostic/transparency view only, same posture as
 * SignalDiagnosticsPanel -- it never itself blocks or alters execution, just shows
 * what the real risk gate is already using. Sign matters: positive correlation means
 * two pairs move together (same-direction positions compound risk), negative means
 * they move oppositely (opposite-direction positions compound risk instead).
 */
export function CorrelationPanel() {
  const { data } = usePolledResource<CorrelationResponse>("correlation", fetchCorrelation, POLL_INTERVAL_MS);

  if (!data) return <div className="text-sm text-zinc-500">Loading…</div>;

  if (data.entries.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Not enough daily candle history yet to compute real correlations — the risk gate falls back to the static USD-direction/
        commodity-complex grouping in the meantime (see README).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-zinc-500">
        Computed {formatAge(data.computedAtAgeMs)} from {data.entries[0]?.sampleSize ?? "?"}-day daily returns. Positive
        correlation (same-direction positions compound risk) and negative correlation (opposite-direction positions compound
        risk) both count toward the risk gate once |correlation| ≥ {data.threshold.toFixed(2)} — highlighted below.
      </p>
      <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-900">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/10 text-left text-zinc-500">
              <th className="px-3 py-2 font-medium">Pairs</th>
              <th className="px-3 py-2 font-medium">Correlation</th>
              <th className="px-3 py-2 font-medium">Sample</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => {
              const flagged = Math.abs(entry.correlation) >= data.threshold;
              return (
                <tr key={`${entry.pairA}-${entry.pairB}`} className="border-b border-white/5 last:border-0">
                  <td className="px-3 py-2 font-medium text-zinc-200">
                    {entry.pairA} / {entry.pairB}
                  </td>
                  <td className={`px-3 py-2 tabular-nums ${flagged ? "font-semibold text-amber-400" : "text-zinc-300"}`}>
                    {entry.correlation >= 0 ? "+" : ""}
                    {entry.correlation.toFixed(2)}
                    {flagged && <span className="ml-1.5 text-[10px] font-normal text-amber-500">flagged</span>}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-400">{entry.sampleSize}d</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
