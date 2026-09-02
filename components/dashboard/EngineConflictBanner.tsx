"use client";

import { useMemo } from "react";
import type { PredictionUpdate, SignalSource } from "@/lib/market/types";
import { detectEngineConflicts } from "@/lib/market/engineConflict";

const SOURCE_LABEL: Partial<Record<SignalSource, string>> = {
  smc: "SMC",
  mean_reversion: "Range",
};

/**
 * Warns when two engines have BOTH fired a real signal on the same pair/timeframe in
 * opposing directions right now -- e.g. SMC says BUY while the range engine says SELL on
 * the same EUR/USD M15 read. See engineConflict.ts's own doc comment for why this is
 * deliberately narrow (only actual fired signals, never a no-trade reason's implied
 * direction). Renders nothing when there's no active conflict, same posture as
 * RiskGuardianBanner.
 */
export function EngineConflictBanner({ predictions }: { predictions: PredictionUpdate[] }) {
  const conflicts = useMemo(() => detectEngineConflicts(predictions), [predictions]);
  if (conflicts.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-amber-800 bg-amber-950/40 px-3.5 py-2 text-sm">
      {conflicts.map((conflict) => (
        <div key={`${conflict.pair}:${conflict.timeframe}`}>
          <span className="font-bold text-amber-400">⚠️ ENGINE CONFLICT</span>
          <span className="ml-2 text-amber-300">
            {conflict.pair} {conflict.timeframe} --{" "}
            {conflict.sides.map((side, i) => (
              <span key={side.source}>
                {i > 0 ? " vs " : ""}
                {SOURCE_LABEL[side.source] ?? side.source} says {side.direction === "long" ? "BUY" : "SELL"}
              </span>
            ))}
            . Wait for one to resolve before acting on either.
          </span>
        </div>
      ))}
    </div>
  );
}
