"use client";

import { useState } from "react";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

type ManualMode = "signal_only" | "confirm";

interface ConfirmationModeResponse {
  manualMode: ManualMode;
  proposalTtlSeconds: number;
}

const POLL_INTERVAL_MS = 15000;

const MODE_BADGE_CLASSES: Record<ManualMode, string> = {
  signal_only: "bg-zinc-700/60 text-zinc-300",
  confirm: "bg-emerald-500/15 text-emerald-400",
};

const MODE_LABEL: Record<ManualMode, string> = {
  signal_only: "SIGNAL ONLY — no Buy/Sell button shown",
  confirm: "CONFIRM — Buy/Sell shown, approval required",
};

/**
 * Whether a fired signal shows a Buy/Sell (Approve) affordance at all. "confirm"
 * (default, see confirmationMode.ts) shows the Trade Proposal card with Approve/Reject;
 * "signal_only" shows the signal but nothing to act on from the dashboard -- this
 * control existed as an API-only setting with no UI anywhere before, which is exactly
 * why "why don't I have a Buy/Sell button" was unanswerable from inside the app itself.
 * No confirmation ceremony needed, unlike EngineModeControl's LIVE path -- both values
 * here are safe, neither auto-executes (see confirmationMode.ts's own doc comment).
 */
export function ConfirmationModeControl() {
  const { data, setData } = usePolledResource<ConfirmationModeResponse>(
    "confirmation-mode",
    () => fetch("/api/confirmation-mode").then((res) => res.json()),
    POLL_INTERVAL_MS
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setMode(manualMode: ManualMode) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/confirmation-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manualMode }),
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${MODE_BADGE_CLASSES[data.manualMode]}`}>
        {MODE_LABEL[data.manualMode]}
      </span>

      {error && <span className="text-xs text-rose-400">{error}</span>}

      {data.manualMode !== "confirm" && (
        <button
          type="button"
          onClick={() => setMode("confirm")}
          disabled={busy}
          className="rounded-md border border-sky-700 bg-sky-600/80 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Show Buy/Sell buttons
        </button>
      )}

      {data.manualMode !== "signal_only" && (
        <button
          type="button"
          onClick={() => setMode("signal_only")}
          disabled={busy}
          className="rounded-md border border-white/10 bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Signal Only (hide buttons)
        </button>
      )}
    </div>
  );
}
