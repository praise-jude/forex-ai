"use client";

import { memo, useMemo } from "react";
import type { PredictionUpdate, Signal } from "@/lib/market/types";
import { computeAutopilotStatus, type PipelineHealth } from "@/lib/market/autopilotStatus";

const HEALTH_DOT: Record<PipelineHealth, string> = {
  fresh: "bg-emerald-400",
  stale: "bg-amber-400",
  unknown: "bg-zinc-600",
};

const HEALTH_LABEL: Record<PipelineHealth, string> = {
  fresh: "Analyzing",
  stale: "No analysis in 20+ minutes -- check the connection",
  unknown: "Waiting for first analysis",
};

function relativeTime(fromMs: number): string {
  const seconds = Math.round((Date.now() - fromMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-zinc-800/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-0.5 text-base font-semibold tabular-nums text-zinc-100">{value}</p>
    </div>
  );
}

/**
 * Answers "is the AI actually running, or just quiet" without needing to check the API
 * by hand -- every number here is a real derivation from live predictionStore/
 * signalStore data (see autopilotStatus.ts), not a decorative always-green indicator.
 * pipelineHealth in particular only reads "stale" when analysis has genuinely stopped
 * updating, so it can't misrepresent a working-but-selective engine as broken.
 */
// Memoized so a Dashboard re-render from an unrelated SSE event (e.g. a price tick,
// which touches neither `predictions` nor `signals`) doesn't redo computeAutopilotStatus.
export const AutopilotStatus = memo(function AutopilotStatus({
  predictions,
  signals,
  marketsMonitored,
}: {
  predictions: PredictionUpdate[];
  signals: Signal[];
  marketsMonitored: number;
}) {
  const status = useMemo(
    () => computeAutopilotStatus(predictions, signals, marketsMonitored),
    [predictions, signals, marketsMonitored]
  );

  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Autopilot</h2>
        <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <span className={`h-1.5 w-1.5 rounded-full ${HEALTH_DOT[status.pipelineHealth]}`} aria-hidden="true" />
          {status.lastAnalysisAt ? `${HEALTH_LABEL[status.pipelineHealth]} -- last analysis ${relativeTime(status.lastAnalysisAt)}` : HEALTH_LABEL[status.pipelineHealth]}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Markets monitored" value={String(status.marketsMonitored)} />
        <StatTile label="Active signals" value={String(status.activeSignals)} />
        <StatTile label="Waiting setups" value={String(status.waitingSetups)} />
        <StatTile label="Blocked by news" value={String(status.blockedByNews)} />
      </div>
    </section>
  );
});
