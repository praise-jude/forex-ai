"use client";

import type { EngineVerdict, PairAnalysisResult } from "@/lib/market/types";
import { ConfirmationRow, STATUS_COLOR } from "./SignerBBreakdown";

const ENGINE_LABEL: Record<EngineVerdict["engine"], string> = {
  smc: "SMC",
  signer_b: "Signer B",
  range_engine: "Range Engine",
  timeframe_15m: "15M",
  timeframe_30m: "30M",
  timeframe_1h: "1H",
  timeframe_4h: "4H",
  timeframe_1d: "1D",
};

function verdictLabel(direction: EngineVerdict["direction"]): string {
  if (direction === "unavailable") return "Unavailable";
  if (direction === "neutral") return "Neutral";
  return direction === "long" ? "BUY" : "SELL";
}

/** Every row here traces to a real, already-computed engine verdict (see
 * pairAnalysisJob.ts's `engines` field) -- "Unavailable" means that engine genuinely
 * never reached a directional read (e.g. Signer B when the killzone gate blocked
 * before it could run), never a fabricated stand-in for a real answer. Mirrors
 * forex-ai-mobile's AiConsensusPanel.tsx. */
export function AiConsensusPanel({ result }: { result: Pick<PairAnalysisResult, "engines" | "direction" | "conflicted"> }) {
  const winningDirection = result.direction === "long" ? "long" : result.direction === "short" ? "short" : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold tracking-wide text-zinc-200">AI CONSENSUS</span>
        {result.conflicted && <span className="text-[11px] font-semibold text-amber-400">⚠️ CONFLICTED ANALYSIS</span>}
      </div>
      <div className="flex flex-col gap-1">
        {result.engines.map((verdict) => {
          const tone: keyof typeof STATUS_COLOR =
            verdict.direction === "neutral" || verdict.direction === "unavailable" || !winningDirection
              ? "neutral"
              : verdict.direction === winningDirection
                ? "positive"
                : "negative";
          return <ConfirmationRow key={verdict.engine} label={ENGINE_LABEL[verdict.engine]} value={verdictLabel(verdict.direction)} tone={tone} />;
        })}
      </div>
    </div>
  );
}
