"use client";

import { usePolledResource } from "@/lib/hooks/usePolledResource";
import type { CorrelationEntry } from "@/lib/market/rollingCorrelation";

interface CorrelationResponse {
  entries: CorrelationEntry[];
  computedAtAgeMs: number | null;
  threshold: number;
  strongThreshold: number;
  extremeThreshold: number;
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

/** Mirrors rollingCorrelation.ts's own tierForMagnitude -- a diagnostic-only re-read of
 * the exact same bands checkCorrelatedExposure (riskManager.ts) sizes trades against,
 * not a second source of truth (the actual gate always computes its own tier from live
 * open positions, this just labels each matrix row for display). */
function tierLabel(magnitude: number, thresholds: { strong: number; extreme: number; base: number }): { label: string; className: string } | null {
  if (magnitude >= thresholds.extreme) return { label: "extreme — new trades blocked", className: "text-rose-400" };
  if (magnitude >= thresholds.strong) return { label: "strong — size cut to 60%", className: "text-orange-400" };
  if (magnitude >= thresholds.base) return { label: "moderate — size cut to 70%", className: "text-amber-400" };
  return null;
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

  const thresholds = { base: data.threshold, strong: data.strongThreshold, extreme: data.extremeThreshold };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-zinc-500">
        Computed {formatAge(data.computedAtAgeMs)} from {data.entries[0]?.sampleSize ?? "?"}-day daily returns. Positive
        correlation (same-direction positions compound risk) and negative correlation (opposite-direction positions compound
        risk) both count toward the risk gate. This isn&apos;t a flat block anymore — a correlated new position gets its size
        reduced in proportion to how strong the correlation is ({data.threshold.toFixed(2)}–{data.strongThreshold.toFixed(2)}:
        70% size, {data.strongThreshold.toFixed(2)}–{data.extremeThreshold.toFixed(2)}: 60% size), and is only blocked outright
        at {data.extremeThreshold.toFixed(2)}+ — highlighted below.
      </p>
      <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-900">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/10 text-left text-zinc-500">
              <th className="px-3 py-2 font-medium">Pairs</th>
              <th className="px-3 py-2 font-medium">Correlation</th>
              <th className="px-3 py-2 font-medium">Sample</th>
              <th className="px-3 py-2 font-medium">Risk gate</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => {
              const tier = tierLabel(Math.abs(entry.correlation), thresholds);
              return (
                <tr key={`${entry.pairA}-${entry.pairB}`} className="border-b border-white/5 last:border-0">
                  <td className="px-3 py-2 font-medium text-zinc-200">
                    {entry.pairA} / {entry.pairB}
                  </td>
                  <td className={`px-3 py-2 tabular-nums ${tier ? "font-semibold " + tier.className : "text-zinc-300"}`}>
                    {entry.correlation >= 0 ? "+" : ""}
                    {entry.correlation.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-400">{entry.sampleSize}d</td>
                  <td className={`px-3 py-2 text-[11px] ${tier ? tier.className : "text-zinc-600"}`}>{tier ? tier.label : "normal size"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
