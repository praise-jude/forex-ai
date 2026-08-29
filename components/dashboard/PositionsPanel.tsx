"use client";

import { memo } from "react";
import type { AccountKey, OpenPosition, PositionRiskAssessment } from "@/lib/market/types";
import { formatPrice } from "@/lib/market/format";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

interface PositionsResponse {
  account: AccountKey;
  positions: OpenPosition[];
  risk: Record<string, PositionRiskAssessment>;
  tradesToday: number;
}

const POLL_INTERVAL_MS = 7000;

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

function PositionRow({ position, risk }: { position: OpenPosition; risk: PositionRiskAssessment | undefined }) {
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
      {risk && (
        <div className="mt-1.5 flex items-start gap-1.5 border-t border-white/5 pt-1.5">
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${RISK_BADGE_CLASS[risk.level]}`}>
            {RISK_BADGE_LABEL[risk.level]}
          </span>
          {risk.level !== "aligned" && <span className="text-[11px] leading-tight text-zinc-400">{risk.reason}</span>}
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
            <PositionRow key={position.id} position={position} risk={data.risk[position.id]} />
          ))}
        </ul>
      )}
    </section>
  );
});
