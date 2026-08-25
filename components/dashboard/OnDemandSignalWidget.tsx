"use client";

import { useState } from "react";
import { PAIRS, type Pair, type PredictionUpdate, type Timeframe } from "@/lib/market/types";
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

  const analyze = async () => {
    setLoading(true);
    setError(null);
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
    </div>
  );
}
