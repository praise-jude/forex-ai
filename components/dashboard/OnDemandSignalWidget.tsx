"use client";

import { useEffect, useState } from "react";
import { PAIRS, type AnalysisJob, type Pair, type PairAnalysisResult, type PredictionUpdate, type StreamEvent, type Timeframe } from "@/lib/market/types";
import { executeSignalRequest, type ExecuteResponse } from "@/lib/market/executionClient";
import { describeExecuteResponse } from "./TradeProposalCard";
import { buildConfirmPhrase } from "@/lib/voice/grammar";
import { TimeframeSelector } from "./TimeframeSelector";
import { PriceChart } from "./PriceChart";
import { AnalysisProgressScreen } from "./AnalysisProgressScreen";
import { AnalysisResultCard, qualifyingSignal } from "./AnalysisResultCard";
import { SignalWeakeningMonitor } from "./SignalWeakeningMonitor";

/**
 * Pick any tracked pair, press Analyze Trade, and watch a real, multi-stage analysis
 * job (see lib/market/pairAnalysisJob.ts) run through market data -> structure -> SMC
 * -> Range Engine -> multi-timeframe -> consensus -> risk validation -> final decision,
 * every stage/percentage tied to genuine computation -- for when the operator wants a
 * one-off answer on a specific pair instead of waiting for the next candle close on the
 * main chart. A qualifying result can then be placed as a real trade via the same
 * publish-then-execute flow the rest of the app uses -- no separate execution path, and
 * nothing here can itself place an order (see pairAnalysisJob.ts's own Auto Pilot
 * boundary doc comment).
 */
interface OnDemandSignalWidgetProps {
  /** The main dashboard's live SSE stream, threaded through purely so this widget's own
   * embedded chart (see below) can tick live too, same as the main chart -- optional,
   * and PriceChart already no-ops cleanly on a null/mismatched-pair event, so this
   * widget works fine standalone (e.g. in a future page without the main dashboard's
   * stream) without a caller ever having to supply it. */
  streamEvent?: StreamEvent | null;
}

