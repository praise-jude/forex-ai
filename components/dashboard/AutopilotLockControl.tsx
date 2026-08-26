"use client";

import { useState } from "react";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

interface AutopilotLockResponse {
  locked: boolean;
}

const POLL_INTERVAL_MS = 7000;

/**
 * The operator's own dedicated on/off switch for the autopilot -- distinct from
 * KillSwitchControl (which also blocks manual Buy/Sell clicks) and EngineModeControl
 * (analysis/demo/live): locking here only stops autoExecutionListener.ts from opening a
 * NEW trade on its own. Manual clicks, TradingView, and managing positions already open
 * (break-even/trailing/invalidation-close) all keep working while locked.
 */
export function AutopilotLockControl() {
  const { data, setData } = usePolledResource<AutopilotLockResponse>(
    "autopilot-lock",
    () => fetch("/api/autopilot-lock").then((res) => res.json()),
    POLL_INTERVAL_MS
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(action: "lock" | "unlock") {
    // Locking is the safe direction and needs no confirmation, same asymmetry
    // KillSwitchControl already establishes for pause/resume.
    if (action === "unlock" && !window.confirm("Unlock the autopilot? It will resume opening trades on its own.")) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/autopilot-lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? "Request failed");
        return;
      }
      setData(json);
    } catch {
      setError("Network error — try again");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;

  if (data.locked) {
    return (
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-rose-400">{error}</span>}
        <button
          type="button"
          onClick={() => toggle("unlock")}
          disabled={busy}
          className="rounded-lg border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs font-bold text-white shadow-[0_3px_0_#92400e] transition disabled:cursor-not-allowed disabled:opacity-60"
        >
          🔒 AUTOPILOT LOCKED — Unlock
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-rose-400">{error}</span>}
      <button
        type="button"
        onClick={() => toggle("lock")}
        disabled={busy}
        className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        🔓 Lock Autopilot
      </button>
    </div>
  );
}
