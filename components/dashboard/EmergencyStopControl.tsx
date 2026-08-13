"use client";

import { useState } from "react";

interface CloseAllResult {
  account: "live" | "demo";
  closed: string[];
  failed: { id: string; reason: string }[];
}

/**
 * Pairs with KillSwitchControl (which stops new trades from being opened) -- this is
 * the destructive counterpart: closes every currently-open position on whichever
 * account a manual click would target. Gated behind its own confirmation dialog, same
 * "resuming/destructive actions get a confirm, pausing doesn't" asymmetry
 * KillSwitchControl already establishes.
 */
export function EmergencyStopControl({ account = "live" }: { account?: "live" | "demo" }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloseAllResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function closeAll() {
    if (!window.confirm(`Close ALL open ${account.toUpperCase()} positions? This cannot be undone.`)) return;

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/positions/close-all", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Request failed");
        return;
      }
      setResult(data);
    } catch {
      setError("Network error — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={closeAll}
        disabled={busy}
        className="rounded-lg border border-rose-800 bg-zinc-900 px-3 py-1.5 text-xs font-bold text-rose-400 transition hover:bg-rose-950/40 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Closing…" : "🛑 Close All Positions"}
      </button>
      {error && <span className="text-xs text-rose-400">{error}</span>}
      {result && (
        <span className="text-xs text-zinc-400">
          Closed {result.closed.length}
          {result.failed.length > 0 && <span className="text-amber-400"> · {result.failed.length} failed</span>}
        </span>
      )}
    </div>
  );
}
