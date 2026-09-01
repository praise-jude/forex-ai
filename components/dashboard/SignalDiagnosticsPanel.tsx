"use client";

import { usePolledResource } from "@/lib/hooks/usePolledResource";
import { PAIRS, type ExecutedTrade, type Pair, type PredictionUpdate, type Signal } from "@/lib/market/types";
import { predictionHeadline, predictionSubline } from "@/lib/market/predictionLabel";
import { describeNoTradeReason, pipelineStages, REGIME_LABEL, type PipelineStage } from "@/lib/market/noTradeReason";
import { DirectionBadge } from "./DirectionBadge";
import { HEADLINE_TONE } from "./PredictionCard";

interface SignalsResponse {
  predictions: PredictionUpdate[];
  signals: Signal[];
  executedTrades: ExecutedTrade[];
}

const POLL_INTERVAL_MS = 10000;

/** The most recently-updated prediction for a pair and a specific engine (source),
 * across whichever of its concurrent timeframes last evaluated -- this panel is a
 * per-pair overview, not a per-timeframe drilldown (PredictionCard.tsx already covers
 * that for the selected pair/timeframe on the main dashboard). Source-aware since two
 * independent engines (SMC, rangeEngine.ts's mean-reversion engine) can both evaluate
 * the same pair without one silently shadowing the other's status. */
function latestForPair(predictions: PredictionUpdate[], pair: Pair, source: PredictionUpdate["source"]): PredictionUpdate | undefined {
  return predictions.filter((p) => p.pair === pair && p.source === source).sort((a, b) => b.time - a.time)[0];
}

const ENGINE_LABEL: Record<"smc" | "mean_reversion", string> = { smc: "SMC", mean_reversion: "Range" };

/** The most recent execution attempt for a signal, if any -- a fired signal with no
 * match here simply hasn't been approved/auto-fired yet (e.g. Confirmation Mode
 * awaiting a click, or ANALYSIS mode where nothing auto-executes). Never fabricated. */
function executionFor(executedTrades: ExecutedTrade[], signalId: string): ExecutedTrade | undefined {
  return executedTrades.filter((t) => t.signalId === signalId).sort((a, b) => b.attemptedAt - a.attemptedAt)[0];
}

const STAGE_DOT: Record<PipelineStage["status"], string> = {
  pass: "bg-emerald-400",
  fail: "bg-rose-400",
  not_reached: "bg-zinc-600",
};
const STAGE_TEXT: Record<PipelineStage["status"], string> = {
  pass: "text-emerald-400",
  fail: "text-rose-400",
  not_reached: "text-zinc-600",
};

/** The stage-by-stage PASS/FAIL/NOT-REACHED breakdown behind the single-sentence
 * `describeNoTradeReason` text above it -- built from the exact same evaluation, just
 * showing which gates a candidate actually cleared before the one that held it, instead
 * of only the final blocking reason. See noTradeReason.ts's pipelineStages doc comment. */
function PipelineStrip({ stages }: { stages: PipelineStage[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      {stages.map((stage) => (
        <span key={stage.label} className={`flex items-center gap-1 text-[10px] ${STAGE_TEXT[stage.status]}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${STAGE_DOT[stage.status]}`} />
          {stage.label}
        </span>
      ))}
    </div>
  );
}

function ExecutionStatus({ trade }: { trade: ExecutedTrade | undefined }) {
  if (!trade) {
    return <span className="text-[11px] text-zinc-500">Not executed -- awaiting approval or a mode that auto-executes.</span>;
  }
  if (trade.status === "filled") {
    return <span className="text-[11px] text-emerald-400">✓ Executed -- filled @ {trade.filledEntry} ({trade.account})</span>;
  }
  if (trade.status === "rejected") {
    return <span className="text-[11px] text-rose-400">✗ Execution rejected -- {trade.rejectReason}</span>;
  }
  return <span className="text-[11px] text-amber-400">… Execution pending ({trade.account})</span>;
}

/**
 * All-pairs "why did/didn't AutoPilot trade" overview -- built entirely from data the
 * engine already computes (describeNoTradeReason, predictionHeadline) and /api/signals,
 * which already joins predictions/signals/executedTrades. Nothing new is invented here;
 * this only surfaces what already exists in one scannable place.
 */
function EngineRow({ pair, source, data }: { pair: Pair; source: "smc" | "mean_reversion"; data: SignalsResponse }) {
  const update = latestForPair(data.predictions, pair, source);
  if (!update) {
    return (
      <div className="rounded-lg border border-white/10 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-500">
        <span className="w-14 shrink-0 text-[11px] font-medium text-zinc-400">{ENGINE_LABEL[source]}</span> — evaluating…
      </div>
    );
  }

  const evaluation = update.evaluation;
  const headline = predictionHeadline(evaluation);
  const subline = predictionSubline(evaluation);
  const signal = evaluation.status === "signal" ? evaluation.signal : null;
  const trade = signal ? executionFor(data.executedTrades, signal.id) : undefined;

  return (
    <div className="rounded-lg border border-white/10 bg-zinc-800/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 shrink-0 text-[11px] font-medium text-zinc-400">{ENGINE_LABEL[source]}</span>
        <DirectionBadge tone={HEADLINE_TONE[headline]} label={headline} className="text-xs" />
        <span className="rounded-full bg-zinc-700/60 px-2 py-0.5 text-[11px] text-zinc-400">{REGIME_LABEL[update.regime]}</span>
        {signal && <span className="text-[11px] text-zinc-500">{signal.confidence.toFixed(0)}% confidence</span>}
      </div>
      {subline && <p className="mt-1 text-xs text-zinc-400">{subline}</p>}
      <p className="mt-1 text-xs text-zinc-400">
        {signal
          ? `Qualifying ${signal.tier.replace("_", " ")} setup on ${signal.timeframe}.`
          : evaluation.status === "no_trade"
            ? describeNoTradeReason(evaluation.reason, update.regime)
            : null}
      </p>
      <PipelineStrip stages={pipelineStages(evaluation, source)} />
      {signal && (
        <div className="mt-1">
          <ExecutionStatus trade={trade} />
        </div>
      )}
    </div>
  );
}

export function SignalDiagnosticsPanel() {
  const { data } = usePolledResource<SignalsResponse>(
    "signals",
    () => fetch("/api/signals").then((res) => res.json()),
    POLL_INTERVAL_MS
  );

  if (!data) return <div className="text-sm text-zinc-500">Loading…</div>;

  return (
    <div className="flex flex-col gap-3">
      {PAIRS.map((pair) => (
        <div key={pair} className="flex flex-col gap-1">
          <span className="font-semibold text-zinc-200">{pair}</span>
          <EngineRow pair={pair} source="smc" data={data} />
          <EngineRow pair={pair} source="mean_reversion" data={data} />
        </div>
      ))}
    </div>
  );
}
