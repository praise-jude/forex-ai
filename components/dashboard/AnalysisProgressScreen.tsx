"use client";

import { useEffect, useState } from "react";
import type { AnalysisJob, AnalysisStage, Pair, Timeframe } from "@/lib/market/types";
import { usePolledResource } from "@/lib/hooks/usePolledResource";
import { ProbabilityBar } from "./ProbabilityBar";

const POLL_INTERVAL_MS = 200;

/** Single source of truth for "how far through is stage X" -- lib/market/pairAnalysisJob.ts's
 * own ANALYSIS_STAGE_PCT export. Duplicated here (not imported) since this is a client
 * component and that module pulls in server-only dependencies (candleStore, MetaApi
 * connection state, etc.) that can't be bundled for the browser -- kept in sync by hand. */
const STAGE_PCT: Record<AnalysisStage, number> = {
  market_data: 15,
  structure: 30,
  smc_engine: 45,
  range_engine: 60,
  multi_timeframe: 75,
  consensus: 85,
  risk_validation: 95,
  final: 100,
};

const STAGE_LABEL: Record<AnalysisStage, string> = {
  market_data: "Loading Market Data",
  structure: "Reading Market Structure",
  smc_engine: "Running SMC Engine",
  range_engine: "Running Range Engine",
  multi_timeframe: "Multi-Timeframe Analysis",
  consensus: "AI Consensus",
  risk_validation: "Risk & Trade Validation",
  final: "Final Decision",
};

const STAGE_DETAIL: Record<AnalysisStage, string> = {
  market_data: "Price, spread, candles, data freshness",
  structure: "Swings, liquidity sweeps, BOS/CHoCH",
  smc_engine: "Order blocks, fair value gaps, Signer A score",
  range_engine: "Trending vs. ranging vs. breakout",
  multi_timeframe: "15M · 30M · 1H · 4H · 1D agreement",
  consensus: "Combining every engine's real verdict",
  risk_validation: "Spread, drift, correlation, policy",
  final: "Locking in the validated result",
};

/** Mirrors forex-ai-mobile's AnalysisProgressScreen.tsx. Every stage/percentage is
 * driven by the real job's own `stage` field (see pairAnalysisJob.ts) -- never a
 * client-side timer. */
export function AnalysisProgressScreen({
  pair,
  timeframe,
  onComplete,
  onFailed,
}: {
  pair: Pair;
  timeframe: Timeframe;
  onComplete: (job: AnalysisJob) => void;
  onFailed: (job: AnalysisJob) => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  // Fired once on mount -- pair/timeframe are fixed for the lifetime of this component;
  // a different pair/timeframe means a new component instance (see OnDemandSignalWidget.tsx).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/signals/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pair, timeframe }),
    })
      .then((res) => res.json())
      .then((body: { jobId?: string; message?: string }) => {
        if (cancelled) return;
        if (body.jobId) setJobId(body.jobId);
        else setStartError(body.message ?? "Couldn't start analysis.");
      })
      .catch(() => {
        if (!cancelled) setStartError("Couldn't reach the server -- check your connection and try again.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: job } = usePolledResource<AnalysisJob>(
    jobId ? `analyze:${jobId}` : "analyze:pending",
    () => (jobId ? fetch(`/api/signals/analyze/${jobId}`).then((res) => res.json()) : Promise.resolve(null as unknown as AnalysisJob)),
    POLL_INTERVAL_MS
  );

  if (job?.status === "complete") {
    onComplete(job);
    return null;
  }
  if (job?.status === "failed") {
    onFailed(job);
    return null;
  }

  if (startError) {
    return (
      <div className="flex flex-col items-center gap-2 p-5 text-center">
        <p className="text-sm font-bold text-rose-400">ANALYSIS FAILED</p>
        <p className="text-xs text-zinc-400">{startError}</p>
      </div>
    );
  }

  const stage = job?.stage ?? "market_data";
  const pct = STAGE_PCT[stage];
  const result = job?.result;

  return (
    <div className="flex flex-col items-center gap-2.5 p-5">
      <p className="text-sm font-extrabold tracking-wide text-zinc-100">AI ANALYZING {pair}</p>

      <div className="my-2 flex h-28 w-28 items-center justify-center rounded-full border-[6px] border-sky-500">
        <span className="text-2xl font-extrabold text-sky-400">{pct}%</span>
      </div>

      <p className="text-base font-bold text-zinc-100">{STAGE_LABEL[stage]}</p>
      <p className="text-center text-xs text-zinc-500">{STAGE_DETAIL[stage]}</p>

      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
      </div>

      {/* Live-updating, never a client-side guess -- only appears once the real
       * "consensus" stage has actually finished computing these fields (see
       * pairAnalysisJob.ts's incremental result-building). */}
      {result?.buyPct !== undefined && result.sellPct !== undefined && result.noTradePct !== undefined && (
        <div className="mt-3.5 flex w-full flex-col gap-1.5">
          <p className="text-center text-[11px] font-bold text-zinc-500">ANALYZING... {pct}%</p>
          <ProbabilityBar buyPct={result.buyPct} sellPct={result.sellPct} noTradePct={result.noTradePct} compact />
        </div>
      )}
    </div>
  );
}
