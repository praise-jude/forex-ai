"use client";

import { memo, useEffect, useState } from "react";
import type { AccountKey, OpenPosition, Pair, PositionRiskAssessment } from "@/lib/market/types";
import { formatDurationRange, formatPrice } from "@/lib/market/format";
import { usePolledResource } from "@/lib/hooks/usePolledResource";
import type { DurationStats } from "@/lib/market/tradeJournal";

interface PositionsResponse {
  account: AccountKey;
  positions: OpenPosition[];
  risk: Record<string, PositionRiskAssessment>;
  tradesToday: number;
}

// 1s, not the 7s every other poller here uses -- confirmed real user request: the P/L
// number should feel like it's actually counting, the way Exness's own platform does,
// not visibly jumping every few seconds. Safe to poll this fast because the data behind
// it (getOpenPositions) is a cheap read of MetaApi's own already-synced local terminal
// state, never a live broker round-trip -- see metaApiConnection.ts's own doc comment
// on terminalState.positions.
const POLL_INTERVAL_MS = 1000;

const RISK_BADGE_CLASS: Record<PositionRiskAssessment["level"], string> = {
  aligned: "bg-zinc-700/60 text-zinc-400",
  caution: "bg-amber-500/15 text-amber-400",
  warning: "bg-rose-500/15 text-rose-400",
};

const RISK_BADGE_LABEL: Record<PositionRiskAssessment["level"], string> = {
  aligned: "Aligned",
  caution: "Caution",
  warning: "Warning",
};

