"use client";

import { usePolledResource } from "@/lib/hooks/usePolledResource";
import type { AccountInfo, Pair } from "@/lib/market/types";

const POLL_INTERVAL_MS = 10000;

interface PairHealth {
  pair: Pair;
  specAvailable: boolean;
  tradeMode: string | null;
  stopsLevel: number | null;
  priceAvailable: boolean;
  stale: boolean;
}

interface AccountHealth {
  account: "live" | "demo";
  connectionStatus: { status: "live" | "reconnecting" | "disconnected"; lastUpdateAt: number | null };
  accountInfo: AccountInfo | null;
  pairs: PairHealth[];
}

interface SystemHealthResponse {
  live: AccountHealth;
  demo: AccountHealth | null;
}

function CheckRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/5 py-1 text-xs last:border-0">
      <span className="flex items-center gap-1.5 text-zinc-400">
        <span className={ok ? "text-emerald-400" : "text-rose-400"}>{ok ? "✓" : "✗"}</span>
        {label}
      </span>
      <span className="font-mono text-zinc-200">{value}</span>
    </div>
  );
}

function AccountHealthBlock({ health }: { health: AccountHealth }) {
  const connected = health.connectionStatus.status === "live";
  const info = health.accountInfo;
  const stalePairs = health.pairs.filter((p) => p.stale).length;
  const freshPairs = health.pairs.length - stalePairs;

  return (
    <div className="rounded-lg border border-white/10 bg-zinc-800/60 p-3">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{health.account}</h3>
      <CheckRow label="MT5 connected" ok={connected} value={health.connectionStatus.status} />
      <CheckRow label="Account authenticated" ok={info !== null} value={info !== null ? "yes" : "no data yet"} />
      <CheckRow label="Balance available" ok={info !== null} value={info ? `$${info.balance.toLocaleString()}` : "—"} />
      <CheckRow label="Equity available" ok={info !== null} value={info ? `$${info.equity.toLocaleString()}` : "—"} />
      <CheckRow label="Free margin available" ok={info !== null} value={info ? `$${info.freeMargin.toLocaleString()}` : "—"} />
      <CheckRow label="Trading permission enabled" ok={info?.tradeAllowed === true} value={info ? String(info.tradeAllowed) : "—"} />
      <CheckRow
        label="Markets open (inferred from price activity)"
        ok={freshPairs > 0}
        value={`${freshPairs}/${health.pairs.length} pairs ticking`}
      />

      <table className="mt-2 w-full text-left text-[11px]">
        <thead className="text-zinc-500">
          <tr>
            <th className="pb-1 font-medium">Pair</th>
            <th className="pb-1 font-medium">Symbol</th>
            <th className="pb-1 font-medium">Market</th>
            <th className="pb-1 font-medium">Price</th>
            <th className="pb-1 font-medium">SL/TP</th>
          </tr>
        </thead>
        <tbody className="text-zinc-300">
          {health.pairs.map((p) => (
            <tr key={p.pair} className="border-t border-white/5">
              <td className="py-1 font-medium text-zinc-100">{p.pair}</td>
              <td className="py-1">{p.specAvailable ? "✓" : "✗"}</td>
              <td className={`py-1 ${p.stale ? "text-amber-400" : "text-emerald-400"}`}>{p.stale ? "closed?" : "open"}</td>
              <td className="py-1">{p.priceAvailable ? "✓" : "✗"}</td>
              <td className="py-1">{p.stopsLevel !== null ? "✓" : "✗"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Surfaces exactly the checklist a real broker connection is validated against --
 * connected, authenticated, funded, permitted to trade, symbols/prices available,
 * SL/TP supported -- all sourced from data the persistent live/demo connections already
 * cache, so this is cheap to poll and never a fresh network round-trip per request.
 * "Markets open" is an honest inference from price activity, never a broker-asserted
 * flag -- MetaApi doesn't expose one directly.
 */
export function SystemHealthPanel() {
  const { data } = usePolledResource<SystemHealthResponse>(
    "system-health",
    () => fetch("/api/system-health").then((res) => res.json()),
    POLL_INTERVAL_MS
  );

  if (!data) return <div className="text-sm text-zinc-500">Loading…</div>;

  return (
    <div className={`grid gap-3 ${data.demo ? "md:grid-cols-2" : ""}`}>
      <AccountHealthBlock health={data.live} />
      {data.demo && <AccountHealthBlock health={data.demo} />}
    </div>
  );
}
