"use client";

import { useMemo } from "react";
import type { PredictionUpdate } from "@/lib/market/types";
import { rankNoTradeCloseness } from "@/lib/market/noTradeCloseness";

// How many of the 9 pairs to show -- enough to see real movement/reshuffling as
// conditions change, not so many it duplicates the full "Recent Analysis" grid below.
const MAX_ROWS = 5;

/**
 * "Which of the quiet pairs is actually closest to a real signal" -- ranks every
 * SMC no-trade read right now by rankNoTradeCloseness (see its own doc comment for the
 * real, non-arbitrary tiering). Purely a re-sort/re-label of data this dashboard
 * already has (flatPredictions, SMC-only by construction -- see Dashboard.tsx's own
 * buildPredictionMap) -- no new computation, no new poll, nothing execution-adjacent.
 */
export function ClosestToFiringPanel({ predictions }: { predictions: PredictionUpdate[] }) {
  const ranked = useMemo(() => {
    const rows: ({ pair: PredictionUpdate["pair"] } & ReturnType<typeof rankNoTradeCloseness>)[] = [];
    for (const p of predictions) {
      if (p.timeframe !== "15m" || p.evaluation.status !== "no_trade") continue;
      rows.push({ pair: p.pair, ...rankNoTradeCloseness(p.evaluation.reason) });
    }
    return rows.sort((a, b) => a.tier - b.tier).slice(0, MAX_ROWS);
  }, [predictions]);

  if (ranked.length === 0) return null;

  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Closest to firing (SMC, M15)</h2>
      <ul className="flex flex-col gap-1.5">
        {ranked.map((row) => (
          <li key={row.pair} className="flex items-center justify-between gap-3 text-xs">
            <span className="shrink-0 font-semibold text-zinc-100">{row.pair}</span>
            <span className="truncate text-right text-zinc-500">{row.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