// "Xm Ys" while under an hour (matches the 1s poll's own "feels like it's counting"
// intent, same as the P/L figure above), "Xh Ym" beyond that -- no days tier, since a
// position genuinely open for over a day is already well past the point where minute
// precision matters.
function formatDuration(openedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - openedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

// Real closed-trade duration data changes only when a trade actually closes -- a rare
// event relative to POLL_INTERVAL_MS's 1s cadence, so this gets its own far slower
// interval, same as PriceChart.tsx's own DURATION_STATS_POLL_MS.
const DURATION_POLL_MS = 5 * 60_000;

async function fetchDurationStatsForPair(pair: Pair): Promise<DurationStats> {
  const res = await fetch(`/api/trade-journal/duration?pair=${encodeURIComponent(pair)}`);
  return res.json();
}

/** Whether an open, currently-losing position has already run longer than 75% of past
 * trades on this pair took to hit their own stop -- a real, data-grounded "this is
 * taking longer than usual to turn around" cue for the operator to review manually,
 * never an automated close (see this feature's own request: "enable me to stop the
 * trade if it's moving out of my direction" -- the app surfaces the signal, the human
 * decides). Requires openedAt (undefined for a position opened outside this app, see
 * OpenPosition's own doc comment) and a calibrated stop-loss bucket; returns false
 * (never a guess) when either is missing. */
function isRunningLongForALoss(position: OpenPosition, stats: DurationStats | null, now: number): boolean {
  if (position.profit >= 0 || position.openedAt === undefined) return false;
  if (stats?.stopLoss.status !== "calibrated" || stats.stopLoss.p75Ms === null) return false;
  return now - position.openedAt > stats.stopLoss.p75Ms;
}

function PositionRow({ position, risk, now }: { position: OpenPosition; risk: PositionRiskAssessment | undefined; now: number }) {
  const isLong = position.direction === "long";
  const inProfit = position.profit >= 0;
  const { data: durationStats } = usePolledResource<DurationStats>(
    `duration:${position.pair}`,
    () => fetchDurationStatsForPair(position.pair),
    DURATION_POLL_MS
  );
  const runningLong = isRunningLongForALoss(position, durationStats ?? null, now);
  // Whichever side is actually relevant right now: a losing position wants to know how
  // long losses on this pair typically take to hit stop (the "how much longer might
  // this drag on" question); a winning one wants the take-profit window instead. Never
  // both at once -- showing the side that doesn't match the current direction of travel
  // would just be noise.
  const relevantBucket = inProfit ? durationStats?.takeProfit : durationStats?.stopLoss;

  return (
    <li className="rounded-lg border border-white/10 bg-zinc-800/60 p-2.5 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className={`font-semibold ${isLong ? "text-emerald-400" : "text-rose-400"}`}>{isLong ? "LONG" : "SHORT"}</span>
          <span className="font-semibold text-zinc-100">{position.pair}</span>
        </div>
        <span className={`tabular-nums font-semibold ${inProfit ? "text-emerald-400" : "text-rose-400"}`}>
          {inProfit ? "+" : ""}
          {position.profit.toFixed(2)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-zinc-500">
        <span>{position.lots} lots</span>
        <span className="tabular-nums">
          {formatPrice(position.pair, position.openPrice)} &rarr; {formatPrice(position.pair, position.currentPrice)}
        </span>
      </div>
      {/* Only for a trade this app itself placed -- openedAt is undefined for a
          position opened directly on the broker outside the app (see OpenPosition's own
          doc comment), and there's no real "when" to count from for those. */}
      {position.openedAt !== undefined && (
        <div className="mt-1 flex items-center justify-between text-zinc-500">
          <span>Open for</span>
          <span className="tabular-nums">{formatDuration(position.openedAt, now)}</span>
        </div>
      )}
      {/* A real, historically-grounded read on this pair's own past trades -- never a
          timing prediction for THIS specific position (see computeDurationStats' own
          doc comment). Reassuring context on a winner (typical time-to-target), an
          explicit caution cue on a loser that's already run past the typical
          time-to-stop window. */}
      {relevantBucket?.status === "calibrated" && relevantBucket.p25Ms !== null && relevantBucket.p75Ms !== null && (
        <div className="mt-1 flex items-center justify-between text-zinc-500">
          <span>Typical {inProfit ? "time to target" : "time to stop"}</span>
          <span className="tabular-nums">{formatDurationRange(relevantBucket.p25Ms, relevantBucket.p75Ms)}</span>
        </div>
      )}
      {runningLong && (
        <div className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] leading-tight text-amber-400">
          Open longer than 75% of past losses on this pair took to hit stop -- worth a manual look.
        </div>
      )}
      {risk && (
        <div className="mt-1.5 flex items-start gap-1.5 border-t border-white/5 pt-1.5">
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${RISK_BADGE_CLASS[risk.level]}`}>
            {RISK_BADGE_LABEL[risk.level]}
          </span>
          {risk.level !== "aligned" && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] leading-tight text-zinc-400">{risk.reason}</span>
              {/* Only ever set for "caution" (one opposing timeframe, a real gap to
                  measure) -- a real current distance, never a time estimate for when it'll
                  actually flip back. */}
              {risk.distancePct !== null && (
                <span className="text-[10px] text-zinc-500">Gap: {risk.distancePct.toFixed(2)}% (smaller = closer to clearing)</span>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

async function fetchPositions(): Promise<PositionsResponse> {
  const res = await fetch("/api/positions");
  return res.json();
}

// Takes no props and manages its own polling internally -- memoized so it never
// re-renders from a parent (Dashboard) cascade, only when its own polled data changes.
export const PositionsPanel = memo(function PositionsPanel() {
  const { data } = usePolledResource("positions", fetchPositions, POLL_INTERVAL_MS);

  // Drives the "Open for" duration below -- a real ticking clock, not just a value read
  // fresh on every poll-driven re-render (which would freeze between polls instead of
  // counting), same 1s-tick pattern TradeProposalCard.tsx's own countdown already uses.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tickId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tickId);
  }, []);

  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Open positions {data ? `(${data.account})` : ""}
        </h2>
        <span className="text-[11px] text-zinc-500">{data ? `${data.tradesToday} trades today` : ""}</span>
      </div>
      {!data || data.positions.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">No open positions.</p>
      ) : (
        <ul className="space-y-2">
          {data.positions.map((position) => (
            <PositionRow key={position.id} position={position} risk={data.risk[position.id]} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
});
