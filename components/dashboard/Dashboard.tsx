"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PAIRS, type ExecutedTrade, type Pair, type PredictionUpdate, type Signal, type StreamEvent, type Timeframe } from "@/lib/market/types";
import { executeSignalRequest, statusFromTrade, type CardStatus } from "@/lib/market/executionClient";
import { buildConfirmPhrase } from "@/lib/voice/grammar";
import { usePolledResource } from "@/lib/hooks/usePolledResource";
import { Watchlist, type WatchlistEntry } from "./Watchlist";
import { SignalsPanel } from "./SignalsPanel";
import { PredictionCard } from "./PredictionCard";
import { TimeframeSelector } from "./TimeframeSelector";
import { PositionsPanel } from "./PositionsPanel";
import { RiskGuardianBanner } from "./RiskGuardianBanner";
import { VoiceAssistantPanel } from "./VoiceAssistantPanel";
import { useVoiceAssistant } from "./useVoiceAssistant";
import { SignalToastStack, type ToastEntry } from "./SignalToast";
import { AutopilotStatus } from "./AutopilotStatus";
import { RecentAnalysis } from "./RecentAnalysis";

const PriceChart = dynamic(() => import("./PriceChart").then((mod) => mod.PriceChart), { ssr: false });

const MAX_SIGNALS = 50;

function emptyWatchlist(): WatchlistEntry[] {
  return PAIRS.map((pair) => ({ pair, bid: null, ask: null, time: null }));
}

function buildPredictionMap(updates: PredictionUpdate[]): Partial<Record<Pair, Partial<Record<Timeframe, PredictionUpdate>>>> {
  const map: Partial<Record<Pair, Partial<Record<Timeframe, PredictionUpdate>>>> = {};
  for (const update of updates) {
    map[update.pair] = { ...map[update.pair], [update.timeframe]: update };
  }
  return map;
}

const SELECTED_PAIR_STORAGE_KEY = "forex-ai:selected-pair";

function isPair(value: string | null): value is Pair {
  return PAIRS.includes(value as Pair);
}

export function Dashboard() {
  const [selectedPair, setSelectedPair] = useState<Pair>(PAIRS[0]);
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>("15m");
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>(emptyWatchlist);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [executedTrades, setExecutedTrades] = useState<ExecutedTrade[]>([]);
  // Nested by pair then timeframe -- three signal engines (15m/30m/1h) run concurrently
  // per pair now, so a single PredictionUpdate per pair is no longer enough (mirrors
  // predictionStore.ts's own nested-Map shape on the server).
  const [predictions, setPredictions] = useState<Partial<Record<Pair, Partial<Record<Timeframe, PredictionUpdate>>>>>({});
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

  // The same function both SignalsPanel's Approve button and the voice assistant's
  // hard-confirm path call -- voice execution is never a separate code path, so it can
  // never bypass the backend's risk checks. Builds the exact same confirmation phrase
  // the execute route itself requires (buildConfirmPhrase, shared with voice/chat) so
  // callers here never need to know about it individually.
  const executeSignal = useCallback(async (signal: Signal, riskPctOverride?: number) => {
    setLocalStatuses((prev) => ({ ...prev, [signal.id]: { state: "loading" } }));
    const result = await executeSignalRequest(signal.id, buildConfirmPhrase(signal), riskPctOverride);
    setLocalStatuses((prev) => ({ ...prev, [signal.id]: { state: "done", result } }));
    return result;
  }, []);

  const voice = useVoiceAssistant({ statuses: cardStatuses, executeSignal, selectedPair, selectedTimeframe });

  // Confirmation Mode's own state -- drives whether SignalsPanel shows an execute
  // affordance at all ("signal_only") or the propose-then-approve flow ("confirm").
  const { data: confirmationMode } = usePolledResource<{ manualMode: "signal_only" | "confirm"; proposalTtlSeconds: number }>(
    "confirmation-mode",
    () => fetch("/api/confirmation-mode").then((res) => res.json()),
    15000
  );
  // Seeds the proposal card's default "Risk" figure -- the account's actually-configured
  // riskPerTradePct. Shared key with EngineModeControl.tsx/useVoiceAssistant.ts, which
  // already poll "engine-mode" -- usePolledResource dedupes them into one request.
  const { data: engineModeData } = usePolledResource<{ riskPerTradePct: number }>(
    "engine-mode",
    () => fetch("/api/engine-mode").then((res) => res.json()),
    7000
  );

  // Restored after mount, not read during the initial render -- reading localStorage
  // synchronously in useState's initializer would mismatch the server-rendered HTML
  // (which always starts at PAIRS[0], since localStorage doesn't exist server-side)
  // and trigger a hydration error.
  //
  // Persisting is deliberately NOT a second effect reacting to every selectedPair
  // change (see selectPair below) -- under React StrictMode's dev-only double-invoke,
  // a "persist on change" effect fires with the pre-restore value in the same pass
  // this restore effect runs, overwriting the just-restored value with the SSR default
  // before it ever reaches the screen. Writing only from the real user-selection path
  // (selectPair) has nothing to race against.
  useEffect(() => {
    const stored = window.localStorage.getItem(SELECTED_PAIR_STORAGE_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only restore from localStorage, not state derivable from render.
    if (isPair(stored)) setSelectedPair(stored);
  }, []);

  const selectPair = useCallback((pair: Pair) => {
    setSelectedPair(pair);
    window.localStorage.setItem(SELECTED_PAIR_STORAGE_KEY, pair);
  }, []);

  const selectedPrediction = predictions[selectedPair]?.[selectedTimeframe] ?? null;

  // Flattened once here (rather than in each consumer) since both AutopilotStatus and
  // RecentAnalysis need every pair/timeframe's update, not the single selected one
  // PredictionCard/PriceChart use.
  const flatPredictions = useMemo(
    () => Object.values(predictions).flatMap((byTimeframe) => Object.values(byTimeframe ?? {})),
    [predictions]
  );

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
          setPredictions(buildPredictionMap(data.predictions));
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
        const update = {
          pair: event.pair,
          timeframe: event.timeframe,
          evaluation: event.evaluation,
          time: event.time,
          regime: event.regime,
          trends: event.trends,
        };
        setPredictions((prev) => ({ ...prev, [event.pair]: { ...prev[event.pair], [event.timeframe]: update } }));
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
      <AutopilotStatus predictions={flatPredictions} signals={signals} marketsMonitored={PAIRS.length} />

      <div className="grid gap-4 lg:grid-cols-[220px_1fr_260px]">
        <Watchlist entries={watchlist} selectedPair={selectedPair} onSelect={selectPair} />

        <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold text-zinc-100">{selectedPair}</h2>
            <TimeframeSelector value={selectedTimeframe} onChange={setSelectedTimeframe} />
          </div>
          <div className="mb-3">
            <PredictionCard update={selectedPrediction} />
          </div>
          <div className="h-105">
            <PriceChart
              pair={selectedPair}
              timeframe={selectedTimeframe}
              streamEvent={latestEvent}
              prediction={selectedPrediction}
            />
          </div>
        </section>

        <div className="flex flex-col gap-4">
          <SignalsPanel
            signals={signals}
            statuses={cardStatuses}
            onExecute={executeSignal}
            predictions={predictions}
            manualMode={confirmationMode?.manualMode ?? "confirm"}
            ttlSeconds={confirmationMode?.proposalTtlSeconds ?? 120}
            defaultRiskPct={engineModeData?.riskPerTradePct ?? 1}
          />
          <PositionsPanel />
        </div>
      </div>

      <RecentAnalysis predictions={flatPredictions} />

      <SignalToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
