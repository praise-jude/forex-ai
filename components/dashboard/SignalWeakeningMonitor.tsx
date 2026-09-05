"use client";

import { useEffect, useRef } from "react";
import type { Pair, SignalRecheckResponse, Timeframe } from "@/lib/market/types";
import { usePolledResource } from "@/lib/hooks/usePolledResource";

const RECHECK_INTERVAL_MS = 10_000;
// A drop of at least this many confidence points from the original read counts as a
// real, meaningful weakening -- ordinary poll-to-poll noise in a still-valid setup
// shouldn't flip the banner on and off.
const WEAKENING_DROP_THRESHOLD = 15;

export type WeakeningLevel = "steady" | "weakening" | "invalidated";

/**
 * Section 11 of the spec: after a "Check a Pair" result shows a real BUY/SELL, keep
 * watching whether that specific setup still holds up. Polls the real
 * /api/signals/analyze/recheck endpoint every ~10s -- never a client-side decaying
 * number. "Invalidated" fires when either the original direction's own candidate no
 * longer independently qualifies at all, or the OPPOSITE direction has become a real,
 * qualifying signal in the meantime (a genuine reversal -- the same condition
 * positionInvalidation.ts already treats as a hard invalidation for an open position).
 * "Weakening" fires on a real, meaningful confidence drop that hasn't yet crossed into
 * full invalidation. Calls onLevelChange only on an actual level transition, so the
 * parent (OnDemandSignalWidget.tsx) can gate "Place Trade" once truly invalidated.
 * Mirrors forex-ai-mobile's SignalWeakeningMonitor.tsx.
 */
export function SignalWeakeningMonitor({
  pair,
  timeframe,
  direction,
  originalConfidence,
  onLevelChange,
}: {
  pair: Pair;
  timeframe: Timeframe;
  direction: "long" | "short";
  originalConfidence: number;
  onLevelChange?: (level: WeakeningLevel) => void;
}) {
  const key = `recheck:${pair}:${timeframe}:${direction}`;
  const { data } = usePolledResource<SignalRecheckResponse>(
    key,
    () =>
      fetch(`/api/signals/analyze/recheck?pair=${encodeURIComponent(pair)}&timeframe=${timeframe}&direction=${direction}`).then((res) => res.json()),
    RECHECK_INTERVAL_MS
  );

  // A pure, render-time derivation from the latest real poll response -- not stored as
  // its own state, so there's nothing to keep in sync; `level` is always exactly what
  // the most recent real data implies.
  let level: WeakeningLevel = "steady";
  if (data) {
    const currentConfidence = data.evaluation.status === "signal" ? data.evaluation.signal.confidence : 0;
    level =
      data.opposingSignal || data.evaluation.status !== "signal"
        ? "invalidated"
        : originalConfidence - currentConfidence >= WEAKENING_DROP_THRESHOLD
          ? "weakening"
          : "steady";
  }

  // The one real side effect here: telling the parent once the level actually
  // transitions (e.g. to gate "Place Trade" on invalidation) -- never fires again for
  // the same level on a later poll tick that didn't change anything.
  const previousLevelRef = useRef<WeakeningLevel>("steady");
  useEffect(() => {
    if (previousLevelRef.current === level) return;
    previousLevelRef.current = level;
    onLevelChange?.(level);
  }, [level, onLevelChange]);

  if (level === "steady") return null;

  return (
    <div className={`mt-1 rounded-lg border px-2.5 py-1.5 ${level === "invalidated" ? "border-rose-900 bg-rose-950/30" : "border-amber-800 bg-amber-950/25"}`}>
      <p className={`text-center text-[11px] font-extrabold ${level === "invalidated" ? "text-rose-400" : "text-amber-400"}`}>
        {level === "invalidated" ? `🔴 ${direction === "long" ? "BUY" : "SELL"} SETUP INVALIDATED` : "⚠️ SIGNAL WEAKENING"}
      </p>
    </div>
  );
}
