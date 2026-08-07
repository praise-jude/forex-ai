"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { PAIRS, type ExecutedTrade, type Pair, type Signal, type StreamEvent } from "@/lib/market/types";
import { Watchlist, type WatchlistEntry } from "./Watchlist";
import { SignalsPanel } from "./SignalsPanel";
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
  const [latestEvent, setLatestEvent] = useState<StreamEvent | null>(null);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  // A redelivered/retried webhook alert publishes another "signal" SSE event with the same
  // id -- tracked here (not just in `signals` state) so a toast doesn't fire twice for it.
  const seenSignalIds = useRef<Set<string>>(new Set());

  const dismissToast = useCallback((key: string) => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }, []);

  useEffect(() => {
    fetch("/api/signals")
      .then((res) => res.json())
      .then((data: { watchlist: WatchlistEntry[]; signals: Signal[]; executedTrades: ExecutedTrade[] }) => {
        setWatchlist(data.watchlist);
        setSignals(data.signals);
        setExecutedTrades(data.executedTrades);
        for (const signal of data.signals) seenSignalIds.current.add(signal.id);
      })
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
        // not popping a toast for them either.
        if (event.signal.tier !== "watch") {
          setToasts((prev) => [...prev, { key: `${event.signal.id}-${Date.now()}`, signal: event.signal }]);
        }
      }
    };

    return () => source.close();
  }, []);

  return (
    <div className="grid gap-4 p-5 lg:grid-cols-[220px_1fr_260px]">
      <Watchlist entries={watchlist} selectedPair={selectedPair} onSelect={setSelectedPair} />

      <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">{selectedPair}</h2>
          <span className="text-xs text-zinc-500">15-minute &middot; SMC signal timeframe</span>
        </div>
        <div className="h-105">
          <PriceChart pair={selectedPair} timeframe={TIMEFRAME} streamEvent={latestEvent} />
        </div>
      </section>

      <SignalsPanel signals={signals} executedTrades={executedTrades} />
      <SignalToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
