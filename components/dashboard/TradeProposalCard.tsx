"use client";

import { useEffect, useRef, useState } from "react";
import type { ExecuteResponse } from "@/lib/market/executionClient";
import type { HigherTimeframeTrends, Signal } from "@/lib/market/types";
import { formatPrice } from "@/lib/market/format";
import { CONFLUENCE_LABEL } from "./SignalsPanel";

const TREND_ARROW: Record<HigherTimeframeTrends["d1"], string> = { bullish: "▲", bearish: "▼", neutral: "▬" };
const TREND_COLOR: Record<HigherTimeframeTrends["d1"], string> = {
  bullish: "text-emerald-400",
  bearish: "text-rose-400",
  neutral: "text-zinc-500",
};

const NEWS_LABEL: Record<Signal["newsStatus"], string> = {
  clear: "Low",
  high_impact_soon: "High",
  unavailable: "Unknown",
};

function secondsRemaining(createdAt: number, ttlSeconds: number, now: number): number {
  return Math.max(0, Math.ceil((createdAt + ttlSeconds * 1000 - now) / 1000));
}

// How long an EXPIRED card stays visible (showing the red label) before it closes
// itself -- long enough to actually register as "this one aged out," not so long it
// just sits there cluttering Active Signals once it's no longer actionable.
const AUTO_DISMISS_AFTER_EXPIRED_MS = 4000;

/**
 * The AI prepares the complete trade -- it never places it. Rendered in place of the
 * old immediate-execute Buy/Sell button once a proposal is opened; nothing here can
 * itself cause an order to reach MT5 except the explicit Approve action, which the
 * execute route re-validates from scratch (price drift, spread, every risk limit) and
 * will also reject outright once `ttlSeconds` after the signal's own createdAt has
 * passed -- the countdown below is a display of that same server-enforced rule, not a
 * separate client-only limit.
 */
