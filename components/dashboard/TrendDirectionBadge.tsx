"use client";

import type { HigherTimeframeTrends } from "@/lib/market/types";

type BigDirection = "up" | "down" | "mixed";

// Majority of the same D1/H4/H1 EMA50/200 reads PredictionCard.tsx's own TrendsRow
// already shows individually -- this just consolidates them into one glanceable verdict
// instead of three. 2-of-3 agreeing wins; anything else (a genuine split, or any
// "neutral" reads pulling it apart) is honestly shown as MIXED rather than picking a
// side arbitrarily.
function bigDirection(trends: HigherTimeframeTrends): BigDirection {
  const values = [trends.d1, trends.h4, trends.h1];
  const bullish = values.filter((v) => v === "bullish").length;
  const bearish = values.filter((v) => v === "bearish").length;
  if (bullish >= 2) return "up";
  if (bearish >= 2) return "down";
  return "mixed";
}

const CONFIG: Record<BigDirection, { arrow: string; label: string; className: string }> = {
  up: { arrow: "▲", label: "UP", className: "border-emerald-800/60 bg-emerald-500/10 text-emerald-400" },
  down: { arrow: "▼", label: "DOWN", className: "border-rose-800/60 bg-rose-500/10 text-rose-400" },
  mixed: { arrow: "—", label: "MIXED", className: "border-white/10 bg-zinc-800/60 text-zinc-400" },
};

/**
 * A single big, always-visible verdict for the currently selected pair -- pinned next to
 * the pair name (see Dashboard.tsx) so it's readable at a glance without opening the
 * prediction card. Purely a re-summary of real data this dashboard already computes and
 * shows elsewhere (D1/H4/H1 trend), never a new signal or a reason to trade on its own.
 */
export function TrendDirectionBadge({ trends }: { trends: HigherTimeframeTrends | undefined }) {
  if (!trends) return null;
  const config = CONFIG[bigDirection(trends)];

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-1 ${config.className}`}
      title="Majority of D1/H4/H1 trend direction (2 of 3 agreeing)"
    >
      <span className="text-2xl leading-none">{config.arrow}</span>
      <span className="text-xs font-bold tracking-wide">{config.label}</span>
    </div>
  );
}
