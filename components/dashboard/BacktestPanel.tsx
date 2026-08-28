"use client";

import { useState } from "react";
import { usePolledResource } from "@/lib/hooks/usePolledResource";
import { PAIRS, type Pair, type Timeframe } from "@/lib/market/types";
import { BACKTEST_TIMEFRAMES, DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS } from "@/lib/market/backtest/constants";
import { TIMEFRAME_MS } from "@/lib/market/timeframes";
// Type-only import -- erased at build time, so this never pulls backtestRunner.ts's
// real node:fs/MetaApi-SDK code into the client bundle.
import type { BacktestJob, BacktestRequest } from "@/lib/market/backtest/backtestRunner";

const POLL_INTERVAL_MS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Same lead-in the runner actually fetches (see backtestRunner.ts's LEAD_IN_DAYS) --
// used only to give the operator an honest ballpark of how many bars a run will
// actually touch before they submit, not a precise figure.
const PRIMARY_LEAD_IN_DAYS = 3;
// Above this rough bar-count estimate, warn before submitting -- "all pairs" at the max
// lookback on a fine timeframe is a genuinely long-running job.
const LARGE_RUN_BAR_WARNING = 100_000;

interface BacktestResponse {
  current: BacktestJob | null;
  history: BacktestJob[];
}

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

function DisclosureBanner({ realistic }: { realistic: boolean }) {
  return (
    <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3.5 py-2.5 text-xs text-amber-200">
      <p className="font-semibold text-amber-300">Backtest limitations — read before trusting these numbers</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-200/90">
        <li>Historical news blackout <strong>is</strong> simulated from a real historical economic calendar when a paid historical subscription (FMP) is configured — otherwise every bar reads &quot;clear&quot;, same as always.</li>
        <li>Currency-strength confirmation and early invalidation exit (an opposite-direction signal closing an open position early) <strong>are</strong> simulated from real historical data, in both modes below.</li>
        {realistic ? (
          <>
            <li>Position management <strong>is</strong> simulated (break-even, trailing stop, using this account&apos;s real configured triggers). Partial take-profit isn&apos;t simulated, even if enabled on the account.</li>
            <li>Sizing uses real lot-size math against a fixed hypothetical starting equity (not compounding across trades).</li>
            <li>Spread cost uses each candle&apos;s real broker-reported spread when available, falling back to a fixed fraction of the trade&apos;s own stop distance only when it isn&apos;t.</li>
          </>
        ) : (
          <>
            <li>Break-even and trailing stop are <strong>not</strong> simulated — only a fixed stop-loss vs. take-profit-1 (early invalidation still is, see above).</li>
            <li>Sizing uses a fixed hypothetical stake, not real lot sizing, spread, commission, or compounding.</li>
          </>
        )}
        <li>A running job lives in memory only — a server restart loses it, with no resume.</li>
      </ul>
      <p className="mt-1.5 font-medium">Results likely skew more optimistic than live trading.</p>
    </div>
  );
}

function RunForm({ onStart, busy, disabled }: { onStart: (request: BacktestRequest) => void; busy: boolean; disabled: boolean }) {
  const [selectedPairs, setSelectedPairs] = useState<Pair[]>([]);
  // Defaults to checked -- previously defaulted unchecked with nothing else selected
  // either, so a fresh page load showed "Run backtest" permanently disabled and "~0
  // bars to evaluate across 0 pairs" with no visual cue that a pair needed picking
  // first. Every real run this session has been "all 9 pairs" anyway.
  const [allPairs, setAllPairs] = useState(true);
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [engine, setEngine] = useState<"smc" | "mean_reversion">("smc");
  const [lookbackDays, setLookbackDays] = useState(DEFAULT_LOOKBACK_DAYS);
  const [realistic, setRealistic] = useState(false);

  function togglePair(pair: Pair) {
    setSelectedPairs((prev) => (prev.includes(pair) ? prev.filter((p) => p !== pair) : [...prev, pair]));
  }

  const effectivePairs = allPairs ? PAIRS : selectedPairs;
  const barsPerDay = DAY_MS / TIMEFRAME_MS[timeframe];
  const estimatedBars = Math.round(effectivePairs.length * (lookbackDays + PRIMARY_LEAD_IN_DAYS) * barsPerDay);
  const canSubmit = effectivePairs.length > 0 && !busy && !disabled;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onStart({ pairs: effectivePairs, timeframe, lookbackDays, realistic, engine });
      }}
      className="flex flex-col gap-3 rounded-xl border border-white/10 bg-zinc-900 p-3.5"
    >
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Pairs</p>
        <label className="mb-1.5 flex items-center gap-1.5 text-xs text-zinc-300">
          <input type="checkbox" checked={allPairs} onChange={(e) => setAllPairs(e.target.checked)} />
          All pairs ({PAIRS.length})
        </label>
        {!allPairs && (
          <div className="flex flex-wrap gap-1.5">
            {PAIRS.map((pair) => (
              <button
                key={pair}
                type="button"
                onClick={() => togglePair(pair)}
                className={`rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                  selectedPairs.includes(pair)
                    ? "border-sky-600 bg-sky-600/20 text-sky-300"
                    : "border-white/10 bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                }`}
              >
                {pair}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Engine
          <select
            value={engine}
            onChange={(e) => setEngine(e.target.value as "smc" | "mean_reversion")}
            className="rounded border border-white/10 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          >
            <option value="smc">SMC</option>
            <option value="mean_reversion">Range engine</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Timeframe
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as Timeframe)}
            className="rounded border border-white/10 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          >
            {BACKTEST_TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Lookback (days, max {MAX_LOOKBACK_DAYS})
          <input
            type="number"
            min={1}
            max={MAX_LOOKBACK_DAYS}
            value={lookbackDays}
            onChange={(e) => setLookbackDays(Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Number(e.target.value) || 1)))}
            className="w-24 rounded border border-white/10 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
        </label>

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md border border-sky-700 bg-sky-600/80 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Starting…" : "Run backtest"}
        </button>
      </div>

      <label className="flex items-start gap-1.5 text-xs text-zinc-300">
        <input type="checkbox" checked={realistic} onChange={(e) => setRealistic(e.target.checked)} className="mt-0.5" />
        <span>
          <span className="font-medium">Realistic mode</span>
          <span className="text-zinc-500"> — simulates break-even/trailing-stop, real lot-size-based sizing, and spread cost, using this account&apos;s actual configured triggers. Slower to start (fetches real symbol specs first).</span>
        </span>
      </label>

      <p className="text-[11px] text-zinc-500">
        ~{estimatedBars.toLocaleString()} bars to evaluate across {effectivePairs.length || 0} pair{effectivePairs.length === 1 ? "" : "s"}.
        {estimatedBars > LARGE_RUN_BAR_WARNING && (
          <span className="ml-1 font-medium text-amber-400">That&apos;s a large run — it may take a while.</span>
        )}
      </p>
    </form>
  );
}

