"use client";

import { useEffect, useState } from "react";
import type { AccountKey, OpenPosition } from "@/lib/market/types";
import { formatPrice } from "@/lib/market/format";

interface PositionsResponse {
  account: AccountKey;
  positions: OpenPosition[];
  tradesToday: number;
}

const POLL_INTERVAL_MS = 7000;

function PositionRow({ position }: { position: OpenPosition }) {
  const isLong = position.direction === "long";
  const inProfit = position.profit >= 0;

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
    </li>
  );
}

export function PositionsPanel() {
  const [data, setData] = useState<PositionsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    function poll() {
      fetch("/api/positions")
        .then((res) => res.json())
        .then((json: PositionsResponse) => {
          if (!cancelled) setData(json);
        })
        .catch(() => {
          // Best-effort; keep showing the last known snapshot rather than flashing an error.
        });
    }

    poll();
    const pollId = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(pollId);
    };
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
            <PositionRow key={position.id} position={position} />
          ))}
        </ul>
      )}
    </section>
  );
}
