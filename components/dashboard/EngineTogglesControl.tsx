"use client";

import { useEffect, useState } from "react";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

interface ExecutionConfigResponse {
  live: { rangeEngineEnabled: boolean; trendContinuationEnabled: boolean };
  demo: { rangeEngineEnabled: boolean; trendContinuationEnabled: boolean } | null;
}

const POLL_INTERVAL_MS = 15000;

/**
 * Real dashboard on/off switches for Range Engine and Trend Continuation (see
 * engineToggles.ts) -- replaces the env-var-only posture both engines launched with.
 * Targets the "live" account specifically: this deployment has no demo account
 * configured, so "live" is the only account either engine can ever actually run
 * against. Persists across restarts (unlike ExecutionPolicyControl's Auto-Execute
 * Floor, which is deliberately in-memory-only) -- see engineToggles.ts's own doc
 * comment for why that's the right call here specifically.
 *
 * Turning either of these on does NOT bypass autopilot lock, engine mode, or any other
 * real risk check -- it only lets that engine's own signals be CONSIDERED for
 * auto-execution at all, same as every other gate in autoExecutionListener.ts.
 */
export function EngineTogglesControl() {
  const { data, setData } = usePolledResource<ExecutionConfigResponse>(
    "execution-config",
    () => fetch("/api/execution-config").then((res) => res.json()),
    POLL_INTERVAL_MS
  );
  const [rangeEngineEnabled, setRangeEngineEnabled] = useState(false);
  const [trendContinuationEnabled, setTrendContinuationEnabled] = useState(false);
  const [busyEngine, setBusyEngine] = useState<"range_engine" | "trend_continuation" | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- seeding local toggle state from a
     polled external resource, not state derivable from render. */
  useEffect(() => {
    if (!data) return;
    setRangeEngineEnabled(data.live.rangeEngineEnabled);
    setTrendContinuationEnabled(data.live.trendContinuationEnabled);
  }, [data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function toggle(engine: "range_engine" | "trend_continuation", enabled: boolean) {
    setBusyEngine(engine);
    setError(null);
    try {
      const res = await fetch("/api/execution-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: "live", engine, enabled }),
      });
      const json = (await res.json()) as ExecutionConfigResponse & { error?: string };
      if (!res.ok) {
        setError(json.error ?? "Request failed");
        return;
      }
      setData(json);
    } catch {
      setError("Network error — try again");
    } finally {
      setBusyEngine(null);
    }
  }

  if (!data) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-800/60 px-2.5 py-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Engines</span>

      <label className="flex items-center gap-1.5 text-[11px] text-zinc-300">
        <input
          type="checkbox"
          checked={rangeEngineEnabled}
          disabled={busyEngine === "range_engine"}
          onChange={(e) => {
            setRangeEngineEnabled(e.target.checked);
            void toggle("range_engine", e.target.checked);
          }}
        />
        Range Engine
      </label>

      <label className="flex items-center gap-1.5 text-[11px] text-zinc-300">
        <input
          type="checkbox"
          checked={trendContinuationEnabled}
          disabled={busyEngine === "trend_continuation"}
          onChange={(e) => {
            setTrendContinuationEnabled(e.target.checked);
            void toggle("trend_continuation", e.target.checked);
          }}
        />
        Trend Engine
      </label>

      {error && <span className="text-[11px] text-rose-400">{error}</span>}
    </div>
  );
}
