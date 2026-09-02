"use client";

import { useEffect, useState } from "react";
import { PAIRS, type Pair, type Signal, type StreamEvent } from "@/lib/market/types";
import { executeSignalRequest, type ExecuteResponse } from "@/lib/market/executionClient";
import { buildConfirmPhrase } from "@/lib/voice/grammar";
import { decimals } from "@/lib/market/symbols";
import { describeManualTradePlan } from "@/lib/market/manualTradeSuggestion";
import { describeExecuteResponse } from "./TradeProposalCard";
import { PriceChart } from "./PriceChart";

interface ManualSignalResponse {
  signal?: Signal;
  error?: string;
}

interface SuggestResponse {
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  error?: string;
}

interface ManualTradeWidgetProps {
  /** Same live SSE stream the main dashboard chart uses -- purely so this widget's own
   * embedded chart ticks live too. Optional; the chart still shows real (just not
   * live-updating) candles without it. */
  streamEvent?: StreamEvent | null;
  /** The shared voice assistant's own onSignal (see useVoiceAssistant.ts) -- feeding a
   * hand-built manual signal through it puts it through the exact same announce ->
   * pending -> confirm flow (voice "yes"/exact phrase, or VoiceAssistantPanel's own
   * Confirm button) a live-detected SMC/range signal already gets, instead of building
   * a second, parallel confirm mechanism. Only used while voice mode is actually on (see
   * placeTrade) -- with it off, this widget falls back to executing directly on click,
   * same as before voice support existed here. Optional so this widget still works
   * standalone (e.g. a future page without the voice assistant mounted at all). */
  onSignal?: (signal: Signal) => void;
  /** Whether voice mode is currently off -- see onSignal's own doc comment for why this
   * decides which of the two placeTrade paths runs. */
  voiceModeOff?: boolean;
}

/**
 * A trade the operator builds entirely by hand -- pair, direction, stop-loss, take-profit
 * -- independent of whether the SMC/range engines currently see a qualifying setup.
 * Two-step, same as every other manual execution path in this app: this only registers
 * the hand-entered trade as a real signal (via /api/signals/manual), then executes it
 * through the exact same /api/signals/{id}/execute route (and all its risk checks --
 * sizing, correlation, daily-loss, spread, price-drift) every other signal uses. Fills as
 * a market order at whatever the price is when Place Trade is clicked -- this app has no
 * limit-order concept, so there's no "entry" field here to fill in, only SL/TP.
 */
