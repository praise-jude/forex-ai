"use client";

import type { Timeframe } from "@/lib/market/types";

// The three timeframes that actually have their own independent SMC signal engine
// (see SIGNAL_TIMEFRAMES in metaApiConnection.ts) -- 5m/4h/1d are tracked for charting
// and higher-timeframe trend confirmation, but never generate their own predictions,
// so there's nothing for a user to select them into here.
const SELECTABLE_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h"];

export function TimeframeSelector({ value, onChange }: { value: Timeframe; onChange: (timeframe: Timeframe) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-zinc-800 p-0.5">
      {SELECTABLE_TIMEFRAMES.map((timeframe) => (
        <button
          key={timeframe}
          type="button"
          onClick={() => onChange(timeframe)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
            value === timeframe ? "bg-sky-500/15 text-sky-400" : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {timeframe}
        </button>
      ))}
    </div>
  );
}