function ProgressView({ job, onCancel }: { job: BacktestJob; onCancel: () => void }) {
  const barPct = job.progress.barsTotal > 0 ? Math.round((job.progress.barsEvaluated / job.progress.barsTotal) * 100) : 0;
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-zinc-200">
          {job.status === "queued" ? "Queued…" : "Running…"} pair {job.progress.pairsDone + 1} of {job.progress.pairsTotal}
        </span>
        <button type="button" onClick={onCancel} className="text-xs text-rose-400 hover:text-rose-300">
          Cancel
        </button>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full bg-sky-500 transition-all" style={{ width: `${barPct}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">
        {job.progress.barsEvaluated.toLocaleString()} / {job.progress.barsTotal.toLocaleString()} bars in the current pair
      </p>
    </div>
  );
}

function ResultsView({ job }: { job: BacktestJob }) {
  if (job.status === "failed") {
    return (
      <div className="rounded-xl border border-rose-800 bg-rose-950/40 p-3.5 text-sm text-rose-300">
        Backtest failed: {job.error}
      </div>
    );
  }
  if (!job.result) return null;
  const { stats, profitFactor, sharpeRatio, streaks, scoreRangeBreakdown, openAtWindowEnd, perPair } = job.result;
  const averageRTone = stats.averageR === null ? undefined : stats.averageR >= 0 ? "positive" : "negative";
  const realistic = job.request.realistic === true;
  // The run form's own Engine dropdown is just the NEXT run's config -- switching it
  // after submitting doesn't change what a past result was actually produced by. This
  // badge is the only place these numbers are unambiguously labeled by the engine that
  // actually ran, not whatever the dropdown happens to currently show.
  const engineLabel = job.request.engine === "mean_reversion" ? "Range engine" : "SMC";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-zinc-700/60 px-2 py-0.5 text-[11px] font-semibold text-zinc-300">{engineLabel}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            realistic ? "bg-sky-500/15 text-sky-400" : "bg-zinc-700/60 text-zinc-400"
          }`}
        >
          {realistic ? "Realistic mode" : "Idealized mode"}
        </span>
      </div>
      <DisclosureBanner realistic={realistic} />

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile label="Trades" value={String(stats.count)} hint={openAtWindowEnd > 0 ? `${openAtWindowEnd} still open at window end` : undefined} />
        <StatTile label="Win rate" value={stats.count === 0 ? "—" : `${stats.winRate.toFixed(0)}%`} />
        <StatTile label="Record" value={`${stats.wins}W / ${stats.losses}L`} />
        <StatTile
          label="Average R"
          value={stats.averageR === null ? "—" : `${stats.averageR >= 0 ? "+" : ""}${stats.averageR.toFixed(2)}R`}
          tone={averageRTone}
        />
        <StatTile label="Max drawdown" value={stats.maxDrawdownR === null ? "—" : `${stats.maxDrawdownR.toFixed(2)}R`} tone="negative" />
        <StatTile label="Profit factor" value={profitFactor === null ? "—" : profitFactor.toFixed(2)} />
        <StatTile label="Sharpe (per-trade)" value={sharpeRatio === null ? "—" : sharpeRatio.toFixed(2)} />
        <StatTile label="Win / loss streaks" value={`${streaks.maxConsecutiveWins} / ${streaks.maxConsecutiveLosses}`} />
      </div>

      <div className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Results by signal score</h3>
        <table className="w-full text-left text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="pb-1 font-medium">Score</th>
              <th className="pb-1 font-medium">Trades</th>
              <th className="pb-1 font-medium">Win rate</th>
              <th className="pb-1 font-medium">Average R</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {scoreRangeBreakdown.map((bucket) => (
              <tr key={bucket.range} className="border-t border-white/5">
                <td className="py-1">{bucket.range}</td>
                <td className="py-1 tabular-nums">{bucket.count}</td>
                <td className="py-1 tabular-nums">{bucket.count === 0 ? "—" : `${bucket.winRate.toFixed(0)}%`}</td>
                <td className="py-1 tabular-nums">{bucket.averageR === null ? "—" : `${bucket.averageR >= 0 ? "+" : ""}${bucket.averageR.toFixed(2)}R`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {perPair.length > 1 && (
        <div className="rounded-xl border border-white/10 bg-zinc-900 p-3.5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Results by pair</h3>
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="pb-1 font-medium">Pair</th>
                <th className="pb-1 font-medium">Trades</th>
                <th className="pb-1 font-medium">Win rate</th>
                <th className="pb-1 font-medium">Average R</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {perPair.map(({ pair, stats: pairStats }) => (
                <tr key={pair} className="border-t border-white/5">
                  <td className="py-1 font-medium text-zinc-100">{pair}</td>
                  <td className="py-1 tabular-nums">{pairStats.count}</td>
                  <td className="py-1 tabular-nums">{pairStats.count === 0 ? "—" : `${pairStats.winRate.toFixed(0)}%`}</td>
                  <td className="py-1 tabular-nums">
                    {pairStats.averageR === null ? "—" : `${pairStats.averageR >= 0 ? "+" : ""}${pairStats.averageR.toFixed(2)}R`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function BacktestPanel() {
  const { data, setData, refetch } = usePolledResource<BacktestResponse>(
    "backtest",
    () => fetch("/api/backtest").then((res) => res.json()),
    POLL_INTERVAL_MS
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(request: BacktestRequest) {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? "Could not start backtest");
        return;
      }
      if (data) setData({ ...data, current: json });
      refetch();
    } catch {
      setError("Network error — try again");
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!data?.current) return;
    await fetch(`/api/backtest/${data.current.id}`, { method: "DELETE" }).catch(() => {});
    refetch();
  }

  const current = data?.current ?? null;
  const isActive = current?.status === "queued" || current?.status === "running";
  const showResults = current && (current.status === "completed" || current.status === "failed" || current.status === "cancelled");

  return (
    <div className="flex flex-col gap-3">
      <RunForm onStart={start} busy={starting} disabled={isActive} />
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {isActive && current && <ProgressView job={current} onCancel={cancel} />}
      {showResults && current && <ResultsView job={current} />}
    </div>
  );
}