export function OnDemandSignalWidget({ streamEvent = null }: OnDemandSignalWidgetProps) {
  const [pair, setPair] = useState<Pair>(PAIRS[0]);
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<PairAnalysisResult | null>(null);
  const [failedJob, setFailedJob] = useState<AnalysisJob | null>(null);
  const [invalidated, setInvalidated] = useState(false);

  const [riskPct, setRiskPct] = useState(1);
  const [placing, setPlacing] = useState(false);
  const [placeResult, setPlaceResult] = useState<ExecuteResponse | null>(null);

  // Same default source Dashboard.tsx itself reads for a manual click -- so a risk %
  // typed here matches whatever the account is actually configured to risk per trade.
  useEffect(() => {
    fetch("/api/engine-mode")
      .then((res) => res.json())
      .then((body) => {
        if (typeof body?.riskPerTradePct === "number") setRiskPct(body.riskPerTradePct);
      })
      .catch(() => {});
  }, []);

  function analyze() {
    setResult(null);
    setFailedJob(null);
    setPlaceResult(null);
    setInvalidated(false);
    setAnalyzing(true);
  }

  // Registers this on-demand read as a real, tracked signal (journaled, notified --
  // exactly like one the live engine detects on its own) and then executes it through
  // the exact same /api/signals/{id}/execute route every other signal uses, including
  // every one of its risk checks (daily loss, correlation, price drift, spread,
  // sizing). No shortcut execution path exists here -- this only adds the "register an
  // on-demand read" step in front of the same execution the rest of the app already has.
  const placeTrade = async () => {
    if (!result) return;
    const signal = qualifyingSignal(result);
    if (!signal) return;
    setPlacing(true);
    setPlaceResult(null);
    try {
      const publishRes = await fetch("/api/signals/evaluate/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal, regime: result.regime }),
      });
      if (!publishRes.ok) {
        setPlaceResult({ status: "network_error" });
        return;
      }
      const execResult = await executeSignalRequest(signal.id, buildConfirmPhrase(signal), riskPct);
      setPlaceResult(execResult);
    } catch {
      setPlaceResult({ status: "network_error" });
    } finally {
      setPlacing(false);
    }
  };

  const qualified = result ? qualifyingSignal(result) : null;
  const canPlaceTrade = qualified !== null && !invalidated && !placeResult;

  // PriceChart's forecast overlay (real entry/SL/TP lines, dotted projected path on a
  // qualifying signal) expects the older single-direction PredictionUpdate shape --
  // this just re-packages PairAnalysisResult's own already-real fields into that shape
  // (the winning side's real SignalEvaluation, the real regime, the real D1/H4/H1
  // slice of the 5-rung timeframe ladder) rather than computing anything new.
  const chartPrediction: PredictionUpdate | null = result
    ? {
        pair: result.pair,
        timeframe: result.timeframe,
        source: "smc",
        evaluation:
          (result.direction === "long" ? result.bullish : result.direction === "short" ? result.bearish : null) ??
          { status: "no_trade", reason: { code: "no_setup" } },
        time: result.time,
        regime: result.regime,
        trends: {
          d1: result.timeframeTrends.d1,
          h4: result.timeframeTrends.h4,
          h1: result.timeframeTrends.h1,
          d1Gap: null,
          h4Gap: null,
          h1Gap: null,
        },
      }
    : null;

  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Check a pair</h2>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={pair}
          onChange={(e) => setPair(e.target.value as Pair)}
          className="rounded-lg border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100"
        >
          {PAIRS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <TimeframeSelector value={timeframe} onChange={setTimeframe} />
        <button
          type="button"
          onClick={analyze}
          disabled={analyzing}
          className="rounded-lg bg-sky-500/15 px-3 py-1.5 text-sm font-semibold text-sky-400 transition hover:bg-sky-500/25 disabled:opacity-50"
        >
          {analyzing ? "Analyzing…" : "Analyze Trade"}
        </button>
      </div>

      {analyzing && (
        <div className="mt-2.5 rounded-lg border border-white/10 bg-zinc-800/60">
          <AnalysisProgressScreen
            pair={pair}
            timeframe={timeframe}
            onComplete={(job) => {
              setResult(job.result as PairAnalysisResult);
              setAnalyzing(false);
            }}
            onFailed={(job) => {
              setFailedJob(job);
              setAnalyzing(false);
            }}
          />
        </div>
      )}

      {failedJob && (
        <div className="mt-2.5 flex flex-col gap-1 rounded-lg border border-white/10 bg-zinc-800/60 p-3">
          <p className="text-sm font-extrabold text-rose-400">{failedJob.failReason === "stale_data" ? "STALE MARKET DATA" : "ANALYSIS FAILED"}</p>
          <p className="text-xs font-semibold text-amber-400">{failedJob.failMessage}</p>
        </div>
      )}

      {result && (
        <div className="mt-2.5">
          <div className="rounded-lg border border-white/10 bg-zinc-800/60 p-3">
            <AnalysisResultCard result={result} />
          </div>
          {qualified && (result.direction === "long" || result.direction === "short") && (
            <SignalWeakeningMonitor
              pair={pair}
              timeframe={timeframe}
              direction={result.direction}
              originalConfidence={qualified.confidence}
              onLevelChange={(level) => setInvalidated(level === "invalidated")}
            />
          )}
          {/* Same PriceChart the main dashboard uses -- draws the real entry/SL/TP
              price lines and, on a qualifying signal, the dotted "where it's projected
              to end up" forecast path to TP1/TP2, against this pair's actual candles.
              Nothing chart-specific is computed here; it's fed a real projection of
              this widget's own on-demand result (see chartPrediction above). */}
          <div className="mt-2.5 h-80 overflow-hidden rounded-lg border border-white/10">
            <PriceChart pair={pair} timeframe={timeframe} streamEvent={streamEvent} prediction={chartPrediction} />
          </div>
        </div>
      )}

      {canPlaceTrade && (
        <div className="mt-2.5 flex items-center gap-2 border-t border-white/10 pt-2.5">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            Risk
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={riskPct}
              onChange={(e) => {
                // Number(value) || riskPct previously discarded "0" (falsy) and reverted
                // to the stale value instead of accepting it -- Number.isFinite lets a
                // real 0% through while still rejecting non-numeric input.
                const parsed = Number(e.target.value);
                if (Number.isFinite(parsed)) setRiskPct(parsed);
              }}
              className="w-16 rounded border border-white/10 bg-zinc-800 px-1.5 py-1 text-zinc-100 outline-none focus:border-sky-500"
            />
            <span>% of equity</span>
          </label>
          <button
            type="button"
            onClick={placeTrade}
            disabled={placing}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {placing ? "Placing order…" : "🟢 Place Trade"}
          </button>
        </div>
      )}

      {placeResult && <p className="mt-2 text-xs font-semibold text-zinc-300">{describeExecuteResponse(placeResult)}</p>}
    </div>
  );
}
