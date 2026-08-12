"use client";

import type { PredictionUpdate, Timeframe } from "@/lib/market/types";
import { predictionHeadline, predictionSubline } from "@/lib/market/predictionLabel";
import { describeNoTradeReason, REGIME_LABEL } from "@/lib/market/noTradeReason";
import { DirectionBadge } from "./DirectionBadge";
import { HEADLINE_TONE } from "./PredictionCard";

// The dashboard's own default timeframe -- one row per pair at this timeframe, so a
// pair blocked on all three concurrently-running engines doesn't show three rows.
const PRIMARY_TIMEFRAME: Timeframe = "15m";

function detailFor(update: PredictionUpdate): string | null {
  if (update.evaluation.status === "no_trade") return describeNoTradeReason(update.evaluation.reason, update.regime);
  return predictionSubline(update.evaluation);
}

/**
 * Every watched pair's current read at a glance -- proves the engine is actively
 * analyzing even when Active Signals is empty, distinct from that panel which only
 * ever shows actionable buy/strong_buy setups. Every row traces to a real
 * PredictionUpdate; a pair with no entry yet (still starting up) is simply omitted
 * rather than shown with a fabricated placeholder row.
 */
export function RecentAnalysis({ predictions }: { predictions: PredictionUpdate[] }) {
  const rows = predictions
    .filter((p) => p.timeframe === PRIMARY_TIMEFRAME)
    .sort((a, b) => b.time - a.time);

  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Recent analysis (M15)</h2>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">Starting up -- waiting for the first closed candle on each pair.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((update) => {
            const headline = predictionHeadline(update.evaluation);
            const detail = detailFor(update);
            return (
              <li key={update.pair} className="rounded-lg border border-white/10 bg-zinc-800/60 p-2.5 text-xs">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="font-semibold text-zinc-100">{update.pair}</span>
                  <DirectionBadge tone={HEADLINE_TONE[headline]} label={headline} className="text-[11px]" />
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">{REGIME_LABEL[update.regime]}</div>
                {detail && <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">{detail}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
