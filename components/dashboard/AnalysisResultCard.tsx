"use client";

import type { PairAnalysisResult, Signal } from "@/lib/market/types";
import { describeNoTradeReason, REGIME_LABEL } from "@/lib/market/noTradeReason";
import { deriveRiskLevel, scoreSetupQuality, type RiskLevel } from "@/lib/market/setupQualityScore";
import { ProbabilityBar } from "./ProbabilityBar";
import { AiConsensusPanel } from "./AiConsensusPanel";
import { PointRouteCard } from "./PointRouteCard";
import { SetupQualityBreakdown } from "./SetupQualityBreakdown";

const RISK_LEVEL_DISPLAY: Record<RiskLevel, { label: string; className: string }> = {
  low: { label: "🟢 LOW RISK", className: "bg-emerald-500/15 text-emerald-400" },
  medium: { label: "🟡 MEDIUM RISK", className: "bg-amber-500/15 text-amber-400" },
  high: { label: "🔴 HIGH RISK", className: "bg-rose-500/15 text-rose-400" },
};

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

  // Only meaningful for an actual winning setup -- a risk level for a trade that
  // doesn't exist would just be a made-up number. Reuses the exact same score/checks
  // already shown lower on this card (SetupQualityBreakdown, RISK & TRADE VALIDATION),
  // just distilled into one traffic-light verdict up top, per the operator's own request.
  const riskLevel = winningSignal ? deriveRiskLevel(scoreSetupQuality(winningSignal, result.regime), result.riskValidation) : null;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-base font-extrabold text-zinc-100">{result.pair}</span>
        <span className="text-[10px] font-bold tracking-wide text-zinc-500">AI TRADE ANALYSIS</span>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xl font-extrabold text-zinc-100">{headline}</p>
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          Regime: {REGIME_LABEL[result.regime]}
        </span>
      </div>

      {riskLevel && (
        <div className={`rounded-lg px-3 py-2 text-center text-sm font-extrabold ${RISK_LEVEL_DISPLAY[riskLevel].className}`}>
          {RISK_LEVEL_DISPLAY[riskLevel].label}
        </div>
      )}

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
          <SetupQualityBreakdown signal={winningSignal} regime={result.regime} />
        </>
      )}

      <div className="h-px bg-white/10" />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-zinc-500">Range Engine</span>
        <span className={`text-[11px] font-bold ${result.rangeEvaluation.status === "signal" ? "text-sky-400" : "text-zinc-500"}`}>
          {result.rangeEvaluation.status === "signal"
            ? `${result.rangeEvaluation.signal.direction === "long" ? "LONG" : "SHORT"} setup found`
            : describeNoTradeReason(result.rangeEvaluation.reason, result.regime)}
        </span>
      </div>

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

      {result.moneyAtRisk && (
        <>
          <div className="h-px bg-white/10" />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-zinc-500">Money at risk ({result.moneyAtRisk.riskPct}% of balance)</span>
            <span className="text-[13px] font-extrabold text-rose-400">-${result.moneyAtRisk.amount.toFixed(2)}</span>
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
