"use client";

import type { JournalEntry, PerformanceStats, SignalFunnelStats } from "@/lib/market/tradeJournal";
import { formatPrice } from "@/lib/market/format";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

interface JournalResponse {
  entries: JournalEntry[];
  stats: PerformanceStats;
  /** Currently open positions, across every configured account -- not part of `stats`
   * itself (which only ever scores closed trades, see getPerformanceStats), just added
   * on top for the "Trades" tile below so it counts every trade ever taken. */
  openCount: number;
  /** "AI signal performance" -- approved/rejected/expired/blocked counts, distinct from
   * `stats` above ("actual executed trade performance"). See SignalOutcome's own doc
   * comment in tradeJournal.ts. */
  signalFunnel: SignalFunnelStats;
  /** "Which pairs/sessions is my performance actually coming from" -- see
   * getPerformanceBreakdown in tradeJournal.ts. Always over the full ledger. */
  breakdownByPair: Record<string, PerformanceStats>;
  breakdownBySession: Record<string, PerformanceStats>;
}

// Trades close on the order of minutes to hours, not seconds -- a slow poll is
// plenty responsive without hammering the API for a page that isn't the primary
// live-trading surface (see Dashboard.tsx's SSE stream for that).
const POLL_INTERVAL_MS = 15000;

async function fetchJournal(): Promise<JournalResponse> {
  const res = await fetch("/api/trade-journal");
  return res.json();
}

