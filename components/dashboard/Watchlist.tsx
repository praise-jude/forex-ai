"use client";

import { memo, useEffect, useState } from "react";
import type { Pair } from "@/lib/market/types";
import { formatPrice } from "@/lib/market/format";
import { isMarketClosed } from "@/lib/market/marketHours";

const CLOSED_REFRESH_MS = 60_000;

/** Ticks independently of props (own setInterval) so the weekend "closed" badge stays
 * correct even if this pair never receives another price event -- and doesn't disturb
 * Watchlist's own memo() against Dashboard re-renders, since it's internal state. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOSED_REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

export interface WatchlistEntry {
  pair: Pair;
  bid: number | null;
  ask: number | null;
  time: number | null;
}

interface WatchlistProps {
  entries: WatchlistEntry[];
  selectedPair: Pair;
  onSelect: (pair: Pair) => void;
}

function TickPrice({ pair, bid }: { pair: Pair; bid: number | null }) {
  const [prevBid, setPrevBid] = useState(bid);
  const [direction, setDirection] = useState(0);

  if (bid !== prevBid) {
    setDirection(bid !== null && prevBid !== null ? Math.sign(bid - prevBid) : 0);
    setPrevBid(bid);
  }

  const color = direction > 0 ? "text-emerald-400" : direction < 0 ? "text-rose-400" : "text-zinc-300";

  return (
    <span className={`tabular-nums font-medium ${color}`}>{bid === null ? "–" : formatPrice(pair, bid)}</span>
  );
}

// Memoized so a Dashboard re-render triggered by an unrelated SSE event (a "signal" or
// "prediction" message, which never touches watchlist state) skips re-rendering every
// pair row -- a genuine "price" event still re-renders this normally, since Dashboard's
// own setWatchlist always produces a new `entries` array reference for those.
export const Watchlist = memo(function Watchlist({ entries, selectedPair, onSelect }: WatchlistProps) {
  const now = useNow();

  return (
    <aside className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Pairs</h2>
      <ul className="space-y-0.5">
        {entries.map((entry) => {
          const closed = isMarketClosed(entry.pair, now, entry.time);
          return (
            <li key={entry.pair}>
              <button
                type="button"
                onClick={() => onSelect(entry.pair)}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  entry.pair === selectedPair ? "bg-zinc-800 shadow-[inset_2px_0_0_var(--color-sky-400)]" : "hover:bg-zinc-800/60"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-semibold text-zinc-100">{entry.pair}</span>
                  {closed && (
                    <span className="rounded bg-zinc-700/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                      Closed
                    </span>
                  )}
                </span>
                <TickPrice pair={entry.pair} bid={entry.bid} />
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
});
