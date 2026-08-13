"use client";

import { useEffect, useState } from "react";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

interface ExecutionPolicyResponse {
  minTier: "buy" | "strong_buy";
  minRiskReward: number;
}

const POLL_INTERVAL_MS = 15000;

/**
 * Operator-only selectivity control for auto-execution -- raises the floor above what
 * already qualifies as a fireable signal (buy/strong_buy tier, see executionPolicy.ts).
 * Can only ever make execution MORE selective than the shipped default, so unlike
 * EngineModeControl's LIVE path, no confirmation ceremony is needed here.
 */
export function ExecutionPolicyControl() {
  const { data, setData } = usePolledResource<ExecutionPolicyResponse>(
    "execution-policy",
    () => fetch("/api/execution-policy").then((res) => res.json()),
    POLL_INTERVAL_MS
  );
  const [minTier, setMinTier] = useState<"buy" | "strong_buy">("buy");
  const [minRiskRewardInput, setMinRiskRewardInput] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Local form state only ever seeds from the polled value, never fights the user's
  // in-progress edits on every poll tick -- same one-way "restore, don't fight" shape
  // as Dashboard.tsx's own selected-pair restore effect.
  /* eslint-disable react-hooks/set-state-in-effect -- seeding local form state from a
     polled external resource, not state derivable from render. */
  useEffect(() => {
    if (!data) return;
    setMinTier(data.minTier);
    setMinRiskRewardInput(String(data.minRiskReward));
  }, [data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function save() {
    const minRiskReward = Number(minRiskRewardInput);
    if (!Number.isFinite(minRiskReward) || minRiskReward < 0) {
      setError("Risk/reward must be a number >= 0");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/execution-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minTier, minRiskReward }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? "Request failed");
        return;
      }
      setData(json);
      setSaved(true);
    } catch {
      setError("Network error — try again");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;

  const dirty = minTier !== data.minTier || minRiskRewardInput !== String(data.minRiskReward);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-800/60 px-2.5 py-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Auto-execute floor</span>

      <select
        value={minTier}
        onChange={(e) => {
          setMinTier(e.target.value as "buy" | "strong_buy");
          setSaved(false);
        }}
        className="rounded border border-white/10 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100 outline-none focus:border-zinc-500"
      >
        <option value="buy">Buy or higher</option>
        <option value="strong_buy">Strong buy only</option>
      </select>

      <span className="text-[11px] text-zinc-500">R:R &ge;</span>
      <input
        type="number"
        min={0}
        step={0.1}
        value={minRiskRewardInput}
        onChange={(e) => {
          setMinRiskRewardInput(e.target.value);
          setSaved(false);
        }}
        className="w-16 rounded border border-white/10 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100 outline-none focus:border-zinc-500"
      />

      <button
        type="button"
        onClick={save}
        disabled={busy || !dirty}
        className="rounded-md border border-white/10 bg-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save"}
      </button>

      {saved && !dirty && <span className="text-[11px] text-emerald-400">Saved</span>}
      {error && <span className="text-[11px] text-rose-400">{error}</span>}
    </div>
  );
}