// Journal entries can be days or weeks old, unlike SignalsPanel's own relativeTime
// (which only ever needs to express minutes/hours for a live-fired signal) -- this
// one also expresses days.
function relativeTime(fromMs: number): string {
  const seconds = Math.round((Date.now() - fromMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const REASON_LABEL: Record<JournalEntry["reason"], string> = {
  stop_loss: "Stop loss",
  take_profit: "Take profit",
  invalidation: "Invalidation exit",
  manual: "Manual close",
  other: "Closed",
};

function StatTile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "positive" | "negative" }) {
  return (
    <div className="rounded-lg border border-white/10 bg-zinc-800/60 p-3">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold tabular-nums ${
          tone === "positive" ? "text-emerald-400" : tone === "negative" ? "text-rose-400" : "text-zinc-100"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-zinc-500">{hint}</p>}
    </div>
  );
}

function StatsSummary({ stats, openCount }: { stats: PerformanceStats; openCount: number }) {
  const averageRTone = stats.averageR === null ? undefined : stats.averageR >= 0 ? "positive" : "negative";

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
      <StatTile
        label="Trades"
        value={String(stats.count + openCount)}
        hint={openCount > 0 ? `${openCount} open` : undefined}
      />
      <StatTile label="Win rate" value={stats.count === 0 ? "—" : `${stats.winRate.toFixed(0)}%`} />
      <StatTile label="Record" value={`${stats.wins}W / ${stats.losses}L`} />
      <StatTile
        label="Average R"
        value={stats.averageR === null ? "—" : `${stats.averageR >= 0 ? "+" : ""}${stats.averageR.toFixed(2)}R`}
        tone={averageRTone}
      />
      <StatTile label="Max drawdown" value={stats.maxDrawdownR === null ? "—" : `${stats.maxDrawdownR.toFixed(2)}R`} tone="negative" />
    </div>
  );
}

/** "AI signal performance" -- was the AI's signal-to-decision pipeline healthy (did
 * proposals get a real decision, or mostly expire/get blocked) -- kept visually
 * distinct from the executed-trade StatsSummary above, which is "actual executed trade
 * performance" and only ever reflects real closed trades, never a signal that was
 * proposed but never filled. */
function SignalFunnelSummary({ funnel }: { funnel: SignalFunnelStats }) {
  const total = funnel.approved + funnel.rejected + funnel.expired + funnel.blocked;
  if (total === 0) return null;

  return (
    <div>
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">AI signal performance (proposals, not trades)</h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile label="Approved" value={String(funnel.approved)} tone="positive" />
        <StatTile label="Rejected" value={String(funnel.rejected)} />
        <StatTile label="Expired" value={String(funnel.expired)} tone="negative" />
        <StatTile label="Blocked" value={String(funnel.blocked)} />
      </div>
    </div>
  );
}

const SESSION_LABEL: Record<string, string> = {
  asia: "Asia",
  london: "London",
  newyork: "New York",
  "off-session": "Off-session",
};

/**
 * Which pairs/sessions performance is actually coming from -- kept as a compact table
 * (not tiles like StatsSummary) since there can be up to 10 rows (one per pair) and
 * tiles don't scale to that. Rows sorted by trade count, most-traded first, so the
 * buckets with enough sample size to mean anything surface at the top.
 */
function BreakdownTable({ title, breakdown, labelFor }: { title: string; breakdown: Record<string, PerformanceStats>; labelFor: (key: string) => string }) {
  const rows = Object.entries(breakdown).sort((a, b) => b[1].count - a[1].count);
  if (rows.length === 0) return null;

  return (
    <div>
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
      <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-900">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/10 text-left text-zinc-500">
              <th className="px-3 py-2 font-medium">Group</th>
              <th className="px-3 py-2 font-medium">Trades</th>
              <th className="px-3 py-2 font-medium">Win rate</th>
              <th className="px-3 py-2 font-medium">Avg R</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, stats]) => (
              <tr key={key} className="border-b border-white/5 last:border-0">
                <td className="px-3 py-2 font-medium text-zinc-200">{labelFor(key)}</td>
                <td className="px-3 py-2 tabular-nums text-zinc-300">{stats.count}</td>
                <td className="px-3 py-2 tabular-nums text-zinc-300">{stats.winRate.toFixed(0)}%</td>
                <td className={`px-3 py-2 tabular-nums ${stats.averageR === null ? "text-zinc-500" : stats.averageR >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {stats.averageR === null ? "—" : `${stats.averageR >= 0 ? "+" : ""}${stats.averageR.toFixed(2)}R`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EntryRow({ entry }: { entry: JournalEntry }) {
  const isLong = entry.direction === "long";
  const inProfit = entry.profit >= 0;

  return (
    <li className="rounded-lg border border-white/10 bg-zinc-800/60 p-2.5 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className={`font-semibold ${isLong ? "text-emerald-400" : "text-rose-400"}`}>{isLong ? "LONG" : "SHORT"}</span>
          <span className="font-semibold text-zinc-100">{entry.pair}</span>
          {entry.context && <span className="text-zinc-500">Setup quality {entry.context.setupQuality.total}/100</span>}
        </div>
        <span className={`tabular-nums font-semibold ${inProfit ? "text-emerald-400" : "text-rose-400"}`}>
          {inProfit ? "+" : ""}
          {entry.profit.toFixed(2)}
          {entry.rMultiple !== null && ` (${entry.rMultiple >= 0 ? "+" : ""}${entry.rMultiple.toFixed(2)}R)`}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-zinc-500">
        <span>
          {REASON_LABEL[entry.reason]}
          {entry.context && ` · ${entry.context.regime.replace(/_/g, " ")}`}
        </span>
        <span className="tabular-nums">
          {formatPrice(entry.pair, entry.entryPrice)} &rarr; {formatPrice(entry.pair, entry.exitPrice)} &middot;{" "}
          {relativeTime(entry.closedAt)}
        </span>
      </div>
    </li>
  );
}

export function JournalPanel() {
  const { data } = usePolledResource("trade-journal", fetchJournal, POLL_INTERVAL_MS);

  return (
    <div className="flex flex-col gap-4">
      {data && <StatsSummary stats={data.stats} openCount={data.openCount} />}
      {data && <SignalFunnelSummary funnel={data.signalFunnel} />}
      {data && <BreakdownTable title="Performance by pair" breakdown={data.breakdownByPair} labelFor={(key) => key} />}
      {data && <BreakdownTable title="Performance by session" breakdown={data.breakdownBySession} labelFor={(key) => SESSION_LABEL[key] ?? key} />}

      <section className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
        <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Closed trades</h2>
        {!data || data.entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            No closed trades yet -- entries appear here once a trade this app opened closes.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
