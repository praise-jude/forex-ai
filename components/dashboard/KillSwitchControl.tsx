"use client";

import { useEffect, useState } from "react";

interface KillSwitchState {
  active: boolean;
  envControlled: boolean;
}

export function KillSwitchControl() {
  const [state, setState] = useState<KillSwitchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/kill-switch")
      .then((res) => res.json())
      .then(setState)
      .catch(() => {
        // Best-effort; the button just stays hidden until this succeeds.
      });
  }, []);

  async function toggle(action: "pause" | "resume") {
    // Stopping is always the safe direction and needs no confirmation. Resuming is the
    // one that re-arms real execution, so it gets a confirm dialog even though pausing
    // doesn't — the risk is asymmetric, not the actions.
    if (action === "resume" && !window.confirm("Resume trading? Buy/Sell buttons will be able to place real orders again.")) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Request failed");
        return;
      }
      setState(data);
    } catch {
      setError("Network error — try again");
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;

  if (state.envControlled) {
    return (
      <span className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-400">
        🛑 PAUSED (platform switch)
      </span>
    );
  }

  if (state.active) {
    return (
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-rose-400">{error}</span>}
        <button
          type="button"
          onClick={() => toggle("resume")}
          disabled={busy}
          className="rounded-lg border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-[0_3px_0_#065f46] transition disabled:cursor-not-allowed disabled:opacity-60"
        >
          ▶ RESUME TRADING
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-rose-400">{error}</span>}
      <button
        type="button"
        onClick={() => toggle("pause")}
        disabled={busy}
        className="rounded-lg border border-rose-800 bg-gradient-to-b from-rose-500 to-rose-700 px-3 py-1.5 text-xs font-bold text-white shadow-[0_3px_0_#8f1c1c] transition disabled:cursor-not-allowed disabled:opacity-60"
      >
        🛑 STOP ROBOT
      </button>
    </div>
  );
}
