"use client";

import type { Confluence, Signal } from "@/lib/market/types";
import { formatPrice } from "@/lib/market/format";

const CONFLUENCE_LABEL: Record<Confluence, string> = {
  liquidity_sweep: "Liquidity sweep",
  bos: "Structure break",
  fvg: "Fair value gap",
  order_block: "Order block",
  killzone: "Killzone",
};

function relativeTime(fromMs: number): string {
  const seconds = Math.round((Date.now() - fromMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function SignalCard({ signal }: { signal: Signal }) {
  const isLong = signal.direction === "long";
  return (
    <li className="rounded-lg border border-white/10 bg-zinc-800/60 p-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-zinc-100">{signal.pair}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${
            isLong ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"
          }`}
        >
          {signal.direction}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums">
        <div>
          <dt className="text-zinc-500">Entry</dt>
          <dd className="text-zinc-200">{formatPrice(signal.pair, signal.entry)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">SL</dt>
          <dd className="text-rose-400">{formatPrice(signal.pair, signal.stopLoss)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">TP</dt>
          <dd className="text-emerald-400">{formatPrice(signal.pair, signal.takeProfit)}</dd>
        </div>
      </dl>
      <div className="mt-2 flex flex-wrap gap-1">
        {signal.confluences.map((c) => (
          <span key={c} className="rounded-full bg-zinc-700/60 px-2 py-0.5 text-[11px] text-zinc-300">
            {CONFLUENCE_LABEL[c]}
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
        <span>
          R:R {signal.riskReward.toFixed(1)} &middot; {signal.session}
        </span>
        <span>{relativeTime(signal.createdAt)}</span>
      </div>
    </li>
  );
}

export function SignalsPanel({ signals }: { signals: Signal[] }) {
  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Active signals</h2>
      {signals.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">No signals yet — watching for setups.</p>
      ) : (
        <ul className="space-y-2">
          {signals.map((signal) => (
            <SignalCard key={signal.id} signal={signal} />
          ))}
        </ul>
      )}
    </section>
  );
}
