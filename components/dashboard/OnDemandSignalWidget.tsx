"use client";

import { useEffect, useState } from "react";
import { PAIRS, type Pair, type PredictionUpdate, type Timeframe } from "@/lib/market/types";
import { executeSignalRequest, type ExecuteResponse } from "@/lib/market/executionClient";
import { describeExecuteResponse } from "./TradeProposalCard";
import { buildConfirmPhrase } from "@/lib/voice/grammar";
import { PredictionCard } from "./PredictionCard";
import { TimeframeSelector } from "./TimeframeSelector";

/**
 * Pick any tracked pair, press Analyze, get the real SMC engine's current read for it
 * right now -- for when the operator wants a one-off answer on a specific pair instead
 * of waiting for the next candle close on the main chart. Runs the exact same engine
 * (via /api/signals/evaluate) against the same live candle data; nothing here is a
 * separate or simplified analysis.
 */
export function OnDemandSignalWidget() {
  const [pair, setPair] = useState<Pair>(PAIRS[0]);
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [result, setResult] = useState<PredictionUpdate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const analyze = async () => {
    setLoading(true);
    setError(null);
    setPlaceResult(null);
    try {
      const response = await fetch(`/api/signals/evaluate?pair=${encodeURIComponent(pair)}&timeframe=${timeframe}`);
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? body.error ?? "Couldn't analyze that pair right now.");
        setResult(null);
        return;
      }
      setResult(body as PredictionUpdate);
    } catch {
      setError("Couldn't reach the server -- check your connection and try again.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  // Registers this on-demand read as a real, tracked signal (journaled, notified --
  // exactly like one the live engine detects on its own) and then executes it through
  // the exact same /api/signals/{id}/execute route every other signal uses, including
  // every one of its risk checks (daily loss, correlation, price drift, spread,
  // sizing). No shortcut execution path exists here -- this only adds the "register an
  // on-demand read" step in front of the same execution the rest of the app already has.
  const placeTrade = async () => {
    if (!result || result.evaluation.status !== "signal") return;
    const signal = result.evaluation.signal;
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

  const canPlaceTrade = result?.evaluation.status === "signal" && !placeResult;

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
          disabled={loading}
          className="rounded-lg bg-sky-500/15 px-3 py-1.5 text-sm font-semibold text-sky-400 transition hover:bg-sky-500/25 disabled:opacity-50"
        >
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </div>

      {error && <p className="mt-2.5 text-xs font-semibold text-amber-400">{error}</p>}
      {result && (
        <div className="mt-2.5">
          <PredictionCard update={result} />
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
              onChange={(e) => setRiskPct(Number(e.target.value) || riskPct)}
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
