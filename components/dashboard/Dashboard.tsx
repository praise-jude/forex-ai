"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PAIRS, type ExecutedTrade, type Pair, type PredictionUpdate, type Signal, type StreamEvent } from "@/lib/market/types";
import { executeSignalRequest, statusFromTrade, type CardStatus } from "@/lib/market/executionClient";
import { Watchlist, type WatchlistEntry } from "./Watchlist";
import { SignalsPanel } from "./SignalsPanel";
import { PredictionCard } from "./PredictionCard";
import { PositionsPanel } from "./PositionsPanel";
import { RiskGuardianBanner } from "./RiskGuardianBanner";
import { VoiceAssistantPanel } from "./VoiceAssistantPanel";
import { useVoiceAssistant } from "./useVoiceAssistant";
import { SignalToastStack, type ToastEntry } from "./SignalToast";

const PriceChart = dynamic(() => import("./PriceChart").then((mod) => mod.PriceChart), { ssr: false });

const TIMEFRAME = "15m";
const MAX_SIGNALS = 50;

function emptyWatchlist(): WatchlistEntry[] {
  return PAIRS.map((pair) => ({ pair, bid: null, ask: null, time: null }));
}

export function Dashboard() {
  const [selectedPair, setSelectedPair] = useState<Pair>(PAIRS[0]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>(emptyWatchlist);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [executedTrades, setExecutedTrades] = useState<ExecutedTrade[]>([]);
  const [predictions, setPredictions] = useState<Partial<Record<Pair, PredictionUpdate>>>({});
  const [latestEvent, setLatestEvent] = useState<StreamEvent | null>(null);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  // Only ever set by an execution attempt in this tab (loading/done) -- statuses for
  // trades executed before this page loaded are derived below from `executedTrades`
  // instead, so an attempt in this tab always wins over the seeded snapshot without
  // needing to reconcile them. Lifted up from SignalsPanel so both the plain Buy/Sell
  // button AND the voice assistant share one source of truth for "what happened".
  const [localStatuses, setLocalStatuses] = useState<Record<string, CardStatus>>({});

  const seededStatuses = useMemo(() => {
    const seeded: Record<string, CardStatus> = {};
    for (const trade of executedTrades) {
      const status = statusFromTrade(trade);
      if (status) seeded[trade.signalId] = status;
    }
    return seeded;
  }, [executedTrades]);

  const cardStatuses = useMemo(() => ({ ...seededStatuses, ...localStatuses }), [seededStatuses, localStatuses]);

  // A redelivered/retried webhook alert publishes another "signal" SSE event with the same
  // id -- tracked here (not just in `signals` state) so a toast doesn't fire twice for it.
  const seenSignalIds = useRef<Set<string>>(new Set());

  const dismissToast = useCallback((key: string) => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }, []);

  // The same function both SignalsPanel's Buy/Sell button and the voice assistant's
  // hard-confirm path call -- voice execution is never a separate code path, so it can
  // never bypass the backend's risk checks.
  const executeSignal = useCallback(async (signal: Signal) => {
    setLocalStatuses((prev) => ({ ...prev, [signal.id]: { state: "loading" } }));
    const result = await executeSignalRequest(signal.id);
    setLocalStatuses((prev) => ({ ...prev, [signal.id]: { state: "done", result } }));
    return result;
  }, []);

  const voice = useVoiceAssistant({ statuses: cardStatuses, executeSignal, selectedPair });

  useEffect(() => {
    fetch("/api/signals")
      .then((res) => res.json())
      .then(
        (data: {
          watchlist: WatchlistEntry[];
          signals: Signal[];
          executedTrades: ExecutedTrade[];
          predictions: PredictionUpdate[];
        }) => {
          setWatchlist(data.watchlist);
          setSignals(data.signals);
          setExecutedTrades(data.executedTrades);
          setPredictions(Object.fromEntries(data.predictions.map((p) => [p.pair, p])));
          for (const signal of data.signals) seenSignalIds.current.add(signal.id);
        }
      )
      .catch(() => {
        // Best-effort initial snapshot; the SSE stream will still catch up live data.
      });

    const source = new EventSource("/api/signals/stream");
    source.onmessage = (message) => {
      const event: StreamEvent = JSON.parse(message.data);
      setLatestEvent(event);

      if (event.type === "price") {
        setWatchlist((prev) =>
          prev.map((entry) => (entry.pair === event.pair ? { ...entry, bid: event.bid, ask: event.ask, time: event.time } : entry))
        );
      } else if (event.type === "signal") {
        if (seenSignalIds.current.has(event.signal.id)) return;
        seenSignalIds.current.add(event.signal.id);

        setSignals((prev) => [event.signal, ...prev].slice(0, MAX_SIGNALS));

        // Watch-tier signals are informational only (no execute button) -- match that by
        // not popping a toast, or a JUDE announcement, for them either.
        if (event.signal.tier !== "watch") {
          setToasts((prev) => [...prev, { key: `${event.signal.id}-${Date.now()}`, signal: event.signal }]);
          voice.onSignal(event.signal);
        }
      } else if (event.type === "prediction") {
        const update = { pair: event.pair, timeframe: event.timeframe, evaluation: event.evaluation, time: event.time };
        setPredictions((prev) => ({ ...prev, [event.pair]: update }));
        voice.onPredictionChange(update);
      }
    };

    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-4 p-5">
      <RiskGuardianBanner />
      <VoiceAssistantPanel {...voice} />

      <div className="grid gap-4 lg:grid-cols-[220px_1fr_260px]">
        <Watchlist entries={watchlist} selectedPair={selectedPair} onSelect={setSelectedPair} />

        <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold text-zinc-100">{selectedPair}</h2>
            <span className="text-xs text-zinc-500">15-minute &middot; SMC signal timeframe</span>
          </div>
          <div className="mb-3">
            <PredictionCard update={predictions[selectedPair] ?? null} />
          </div>
          <div className="h-105">
            <PriceChart
              pair={selectedPair}
              timeframe={TIMEFRAME}
              streamEvent={latestEvent}
              prediction={predictions[selectedPair] ?? null}
            />
          </div>
        </section>

        <div className="flex flex-col gap-4">
          <SignalsPanel signals={signals} statuses={cardStatuses} onExecute={executeSignal} />
          <PositionsPanel />
        </div>
      </div>

      <SignalToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
