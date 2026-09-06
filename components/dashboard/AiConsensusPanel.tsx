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

// These aren't equal votes -- SMC proposes the trade, Signer B can independently veto
// it (a real hard gate, see decisionMatrix.ts), and everything else is context that
// never overrides either one. Shown so the panel doesn't read like a tally where
// "3 agree, 2 disagree" would mean anything -- it doesn't.
const ENGINE_ROLE: Record<EngineVerdict["engine"], string> = {
  smc: "finds the setup",
  signer_b: "independent check — can block SMC",
  range_engine: "context only, not a vote",
  timeframe_15m: "trend backdrop, not a vote",
  timeframe_30m: "trend backdrop, not a vote",
  timeframe_1h: "trend backdrop, not a vote",
  timeframe_4h: "trend backdrop, not a vote",
  timeframe_1d: "trend backdrop, not a vote",
};

function verdictLabel(direction: EngineVerdict["direction"]): string {
  if (direction === "unavailable") return "Unavailable";
  if (direction === "neutral") return "Neutral";
  return direction === "long" ? "BUY" : "SELL";
}

/** Plain-English synthesis of WHY the final answer is what it is -- not a new decision,
 * just narrating the real one decisionMatrix.ts/evaluateSignalDualDirection already
 * made, using the actual reason code when a candidate was found and blocked. */
function bottomLine(result: Pick<PairAnalysisResult, "direction" | "conflicted" | "bullish" | "bearish">): string {
  if (result.conflicted) {
    return "SMC found a real setup on BOTH sides at once, and each independently cleared Signer B -- a genuine contradiction, so it's NO TRADE rather than guessing which one to trust.";
  }
  if (result.direction === "long" || result.direction === "short") {
    const label = result.direction === "long" ? "BUY" : "SELL";
    return `SMC found a ${label} setup and Signer B's independent check agrees -- that's why the final answer is ${label}.`;
  }
  const attempted = result.bullish?.status === "no_trade" ? result.bullish : result.bearish?.status === "no_trade" ? result.bearish : null;
  if (attempted?.status === "no_trade") {
    if (attempted.reason.code === "signer_b_neutral") {
      return "SMC found a possible setup, but Signer B (the independent second check) came back Neutral -- both have to agree before a trade counts, so it's NO TRADE.";
    }
    if (attempted.reason.code === "signer_conflict") {
      return "SMC found a setup, but Signer B's independent check pointed the opposite way -- both have to agree before a trade counts, so it's NO TRADE.";
    }
  }
  return "SMC didn't find a setup that cleared every check on either side right now. Range Engine and the timeframe rows below are context, not votes, so they don't override that.";
}

/** Every row here traces to a real, already-computed engine verdict (see
 * pairAnalysisJob.ts's `engines` field) -- "Unavailable" means that engine genuinely
 * never reached a directional read (e.g. Signer B when the killzone gate blocked
 * before it could run), never a fabricated stand-in for a real answer. Mirrors
 * forex-ai-mobile's AiConsensusPanel.tsx. */
export function AiConsensusPanel({
  result,
}: {
  result: Pick<PairAnalysisResult, "engines" | "direction" | "conflicted" | "bullish" | "bearish">;
}) {
  const winningDirection = result.direction === "long" ? "long" : result.direction === "short" ? "short" : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold tracking-wide text-zinc-200">AI CONSENSUS</span>
        {result.conflicted && <span className="text-[11px] font-semibold text-amber-400">⚠️ CONFLICTED ANALYSIS</span>}
      </div>
      <p className="rounded-md bg-zinc-800/80 px-2.5 py-2 text-[11px] leading-snug text-zinc-300">{bottomLine(result)}</p>
      <div className="flex flex-col gap-1.5">
        {result.engines.map((verdict) => {
          const tone: keyof typeof STATUS_COLOR =
            verdict.direction === "neutral" || verdict.direction === "unavailable" || !winningDirection
              ? "neutral"
              : verdict.direction === winningDirection
                ? "positive"
                : "negative";
          return (
            <div key={verdict.engine} className="flex flex-col">
              <ConfirmationRow label={ENGINE_LABEL[verdict.engine]} value={verdictLabel(verdict.direction)} tone={tone} />
              <span className="text-[10px] italic text-zinc-600">{ENGINE_ROLE[verdict.engine]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
