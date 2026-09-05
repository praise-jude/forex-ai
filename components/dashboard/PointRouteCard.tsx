"use client";

import type { Signal } from "@/lib/market/types";
import { formatPrice } from "@/lib/market/format";

/**
 * Entry ("Point A") -> stop-loss/TP1/TP2 ("Point B") -- every number is the real,
 * already-computed Signal field (see signalEngine.ts's own entry/SL/TP construction),
 * nothing projected or estimated here beyond what the engine already decided. The
 * arrows are a presentation device for a real, already-fixed route, never a claim about
 * a guaranteed future price path. Mirrors forex-ai-mobile's PointRouteCard.tsx.
 */
export function PointRouteCard({ signal }: { signal: Signal }) {
  const isLong = signal.direction === "long";
  const arrow = isLong ? "↗" : "↘";
  const arrowColor = isLong ? "text-emerald-400" : "text-rose-400";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-1 flex-col items-center gap-0.5">
          <span className="text-[10px] font-bold tracking-wide text-zinc-500">POINT A</span>
          <span className="text-[10px] text-zinc-500">Potential Entry</span>
          <span className="text-sm font-bold text-zinc-100">{formatPrice(signal.pair, signal.entry)}</span>
        </div>
        <span className={`text-base font-bold ${arrowColor}`}>
          {arrow} {arrow} {arrow}
        </span>
        <div className="flex flex-1 flex-col items-center gap-0.5">
          <span className="text-[10px] font-bold tracking-wide text-zinc-500">POINT B</span>
          <span className="text-[10px] text-zinc-500">Projected Target</span>
          <span className="text-sm font-bold text-zinc-100">{formatPrice(signal.pair, signal.takeProfit)}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div className="flex min-w-[45%] flex-1 flex-col gap-0.5">
          <span className="text-[10px] tracking-wide text-zinc-500">STOP LOSS</span>
          <span className="text-sm font-semibold text-rose-400">{formatPrice(signal.pair, signal.stopLoss)}</span>
        </div>
        <div className="flex min-w-[45%] flex-1 flex-col gap-0.5">
          <span className="text-[10px] tracking-wide text-zinc-500">TP1</span>
          <span className="text-sm font-semibold text-emerald-400">{formatPrice(signal.pair, signal.takeProfit)}</span>
        </div>
        <div className="flex min-w-[45%] flex-1 flex-col gap-0.5">
          <span className="text-[10px] tracking-wide text-zinc-500">TP2</span>
          <span className="text-sm font-semibold text-emerald-400">{formatPrice(signal.pair, signal.takeProfit2)}</span>
        </div>
        <div className="flex min-w-[45%] flex-1 flex-col gap-0.5">
          <span className="text-[10px] tracking-wide text-zinc-500">RISK/REWARD</span>
          <span className="text-sm font-semibold text-zinc-100">1:{signal.riskReward.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
}