export function ManualTradeWidget({ streamEvent = null, onSignal, voiceModeOff = true }: ManualTradeWidgetProps) {
  const [pair, setPair] = useState<Pair>(PAIRS[0]);
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [entry, setEntry] = useState<number | null>(null);
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [riskPct, setRiskPct] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placeResult, setPlaceResult] = useState<ExecuteResponse | null>(null);

  // Same default source OnDemandSignalWidget/Dashboard.tsx already read -- a risk % typed
  // here matches whatever the account is actually configured to risk per trade.
  useEffect(() => {
    fetch("/api/engine-mode")
      .then((res) => res.json())
      .then((body) => {
        if (typeof body?.riskPerTradePct === "number") setRiskPct(body.riskPerTradePct);
      })
      .catch(() => {});
  }, []);

  // Auto-fills a starting stop-loss/take-profit from this pair's own real recent
  // volatility (see manualTradeSuggestion.ts) whenever the pair or direction changes --
  // the operator's job is then just to glance at it and click Buy/Sell, not compute
  // levels from scratch, though both fields below stay ordinary editable inputs if they
  // want something different. Never overwrites a value while the request is in flight
  // for a pair/direction combo that's already been superseded (the `cancelled` guard) --
  // switching pairs quickly must not have an older suggestion land after a newer one.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/signals/manual/suggest?pair=${encodeURIComponent(pair)}&direction=${direction}`)
      .then((res) => res.json())
      .then((body: SuggestResponse) => {
        if (cancelled) return;
        if (typeof body.entry === "number") setEntry(body.entry);
        if (typeof body.stopLoss === "number" && typeof body.takeProfit === "number") {
          const dp = decimals(pair);
          setStopLoss(body.stopLoss.toFixed(dp));
          setTakeProfit(body.takeProfit.toFixed(dp));
        }
      })
      .catch(() => {
        // Best-effort -- the operator can still type their own levels if this fails.
      });
    return () => {
      cancelled = true;
    };
  }, [pair, direction]);

  const placeTrade = async () => {
    setError(null);
    setPlaceResult(null);
    const stopLossNum = Number(stopLoss);
    const takeProfitNum = Number(takeProfit);
    if (!stopLoss || !Number.isFinite(stopLossNum)) {
      setError("Enter a stop-loss price.");
      return;
    }
    if (!takeProfit || !Number.isFinite(takeProfitNum)) {
      setError("Enter a take-profit price.");
      return;
    }

    setSubmitting(true);
    try {
      const buildRes = await fetch("/api/signals/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair, direction, stopLoss: stopLossNum, takeProfit: takeProfitNum }),
      });
      const body = (await buildRes.json()) as ManualSignalResponse;
      if (!buildRes.ok || !body.signal) {
        setError(body.error ?? "Couldn't place that trade.");
        return;
      }

      // Voice on: hand it to the shared voice assistant instead of executing directly --
      // it announces the trade and waits for "yes"/the exact confirm phrase (or a click
      // on VoiceAssistantPanel's own Confirm button), the same two-step flow every
      // algorithm-detected signal already goes through. Voice off: unchanged, immediate
      // one-click execution (see onSignal's own doc comment).
      if (!voiceModeOff && onSignal) {
        onSignal(body.signal);
        setPlaceResult(null);
      } else {
        const execResult = await executeSignalRequest(body.signal.id, buildConfirmPhrase(body.signal), riskPct);
        setPlaceResult(execResult);
        if (execResult.status === "filled") {
          setStopLoss("");
          setTakeProfit("");
        }
      }
    } catch {
      setError("Couldn't reach the server -- check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Manual trade</h2>
      <p className="mb-2.5 text-xs text-zinc-500">
        Place a trade you decide on yourself, whether or not the AI currently sees a qualifying setup. Pick a pair and Buy/Sell --
        the AI fills in a suggested stop-loss and take-profit for you (based on this pair&rsquo;s own recent volatility), which you
        can leave as-is or edit before placing. Fills at the current market price; still goes through every safety check (daily
        loss limit, correlation, spread, sizing) a signal-based trade does.
      </p>

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
        <div className="flex overflow-hidden rounded-lg border border-white/10">
          <button
            type="button"
            onClick={() => setDirection("long")}
            className={`px-3 py-1.5 text-sm font-semibold transition ${
              direction === "long" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => setDirection("short")}
            className={`px-3 py-1.5 text-sm font-semibold transition ${
              direction === "short" ? "bg-rose-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Sell
          </button>
        </div>
      </div>

      <div className="mt-2.5 h-64 overflow-hidden rounded-lg border border-white/10">
        <PriceChart pair={pair} timeframe="15m" streamEvent={streamEvent} prediction={null} />
      </div>

      {/* The plain-language "just look and click" summary -- recomputed live from
          whatever's actually in the fields below (the AI's own suggestion by default,
          or the operator's own edit), so it never describes a plan that's out of sync
          with what Place Buy/Sell would actually submit. */}
      {entry !== null && Number.isFinite(Number(stopLoss)) && Number.isFinite(Number(takeProfit)) ? (
        <p className="mt-2.5 rounded-lg border border-sky-800/60 bg-sky-950/30 px-3 py-2 text-sm text-sky-200">
          {describeManualTradePlan(pair, direction, entry, Number(stopLoss), Number(takeProfit))}
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-zinc-500">
          Stop-loss and take-profit below are AI-suggested from this pair’s recent volatility -- review or edit before placing.
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Stop-loss
          <input
            type="number"
            step="any"
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
            placeholder="price"
            className="w-28 rounded border border-white/10 bg-zinc-800 px-1.5 py-1 text-zinc-100 outline-none focus:border-sky-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Take-profit
          <input
            type="number"
            step="any"
            value={takeProfit}
            onChange={(e) => setTakeProfit(e.target.value)}
            placeholder="price"
            className="w-28 rounded border border-white/10 bg-zinc-800 px-1.5 py-1 text-zinc-100 outline-none focus:border-sky-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Risk
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={riskPct}
              onChange={(e) => setRiskPct(Number(e.target.value) || riskPct)}
              className="w-16 rounded border border-white/10 bg-zinc-800 px-1.5 py-1 text-zinc-100 outline-none focus:border-sky-500"
            />
            <span className="text-zinc-500">% of equity</span>
          </div>
        </label>
        <button
          type="button"
          onClick={placeTrade}
          disabled={submitting}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
            direction === "long" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-rose-600 hover:bg-rose-500"
          }`}
        >
          {submitting
            ? voiceModeOff
              ? "Placing order…"
              : "Announcing…"
            : direction === "long"
              ? "🟢 Place Buy"
              : "🔴 Place Sell"}
        </button>
      </div>

      {!voiceModeOff && (
        <p className="mt-2 text-[11px] text-zinc-500">
          Voice mode is on -- clicking Place {direction === "long" ? "Buy" : "Sell"} announces this trade and waits for you to say
          &ldquo;yes&rdquo; (or the exact confirm phrase) before it actually fires. Turn voice off in the panel above to place
          immediately on click instead.
        </p>
      )}

      {error && <p className="mt-2 text-xs font-semibold text-amber-400">{error}</p>}
      {placeResult && <p className="mt-2 text-xs font-semibold text-zinc-300">{describeExecuteResponse(placeResult)}</p>}
    </div>
  );
}
