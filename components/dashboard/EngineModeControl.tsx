"use client";

import { useState } from "react";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

type EngineMode = "analysis" | "demo" | "live";

interface EngineModeResponse {
  mode: EngineMode;
  demoConfigured: boolean;
}

const LIVE_CONFIRMATION_PHRASE = "ENABLE LIVE TRADING";
const POLL_INTERVAL_MS = 7000;

const MODE_BADGE_CLASSES: Record<EngineMode, string> = {
  analysis: "bg-zinc-700/60 text-zinc-300",
  demo: "bg-sky-500/15 text-sky-400",
  live: "animate-pulse bg-rose-500/20 text-rose-400",
};

const MODE_LABEL: Record<EngineMode, string> = {
  analysis: "MODE: ANALYSIS ONLY",
  demo: "MODE: DEMO AUTO-TRADE",
  live: "MODE: LIVE AUTO-TRADE",
};

export function EngineModeControl() {
  // Shared with useVoiceAssistant.ts, which polls this exact same "engine-mode" key --
  // usePolledResource dedupes them into a single interval/request instead of two.
  const { data, setData } = usePolledResource<EngineModeResponse>(
    "engine-mode",
    () => fetch("/api/engine-mode").then((res) => res.json()),
    POLL_INTERVAL_MS
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [phraseInput, setPhraseInput] = useState("");

  async function setMode(mode: EngineMode, confirmationPhrase?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/engine-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, confirmationPhrase }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message ?? "Request failed");
        return;
      }
      if (data) setData({ ...data, mode: json.mode });
      setShowLiveConfirm(false);
      setPhraseInput("");
    } catch {
      setError("Network error — try again");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;

  return (
    <div className="flex items-center gap-2">
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${MODE_BADGE_CLASSES[data.mode]}`}>
        {MODE_LABEL[data.mode]}
      </span>

      {error && <span className="text-xs text-rose-400">{error}</span>}

      {data.mode !== "analysis" && (
        <button
          type="button"
          onClick={() => setMode("analysis")}
          disabled={busy}
          className="rounded-md border border-white/10 bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Back to Analysis
        </button>
      )}

      {data.demoConfigured && data.mode !== "demo" && (
        <button
          type="button"
          onClick={() => setMode("demo")}
          disabled={busy}
          className="rounded-md border border-sky-700 bg-sky-600/80 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Enable Demo
        </button>
      )}

      {data.mode !== "live" && !showLiveConfirm && (
        <button
          type="button"
          onClick={() => setShowLiveConfirm(true)}
          disabled={busy}
          className="rounded-md border border-rose-800 bg-gradient-to-b from-rose-500 to-rose-700 px-2.5 py-1 text-xs font-bold text-white shadow-[0_3px_0_#8f1c1c] transition disabled:cursor-not-allowed disabled:opacity-60"
        >
          Enable Live&hellip;
        </button>
      )}

      {showLiveConfirm && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-800 bg-rose-950/40 px-2.5 py-1.5">
          <span className="text-[11px] text-rose-300">
            Type <code className="font-mono font-bold">{LIVE_CONFIRMATION_PHRASE}</code> to place real orders automatically:
          </span>
          <input
            type="text"
            value={phraseInput}
            onChange={(e) => setPhraseInput(e.target.value)}
            className="w-44 rounded border border-rose-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-100 outline-none focus:border-rose-400"
            autoFocus
          />
          <button
            type="button"
            onClick={() => setMode("live", phraseInput)}
            disabled={busy || phraseInput.trim() !== LIVE_CONFIRMATION_PHRASE}
            className="rounded-md bg-rose-600 px-2 py-0.5 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={() => {
              setShowLiveConfirm(false);
              setPhraseInput("");
            }}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
