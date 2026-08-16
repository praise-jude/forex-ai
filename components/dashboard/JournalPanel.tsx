"use client";

import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { ConfluenceBreakdownBucket, JournalEntry, PerformanceStats, SignalFunnelStats } from "@/lib/market/tradeJournal";
import type { SlippageStats } from "@/lib/market/slippage";
import { ProgressBar } from "./ProgressBar";
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
  /** "Which market regime is my SMC strategy actually working in" -- effectively
   * SMC-only, see getPerformanceBreakdown's own doc comment in tradeJournal.ts. */
  breakdownByRegime: Record<string, PerformanceStats>;
  /** "Which confluences actually predict wins" -- see getConfluenceBreakdown in
   * tradeJournal.ts. Always over the full ledger. */
  breakdownByConfluence: ConfluenceBreakdownBucket[];
  /** "Is the broker filling me at a worse price than I asked for" -- see
   * getSlippageStats in lib/market/slippage.ts. Covers every filled trade (open or
   * closed), not just the closed-trade entries above. */
  slippage: SlippageStats;
  slippageByPair: Record<string, SlippageStats>;
}

// Mirrors tradeJournal.ts's own DEFAULT_CONFLUENCE_MIN_SAMPLES -- duplicated (not
// imported) for the same reason BacktestPanel.tsx type-only-imports backtestRunner.ts:
// tradeJournal.ts pulls in node:fs at module scope, which can't end up in this client
// component's bundle. Purely a display label; the server is the actual source of truth
// for each bucket's real "ok"/"insufficient_data" status.
const CONFLUENCE_MIN_SAMPLES = 10;

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

