"use client";

import { useEffect, useState } from "react";
import { formatCountdown, getAllSessionStatuses, getOverlapLabel, type SessionStatus } from "@/lib/market/marketSessions";

const NIGERIA_CLOCK_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const UTC_CLOCK_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function SessionCard({ status }: { status: SessionStatus }) {
  return (
    <div className="rounded-lg border border-white/10 bg-zinc-800/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-zinc-200">{status.label}</span>
        <span className="flex items-center gap-1.5 text-xs">
          <span className={`h-2 w-2 rounded-full ${status.isOpen ? "bg-emerald-400" : "bg-zinc-500"}`} />
          <span className={status.isOpen ? "text-emerald-400" : "text-zinc-500"}>{status.isOpen ? "OPEN" : "CLOSED"}</span>
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">{status.currencies.join(" / ")}</p>
      <p className="mt-2 text-xs text-zinc-400">
        Local session <span className="text-zinc-300">{status.localWindowLabel}</span>
      </p>
      <p className="text-xs text-zinc-400">
        {status.nextTransition === "open" ? "Opens" : "Closes"} in{" "}
        <span className="text-zinc-300">{formatCountdown(status.msUntilTransition)}</span> ({status.nigeriaTransitionLabel})
      </p>
    </div>
  );
}

/**
 * Purely informational -- shows which forex sessions are open right now, a live
 * Nigeria/UTC clock, and the London+New York overlap (the highest-liquidity window
 * among these four). Never reads or writes engine mode, execution, or risk state; see
 * lib/market/marketSessions.ts's own header comment on why this is fully independent
 * of the trading engine's own killzone logic.
 */
export function MarketSessionsPanel() {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Only ticks while the panel is actually open -- no permanent background timer for a
  // clock nobody is looking at.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  if (!open) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-700"
        >
          🌍 Market Sessions
        </button>
      </div>
    );
  }

  const statuses = getAllSessionStatuses(now);
  const overlap = getOverlapLabel(statuses);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(false)}>
      <div
        className="w-full max-w-lg rounded-xl border border-white/10 bg-zinc-900 p-5 text-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">🌍 Market Sessions</h2>
          <button type="button" onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-300">
            ✕
          </button>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-lg border border-white/10 bg-zinc-800/60 p-3 text-sm">
          <div>
            <p className="text-xs text-zinc-500">Nigeria (WAT, UTC+1, no DST)</p>
            <p className="font-mono text-lg text-zinc-100">{NIGERIA_CLOCK_FORMATTER.format(now)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-zinc-500">UTC</p>
            <p className="font-mono text-lg text-zinc-100">{UTC_CLOCK_FORMATTER.format(now)}</p>
          </div>
        </div>

        <div
          className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
            overlap ? "border-amber-500/20 bg-amber-500/10 text-amber-200" : "border-white/10 bg-zinc-800/60 text-zinc-400"
          }`}
        >
          {overlap ? (
            <span>
              🔥 <span className="font-semibold">{overlap}</span> overlap -- highest liquidity window right now.
            </span>
          ) : (
            <span>{statuses.some((s) => s.isOpen) ? `${statuses.filter((s) => s.isOpen).map((s) => s.label).join(", ")} open` : "No major session open right now."}</span>
          )}
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {statuses.map((status) => (
            <SessionCard key={status.id} status={status} />
          ))}
        </div>

        <p className="mt-3 text-xs text-zinc-500">
          High liquidity does not guarantee a valid trade. Wait for your Forex-AI strategy confirmation.
        </p>
      </div>
    </div>
  );
}