export function TradeProposalCard({
  signal,
  trends,
  ttlSeconds,
  defaultRiskPct,
  busy,
  onApprove,
  onDismiss,
}: {
  signal: Signal;
  trends: HigherTimeframeTrends | undefined;
  ttlSeconds: number;
  defaultRiskPct: number;
  busy: boolean;
  onApprove: (riskPctOverride: number) => void;
  /** Closes the card -- called both after an explicit Reject (logged server-side, see
   * below) and after Wait (nothing logged, the signal stays in Active Signals so
   * clicking Buy/Sell again reopens a proposal for it until it ages out). */
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [editingRisk, setEditingRisk] = useState(false);
  const [riskInput, setRiskInput] = useState(String(defaultRiskPct));
  const [rejecting, setRejecting] = useState(false);

  // An explicit "no" -- logged server-side as a real decision (tradeJournal.ts's
  // SignalOutcome, part of the signal funnel), distinct from Wait below, which logs
  // nothing since nothing was actually decided.
  async function handleReject() {
    setRejecting(true);
    try {
      await fetch(`/api/signals/${signal.id}/reject`, { method: "POST" });
    } catch {
      // Best-effort -- the card closes either way; a missed log entry here only
      // affects the funnel stats display, never execution/risk.
    } finally {
      setRejecting(false);
      onDismiss();
    }
  }

  useEffect(() => {
    const tickId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tickId);
  }, []);

  const remaining = secondsRemaining(signal.createdAt, ttlSeconds, now);
  const expired = remaining <= 0;

  // Confirmed real user pain: an expired card previously just sat there forever with
  // Approve disabled, cluttering Active Signals until a manual page refresh cleared
  // it. Auto-closes itself a few seconds after expiring instead -- via a ref, not a
  // dependency, so the per-second `now` tick above (which re-renders this component
  // and could hand onDismiss a fresh closure) can't keep resetting this timer before
  // it ever fires; it only actually (re)starts on the one real transition that
  // matters, `expired` flipping false -> true.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    if (!expired) return;
    const timeoutId = setTimeout(() => onDismissRef.current(), AUTO_DISMISS_AFTER_EXPIRED_MS);
    return () => clearTimeout(timeoutId);
  }, [expired]);
  const isLong = signal.direction === "long";
  const riskPct = Number(riskInput) > 0 ? Number(riskInput) : defaultRiskPct;

  return (
    <div className="mt-2 rounded-lg border border-sky-800/60 bg-sky-950/20 p-2.5 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sky-300">
          {signal.pair} — {signal.timeframe} {isLong ? "BUY" : "SELL"} PROPOSAL
        </span>
        <span className={`tabular-nums font-semibold ${expired ? "text-rose-400" : "text-zinc-400"}`}>
          {expired ? "EXPIRED" : `${remaining}s`}
        </span>
      </div>

      {trends && (
        <div className="mt-1.5 flex items-center gap-2.5 text-[11px] text-zinc-500">
          <span>
            D1 <span className={TREND_COLOR[trends.d1]}>{TREND_ARROW[trends.d1]}</span>
          </span>
          <span>
            H4 <span className={TREND_COLOR[trends.h4]}>{TREND_ARROW[trends.h4]}</span>
          </span>
          <span>
            H1 <span className={TREND_COLOR[trends.h1]}>{TREND_ARROW[trends.h1]}</span>
          </span>
          <span className="ml-auto">Score {signal.confidence.toFixed(0)}/100</span>
        </div>
      )}

      <dl className="mt-2 grid grid-cols-4 gap-2 tabular-nums">
        <div>
          <dt className="text-zinc-500">Entry</dt>
          <dd className="text-zinc-200">{formatPrice(signal.pair, signal.entry)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">SL</dt>
          <dd className="text-rose-400">{formatPrice(signal.pair, signal.stopLoss)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">TP1</dt>
          <dd className="text-emerald-400">{formatPrice(signal.pair, signal.takeProfit)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">R:R</dt>
          <dd className="text-zinc-200">1:{signal.riskReward.toFixed(1)}</dd>
        </div>
      </dl>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span>News risk: {NEWS_LABEL[signal.newsStatus]}</span>
        <span>Session: {signal.session}</span>
        {signal.confluences.length > 0 && <span>{signal.confluences.map((c) => CONFLUENCE_LABEL[c]).join(" · ")}</span>}
      </div>

      <div className="mt-2 flex items-center gap-1.5 border-t border-white/10 pt-2">
        <span className="text-zinc-500">Risk</span>
        {editingRisk ? (
          <input
            type="number"
            min={0.01}
            step={0.01}
            autoFocus
            value={riskInput}
            onChange={(e) => setRiskInput(e.target.value)}
            onBlur={() => setEditingRisk(false)}
            className="w-16 rounded border border-white/10 bg-zinc-900 px-1 py-0.5 text-zinc-100 outline-none focus:border-sky-500"
          />
        ) : (
          <button type="button" onClick={() => setEditingRisk(true)} className="font-medium text-zinc-200 underline decoration-dotted">
            {riskPct}%
          </button>
        )}
        <span className="text-zinc-600">of equity</span>
      </div>

      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          disabled={busy || expired}
          onClick={() => onApprove(riskPct)}
          className="flex-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Placing order…" : "🟢 Approve & Execute"}
        </button>
        <button
          type="button"
          disabled={busy || rejecting}
          onClick={handleReject}
          className="rounded-md border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {rejecting ? "…" : "🔴 Reject"}
        </button>
        <button
          type="button"
          disabled={busy || rejecting}
          onClick={onDismiss}
          className="rounded-md border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ⏸ Wait
        </button>
      </div>
    </div>
  );
}

export function describeExecuteResponse(result: ExecuteResponse): string {
  switch (result.status) {
    case "filled":
      return `Filled @ ${result.trade.filledEntry ?? result.trade.requestedEntry}`;
    case "rejected":
      return `Rejected: ${result.trade.rejectReason ?? "unknown reason"}`;
    case "blocked":
      return `Blocked: ${result.reason}`;
    case "skipped_sizing":
      return `Skipped: ${result.reason}`;
    case "duplicate":
      return "Already executed";
    case "not_found":
      return "Signal expired";
    case "expired":
      return "Proposal expired — market moved on, wait for a new setup";
    case "confirmation_required":
      return "Could not confirm this trade — try again";
    case "network_error":
      return "Network error — try again";
    case "timeout":
      return "Broker is responding slowly — check your open positions before retrying, this trade may still go through.";
  }
}
