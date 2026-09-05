"use client";

import type { PairAnalysisResult, Signal } from "@/lib/market/types";
import { describeNoTradeReason } from "@/lib/market/noTradeReason";
import { ProbabilityBar } from "./ProbabilityBar";
import { AiConsensusPanel } from "./AiConsensusPanel";
import { PointRouteCard } from "./PointRouteCard";

const TIMEFRAME_ROW_LABEL: { key: "m15" | "m30" | "h1" | "h4" | "d1"; label: string }[] = [
  { key: "m15", label: "15M" },
  { key: "m30", label: "30M" },
  { key: "h1", label: "1H" },
  { key: "h4", label: "4H" },
  { key: "d1", label: "1D" },
];

function trendLabel(direction: "bullish" | "bearish" | "neutral"): string {
  return direction === "bullish" ? "BUY" : direction === "bearish" ? "SELL" : "NEUTRAL";
}

function trendColor(direction: "bullish" | "bearish" | "neutral"): string {
  return direction === "bullish" ? "text-emerald-400" : direction === "bearish" ? "text-rose-400" : "text-zinc-500";
}

/** The one real "did this fully qualify" check, shared between this card's own STATUS
 * row and OnDemandSignalWidget.tsx's Place Trade gating -- a real signal cleared every
 * SMC/Signer B gate AND every risk-validation check run during analysis. Re-checked
 * again for real at actual execute time regardless (see executionEngine.ts); this is a
 * transparency preview, not the final word. Mirrors forex-ai-mobile's identical helper. */
export function qualifyingSignal(result: PairAnalysisResult): Signal | null {
  const winning = result.direction === "long" ? result.bullish : result.direction === "short" ? result.bearish : null;
  const winningSignal = winning?.status === "signal" ? winning.signal : null;
  if (!winningSignal) return null;

  const riskAllOk = result.riskValidation
    ? result.riskValidation.spread.allowed &&
      result.riskValidation.priceDrift.allowed &&
      result.riskValidation.correlatedExposure.allowed &&
      result.riskValidation.executionPolicy.allowed
    : false;
  return riskAllOk ? winningSignal : null;
}

/**
 * The final, fully-computed "Check a Pair" result -- section 9 of the spec. Every
 * number/label here traces to a real field on PairAnalysisResult (see
 * pairAnalysisJob.ts); "TRADE QUALIFIED" only ever appears when a real signal cleared
 * every gate AND every risk-validation check. Handing off to the existing Place Trade
 * flow (see OnDemandSignalWidget.tsx) is the caller's responsibility -- this component
 * is display-only and never itself places an order. Mirrors forex-ai-mobile's
 * AnalysisResultCard.tsx.
 */
export function AnalysisResultCard({ result }: { result: PairAnalysisResult }) {
  const winning = result.direction === "long" ? result.bullish : result.direction === "short" ? result.bearish : null;
  const winningSignal = winning?.status === "signal" ? winning.signal : null;
  const qualifiedSignal = qualifyingSignal(result);
  const qualified = qualifiedSignal !== null;

  const headline = result.conflicted
    ? "⚠️ CONFLICTED ANALYSIS"
    : result.direction === "long"
      ? "🟢 BUY"
      : result.direction === "short"
        ? "🔴 SELL"
        : "⚪ NO TRADE";

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-base font-extrabold text-zinc-100">{result.pair}</span>
        <span className="text-[10px] font-bold tracking-wide text-zinc-500">AI TRADE ANALYSIS</span>
      </div>
      <p className="text-xl font-extrabold text-zinc-100">{headline}</p>

      <ProbabilityBar buyPct={result.buyPct} sellPct={result.sellPct} noTradePct={result.noTradePct} />

      {!winningSignal && result.direction === "no_trade" && !result.conflicted && (
        <p className="text-xs text-zinc-500">
          {(result.bullish?.status === "no_trade" ? describeNoTradeReason(result.bullish.reason, result.regime) : null) ??
            (result.bearish?.status === "no_trade" ? describeNoTradeReason(result.bearish.reason, result.regime) : null) ??
            "No qualifying setup found."}
        </p>
      )}

      {winningSignal && (
        <>
          <div className="h-px bg-white/10" />
          <PointRouteCard signal={winningSignal} />
        </>
      )}

      <div className="h-px bg-white/10" />
      <AiConsensusPanel result={result} />

      <div className="h-px bg-white/10" />
      <div className="flex items-center justify-between">
        {TIMEFRAME_ROW_LABEL.map(({ key, label }) => (
          <div key={key} className="flex flex-col items-center gap-0.5">
            <span className="text-[10px] text-zinc-500">{label}</span>
            <span className={`text-[11px] font-extrabold ${trendColor(result.timeframeTrends[key])}`}>{trendLabel(result.timeframeTrends[key])}</span>
          </div>
        ))}
      </div>

      {result.riskValidation && (
        <>
          <div className="h-px bg-white/10" />
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-bold tracking-wide text-zinc-500">RISK &amp; TRADE VALIDATION</span>
            {(
              [
                ["Spread", result.riskValidation.spread],
                ["Price drift", result.riskValidation.priceDrift],
                ["Correlated exposure", result.riskValidation.correlatedExposure],
                ["Execution policy", result.riskValidation.executionPolicy],
              ] as const
            ).map(([label, check]) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-500">{label}</span>
                <span className={`text-[11px] font-bold ${check.allowed ? "text-emerald-400" : "text-rose-400"}`}>
                  {check.allowed ? "OK" : (check.reason ?? "Blocked")}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="h-px bg-white/10" />
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold tracking-wide text-zinc-500">STATUS</span>
        <span className={`text-sm font-extrabold ${qualified ? "text-emerald-400" : "text-zinc-500"}`}>
          {qualified ? "🟢 TRADE QUALIFIED" : "⚪ NOT QUALIFIED"}
        </span>
      </div>
    </div>
  );
}
