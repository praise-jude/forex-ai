"use client";

import { useEffect } from "react";
import type { Signal } from "@/lib/market/types";
import { formatPrice } from "@/lib/market/format";
import { TradingRobot } from "./TradingRobot";

export interface ToastEntry {
  key: string;
  signal: Signal;
}

const AUTO_DISMISS_MS = 8000;

function ToastCard({ entry, onDismiss }: { entry: ToastEntry; onDismiss: (key: string) => void }) {
  const { signal } = entry;

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(entry.key), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [entry.key, onDismiss]);

  const label = signal.direction === "long" ? "BUY SIGNAL" : "SELL SIGNAL";

  return (
    <div className="animate-toast-in pointer-events-auto w-80 rounded-xl border border-white/10 bg-zinc-900 p-3 shadow-2xl shadow-black/50">
      <div className="flex items-start justify-between gap-2">
        <TradingRobot direction={signal.direction} />
        <button
          type="button"
          onClick={() => onDismiss(entry.key)}
          aria-label="Dismiss notification"
          className="shrink-0 rounded p-0.5 text-lg leading-none text-zinc-500 hover:bg-white/10 hover:text-zinc-300"
        >
          &times;
        </button>
      </div>
      <div className="mt-2 text-sm font-semibold text-zinc-100">
        {label} &middot; {signal.pair}
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-zinc-400">
        <span>Entry {formatPrice(signal.pair, signal.entry)}</span>
        <span>{signal.timeframe}</span>
      </div>
      <div className="mt-1 text-[11px] text-zinc-500">
        {signal.source === "tradingview" ? "Source: TradingView" : `Confidence ${signal.confidence.toFixed(0)}%`}
      </div>
    </div>
  );
}

/** Stacked, auto-dismissing popups for newly arrived signals -- fed by the same live SSE
 * stream the dashboard already uses, so no new backend or connection is needed. */
export function SignalToastStack({ toasts, onDismiss }: { toasts: ToastEntry[]; onDismiss: (key: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 top-4 z-50 flex flex-col gap-2">
      {toasts.map((entry) => (
        <ToastCard key={entry.key} entry={entry} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