const REGIME_LABEL: Record<string, string> = {
  news_driven: "News-driven",
  breakout: "Breakout",
  strong_uptrend: "Strong uptrend",
  strong_downtrend: "Strong downtrend",
  high_volatility: "High volatility",
  low_volatility: "Low volatility",
  consolidation: "Consolidation",
  range: "Range",
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

interface EquityPoint {
  time: number;
  cumulativeR: number;
}

/** Chronological cumulative R across every closed trade with a computed rMultiple --
 * same exclusion (null rMultiple) as getPerformanceStats' own R-based figures, and the
 * same chronological-sort-then-accumulate approach tradeJournal.ts's own maxDrawdownR
 * uses internally, just kept as a full running series here instead of collapsing to one
 * peak-to-trough number. */
function buildEquityCurve(entries: JournalEntry[]): EquityPoint[] {
  const withR = entries
    .filter((e): e is JournalEntry & { rMultiple: number } => e.rMultiple !== null)
    .slice()
    .sort((a, b) => a.closedAt - b.closedAt);

  let cumulative = 0;
  return withR.map((e) => {
    cumulative += e.rMultiple;
    return { time: e.closedAt, cumulativeR: cumulative };
  });
}

const CHART_WIDTH = 600;
const CHART_HEIGHT = 160;
const CHART_PADDING = { top: 14, right: 8, bottom: 14, left: 8 };
const EMERALD = "#34d399";
const ROSE = "#fb7185";

/**
 * The one "is this thing actually working over time" view the journal was missing --
 * everything else here is a table or a tile, this is the only place performance reads
 * as a trajectory. Single series (cumulative R), so no legend -- the title names it and
 * the line's color (emerald/rose) already carries the one bit of identity that matters
 * (net positive vs. net negative), matching this file's own established StatTile/
 * BreakdownTable convention of coloring by sign. A hand-rolled SVG line+area, not
 * lightweight-charts (that library is reserved for PriceChart.tsx's real candlestick
 * view) -- this is a single simple series, not worth the extra bundle weight.
 */
function EquityCurveChart({ entries }: { entries: JournalEntry[] }) {
  const points = useMemo(() => buildEquityCurve(entries), [entries]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

  const minTime = points[0]?.time ?? 0;
  const maxTime = points[points.length - 1]?.time ?? 1;
  const timeRange = Math.max(maxTime - minTime, 1);

  const values = points.map((p) => p.cumulativeR);
  const minR = Math.min(0, ...values);
  const maxR = Math.max(0, ...values);
  const rRange = Math.max(maxR - minR, 1e-6);

  function x(time: number): number {
    return CHART_PADDING.left + ((time - minTime) / timeRange) * plotWidth;
  }
  function y(value: number): number {
    return CHART_PADDING.top + (1 - (value - minR) / rRange) * plotHeight;
  }

  function handleMove(e: ReactMouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || points.length === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * CHART_WIDTH;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(x(points[i].time) - px);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    setHoverIndex(nearest);
  }

  if (points.length < 2) {
    return (
      <div>
        <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Equity curve (cumulative R)</h2>
        <div className="rounded-xl border border-white/10 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
          Needs at least 2 closed trades with a computed R multiple to plot a curve.
        </div>
      </div>
    );
  }

  const last = points[points.length - 1];
  const positive = last.cumulativeR >= 0;
  const color = positive ? EMERALD : ROSE;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.time).toFixed(1)},${y(p.cumulativeR).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${x(last.time).toFixed(1)},${y(0).toFixed(1)} L${x(points[0].time).toFixed(1)},${y(0).toFixed(1)} Z`;

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  return (
    <div>
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Equity curve (cumulative R)</h2>
        <span className={`text-xs font-semibold tabular-nums ${positive ? "text-emerald-400" : "text-rose-400"}`}>
          {positive ? "+" : ""}
          {last.cumulativeR.toFixed(2)}R
        </span>
      </div>
      <div className="rounded-xl border border-white/10 bg-zinc-900 p-3">
        <div className="relative">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            className="w-full"
            style={{ height: "auto", display: "block" }}
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <line
              x1={CHART_PADDING.left}
              x2={CHART_WIDTH - CHART_PADDING.right}
              y1={y(0)}
              y2={y(0)}
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={1}
            />
            <path d={areaPath} fill={color} fillOpacity={0.1} stroke="none" />
            <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(last.time)} cy={y(last.cumulativeR)} r={4} fill={color} stroke="#18181b" strokeWidth={2} />
            {hovered && (
              <>
                <line
                  x1={x(hovered.time)}
                  x2={x(hovered.time)}
                  y1={CHART_PADDING.top}
                  y2={CHART_HEIGHT - CHART_PADDING.bottom}
                  stroke="rgba(255,255,255,0.2)"
                  strokeWidth={1}
                />
                <circle cx={x(hovered.time)} cy={y(hovered.cumulativeR)} r={4} fill={color} stroke="#18181b" strokeWidth={2} />
              </>
            )}
          </svg>
          {hovered && (
            <div
              className="pointer-events-none absolute rounded-md border border-white/10 bg-zinc-950 px-2 py-1 text-[11px] whitespace-nowrap text-zinc-300 shadow-lg"
              style={{
                left: `${Math.min(85, Math.max(2, (x(hovered.time) / CHART_WIDTH) * 100))}%`,
                top: `${Math.max(2, (y(hovered.cumulativeR) / CHART_HEIGHT) * 100 - 16)}%`,
              }}
            >
              <span className={`font-semibold ${hovered.cumulativeR >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {hovered.cumulativeR >= 0 ? "+" : ""}
                {hovered.cumulativeR.toFixed(2)}R
              </span>
              <span className="ml-1.5 text-zinc-500">{new Date(hovered.time).toLocaleDateString()}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const CONFLUENCE_LABEL: Record<string, string> = {
  liquidity_sweep: "Liquidity sweep",
  bos: "Break of structure",
  choch: "Change of character",
  fvg: "Fair value gap",
  order_block: "Order block",
  killzone: "Killzone timing",
  ema_trend: "EMA trend",
  rsi_momentum: "RSI momentum",
  macd_crossover: "MACD crossover",
  volume: "Volume",
  trend_ema_stack: "EMA stack trend",
  market_structure: "Market structure",
  adx: "ADX strength",
  candlestick: "Candlestick pattern",
  multi_timeframe: "Multi-timeframe",
  supertrend: "Supertrend",
  currency_strength: "Currency strength",
  rsi_divergence: "RSI divergence",
};

/**
 * "Which confluences actually predict wins" -- a dedicated table (not BreakdownTable
 * above) because buckets aren't mutually exclusive and can be "insufficient_data",
 * which needs an honest flagged cell instead of a misleadingly-precise percentage from
 * a handful of trades. Rows already arrive sorted by sample size (see
 * getConfluenceBreakdown), so the most-evidenced factors surface first regardless of
 * status.
 */
function ConfluenceBreakdownTable({ breakdown }: { breakdown: ConfluenceBreakdownBucket[] }) {
  if (breakdown.length === 0) return null;

  return (
    <div>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Which confluences actually predict wins</h2>
      <p className="mb-2.5 text-[11px] text-zinc-500">
        Real win rate/average R for closed trades where each confluence was present on the signal -- not a static score,
        an outcome. Buckets under {CONFLUENCE_MIN_SAMPLES} trades are shown but flagged, not hidden, since a handful of
        trades can look like edge by chance.
      </p>
      <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-900">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/10 text-left text-zinc-500">
              <th className="px-3 py-2 font-medium">Confluence</th>
              <th className="px-3 py-2 font-medium">Trades</th>
              <th className="px-3 py-2 font-medium">Win rate</th>
              <th className="px-3 py-2 font-medium">Avg R</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((bucket) => (
              <tr key={bucket.confluence} className="border-b border-white/5 last:border-0">
                <td className="px-3 py-2 font-medium text-zinc-200">{CONFLUENCE_LABEL[bucket.confluence] ?? bucket.confluence}</td>
                <td className="px-3 py-2 tabular-nums text-zinc-300">{bucket.sampleSize}</td>
                {bucket.status === "insufficient_data" ? (
                  <td colSpan={2} className="px-3 py-2">
                    <ProgressBar value={bucket.sampleSize} max={CONFLUENCE_MIN_SAMPLES} label={`${bucket.sampleSize} of ${CONFLUENCE_MIN_SAMPLES}`} />
                  </td>
                ) : (
                  <>
                    <td className="px-3 py-2 tabular-nums text-zinc-300">{bucket.winRate!.toFixed(0)}%</td>
                    <td
                      className={`px-3 py-2 tabular-nums ${
                        bucket.averageR === null ? "text-zinc-500" : bucket.averageR >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {bucket.averageR === null ? "—" : `${bucket.averageR >= 0 ? "+" : ""}${bucket.averageR.toFixed(2)}R`}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatPips(pips: number | null): string {
  return pips === null ? "—" : `${pips >= 0 ? "+" : ""}${pips.toFixed(1)} pips`;
}

/**
 * "Is the broker filling me at a worse price than I asked for" -- requestedEntry vs.
 * filledEntry was already recorded on every filled trade but never surfaced. Positive
 * pips = adverse (cost you); negative = favorable (helped you) -- matches this file's
 * StatTile tone convention (rose for adverse/negative outcomes, emerald for favorable).
 */
function SlippageSummary({ stats }: { stats: SlippageStats }) {
  if (stats.count === 0) return null;
  const avgTone = stats.averagePips === null || stats.averagePips === 0 ? undefined : stats.averagePips > 0 ? "negative" : "positive";
  const worstIsAdverse = stats.worstAdversePips !== null && stats.worstAdversePips > 0;
  const bestIsFavorable = stats.bestFavorablePips !== null && stats.bestFavorablePips < 0;

  return (
    <div>
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Execution quality (slippage)</h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
        <StatTile label="Fills measured" value={String(stats.count)} />
        <StatTile label="Average slippage" value={formatPips(stats.averagePips)} tone={avgTone} />
        <StatTile label="Adverse fills" value={`${stats.adverseRate.toFixed(0)}%`} tone={stats.adverseRate > 50 ? "negative" : undefined} />
        <StatTile label="Worst adverse" value={formatPips(stats.worstAdversePips)} tone={worstIsAdverse ? "negative" : "positive"} />
        <StatTile label="Best favorable" value={formatPips(stats.bestFavorablePips)} tone={bestIsFavorable ? "positive" : "negative"} />
      </div>
    </div>
  );
}

function SlippageBreakdownTable({ breakdown }: { breakdown: Record<string, SlippageStats> }) {
  const rows = Object.entries(breakdown).sort((a, b) => b[1].count - a[1].count);
  if (rows.length === 0) return null;

  return (
    <div>
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Slippage by pair</h2>
      <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-900">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/10 text-left text-zinc-500">
              <th className="px-3 py-2 font-medium">Pair</th>
              <th className="px-3 py-2 font-medium">Fills</th>
              <th className="px-3 py-2 font-medium">Avg slippage</th>
              <th className="px-3 py-2 font-medium">Adverse rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([pair, stats]) => (
              <tr key={pair} className="border-b border-white/5 last:border-0">
                <td className="px-3 py-2 font-medium text-zinc-200">{pair}</td>
                <td className="px-3 py-2 tabular-nums text-zinc-300">{stats.count}</td>
                <td
                  className={`px-3 py-2 tabular-nums ${
                    stats.averagePips === null || stats.averagePips === 0
                      ? "text-zinc-500"
                      : stats.averagePips > 0
                        ? "text-rose-400"
                        : "text-emerald-400"
                  }`}
                >
                  {formatPips(stats.averagePips)}
                </td>
                <td className="px-3 py-2 tabular-nums text-zinc-300">{stats.adverseRate.toFixed(0)}%</td>
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
      {data && <EquityCurveChart entries={data.entries} />}
      {data && <SignalFunnelSummary funnel={data.signalFunnel} />}
      {data && <BreakdownTable title="Performance by pair" breakdown={data.breakdownByPair} labelFor={(key) => key} />}
      {data && <BreakdownTable title="Performance by session" breakdown={data.breakdownBySession} labelFor={(key) => SESSION_LABEL[key] ?? key} />}
      {data && (
        <BreakdownTable title="Performance by market regime (SMC signals only)" breakdown={data.breakdownByRegime} labelFor={(key) => REGIME_LABEL[key] ?? key} />
      )}
      {data && <ConfluenceBreakdownTable breakdown={data.breakdownByConfluence} />}
      {data && <SlippageSummary stats={data.slippage} />}
      {data && <SlippageBreakdownTable breakdown={data.slippageByPair} />}

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
